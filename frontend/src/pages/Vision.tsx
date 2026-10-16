// CV-2 — Camera occupancy page.
//
// Fully client-side: the camera stream and the MediaPipe detector run in the
// browser (owned by VisionProvider so the Digital Twin room monitor can reuse
// the same live state). The only backend calls are the existing
// /api/dashboard/summary and /api/spaces. An occupancy count is only ever shown
// against an IFC space through an explicit, clearly-labelled DEMO MAPPING that
// the operator configured; it is never inferred from detections.

import { Link } from "react-router-dom";
import { api } from "../api";
import { useApi } from "../hooks/useApi";
import { Badge, LoadingState, Panel } from "../components/common";
import { CameraPanel } from "../components/vision/CameraPanel";
import { useVision } from "../vision/visionContext";
import { resolveSpaceDisplayName } from "../lib/format";
import {
  DEMO_MAPPING_DISCLAIMER,
  DEMO_MAPPING_LABEL,
  OCCUPANCY_MODEL_NAME,
  OCCUPANCY_SCORE_THRESHOLD,
} from "../components/vision/provenance";

export function VisionPage() {
  const { state: dashState } = useApi(() => api.dashboard(), []);
  const vision = useVision();

  const mapping = dashState.status === "READY" ? dashState.data.mapping : null;
  const mappingStatus = mapping?.status ?? "UNKNOWN";
  const unresolved = mapping?.unresolved ?? null;
  const verified = mapping?.verified_locations ?? null;

  const attribution = vision.demoMapping
    ? `${DEMO_MAPPING_LABEL} → ${vision.demoMapping.space_name ?? vision.demoMapping.space_id}`
    : "none (unassigned)";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "1.25rem",
        padding: "1.5rem",
        maxWidth: "1200px",
        margin: "0 auto",
        width: "100%",
      }}
    >
      <header style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 800, margin: 0 }}>
          Occupancy Monitoring
        </h1>
        <p style={{ margin: 0, color: "var(--color-ink-muted)", fontSize: "0.85rem", maxWidth: "52rem" }}>
          Estimates the number of people visible to a local camera using an
          on-device {OCCUPANCY_MODEL_NAME} model. Frames are processed in this
          browser and are never uploaded. Counts are camera observations only —
          they are never assigned to a room because of what the model saw.
        </p>
      </header>

      {/* Mapping-honesty banner: data-driven from the existing dashboard API. */}
      <div
        data-testid="mapping-banner"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          flexWrap: "wrap",
          padding: "0.85rem 1rem",
          borderRadius: "12px",
          border: "1px solid rgba(245, 158, 11, 0.3)",
          background: "rgba(245, 158, 11, 0.08)",
        }}
      >
        <Badge
          label={`CAMERA→ROOM MAPPING: ${mappingStatus}`}
          tone={mappingStatus === "UNRESOLVED" ? "warn" : "info"}
          mono
        />
        <span style={{ fontSize: "0.8rem", color: "var(--color-ink-muted)" }}>
          {verified !== null && unresolved !== null
            ? `${verified} verified · ${unresolved} unresolved`
            : "Mapping status unavailable from the API"}{" "}
          — verified sensor→space mapping is what would attribute telemetry to a
          room. Occupancy counts are never attributed to an IFC space based on
          detections; only an explicit demo mapping below can associate a camera
          with a room, and it is labelled as such.
        </span>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1.6fr) minmax(0, 1fr)",
          gap: "1.25rem",
          alignItems: "start",
        }}
      >
        <Panel title="Live camera feed" hint="Local processing only">
          <div style={{ padding: "1.25rem" }}>
            <CameraPanel
              status={vision.cameraStatus}
              error={vision.cameraError}
              stream={vision.stream}
              sourceLabel={vision.source.label}
              detections={vision.detections}
              observation={vision.observation}
              detectorStatus={vision.detectorStatus}
              detectorError={vision.detectorError}
              onStart={() => void vision.startCamera()}
              onStop={vision.stopCamera}
            />
          </div>
        </Panel>

        <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
          <Panel title="Room association" hint="Configured in the Digital Twin">
            <div
              style={{
                padding: "1.25rem",
                display: "flex",
                flexDirection: "column",
                gap: "0.75rem",
              }}
            >
              {vision.demoMapping ? (
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                    <Badge label="DEMO MAPPING" tone="warn" mono />
                    <span style={{ fontSize: "0.85rem", color: "var(--color-ink)" }}>
                      {resolveSpaceDisplayName(vision.demoMapping.space_id)}
                    </span>
                  </div>
                  <p style={{ margin: 0, fontSize: "0.75rem", color: "var(--color-ink-dim)", lineHeight: 1.5 }}>
                    {DEMO_MAPPING_DISCLAIMER}
                  </p>
                  <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
                    <Link
                      to={`/twin?space=${encodeURIComponent(vision.demoMapping.space_id)}`}
                      style={{ fontSize: "0.78rem", color: "var(--accent-cyan)" }}
                    >
                      Open the room in the Digital Twin →
                    </Link>
                    <button
                      type="button"
                      onClick={vision.clearDemoSpace}
                      data-testid="demo-mapping-clear"
                      style={{
                        background: "transparent",
                        border: "1px solid var(--color-line)",
                        color: "var(--color-ink-muted)",
                        borderRadius: "8px",
                        padding: "0.3rem 0.6rem",
                        fontSize: "0.72rem",
                        cursor: "pointer",
                      }}
                    >
                      Clear association
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--color-ink-muted)", lineHeight: 1.55 }}>
                    No room is associated with the camera yet. Associations are set
                    from the room itself: open a room in the Digital Twin and choose
                    <strong> Enable occupancy monitoring</strong>. This page only
                    reflects the current association.
                  </p>
                  <Link to="/twin" style={{ fontSize: "0.78rem", color: "var(--accent-cyan)" }}>
                    Open the Digital Twin →
                  </Link>
                </>
              )}
            </div>
          </Panel>

          <Panel title="Data Provenance">
            <div style={{ padding: "1.25rem", display: "flex", flexDirection: "column", gap: "0.85rem" }}>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.6rem",
                  fontSize: "0.85rem",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={vision.sampleMode}
                  onChange={(e) => vision.setSampleMode(e.target.checked)}
                  data-testid="sample-toggle"
                />
                Use simulated sample data (demo)
              </label>
              <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--color-ink-dim)" }}>
                Sample data is clearly labelled and is <strong>not</strong> a
                camera observation. It exists only so the interface can be
                demonstrated without a camera.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem", fontSize: "0.78rem", color: "var(--color-ink-muted)" }}>
                <span>
                  <strong style={{ color: "var(--color-ink)" }}>Model:</strong>{" "}
                  {OCCUPANCY_MODEL_NAME}
                </span>
                <span>
                  <strong style={{ color: "var(--color-ink)" }}>Score threshold:</strong>{" "}
                  {OCCUPANCY_SCORE_THRESHOLD}
                </span>
                <span>
                  <strong style={{ color: "var(--color-ink)" }}>Room attribution:</strong>{" "}
                  {attribution}
                </span>
              </div>
            </div>
          </Panel>

          <Panel title="How this relates to telemetry">
            <div style={{ padding: "1.25rem", fontSize: "0.78rem", color: "var(--color-ink-muted)", display: "flex", flexDirection: "column", gap: "0.6rem" }}>
              <span>
                Camera occupancy is an independent, additive signal. It does not
                alter the existing telemetry, forecasts or the rule-based
                intelligence engine. A demo camera mapping associates the camera
                with a room for display only — it does not attribute telemetry to
                that room.
              </span>
              {dashState.status === "LOADING" && <LoadingState label="Loading mapping status…" />}
              {dashState.status === "ERROR" && (
                <span style={{ color: "#fda4af" }}>
                  Mapping status could not be loaded from the API; counts remain
                  unassigned.
                </span>
              )}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
