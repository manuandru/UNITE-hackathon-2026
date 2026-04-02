"""
NYC Bus Delay Prediction — Backend
FastAPI server that:
  - Serves ML model predictions via REST
  - Simulates real-time bus position via WebSocket
  - Provides feature schema for the frontend form
"""

import asyncio
import json
import math
import os
import random
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import joblib
import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ─── Config ────────────────────────────────────────────────────────────────────
MODEL_DIR = Path(os.getenv("MODEL_DIR", "/model"))
MODEL_PATH = MODEL_DIR / "bus_delay_rf.joblib"
META_PATH = MODEL_DIR / "model_metadata.json"
ENCODERS_PATH = MODEL_DIR / "label_encoders.joblib"

app = FastAPI(title="NYC Bus Delay Prediction API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Model Loading ──────────────────────────────────────────────────────────────
model = None
metadata: Dict[str, Any] = {}
label_encoders: Dict = {}


def load_model():
    global model, metadata, label_encoders
    if MODEL_PATH.exists():
        model = joblib.load(MODEL_PATH)
        with open(META_PATH) as f:
            metadata = json.load(f)
        if ENCODERS_PATH.exists():
            label_encoders = joblib.load(ENCODERS_PATH)
        print(f"Model loaded | features={len(metadata['feature_names'])} | classes={metadata['target_classes']}")
    else:
        print("Model not found. Run the notebook first to train and save the model.")


@app.on_event("startup")
def startup():
    load_model()


# ─── NYC Bus Routes (simplified waypoints) ─────────────────────────────────────
BUS_ROUTES = {
    "M15": {
        "name": "M15 - 1st/2nd Ave",
        "color": "#e11d48",
        "waypoints": [
            [40.7589, -73.9851],
            [40.7549, -73.9768],
            [40.7489, -73.9730],
            [40.7429, -73.9710],
            [40.7369, -73.9742],
            [40.7309, -73.9762],
            [40.7249, -73.9782],
            [40.7189, -73.9802],
            [40.7129, -73.9760],
            [40.7069, -73.9720],
        ],
    },
    "M79": {
        "name": "M79 - 79th St Crosstown",
        "color": "#2563eb",
        "waypoints": [
            [40.7794, -73.9813],
            [40.7794, -73.9750],
            [40.7792, -73.9680],
            [40.7791, -73.9610],
            [40.7789, -73.9540],
            [40.7787, -73.9470],
            [40.7785, -73.9400],
            [40.7783, -73.9330],
        ],
    },
    "Q58": {
        "name": "Q58 - Myrtle Ave",
        "color": "#16a34a",
        "waypoints": [
            [40.7282, -73.8951],
            [40.7262, -73.9011],
            [40.7242, -73.9071],
            [40.7222, -73.9131],
            [40.7202, -73.9191],
            [40.7182, -73.9251],
            [40.7162, -73.9311],
            [40.7142, -73.9371],
        ],
    },
    "BX12": {
        "name": "BX12 - Fordham Rd",
        "color": "#d97706",
        "waypoints": [
            [40.8620, -73.9250],
            [40.8618, -73.9170],
            [40.8616, -73.9090],
            [40.8614, -73.9010],
            [40.8612, -73.8930],
            [40.8610, -73.8850],
            [40.8608, -73.8770],
            [40.8606, -73.8690],
        ],
    },
}

# ─── Bus Simulator State ────────────────────────────────────────────────────────
class BusState:
    def __init__(self, bus_id: str, route_id: str):
        self.bus_id = bus_id
        self.route_id = route_id
        route = BUS_ROUTES[route_id]
        self.waypoints = route["waypoints"]
        self.segment = 0
        self.t = 0.0  # interpolation within segment [0, 1]
        self.speed = random.uniform(0.003, 0.006)  # progress per tick
        self.passengers = random.randint(10, 60)
        self.delay_minutes = random.randint(0, 15)
        self.heading = "northbound"

    def tick(self):
        self.t += self.speed
        if self.t >= 1.0:
            self.t = 0.0
            self.segment = (self.segment + 1) % (len(self.waypoints) - 1)
            # Simulate passenger & delay fluctuation
            self.passengers = max(0, min(80, self.passengers + random.randint(-5, 5)))
            self.delay_minutes = max(0, min(30, self.delay_minutes + random.randint(-2, 3)))

    @property
    def position(self):
        a = self.waypoints[self.segment]
        b = self.waypoints[self.segment + 1]
        lat = a[0] + (b[0] - a[0]) * self.t
        lon = a[1] + (b[1] - a[1]) * self.t
        return lat, lon

    def to_dict(self):
        lat, lon = self.position
        return {
            "bus_id": self.bus_id,
            "route_id": self.route_id,
            "route_name": BUS_ROUTES[self.route_id]["name"],
            "route_color": BUS_ROUTES[self.route_id]["color"],
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "passengers": self.passengers,
            "delay_minutes": self.delay_minutes,
            "segment": self.segment,
            "timestamp": time.time(),
        }


# Create initial bus states
buses: Dict[str, BusState] = {
    "BUS-001": BusState("BUS-001", "M15"),
    "BUS-002": BusState("BUS-002", "M79"),
    "BUS-003": BusState("BUS-003", "Q58"),
    "BUS-004": BusState("BUS-004", "BX12"),
}

# ─── WebSocket Manager ──────────────────────────────────────────────────────────
class ConnectionManager:
    def __init__(self):
        self.active: List[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active.append(ws)

    def disconnect(self, ws: WebSocket):
        self.active.remove(ws)

    async def broadcast(self, data: dict):
        dead = []
        for ws in self.active:
            try:
                await ws.send_json(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.active.remove(ws)


manager = ConnectionManager()


async def bus_ticker():
    """Background task: update all buses and broadcast every second."""
    while True:
        for bus in buses.values():
            bus.tick()
        payload = {"type": "bus_update", "buses": [b.to_dict() for b in buses.values()]}
        await manager.broadcast(payload)
        await asyncio.sleep(1)


@app.on_event("startup")
async def start_ticker():
    asyncio.create_task(bus_ticker())


# ─── REST Endpoints ─────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {
        "status": "ok",
        "model_loaded": model is not None,
        "buses": len(buses),
    }


@app.get("/routes")
def get_routes():
    return {
        route_id: {
            "name": r["name"],
            "color": r["color"],
            "waypoints": r["waypoints"],
        }
        for route_id, r in BUS_ROUTES.items()
    }


@app.get("/model/info")
def model_info():
    if model is None:
        raise HTTPException(503, "Model not loaded. Run the notebook first.")
    return {
        "features": metadata.get("feature_names", []),
        "target_classes": metadata.get("target_classes", []),
        "n_estimators": metadata.get("n_estimators"),
        "max_depth": metadata.get("max_depth"),
        "dataset": metadata.get("dataset"),
    }


@app.get("/model/feature_schema")
def feature_schema():
    """Return the feature schema so the frontend can build a prediction form."""
    if model is None:
        raise HTTPException(503, "Model not loaded. Run the notebook first.")

    # Build a schema with type hints and sample values for each feature
    schema = {}
    feature_names = metadata.get("feature_names", [])
    categorical_cols = metadata.get("categorical_columns", [])

    SAMPLE_VALUES = {
        # Typical NYC bus breakdown dataset columns
        "School_Year": {"type": "select", "options": ["2015-2016", "2016-2017", "2017-2018", "2018-2019", "2019-2020"]},
        "Busbreakdown_ID": {"type": "number", "min": 1, "max": 999999, "default": 123456},
        "Run_Type": {"type": "select", "options": ["Special Ed AM Run", "Special Ed PM Run", "General Ed AM Run", "General Ed PM Run"]},
        "Bus_No": {"type": "text", "default": "7890"},
        "Route_Number": {"type": "text", "default": "M15"},
        "Reason": {"type": "select", "options": ["Heavy Traffic", "Mechanical Problem", "Weather Conditions", "Won't Start", "Flat Tire", "Accident"]},
        "Schools_Serviced": {"type": "text", "default": "12345"},
        "Occurred_On": {"type": "select", "options": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]},
        "Has_Contractor_Notified_Schools": {"type": "select", "options": ["Yes", "No"]},
        "Has_Contractor_Notified_Parents": {"type": "select", "options": ["Yes", "No"]},
        "Have_You_Alerted_OPT": {"type": "select", "options": ["Yes", "No", "N/A"]},
        "Informed_On": {"type": "select", "options": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]},
        "Boro": {"type": "select", "options": ["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"]},
        "Bus_Company_Name": {"type": "select", "options": ["LITTLE LINDA BUS CO.", "L& M BUS CORP.", "CAREFUL BUS SERVICE INC", "CONSOLIDATED BUS TRANSIT INC"]},
        "How_Long_Delayed": {"type": "number", "min": 0, "max": 120, "default": 15},
        "Number_Of_Students_On_The_Bus": {"type": "number", "min": 0, "max": 80, "default": 20},
        "Active_Vehicles": {"type": "number", "min": 0, "max": 1000, "default": 150},
    }

    for feat in feature_names:
        if feat in SAMPLE_VALUES:
            schema[feat] = SAMPLE_VALUES[feat]
        elif feat in categorical_cols:
            schema[feat] = {"type": "text", "default": "Unknown"}
        else:
            schema[feat] = {"type": "number", "min": 0, "max": 100, "default": 0}

    return {"features": schema, "categorical_columns": categorical_cols}


class PredictionRequest(BaseModel):
    features: Dict[str, Any]


@app.post("/predict")
def predict(req: PredictionRequest):
    if model is None:
        raise HTTPException(503, "Model not loaded. Run the notebook first.")

    feature_names = metadata["feature_names"]
    categorical_cols = metadata.get("categorical_columns", [])

    # Build feature vector
    row = {}
    for feat in feature_names:
        val = req.features.get(feat, None)
        if val is None:
            val = "Unknown" if feat in categorical_cols else 0
        row[feat] = val

    df_input = pd.DataFrame([row])

    # Encode categoricals
    for col in categorical_cols:
        if col in df_input.columns and col in label_encoders:
            le = label_encoders[col]
            try:
                df_input[col] = le.transform(df_input[col].astype(str))
            except ValueError:
                # Unseen label → use 0
                df_input[col] = 0

    # Fill numeric NaN
    df_input = df_input.fillna(0)
    df_input = df_input[feature_names]

    pred_class = int(model.predict(df_input)[0])
    pred_proba = model.predict_proba(df_input)[0].tolist()
    target_classes = metadata["target_classes"]

    return {
        "predicted_class": pred_class,
        "predicted_label": target_classes[pred_class],
        "probabilities": {target_classes[i]: round(p, 4) for i, p in enumerate(pred_proba)},
        "delay_probability": round(max(pred_proba), 4),
        "is_delayed": target_classes[pred_class].lower() in ("yes", "true", "1", "delayed"),
    }


@app.post("/predict/bus/{bus_id}")
def predict_for_bus(bus_id: str):
    """Auto-generate a prediction using the current bus state."""
    if model is None:
        raise HTTPException(503, "Model not loaded. Run the notebook first.")
    if bus_id not in buses:
        raise HTTPException(404, f"Bus {bus_id} not found.")

    bus = buses[bus_id]
    feature_names = metadata["feature_names"]
    categorical_cols = metadata.get("categorical_columns", [])

    # Map bus state to approximate feature values
    REASON_OPTIONS = ["Heavy Traffic", "Mechanical Problem", "Weather Conditions", "Won't Start", "Flat Tire"]
    BORO_OPTIONS = ["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"]
    RUN_TYPE_OPTIONS = ["Special Ed AM Run", "Special Ed PM Run", "General Ed AM Run"]
    BUS_COMPANY_OPTIONS = ["LITTLE LINDA BUS CO.", "L& M BUS CORP.", "CAREFUL BUS SERVICE INC"]

    auto_features = {
        "School_Year": "2019-2020",
        "Run_Type": random.choice(RUN_TYPE_OPTIONS),
        "Reason": "Heavy Traffic" if bus.delay_minutes > 10 else random.choice(REASON_OPTIONS),
        "Occurred_On": "Monday",
        "Has_Contractor_Notified_Schools": "Yes" if bus.delay_minutes > 5 else "No",
        "Has_Contractor_Notified_Parents": "Yes" if bus.delay_minutes > 8 else "No",
        "Have_You_Alerted_OPT": "Yes" if bus.delay_minutes > 10 else "No",
        "Informed_On": "Monday",
        "Boro": BORO_OPTIONS[list(buses.keys()).index(bus_id) % len(BORO_OPTIONS)],
        "Bus_Company_Name": random.choice(BUS_COMPANY_OPTIONS),
        "How_Long_Delayed": bus.delay_minutes,
        "Number_Of_Students_On_The_Bus": bus.passengers,
        "Active_Vehicles": random.randint(100, 300),
        "Busbreakdown_ID": random.randint(100000, 999999),
        "Bus_No": bus_id.replace("BUS-", ""),
        "Route_Number": bus.route_id,
        "Schools_Serviced": str(random.randint(10000, 99999)),
    }

    return predict(PredictionRequest(features=auto_features))


# ─── WebSocket ──────────────────────────────────────────────────────────────────
@app.websocket("/ws/buses")
async def websocket_buses(ws: WebSocket):
    await manager.connect(ws)
    # Send initial state immediately
    payload = {"type": "bus_update", "buses": [b.to_dict() for b in buses.values()]}
    await ws.send_json(payload)
    try:
        while True:
            await ws.receive_text()  # keep-alive
    except WebSocketDisconnect:
        manager.disconnect(ws)
