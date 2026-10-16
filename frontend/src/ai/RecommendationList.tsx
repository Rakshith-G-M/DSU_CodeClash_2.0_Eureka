// RecommendationList — one consistent, action-first rendering of the model's
// recommendations, shared by the room and finding AI surfaces.
//
// The single most important action (highest priority; ties keep the model's own
// order) is shown prominently as the "Next action"; the rest are a compact,
// ordered list of additional steps. Every item keeps the same operational
// shape — what to do, why, and how to verify it worked — plus the model's
// self-reported priority, confidence and (unverified) impact status.
//
// This is presentation only: it never changes the recommendation content.

import type { AiRecommendation } from "../api/types";
import { Badge } from "../components/common";
import {
  byPriority,
  confidenceLabel,
  confidenceTone,
  impactLabel,
  impactTone,
  priorityLabel,
  priorityTone,
} from "./presentation";

const HEADING_STYLE: React.CSSProperties = {
  fontSize: "0.66rem",
  fontWeight: 800,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  color: "var(--color-ink-dim)",
  margin: "0.85rem 0 0.4rem",
};

function RecBadges({ rec }: { rec: AiRecommendation }) {
  const priority = priorityLabel(rec.priority);
  const confidence = confidenceLabel(rec.confidence);
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}
    >
      {priority && <Badge tone={priorityTone(rec.priority)} label={priority} />}
      {confidence && <Badge tone={confidenceTone(rec.confidence)} label={confidence} />}
      <Badge tone={impactTone(rec.impact_status)} label={impactLabel(rec.impact_status)} />
    </div>
  );
}

export function RecommendationList({
  recommendations,
  itemTestId,
  containerTestId,
  additionalTestId,
}: {
  recommendations: AiRecommendation[];
  /** testid on each rendered action (container when no containerTestId is set). */
  itemTestId: string;
  containerTestId?: string;
  additionalTestId?: string;
}) {
  const ordered = byPriority(recommendations);
  if (ordered.length === 0) return null;
  const [next, ...rest] = ordered;

  const body = (
    <>
      {/* ── Primary next action (prominent) ─────────────────────────────── */}
      <div
        data-testid={itemTestId}
        style={{
          background: "var(--color-panel-3)",
          border: "1px solid rgba(79, 176, 138, 0.45)",
          borderRadius: "10px",
          padding: "0.7rem 0.85rem",
        }}
      >
        <div
          style={{
            fontSize: "0.62rem",
            fontWeight: 800,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "var(--color-ok)",
          }}
        >
          Next action
        </div>
        <strong
          style={{
            display: "block",
            fontSize: "0.88rem",
            color: "var(--color-ink)",
            margin: "0.2rem 0 0.25rem",
          }}
        >
          {next.title}
        </strong>
        <div style={{ fontSize: "0.84rem", color: "var(--color-ink)", lineHeight: 1.55 }}>
          {next.action}
        </div>
        {next.why_relevant && (
          <div
            style={{
              fontSize: "0.79rem",
              color: "var(--color-ink-muted)",
              lineHeight: 1.5,
              marginTop: "0.3rem",
            }}
          >
            <span style={{ fontWeight: 700 }}>Why: </span>
            {next.why_relevant}
          </div>
        )}
        {next.verification && (
          <div
            style={{
              fontSize: "0.79rem",
              color: "var(--color-ink-muted)",
              lineHeight: 1.5,
              marginTop: "0.2rem",
            }}
          >
            <span style={{ fontWeight: 700 }}>Verify: </span>
            {next.verification}
          </div>
        )}
        <div style={{ marginTop: "0.5rem" }}>
          <RecBadges rec={next} />
        </div>
      </div>

      {/* ── Additional actions (compact, ordered) ───────────────────────── */}
      {rest.length > 0 && (
        <>
          <div style={HEADING_STYLE}>Additional actions</div>
          <ol
            data-testid={additionalTestId}
            style={{
              margin: 0,
              paddingLeft: "1.2rem",
              display: "flex",
              flexDirection: "column",
              gap: "0.5rem",
            }}
          >
            {rest.map((rec, i) => (
              <li
                key={`${rec.title}-${i}`}
                data-testid={itemTestId}
                style={{ fontSize: "0.84rem", lineHeight: 1.55, color: "var(--color-ink)" }}
              >
                <strong style={{ color: "var(--color-ink)" }}>{rec.title}</strong>
                <div>{rec.action}</div>
                {rec.why_relevant && (
                  <div style={{ color: "var(--color-ink-muted)" }}>
                    <span style={{ fontWeight: 700 }}>Why: </span>
                    {rec.why_relevant}
                  </div>
                )}
                {rec.verification && (
                  <div style={{ color: "var(--color-ink-muted)" }}>
                    <span style={{ fontWeight: 700 }}>Verify: </span>
                    {rec.verification}
                  </div>
                )}
                <div style={{ marginTop: "0.3rem" }}>
                  <RecBadges rec={rec} />
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
    </>
  );

  // When a container testid is supplied, the wrapper carries it; each rendered
  // action always carries `itemTestId`.
  return containerTestId ? (
    <div data-testid={containerTestId} style={{ display: "flex", flexDirection: "column" }}>
      {body}
    </div>
  ) : (
    <div style={{ display: "flex", flexDirection: "column" }}>{body}</div>
  );
}
