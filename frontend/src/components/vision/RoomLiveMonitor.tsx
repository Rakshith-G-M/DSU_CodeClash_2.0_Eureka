// Room occupancy monitoring — the primary camera control for a selected room.
//
// Rendered inside the Digital Twin room overview. From here the operator can:
//   • enable occupancy monitoring for THIS IFC space (creates the demo
//     association and starts the camera in one explicit action),
//   • see the live person estimate, provenance and last update,
//   • stop monitoring (all MediaStream tracks are stopped by the source).
//
// Honesty rules:
//   • The camera's room association is ALWAYS the operator's explicit demo
//     mapping. It is never inferred from detections, and it is never moved to
//     another room silently.
//   • LIVE camera observations and SAMPLE data are labelled distinctly.
//   • Occupancy is a camera estimate; it is never a sensor measurement.

import { useState, type CSSProperties } from "react";
import { Badge } from "../common";
import { useVision } from "../../vision/visionContext";
import {
  DEMO_MAPPING_LABEL,
  cameraStatusInfo,
  monitoringState,
  monitoringStateLabel,
  monitoringStateTone,
  occupancyHeadline,
  occupancySourceLabel,
  occupancySourceTone,
} from "./provenance";
import { fmtDateTime, formatSpaceRoomName, getSpaceMeta } from "../../lib/format";

export function RoomLiveMonitor({
  spaceId,
  storeyId,
}: {
  spaceId: string;
  storeyId: string | null;
}) {
  const vision = useVision();
  const mapping = vision.demoMapping;
  const mappedHere = mapping?.space_id === spaceId;
  const mappedElsewhere = mapping !== null && mapping.space_id !== spaceId;

  const [isMoving, setIsMoving] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<{ success: boolean; text: string } | null>(null);

  const state = monitoringState(vision.cameraStatus, vision.hasStarted);
  const cameraInfo = cameraStatusInfo(vision.cameraStatus);
  const observation = mappedHere ? vision.observation : null;

  const otherRoom = mappedElsewhere
    ? formatSpaceRoomName(mapping?.space_name ?? null, mapping?.space_id)
    : null;

  async function associateAndStart() {
    setIsMoving(true);
    setActionFeedback(null);
    try {
      if (!mappedHere) {
        const meta = getSpaceMeta(spaceId);
        vision.setDemoSpace({
          space_id: spaceId,
          ifc_global_id: meta?.ifcGlobalId ?? null,
          space_name: meta?.ifcName ?? null,
          storey_id: storeyId,
          storey_name: meta?.storeyName ?? null,
        });
      }
      await vision.startCamera();
      setActionFeedback({
        success: true,
        text: `Camera association updated to ${formatSpaceRoomName(null, spaceId)} & monitoring started.`,
      });
    } catch (err: unknown) {
      setActionFeedback({
        success: false,
        text: String((err as Error)?.message ?? "Failed to start camera."),
      });
    } finally {
      setIsMoving(false);
    }
  }

  return (
    <div
      data-testid="room-live-monitor"
      style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
        <Badge label={vision.source.label} tone="info" mono />
        <Badge label={monitoringStateLabel(state)} tone={monitoringStateTone(state)} mono />
        {mappedHere && <Badge label="DEMO MAPPING" tone="warn" mono />}
      </div>

      {actionFeedback && (
        <div
          style={{
            fontSize: "0.72rem",
            padding: "0.35rem 0.6rem",
            borderRadius: "6px",
            background: actionFeedback.success ? "rgba(52, 211, 153, 0.12)" : "rgba(248, 113, 113, 0.12)",
            border: `1px solid ${actionFeedback.success ? "rgba(52, 211, 153, 0.4)" : "rgba(248, 113, 113, 0.4)"}`,
            color: actionFeedback.success ? "#34d399" : "#f87171",
          }}
        >
          {actionFeedback.text}
        </div>
      )}

      {mappedHere ? (
        <div data-testid="room-camera" style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: "0.6rem" }}>
            <span
              data-testid="room-occupancy-count"
              style={{
                fontSize: state === "MONITORING" || observation ? "2rem" : "1.6rem",
                fontWeight: 800,
                lineHeight: 1,
                color: observation ? "var(--color-ink)" : "var(--color-ink-dim)",
              }}
            >
              {observation ? observation.count : "—"}
            </span>
            <span style={{ fontSize: "0.82rem", color: "var(--color-ink-muted)" }}>
              {observation
                ? occupancyHeadline(observation.count, observation.source)
                : state === "STOPPED"
                ? "Monitoring stopped"
                : state === "REQUESTING"
                ? "Starting camera..."
                : "No occupancy reading yet"}
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
            {observation && (
              <Badge
                label={occupancySourceLabel(observation.source)}
                tone={occupancySourceTone(observation.source)}
                mono
              />
            )}
            <span style={{ fontSize: "0.68rem", color: "var(--color-ink-dim)" }}>
              {observation?.timestamp
                ? `Updated ${fmtDateTime(observation.timestamp)}`
                : cameraInfo.hint}
              {observation?.confidence != null
                ? ` · conf ${observation.confidence}`
                : ""}
            </span>
          </div>

          <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
            {state === "MONITORING" ? (
              <button
                type="button"
                onClick={vision.stopCamera}
                data-testid="room-camera-stop"
                style={primaryBtn}
              >
                ■ Stop monitoring
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void vision.startCamera()}
                disabled={state === "REQUESTING" || isMoving}
                data-testid="room-camera-start"
                style={{ ...primaryBtn, opacity: state === "REQUESTING" || isMoving ? 0.5 : 1 }}
              >
                {state === "STOPPED" ? "Resume monitoring" : "Start monitoring"}
              </button>
            )}
          </div>

          {/* Compact collapsible demo options */}
          <details
            style={{
              marginTop: "0.2rem",
              borderTop: "1px solid rgba(255, 255, 255, 0.08)",
              paddingTop: "0.35rem",
            }}
          >
            <summary
              style={{
                fontSize: "0.68rem",
                color: "var(--color-ink-muted)",
                cursor: "pointer",
                userSelect: "none",
              }}
            >
              Camera settings & demo options
            </summary>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.45rem", marginTop: "0.4rem" }}>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.4rem",
                  fontSize: "0.7rem",
                  color: "var(--color-ink-muted)",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={vision.sampleMode}
                  onChange={(e) => vision.setSampleMode(e.target.checked)}
                  data-testid="room-sample-toggle"
                />
                Use sample data (demo) — never a camera observation
              </label>

              <button
                type="button"
                onClick={vision.clearDemoSpace}
                data-testid="room-camera-unlink"
                style={{ ...ctrlBtn, alignSelf: "flex-start", fontSize: "0.7rem", padding: "0.25rem 0.55rem" }}
              >
                Remove association
              </button>

              <p style={noteStyle}>
                {DEMO_MAPPING_LABEL}. Occupancy is a camera estimate, not a sensor measurement.
              </p>
            </div>
          </details>

          {state === "UNAVAILABLE" && (
            <p style={{ ...noteStyle, color: "#fda4af" }}>{cameraInfo.hint}</p>
          )}
        </div>
      ) : (
        <div
          data-testid="room-camera-unmapped"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.45rem",
            padding: "0.5rem 0.65rem",
            borderRadius: "7px",
            background: mappedElsewhere ? "rgba(251, 191, 36, 0.06)" : "rgba(14, 32, 24, 0.35)",
            border: `1px solid ${mappedElsewhere ? "rgba(251, 191, 36, 0.3)" : "var(--color-line)"}`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
            <span
              style={{
                width: "6px",
                height: "6px",
                borderRadius: "50%",
                background: mappedElsewhere ? "#fbbf24" : "var(--color-ink-dim)",
                flexShrink: 0,
              }}
            />
            <span style={{ fontSize: "0.74rem", fontWeight: 700, color: mappedElsewhere ? "#fbbf24" : "var(--color-ink-muted)" }}>
              {mappedElsewhere ? "Associated Elsewhere" : "No Camera Association"}
            </span>
          </div>
          <p style={noteStyle}>
            {otherRoom
              ? `The demo camera is currently associated with ${otherRoom}. It is never moved automatically.`
              : "Occupancy monitoring is not set up for this room yet."}
          </p>
          <button
            type="button"
            onClick={associateAndStart}
            disabled={isMoving || state === "REQUESTING"}
            data-testid="room-camera-associate"
            style={{
              ...primaryBtn,
              alignSelf: "flex-start",
              opacity: isMoving || state === "REQUESTING" ? 0.6 : 1,
            }}
          >
            {isMoving
              ? "Starting camera..."
              : otherRoom
              ? "Move camera to this room & start"
              : "Enable occupancy monitoring"}
          </button>
          <p style={{ ...noteStyle, fontSize: "0.65rem" }}>
            Creates a demo association with this room (not a verified physical
            installation) and starts the camera.
          </p>
        </div>
      )}
    </div>
  );
}

const ctrlBtn: CSSProperties = {
  background: "transparent",
  border: "1px solid var(--color-line)",
  color: "var(--color-ink-muted)",
  borderRadius: "8px",
  padding: "0.4rem 0.7rem",
  fontSize: "0.75rem",
  cursor: "pointer",
};

const primaryBtn: CSSProperties = {
  background: "rgba(63, 174, 131, 0.16)",
  border: "1px solid rgba(63, 174, 131, 0.55)",
  color: "var(--accent-cyan)",
  borderRadius: "8px",
  padding: "0.45rem 0.8rem",
  fontSize: "0.78rem",
  fontWeight: 700,
  cursor: "pointer",
};

const noteStyle: CSSProperties = {
  margin: 0,
  fontSize: "0.7rem",
  color: "var(--color-ink-dim)",
  lineHeight: 1.5,
};
