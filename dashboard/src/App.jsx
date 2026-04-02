import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  MapContainer,
  Marker,
  Polyline,
  Popup,
  TileLayer,
  useMap,
} from "react-leaflet";
import {
  PolarAngleAxis,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer
} from "recharts";

const API = process.env.REACT_APP_API_URL || "http://localhost:8000";
const WS_URL = process.env.REACT_APP_WS_URL || "ws://localhost:8000/ws/buses";

// ─── Bus SVG Icon ─────────────────────────────────────────────────────────────
function makeBusIcon(color, selected) {
  const size = selected ? 36 : 28;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 36 36">
    <circle cx="18" cy="18" r="17" fill="${color}" stroke="${selected ? "#fff" : "transparent"}" stroke-width="2.5" opacity="${selected ? 1 : 0.9}"/>
    <text x="18" y="23" text-anchor="middle" font-size="16" fill="white">🚌</text>
  </svg>`;
  return L.divIcon({
    html: svg,
    className: "",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

// ─── Gauge Component ──────────────────────────────────────────────────────────
function DelayGauge({ probability, label }) {
  const pct = Math.round((probability || 0) * 100);
  const color = pct > 70 ? "#ef4444" : pct > 40 ? "#f59e0b" : "#22c55e";
  const data = [{ value: pct, fill: color }];

  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ position: "relative", height: 120 }}>
        <ResponsiveContainer width="100%" height={120}>
          <RadialBarChart
            innerRadius="65%"
            outerRadius="100%"
            data={data}
            startAngle={225}
            endAngle={-45}
          >
            <PolarAngleAxis
              type="number"
              domain={[0, 100]}
              angleAxisId={0}
              tick={false}
            />
            <RadialBar
              background={{ fill: "#1f2d47" }}
              dataKey="value"
              angleAxisId={0}
              fill={color}
              cornerRadius={6}
            />
          </RadialBarChart>
        </ResponsiveContainer>
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -30%)",
            textAlign: "center",
          }}
        >
          <div
            style={{
              fontSize: 26,
              fontWeight: 700,
              color,
              fontFamily: "Space Mono, monospace",
            }}
          >
            {pct}%
          </div>
        </div>
      </div>
      <div
        style={{
          fontSize: 11,
          color: "#64748b",
          marginTop: -8,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
    </div>
  );
}

// ─── Stat Card ────────────────────────────────────────────────────────────────
function StatCard({ label, value, unit, color }) {
  return (
    <div
      style={{
        background: "#1a2236",
        border: "1px solid #1f2d47",
        borderRadius: 10,
        padding: "12px 16px",
        flex: 1,
      }}
    >
      <div
        style={{
          fontSize: 10,
          color: "#64748b",
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 22,
          fontWeight: 700,
          color: color || "#e2e8f0",
          fontFamily: "Space Mono, monospace",
        }}
      >
        {value}
        <span style={{ fontSize: 12, color: "#64748b", marginLeft: 3 }}>
          {unit}
        </span>
      </div>
    </div>
  );
}

// ─── Prediction Panel ─────────────────────────────────────────────────────────
function PredictionPanel({ selectedBus, buses }) {
  const [prediction, setPrediction] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [autoMode, setAutoMode] = useState(true);

  const bus = buses.find((b) => b.bus_id === selectedBus);

  const runPrediction = useCallback(async () => {
    if (!selectedBus) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/predict/bus/${selectedBus}`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setPrediction(data);
    } catch (e) {
      setError(
        e.message.includes("503")
          ? "Model not loaded — run the notebook first!"
          : e.message,
      );
    } finally {
      setLoading(false);
    }
  }, [selectedBus]);

  // Auto-predict every 5s when a bus is selected
  useEffect(() => {
    if (!selectedBus || !autoMode) return;
    runPrediction();
    const interval = setInterval(runPrediction, 5000);
    return () => clearInterval(interval);
  }, [selectedBus, autoMode, runPrediction]);

  if (!selectedBus) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          color: "#64748b",
          gap: 12,
        }}
      >
        <div style={{ fontSize: 32 }}>🚌</div>
        <div style={{ fontSize: 13, textAlign: "center" }}>
          Click a bus on the map
          <br />
          to see delay predictions
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Bus Info */}
      {bus && (
        <div style={{ display: "flex", gap: 8 }}>
          <StatCard label="Passengers" value={bus.passengers} unit="pax" />
          <StatCard
            label="Delay"
            value={bus.delay_minutes}
            unit="min"
            color={
              bus.delay_minutes > 10
                ? "#ef4444"
                : bus.delay_minutes > 5
                  ? "#f59e0b"
                  : "#22c55e"
            }
          />
        </div>
      )}

      {/* Gauge */}
      {prediction && !error && (
        <>
          <DelayGauge
            probability={prediction.delay_probability}
            label="Delay Probability"
          />

          {/* Result Badge */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "10px 16px",
              borderRadius: 10,
              background: prediction.is_delayed
                ? "rgba(239,68,68,0.12)"
                : "rgba(34,197,94,0.12)",
              border: `1px solid ${prediction.is_delayed ? "#ef4444" : "#22c55e"}40`,
              gap: 8,
            }}
          >
            <span style={{ fontSize: 16 }}>
              {prediction.is_delayed ? "⚠️" : "✅"}
            </span>
            <span
              style={{
                fontWeight: 600,
                fontSize: 13,
                color: prediction.is_delayed ? "#ef4444" : "#22c55e",
              }}
            >
              {prediction.predicted_label}
            </span>
          </div>

          {/* Probabilities breakdown */}
          <div
            style={{
              background: "#0a0e1a",
              borderRadius: 10,
              padding: "12px 14px",
            }}
          >
            <div
              style={{
                fontSize: 10,
                color: "#64748b",
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                marginBottom: 10,
              }}
            >
              Class Probabilities
            </div>
            {Object.entries(prediction.probabilities).map(([label, prob]) => (
              <div key={label} style={{ marginBottom: 8 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginBottom: 3,
                  }}
                >
                  <span style={{ fontSize: 11, color: "#94a3b8" }}>
                    {label}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      color: "#e2e8f0",
                      fontFamily: "Space Mono, monospace",
                    }}
                  >
                    {(prob * 100).toFixed(1)}%
                  </span>
                </div>
                <div
                  style={{ height: 4, background: "#1f2d47", borderRadius: 2 }}
                >
                  <div
                    style={{
                      height: "100%",
                      borderRadius: 2,
                      width: `${prob * 100}%`,
                      background:
                        label.toLowerCase().includes("yes") || label === "1"
                          ? "#ef4444"
                          : "#22c55e",
                      transition: "width 0.5s ease",
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {error && (
        <div
          style={{
            padding: "12px 16px",
            background: "rgba(239,68,68,0.1)",
            border: "1px solid #ef444440",
            borderRadius: 10,
            fontSize: 12,
            color: "#f87171",
          }}
        >
          ⚠️ {error}
        </div>
      )}

      {loading && !prediction && (
        <div
          style={{ textAlign: "center", color: "#64748b", padding: "20px 0" }}
        >
          <div className="pulse">Predicting…</div>
        </div>
      )}

      {/* Auto refresh toggle */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px",
          background: "#0a0e1a",
          borderRadius: 8,
        }}
      >
        <span style={{ fontSize: 11, color: "#64748b" }}>
          Auto-predict every 5s
        </span>
        <button
          onClick={() => setAutoMode(!autoMode)}
          style={{
            padding: "4px 10px",
            borderRadius: 6,
            border: "none",
            cursor: "pointer",
            fontSize: 11,
            background: autoMode ? "#3b82f6" : "#1f2d47",
            color: autoMode ? "#fff" : "#64748b",
            transition: "all 0.2s",
          }}
        >
          {autoMode ? "ON" : "OFF"}
        </button>
      </div>

      <button
        onClick={runPrediction}
        disabled={loading}
        style={{
          padding: "10px",
          borderRadius: 10,
          border: "none",
          cursor: "pointer",
          background: loading
            ? "#1f2d47"
            : "linear-gradient(135deg, #3b82f6, #06b6d4)",
          color: "#fff",
          fontWeight: 600,
          fontSize: 13,
          transition: "opacity 0.2s",
          opacity: loading ? 0.5 : 1,
        }}
      >
        {loading ? "⟳ Running…" : "▶ Predict Now"}
      </button>
    </div>
  );
}

// ─── Bus List Panel ───────────────────────────────────────────────────────────
function BusList({ buses, selectedBus, onSelect }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {buses.map((bus) => (
        <div
          key={bus.bus_id}
          onClick={() =>
            onSelect(bus.bus_id === selectedBus ? null : bus.bus_id)
          }
          style={{
            padding: "10px 14px",
            borderRadius: 10,
            cursor: "pointer",
            background: selectedBus === bus.bus_id ? "#1a2e4a" : "#111827",
            border: `1px solid ${selectedBus === bus.bus_id ? bus.route_color : "#1f2d47"}`,
            transition: "all 0.2s",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <div
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: bus.route_color,
              flexShrink: 0,
            }}
          />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 600 }}>{bus.bus_id}</div>
            <div style={{ fontSize: 10, color: "#64748b" }}>
              {bus.route_name}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                fontFamily: "Space Mono, monospace",
                color:
                  bus.delay_minutes > 10
                    ? "#ef4444"
                    : bus.delay_minutes > 5
                      ? "#f59e0b"
                      : "#22c55e",
              }}
            >
              +{bus.delay_minutes}m
            </div>
            <div style={{ fontSize: 10, color: "#64748b" }}>
              {bus.passengers} pax
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Map recenter helper ──────────────────────────────────────────────────────
function MapUpdater({ buses, selectedBus }) {
  const map = useMap();
  useEffect(() => {
    if (selectedBus) {
      const bus = buses.find((b) => b.bus_id === selectedBus);
      if (bus) {
        map.panTo([bus.lat, bus.lon], { animate: true, duration: 0.5 });
      }
    }
  }, [selectedBus, buses, map]);
  return null;
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [buses, setBuses] = useState([]);
  const [routes, setRoutes] = useState({});
  const [selectedBus, setSelectedBus] = useState(null);
  const [wsStatus, setWsStatus] = useState("connecting");
  const [lastUpdate, setLastUpdate] = useState(null);
  const wsRef = useRef(null);

  // Load routes
  useEffect(() => {
    fetch(`${API}/routes`)
      .then((r) => r.json())
      .then(setRoutes)
      .catch(() => {});
  }, []);

  // WebSocket for real-time bus positions
  useEffect(() => {
    function connect() {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => setWsStatus("connected");
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "bus_update") {
          setBuses(msg.buses);
          setLastUpdate(new Date().toLocaleTimeString());
        }
      };
      ws.onclose = () => {
        setWsStatus("reconnecting");
        setTimeout(connect, 2000);
      };
      ws.onerror = () => setWsStatus("error");
    }
    connect();
    return () => wsRef.current?.close();
  }, []);

  const statusColor = {
    connected: "#22c55e",
    connecting: "#f59e0b",
    reconnecting: "#f59e0b",
    error: "#ef4444",
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: "#0a0e1a",
      }}
    >
      {/* ─── Header ─── */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 24px",
          height: 56,
          flexShrink: 0,
          background: "#111827",
          borderBottom: "1px solid #1f2d47",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ fontSize: 20 }}>🚌</div>
          <div>
            <div
              style={{
                fontFamily: "Space Mono, monospace",
                fontWeight: 700,
                fontSize: 15,
                letterSpacing: "-0.02em",
              }}
            >
              NYC Bus Delay Predictor
            </div>
            <div
              style={{
                fontSize: 10,
                color: "#64748b",
                textTransform: "uppercase",
                letterSpacing: "0.1em",
              }}
            >
              ML-Powered Traffic Dashboard
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ fontSize: 10, color: "#64748b" }}>
            {lastUpdate ? `Updated ${lastUpdate}` : "Waiting for data…"}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: statusColor[wsStatus] || "#64748b",
              }}
            />
            <span
              style={{
                fontSize: 11,
                color: "#94a3b8",
                textTransform: "capitalize",
              }}
            >
              {wsStatus}
            </span>
          </div>
        </div>
      </header>

      {/* ─── Main Layout ─── */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Left sidebar */}
        <aside
          style={{
            width: 240,
            flexShrink: 0,
            background: "#111827",
            borderRight: "1px solid #1f2d47",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          <div
            style={{ padding: "14px 16px", borderBottom: "1px solid #1f2d47" }}
          >
            <div
              style={{
                fontSize: 10,
                color: "#64748b",
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                marginBottom: 10,
              }}
            >
              Active Buses ({buses.length})
            </div>
            <BusList
              buses={buses}
              selectedBus={selectedBus}
              onSelect={setSelectedBus}
            />
          </div>

          {/* Route legend */}
          <div
            style={{ padding: "14px 16px", borderBottom: "1px solid #1f2d47" }}
          >
            <div
              style={{
                fontSize: 10,
                color: "#64748b",
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                marginBottom: 10,
              }}
            >
              Routes
            </div>
            {Object.entries(routes).map(([id, r]) => (
              <div
                key={id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 7,
                }}
              >
                <div
                  style={{
                    width: 20,
                    height: 3,
                    background: r.color,
                    borderRadius: 2,
                    flexShrink: 0,
                  }}
                />
                <span style={{ fontSize: 11, color: "#94a3b8" }}>{r.name}</span>
              </div>
            ))}
          </div>

          {/* Summary stats */}
          <div style={{ padding: "14px 16px", flex: 1 }}>
            <div
              style={{
                fontSize: 10,
                color: "#64748b",
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                marginBottom: 10,
              }}
            >
              Fleet Summary
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontSize: 11, color: "#64748b" }}>
                  Total passengers
                </span>
                <span
                  style={{ fontSize: 11, fontFamily: "Space Mono, monospace" }}
                >
                  {buses.reduce((s, b) => s + b.passengers, 0)}
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontSize: 11, color: "#64748b" }}>
                  Avg delay
                </span>
                <span
                  style={{
                    fontSize: 11,
                    fontFamily: "Space Mono, monospace",
                    color: "#f59e0b",
                  }}
                >
                  {buses.length
                    ? Math.round(
                        buses.reduce((s, b) => s + b.delay_minutes, 0) /
                          buses.length,
                      )
                    : 0}
                  m
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontSize: 11, color: "#64748b" }}>
                  Delayed (&gt;10m)
                </span>
                <span
                  style={{
                    fontSize: 11,
                    fontFamily: "Space Mono, monospace",
                    color: "#ef4444",
                  }}
                >
                  {buses.filter((b) => b.delay_minutes > 10).length} /{" "}
                  {buses.length}
                </span>
              </div>
            </div>
          </div>
        </aside>

        {/* Map */}
        <main style={{ flex: 1, position: "relative", overflow: "hidden" }}>
          <MapContainer
            center={[40.758, -73.985]}
            zoom={12}
            style={{ width: "100%", height: "100%" }}
            zoomControl={false}
          >
            <TileLayer
              url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
              attribution="&copy; CartoDB"
            />

            {/* Route polylines */}
            {Object.entries(routes).map(([id, r]) => (
              <Polyline
                key={id}
                positions={r.waypoints}
                color={r.color}
                weight={2.5}
                opacity={0.5}
                dashArray="6 4"
              />
            ))}

            {/* Bus markers */}
            {buses.map((bus) => (
              <Marker
                key={bus.bus_id}
                position={[bus.lat, bus.lon]}
                icon={makeBusIcon(bus.route_color, selectedBus === bus.bus_id)}
                eventHandlers={{
                  click: () =>
                    setSelectedBus(
                      bus.bus_id === selectedBus ? null : bus.bus_id,
                    ),
                }}
              >
                <Popup>
                  <div
                    style={{ fontFamily: "DM Sans, sans-serif", minWidth: 160 }}
                  >
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>
                      {bus.bus_id}
                    </div>
                    <div
                      style={{
                        color: "#94a3b8",
                        fontSize: 12,
                        marginBottom: 8,
                      }}
                    >
                      {bus.route_name}
                    </div>
                    <div style={{ display: "flex", gap: 16, fontSize: 12 }}>
                      <div>
                        <div style={{ color: "#64748b", fontSize: 10 }}>
                          PASSENGERS
                        </div>
                        <div style={{ fontWeight: 600 }}>{bus.passengers}</div>
                      </div>
                      <div>
                        <div style={{ color: "#64748b", fontSize: 10 }}>
                          DELAY
                        </div>
                        <div
                          style={{
                            fontWeight: 600,
                            color:
                              bus.delay_minutes > 10 ? "#ef4444" : "#22c55e",
                          }}
                        >
                          +{bus.delay_minutes} min
                        </div>
                      </div>
                    </div>
                  </div>
                </Popup>
              </Marker>
            ))}

            <MapUpdater buses={buses} selectedBus={selectedBus} />
          </MapContainer>

          {/* Map overlay: coordinates of selected bus */}
          {selectedBus &&
            buses.find((b) => b.bus_id === selectedBus) &&
            (() => {
              const bus = buses.find((b) => b.bus_id === selectedBus);
              return (
                <div
                  style={{
                    position: "absolute",
                    bottom: 16,
                    left: 16,
                    zIndex: 1000,
                    background: "rgba(17,24,39,0.9)",
                    backdropFilter: "blur(8px)",
                    border: "1px solid #1f2d47",
                    borderRadius: 10,
                    padding: "10px 14px",
                    fontFamily: "Space Mono, monospace",
                    fontSize: 11,
                    color: "#94a3b8",
                  }}
                >
                  <div
                    style={{
                      color: bus.route_color,
                      fontWeight: 700,
                      marginBottom: 2,
                    }}
                  >
                    {bus.bus_id}
                  </div>
                  <div>LAT {bus.lat.toFixed(5)}</div>
                  <div>LON {bus.lon.toFixed(5)}</div>
                </div>
              );
            })()}
        </main>

        {/* Right prediction panel */}
        <aside
          style={{
            width: 270,
            flexShrink: 0,
            background: "#111827",
            borderLeft: "1px solid #1f2d47",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          <div
            style={{ padding: "14px 16px", borderBottom: "1px solid #1f2d47" }}
          >
            <div
              style={{
                fontSize: 10,
                color: "#64748b",
                textTransform: "uppercase",
                letterSpacing: "0.1em",
              }}
            >
              {selectedBus ? `Prediction — ${selectedBus}` : "ML Prediction"}
            </div>
            {selectedBus && buses.find((b) => b.bus_id === selectedBus) && (
              <div
                style={{
                  fontSize: 12,
                  color: buses.find((b) => b.bus_id === selectedBus)
                    ?.route_color,
                  marginTop: 2,
                }}
              >
                {buses.find((b) => b.bus_id === selectedBus)?.route_name}
              </div>
            )}
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: "16px" }}>
            <PredictionPanel selectedBus={selectedBus} buses={buses} />
          </div>

          {/* Model info footer */}
          <div style={{ padding: "10px 16px", borderTop: "1px solid #1f2d47" }}>
            <div style={{ fontSize: 10, color: "#64748b", lineHeight: 1.5 }}>
              🧠 Random Forest · OpenML #43484
              <br />
              NYC Bus Breakdowns dataset
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
