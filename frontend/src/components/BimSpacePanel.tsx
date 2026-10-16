// Room overview for a selected IFC space.
//
// Hierarchy:
//   1. Header            — room name + floor (no raw identifiers).
//   2. Occupancy         — primary: camera controls + live estimate.
//   3. Room conditions   — temperature/humidity/CO₂/PM2.5, or an honest
//                          plain-language unavailable state (no verified
//                          sensor→room mapping exists in this data release).
//   4. Room details      — a few populated BIM values only.
//   5. Room insights     — rule-based recommendations for THIS room, if any.
//   6. AI room analysis  — advisory GenAI grounded in this room's evidence.
//   7. Building telemetry— collapsed, clearly secondary, historical and NOT
//                          room-specific.
//   8. Building specs    — collapsed design/specification values (zero/missing
//                          treated as "not specified", never as absence).
//   9. Technical details — collapsed IFC identifiers for debugging.
//
// Everything from an internal identifier to schema/implementation detail stays
// behind the collapsed sections so the default view is readable.

import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../hooks/useApi";
import { api } from "../api";
import {
  fmtArea,
  fmtNum,
  fmtVolume,
  formatStoreyName,
  formatSpaceRoomName,
  getSpaceMeta,
  toneForRecommendation,
} from "../lib/format";
import { Badge } from "./common";
import { RoomLiveMonitor } from "./vision/RoomLiveMonitor";
import { BuildingTelemetry } from "./vision/BuildingTelemetry";
import { RoomAnalysis } from "../ai/RoomAnalysis";
import { ROOM_TELEMETRY_UNMAPPED_LABEL } from "./vision/replayPresentation";
import {
  ROOM_STATUS_COLOR_HEX,
  roomStatusDetail,
  roomStatusHeadline,
  type RoomStatus,
} from "../lib/roomStatus";

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "0.625rem",
        padding: "0.4rem 0",
        borderBottom: "1px solid rgba(30,47,66,0.4)",
        fontSize: "0.78rem",
      }}
    >
      <span style={{ color: "var(--color-ink-dim)", flexShrink: 0 }}>{label}</span>
      <span style={{ textAlign: "right", color: "var(--color-ink)" }}>{value}</span>
    </div>
  );
}

function SectionCard({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section
      style={{
        background: "rgba(5, 7, 17, 0.6)",
        border: "1px solid var(--color-line)",
        borderRadius: "8px",
        padding: "0.65rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.6rem",
      }}
    >
      <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "0.5rem" }}>
        <span
          style={{
            fontSize: "0.7rem",
            fontWeight: 800,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            color: "var(--color-ink-muted)",
          }}
        >
          {title}
        </span>
        {hint && <span style={{ fontSize: "0.65rem", color: "var(--color-ink-dim)" }}>{hint}</span>}
      </header>
      {children}
    </section>
  );
}

const DESIGN_LABELS: Array<{ key: string; label: string; unit: string }> = [
  { key: "lighting_design_load_w", label: "Lighting design load", unit: "W" },
  { key: "lighting_design_load_w_per_area", label: "Lighting intensity", unit: "W/m²" },
  { key: "power_design_load_w", label: "Power design load", unit: "W" },
  { key: "power_design_load_w_per_area", label: "Power intensity", unit: "W/m²" },
  { key: "illumination_lx", label: "Average illumination", unit: "lx" },
  { key: "design_cooling_load_w", label: "Design cooling load", unit: "W" },
  { key: "design_heating_load_w", label: "Design heating load", unit: "W" },
  { key: "air_changes_per_hour", label: "Air changes", unit: "/h" },
  { key: "design_occupancy_people", label: "Design occupancy", unit: "people" },
  { key: "area_per_person_m2", label: "Area per person", unit: "m²/person" },
];

/**
 * Design/specification values from the IFC model. Zero or missing values are
 * shown as "Not specified" — they mean the property is not published in the
 * model, not that the equipment or service is absent.
 */
function DesignSpecs({ spaceId }: { spaceId: string }) {
  const { state } = useApi(() => api.bimDesign(spaceId), [spaceId]);

  if (state.status === "LOADING")
    return <span style={mutedNote}>Loading specification values…</span>;
  if (state.status !== "READY")
    return <span style={mutedNote}>Specification values unavailable for this space.</span>;

  const design = state.data.design;
  const present = DESIGN_LABELS.filter((d) => design[d.key] !== undefined);
  if (present.length === 0)
    return <span style={mutedNote}>No specification values published for this space.</span>;

  return (
    <div>
      {present.map((d) => {
        const raw = design[d.key];
        const isZero = typeof raw === "number" && raw === 0;
        return (
          <Row
            key={d.key}
            label={d.label}
            value={
              isZero ? (
                <span style={{ color: "var(--color-ink-dim)", fontStyle: "italic" }}>Not specified</span>
              ) : (
                `${fmtNum(raw, 1)} ${d.unit}`
              )
            }
          />
        );
      })}
      <p style={{ ...mutedNote, marginTop: "0.5rem" }}>
        A blank or 0 value means the IFC model does not specify this property. It
        is not evidence that the equipment or service is absent.
      </p>
    </div>
  );
}

function RoomInsights({ spaceId }: { spaceId: string }) {
  const { state } = useApi(() => api.recommendations({ limit: 200 }), []);

  if (state.status === "LOADING") return <span style={mutedNote}>Checking rule-based insights…</span>;
  if (state.status === "ERROR")
    return (
      <span style={mutedNote}>
        Rule-based insights could not be loaded. The intelligence engine is
        unchanged and available on the Intelligence page.
      </span>
    );

  const matches =
    state.status === "READY"
      ? state.data.items.filter(
          (r) => r.affected_entity?.space_id === spaceId || r.location?.space_id === spaceId,
        )
      : [];

  if (matches.length === 0)
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <span style={mutedNote}>
          No rule-based recommendation is attributed to this room. Sensor→space
          mapping is unresolved, so the engine cannot assert room-level findings
          here — this is not a statement that the room is fine.
        </span>
        <Link to="/intelligence" style={{ fontSize: "0.72rem", color: "var(--accent-cyan)" }}>
          Open the Intelligence page →
        </Link>
      </div>
    );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      {matches.slice(0, 4).map((r) => (
        <div key={r.recommendation_id} style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
            <Badge label={r.priority} tone={toneForRecommendation(r.priority)} mono />
            <span style={{ fontSize: "0.72rem", color: "var(--color-ink-muted)" }}>
              {r.recommendation_category}
            </span>
          </div>
          <span style={{ fontSize: "0.75rem", color: "var(--color-ink)" }}>{r.recommended_action}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Compact status indicator. Uses the exact resolved status colour (so a
 * critical issue and an over-capacity state stay visually distinct) plus a
 * plain-language headline and supporting detail.
 */
function RoomStatusPill({ status }: { status: RoomStatus }) {
  const color = ROOM_STATUS_COLOR_HEX[status.level];
  const detail = roomStatusDetail(status);
  return (
    <div
      data-testid="room-status-pill"
      data-status-level={status.level}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.15rem",
        padding: "0.5rem 0.7rem",
        borderRadius: "8px",
        border: `1px solid ${color}66`,
        background: `${color}1f`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.45rem" }}>
        <span
          style={{
            width: "8px",
            height: "8px",
            borderRadius: "50%",
            flexShrink: 0,
            background: color,
            boxShadow: `0 0 8px ${color}99`,
          }}
        />
        <span style={{ fontSize: "0.8rem", fontWeight: 800, color }}>{roomStatusHeadline(status)}</span>
      </div>
      {detail.map((line) => (
        <span key={line} style={{ fontSize: "0.68rem", color: "var(--color-ink-dim)", lineHeight: 1.45 }}>
          {line}
        </span>
      ))}
    </div>
  );
}

export function BimSpacePanel({
  spaceId,
  spaceName,
  storey,
  storeyId,
  area,
  volume,
  height,
  capacity,
  occupiable,
  conditioning,
  ifcGlobalId,
  rawStorey,
  status = null,
}: {
  spaceId: string;
  spaceName?: string | null;
  storey: string | null;
  storeyId?: string | null;
  area: number | null;
  volume: number | null;
  height: number | null;
  capacity: number | null;
  occupiable: boolean;
  conditioning: string | null;
  ifcGlobalId?: string | null;
  rawStorey?: string | null;
  /** Resolved room status (occupancy + rule-based issues), when available. */
  status?: RoomStatus | null;
}) {
  const [showTechDetails, setShowTechDetails] = useState(false);
  const meta = getSpaceMeta(spaceId);

  const humanRoomName = formatSpaceRoomName(spaceName ?? meta?.ifcName, spaceId);
  const humanStoreyName = formatStoreyName(storey ?? meta?.storeyName);
  const effectiveGlobalId = ifcGlobalId ?? meta?.ifcGlobalId ?? spaceId.replace(/^space_/i, "");
  const effectiveRawStorey = rawStorey ?? meta?.rawStorey ?? storey ?? "—";

  const areaValue = area ?? meta?.areaM2 ?? null;
  const hasCapacity = capacity !== null && Number.isFinite(capacity) && capacity > 0;

  return (
    <div style={{ padding: "0.8rem", display: "flex", flexDirection: "column", gap: "0.7rem" }}>
      {/* Header — human room name + floor, no raw identifiers. */}
      <div>
        <div
          style={{
            fontSize: "0.68rem",
            fontWeight: 800,
            color: "var(--accent-cyan)",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          Space inspector
        </div>
        <div
          style={{
            fontSize: "1.2rem",
            fontWeight: 800,
            color: "#ffffff",
            letterSpacing: "-0.01em",
            lineHeight: 1.25,
            marginTop: "0.15rem",
          }}
        >
          {humanRoomName}
        </div>
        <div style={{ fontSize: "0.8rem", color: "var(--color-ink-muted)", marginTop: "0.2rem" }}>
          {humanStoreyName} · TalTech DS3 Ehituse Mäemaja
        </div>
      </div>

      {/* Resolved room status — same source as the 3D room mesh colouring. */}
      {status && <RoomStatusPill status={status} />}

      {/* Primary: occupancy monitoring (camera) for this room. */}
      <SectionCard title="Occupancy monitoring" hint="Camera estimate">
        <div data-testid="room-live-monitor-wrap">
          <RoomLiveMonitor spaceId={spaceId} storeyId={storeyId ?? null} />
        </div>
      </SectionCard>

      {/* Room conditions — only legitimate room-level telemetry, else honest
          unavailable state. Historical building data lives further down. */}
      <SectionCard title="Room conditions" hint="Operational telemetry">
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <Badge label={ROOM_TELEMETRY_UNMAPPED_LABEL} tone="warn" mono />
          <p style={mutedNote}>
            Temperature, humidity, CO₂ and PM2.5 are not shown because no sensor
            has a verified location in this room in the current data release.
            Building-wide history is available under{" "}
            <em>Building telemetry</em> below — it is not room-specific.
          </p>
        </div>
      </SectionCard>

      {/* Room details — a few meaningful, populated BIM values. */}
      <SectionCard title="Room details" hint="IFC model">
        <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
            <Row label="Area" value={fmtArea(areaValue)} />
            <Row label="Volume" value={fmtVolume(volume)} />
            <Row label="Height" value={height !== null ? `${fmtNum(height, 1)} m` : "Not published"} />
            <Row label="Floor" value={humanStoreyName} />
            <Row
              label="Occupiable"
              value={<Badge tone={occupiable ? "ok" : "dim"} label={occupiable ? "Yes" : "No"} mono />}
            />
            <Row label="Conditioning" value={conditioning ?? "Not specified"} />
            {hasCapacity && (
              <Row label="Design capacity" value={`${fmtNum(capacity, 1)} persons`} />
            )}
          </div>
        </div>
      </SectionCard>

      {/* Room insights — existing rule-based engine, room-scoped if possible. */}
      <SectionCard title="Room insights" hint="Rule-based">
        <RoomInsights spaceId={spaceId} />
      </SectionCard>

      {/* Room AI analysis — advisory GenAI grounded in this room's evidence.
          Triggered by meaningful occupancy/status changes; never authoritative. */}
      <SectionCard title="AI room analysis" hint="Advisory · GenAI">
        <RoomAnalysis spaceId={spaceId} status={status} />
      </SectionCard>

      {/* Secondary: building telemetry (historical, not room-specific). */}
      <BuildingTelemetry />

      {/* Collapsed: building specifications (design values). */}
      <details
        data-testid="building-specifications"
        style={{
          background: "rgba(5, 7, 17, 0.6)",
          border: "1px solid var(--color-line)",
          borderRadius: "8px",
          overflow: "hidden",
        }}
      >
        <summary style={summaryStyle}>Building specifications</summary>
        <div style={{ padding: "0.65rem 0.75rem", borderTop: "1px solid var(--color-line)" }}>
          <DesignSpecs spaceId={spaceId} />
        </div>
      </details>

      {/* Collapsed: technical details (identifiers, debugging only). */}
      <div
        style={{
          background: "rgba(5, 7, 17, 0.6)",
          border: "1px solid var(--color-line)",
          borderRadius: "8px",
          overflow: "hidden",
        }}
      >
        <button type="button" onClick={() => setShowTechDetails((v) => !v)} style={summaryButtonStyle}>
          <span>Technical details</span>
          <span>{showTechDetails ? "▲ Hide" : "▼ Expand"}</span>
        </button>

        {showTechDetails && (
          <div
            style={{
              padding: "0.65rem 0.75rem",
              borderTop: "1px solid var(--color-line)",
              fontSize: "0.72rem",
              display: "flex",
              flexDirection: "column",
              gap: "0.4rem",
              fontFamily: "var(--font-mono)",
            }}
          >
            <div style={techRow}>
              <span style={techKey}>IfcSpace ID:</span>
              <span style={techVal}>{spaceId}</span>
            </div>
            <div style={techRow}>
              <span style={techKey}>GlobalId:</span>
              <span style={techVal}>{effectiveGlobalId}</span>
            </div>
            <div style={techRow}>
              <span style={techKey}>IFC Entity:</span>
              <span style={{ color: "var(--accent-cyan)" }}>IfcSpace</span>
            </div>
            <div style={techRow}>
              <span style={techKey}>IFC Space Name:</span>
              <span style={techVal}>{spaceName ?? meta?.ifcName ?? "—"}</span>
            </div>
            <div style={techRow}>
              <span style={techKey}>Storey (Raw IFC):</span>
              <span style={techVal}>{effectiveRawStorey}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const mutedNote: React.CSSProperties = {
  margin: 0,
  fontSize: "0.72rem",
  color: "var(--color-ink-dim)",
  lineHeight: 1.5,
};

const summaryStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  padding: "0.6rem 0.75rem",
  cursor: "pointer",
  fontSize: "0.78rem",
  fontWeight: 700,
  color: "var(--color-ink-muted)",
  listStyle: "none",
};

const summaryButtonStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.55rem 0.75rem",
  background: "transparent",
  border: "none",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  cursor: "pointer",
  fontSize: "0.78rem",
  fontWeight: 600,
  color: "var(--color-ink-muted)",
  fontFamily: "var(--font-mono)",
};

const techRow: React.CSSProperties = { display: "flex", justifyContent: "space-between", gap: "0.5rem" };
const techKey: React.CSSProperties = { color: "var(--color-ink-dim)" };
const techVal: React.CSSProperties = { color: "#ffffff", wordBreak: "break-all", textAlign: "right" };
