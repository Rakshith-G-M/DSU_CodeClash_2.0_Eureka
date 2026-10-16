// Building telemetry — the clearly-separated, secondary view of historical
// building/channel-level readings.
//
// This data comes from the replay engine and is intentionally NOT shown inside
// the room-level metric cards: every channel reports
// `location_status: "UNKNOWN_LOCATION"`, so no reading can be attributed to an
// individual room. Values keep their verbatim unit, timestamp and replay-clock
// lag, and a raw sensor UUID is never surfaced here (only a friendly channel
// name). Collapsed by default so it stays visually secondary to the room
// overview.

import { useMemo, type CSSProperties } from "react";
import { Badge } from "../common";
import { useReplay } from "../../hooks/useReplay";
import { fmtNum } from "../../lib/format";
import { getSensorDisplayName } from "../../lib/sensorsData";
import {
  ENERGY_TYPES,
  ENVIRONMENTAL_TYPES,
  REPLAY_RUNNING_LABEL,
  REPLAY_SOURCE_LABEL,
  UNAVAILABLE_LABEL,
  formatLag,
  latestByType,
  pickTypes,
  type MeasurementView,
} from "./replayPresentation";

const SPEEDS = [1, 10, 60];

function MeasurementRow({ view }: { view: MeasurementView }) {
  return (
    <div
      data-testid="building-telemetry-row"
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: "0.6rem",
        padding: "0.35rem 0",
        borderBottom: "1px solid rgba(30,47,66,0.4)",
        fontSize: "0.78rem",
      }}
    >
      <span style={{ color: "var(--color-ink-muted)", minWidth: 0 }}>
        {getSensorDisplayName(null, view.measurement_type)}
      </span>
      <span style={{ textAlign: "right" }}>
        <span style={{ fontFamily: "var(--font-mono)", color: "var(--color-ink)" }}>
          {fmtNum(view.value, 1)} {view.unit}
        </span>
        <span style={{ display: "block", fontSize: "0.66rem", color: "var(--color-ink-dim)" }}>
          {view.timestamp} · lag {formatLag(view.lag_seconds)}
        </span>
      </span>
    </div>
  );
}

export function BuildingTelemetry() {
  const replay = useReplay();

  const views = useMemo(
    () => latestByType(replay.state?.channels ?? [], replay.simTimestamp),
    [replay.state, replay.simTimestamp],
  );
  const environmental = pickTypes(views, ENVIRONMENTAL_TYPES);
  const energy = pickTypes(views, ENERGY_TYPES);

  const hasChannels = views.length > 0;

  return (
    <details
      data-testid="building-telemetry"
      style={{
        background: "rgba(5, 7, 17, 0.6)",
        border: "1px solid var(--color-line)",
        borderRadius: "8px",
        overflow: "hidden",
      }}
    >
      <summary
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          flexWrap: "wrap",
          padding: "0.6rem 0.75rem",
          cursor: "pointer",
          fontSize: "0.78rem",
          fontWeight: 700,
          color: "var(--color-ink-muted)",
          listStyle: "none",
        }}
      >
        <span>Building telemetry</span>
        <Badge
          label={replay.isRunning ? REPLAY_RUNNING_LABEL : REPLAY_SOURCE_LABEL}
          tone={replay.isRunning ? "info" : "warn"}
          mono
        />
        <span style={{ fontSize: "0.68rem", color: "var(--color-ink-dim)", fontWeight: 500 }}>
          Historical · not room-specific
        </span>
      </summary>

      <div
        style={{
          padding: "0.75rem",
          borderTop: "1px solid var(--color-line)",
          display: "flex",
          flexDirection: "column",
          gap: "0.7rem",
        }}
      >
        <p style={noteStyle}>
          Historical readings replayed from the building dataset. Every channel
          is building/channel-level — its physical room is unresolved, so these
          values are <strong>not</strong> attributed to this or any room, and
          they are never live IoT readings.
        </p>

        <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
          {replay.isRunning ? (
            <button type="button" onClick={() => void replay.pause()} style={btn}>
              Pause replay
            </button>
          ) : (
            <button type="button" onClick={() => void replay.start()} style={btn}>
              Start replay
            </button>
          )}
          <button type="button" onClick={() => void replay.reset()} style={btn}>
            Reset
          </button>
          <label style={{ display: "flex", alignItems: "center", gap: "0.3rem", fontSize: "0.72rem", color: "var(--color-ink-dim)" }}>
            Speed
            <select
              value={replay.speed}
              onChange={(e) => void replay.setSpeed(Number(e.target.value))}
              style={{
                background: "var(--color-panel-3)",
                color: "var(--color-ink)",
                border: "1px solid var(--color-line)",
                borderRadius: "6px",
                fontSize: "0.72rem",
                padding: "0.15rem 0.3rem",
              }}
            >
              {SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s}×
                </option>
              ))}
            </select>
          </label>
        </div>

        <div style={{ fontSize: "0.7rem", color: "var(--color-ink-dim)" }}>
          {replay.simTimestamp ? `Replay time ${replay.simTimestamp} · ` : ""}
          {replay.readingsCount} readings replayed
        </div>

        {!hasChannels ? (
          <div style={{ fontSize: "0.75rem", color: "var(--color-ink-dim)", fontStyle: "italic" }}>
            {UNAVAILABLE_LABEL} — start the replay to stream building channels.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <div>
              <div style={groupLabel}>Environment (building-wide)</div>
              {environmental.length > 0 ? (
                environmental.map((v) => <MeasurementRow key={v.measurement_type} view={v} />)
              ) : (
                <div style={emptyRow}>No environmental channels in the current replay window.</div>
              )}
            </div>
            <div>
              <div style={groupLabel}>Energy (building-wide)</div>
              {energy.length > 0 ? (
                energy.map((v) => <MeasurementRow key={v.measurement_type} view={v} />)
              ) : (
                <div style={emptyRow}>
                  {UNAVAILABLE_LABEL} — no measured energy channel in the dataset.
                </div>
              )}
            </div>
          </div>
        )}

        {replay.state?.location_note && (
          <p style={{ ...noteStyle, fontSize: "0.66rem" }}>{replay.state.location_note}</p>
        )}
      </div>
    </details>
  );
}

const btn: CSSProperties = {
  background: "transparent",
  border: "1px solid var(--color-line)",
  color: "var(--color-ink-muted)",
  borderRadius: "8px",
  padding: "0.35rem 0.65rem",
  fontSize: "0.72rem",
  cursor: "pointer",
};

const noteStyle: CSSProperties = {
  margin: 0,
  fontSize: "0.7rem",
  color: "var(--color-ink-dim)",
  lineHeight: 1.5,
};

const groupLabel: CSSProperties = {
  fontSize: "0.68rem",
  fontWeight: 700,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--color-ink-dim)",
  marginBottom: "0.15rem",
};

const emptyRow: CSSProperties = {
  fontSize: "0.72rem",
  color: "var(--color-ink-dim)",
  fontStyle: "italic",
};
