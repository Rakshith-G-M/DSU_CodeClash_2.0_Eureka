// RoomAnalysis — the integrated, room-scoped GenAI surface.
//
// Rendered inside the Digital Twin space inspector, so the AI analysis is
// available in the same room workflow as the occupancy monitor and the
// rule-based insights. It analyses the room the operator is already looking at
// — the operator never has to restate the problem in a separate chat window.
//
// Design contract:
//   * The component sends only the room id, an explicitly-associated camera
//     observation (when one exists) and a material state fingerprint. The
//     backend resolves every room value (capacity, IFC design, telemetry) from
//     its own authoritative datapack.
//   * The deterministic room status is computed by the app and shown separately;
//     the model may explain it but can never change it.
//   * Occupancy/status changes trigger a *throttled* re-analysis (debounce +
//     minimum refresh + dedup + cooldown), and a late response for a room the
//     operator has left is discarded.
//   * States are explicit: not analysed / scheduled / analysing / current /
//     stale / failed (with retry).

import { useCallback, useState } from "react";
import { useVision } from "../vision/visionContext";
import type { RoomStatus } from "../lib/roomStatus";
import type { AiResponse, AiConversationTurn } from "../api/types";
import { Badge, LoadingState } from "../components/common";
import {
  IconAlert,
  IconRefresh,
  IconSend,
  IconSparkles,
} from "../components/icons";
import {
  causeStatusLabel,
  causeStatusTone,
  provenanceLabel,
  provenanceTone,
  roomStatusLevelLabel,
} from "./presentation";
import { RecommendationList } from "./RecommendationList";
import { useRoomIntelligence } from "./useRoomIntelligence";
import type { RoomTurn } from "./useRoomIntelligence";
import type { AiAnalysisPhase } from "./roomIntelligence";
import type { Tone } from "../lib/format";

// A single, compact status pill so the operator can see at a glance whether the
// shown analysis is current, pending, stale or failed — without repeating the
// same warning in several places.
const PHASE_STATUS: Record<AiAnalysisPhase, { label: string; tone: Tone }> = {
  NOT_ANALYZED: { label: "Not analysed", tone: "dim" },
  SCHEDULED: { label: "Scheduling…", tone: "info" },
  ANALYZING: { label: "Analyzing…", tone: "info" },
  CURRENT: { label: "Current", tone: "ok" },
  STALE: { label: "Refresh needed", tone: "warn" },
  FAILED: { label: "Failed", tone: "danger" },
};

const SUGGESTED_QUESTIONS = [
  "What is happening in this room right now?",
  "Should we be concerned about the current occupancy?",
  "What should we check or measure next?",
  "What evidence supports this assessment?",
  "What data is missing for this room?",
];

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: "0.68rem",
        fontWeight: 800,
        letterSpacing: "0.05em",
        textTransform: "uppercase",
        color: "var(--color-ink-dim)",
        margin: "1rem 0 0.4rem",
      }}
    >
      {children}
    </div>
  );
}

function Notice({
  tone,
  testId,
  children,
}: {
  tone: "warn" | "info" | "danger";
  testId?: string;
  children: React.ReactNode;
}) {
  const palette =
    tone === "warn"
      ? { bg: "rgba(245, 158, 11, 0.08)", border: "rgba(245, 158, 11, 0.3)" }
      : tone === "danger"
        ? { bg: "rgba(244, 63, 94, 0.08)", border: "rgba(244, 63, 94, 0.3)" }
        : { bg: "rgba(79, 176, 138, 0.08)", border: "rgba(79, 176, 138, 0.3)" };
  return (
    <div
      data-testid={testId}
      style={{
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        borderRadius: "10px",
        padding: "0.65rem 0.8rem",
        fontSize: "0.8rem",
        lineHeight: 1.55,
        color: "var(--color-ink-muted)",
        marginTop: "0.55rem",
      }}
    >
      {children}
    </div>
  );
}

function RetryButton({ onClick, label = "Retry" }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      data-testid="room-ai-retry"
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.4rem",
        padding: "0.38rem 0.7rem",
        borderRadius: "8px",
        border: "1px solid var(--color-line)",
        background: "var(--color-panel-3)",
        color: "var(--color-ink)",
        fontWeight: 600,
        fontSize: "0.76rem",
        cursor: "pointer",
      }}
    >
      <IconRefresh size={13} />
      {label}
    </button>
  );
}

/** A compact, honest summary of the room state the analysis is based on. */
function BasedOnFootnote({ response, status }: { response: AiResponse; status: RoomStatus | null }) {
  const based = response.based_on;
  if (!based) return null;
  const parts: string[] = [];
  parts.push(`Status: ${roomStatusLevelLabel(based.status_level ?? "UNKNOWN")}`);
  if (based.occupancy_count !== null) {
    parts.push(
      `Camera occupancy ${based.occupancy_count}${based.occupancy_is_demo ? " (DEMO estimate)" : ""}`,
    );
  } else {
    parts.push("No camera occupancy");
  }
  if (based.occupancy_stale) parts.push("occupancy reading stale");
  if (status?.issue) parts.push(`${status.issue.count} rule-based issue(s)`);
  return (
    <div
      data-testid="room-ai-based-on"
      style={{
        marginTop: "0.8rem",
        paddingTop: "0.6rem",
        borderTop: "1px solid var(--color-line)",
        fontSize: "0.7rem",
        color: "var(--color-ink-dim)",
        lineHeight: 1.5,
      }}
    >
      Based on the room state at {based.generated_at || "—"}. {parts.join(" · ")}.
    </div>
  );
}

export function RoomAnalysis({
  spaceId,
  status,
}: {
  spaceId: string;
  /** The deterministic room status for THIS room (same source as the twin). */
  status: RoomStatus | null;
}) {
  const vision = useVision();
  // A camera only contributes to this room when explicitly associated with it.
  const observedHere =
    vision.demoMapping?.space_id === spaceId ? vision.observation : null;

  // Automatic analysis is only triggered once the room has a concrete,
  // deterministic signal (an associated camera and/or a verified rule-based
  // issue). Rooms with neither still offer an explicit "Analyse this room".
  const enabled = status !== null;

  const { phase, response, error, turns, sending, isStale, retry, ask } =
    useRoomIntelligence({
      spaceId,
      status,
      observation: observedHere,
      enabled,
    });

  const [draft, setDraft] = useState("");

  const submit = useCallback(
    (raw: string) => {
      const question = raw.trim();
      if (!question || sending) return; // never allow duplicate submissions
      void ask(question);
      setDraft("");
    },
    [ask, sending],
  );

  const ok = response?.status === "OK" && !!response.answer?.trim();

  return (
    <section
      data-testid="room-ai"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
      }}
    >
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.45rem", flexWrap: "wrap" }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.4rem",
            fontSize: "0.82rem",
            fontWeight: 800,
            color: "#ffffff",
          }}
        >
          <IconSparkles size={14} color="var(--color-ok)" />
          AI room analysis
        </span>
        {response?.context && <Badge tone="info" label="Room context" />}
        <span data-testid="room-ai-status" style={{ display: "inline-flex" }}>
          <span data-testid={phase === "STALE" ? "room-ai-stale" : undefined}>
            <Badge tone={PHASE_STATUS[phase].tone} label={PHASE_STATUS[phase].label} />
          </span>
        </span>
      </div>
      <p
        style={{
          fontSize: "0.7rem",
          color: "var(--color-ink-dim)",
          margin: 0,
          lineHeight: 1.5,
        }}
      >
        Advisory only — it explains the room status shown above and never changes
        occupancy, capacity or the resolved status.
      </p>

      {/* ── Scheduled (waiting out debounce/throttle) ──────────────────── */}
      {phase === "SCHEDULED" && (
        <div data-testid="room-ai-scheduled" style={{ marginTop: "0.4rem" }}>
          <LoadingState label="Room state changed — scheduling a fresh analysis…" />
        </div>
      )}

      {/* ── Analysing ──────────────────────────────────────────────────── */}
      {phase === "ANALYZING" && !ok && (
        <div data-testid="room-ai-loading" style={{ marginTop: "0.4rem" }}>
          <LoadingState label="Analysing this room from its evidence…" />
        </div>
      )}

      {/* ── Not analysed yet ───────────────────────────────────────────── */}
      {phase === "NOT_ANALYZED" && (
        <Notice tone="info" testId="room-ai-not-analyzed">
          No camera association and no verified rule-based issue for this room, so
          no automatic analysis was scheduled. You can still analyse the room's
          design and availability.
          <div style={{ marginTop: "0.55rem" }}>
            <RetryButton onClick={retry} label="Analyse this room" />
          </div>
        </Notice>
      )}

      {/* ── Failure ────────────────────────────────────────────────────── */}
      {phase === "FAILED" && (
        <Notice tone="danger" testId="room-ai-error">
          {error ?? "The AI service could not be reached."}
          <div style={{ marginTop: "0.55rem" }}>
            <RetryButton onClick={retry} />
          </div>
        </Notice>
      )}

      {/* ── Successful analysis ────────────────────────────────────────── */}
      {ok && response && (
        <>
          <div
            data-testid="room-ai-answer"
            style={{
              fontSize: "0.86rem",
              lineHeight: 1.65,
              color: "var(--color-ink)",
              marginTop: "0.55rem",
            }}
          >
            {response.answer}
          </div>

          {response.evidence.length > 0 && (
            <details style={{ marginTop: "0.6rem" }}>
              <summary
                style={{
                  cursor: "pointer",
                  fontSize: "0.68rem",
                  fontWeight: 800,
                  letterSpacing: "0.05em",
                  textTransform: "uppercase",
                  color: "var(--color-ink-dim)",
                }}
              >
                Evidence &amp; sources ({response.evidence.length})
              </summary>
              <div
                data-testid="room-ai-evidence"
                style={{ display: "flex", flexDirection: "column", gap: "0.35rem", marginTop: "0.4rem" }}
              >
                {response.evidence.map((e, i) => (
                  <div
                    key={`${e.claim}-${i}`}
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: "0.45rem",
                      flexWrap: "wrap",
                      fontSize: "0.8rem",
                      lineHeight: 1.5,
                    }}
                  >
                    <Badge tone={provenanceTone(e.provenance)} label={provenanceLabel(e.provenance)} />
                    <span style={{ color: "var(--color-ink)" }}>{e.claim}</span>
                    {e.value && <span style={{ color: "var(--color-ink-muted)" }}>· {e.value}</span>}
                  </div>
                ))}
              </div>
            </details>
          )}

          {(response.likely_causes?.length ?? 0) > 0 && (
            <>
              <SectionHeading>Likely causes</SectionHeading>
              <div
                data-testid="room-ai-causes"
                style={{ display: "flex", flexDirection: "column", gap: "0.45rem" }}
              >
                {(response.likely_causes ?? []).map((c, i) => (
                  <div
                    key={`${c.cause}-${i}`}
                    data-testid="room-ai-cause"
                    style={{
                      borderLeft: "2px solid var(--color-line)",
                      paddingLeft: "0.6rem",
                      fontSize: "0.82rem",
                      lineHeight: 1.5,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
                      <Badge tone={causeStatusTone(c.status)} label={causeStatusLabel(c.status)} />
                      <strong style={{ color: "var(--color-ink)" }}>{c.cause}</strong>
                    </div>
                    {c.basis && (
                      <div style={{ color: "var(--color-ink-muted)", marginTop: "0.1rem" }}>
                        Based on: {c.basis}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          {response.recommendations.length > 0 && (
            <>
              <SectionHeading>Recommended actions</SectionHeading>
              <RecommendationList
                recommendations={response.recommendations}
                itemTestId="room-ai-recommendation"
                containerTestId="room-ai-recommendations"
                additionalTestId="room-ai-additional-actions"
              />
            </>
          )}

          {(response.next_checks?.length ?? 0) > 0 && (
            <>
              <SectionHeading>What to inspect or measure next</SectionHeading>
              <ul
                data-testid="room-ai-next-checks"
                style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.82rem", color: "var(--color-ink)", lineHeight: 1.65 }}
              >
                {(response.next_checks ?? []).map((check, i) => (
                  <li key={`${check}-${i}`}>{check}</li>
                ))}
              </ul>
            </>
          )}

          {(response.limitations.length > 0 || response.assumptions.length > 0) && (
            <>
              <SectionHeading>Limitations &amp; missing evidence</SectionHeading>
              <ul
                data-testid="room-ai-limitations"
                style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.8rem", color: "var(--color-ink-muted)", lineHeight: 1.65 }}
              >
                {response.limitations.map((l, i) => (
                  <li key={`limit-${i}`}>
                    <IconAlert size={12} color="var(--color-warn)" style={{ marginRight: "0.3rem", verticalAlign: "-1px" }} />
                    {l}
                  </li>
                ))}
                {response.assumptions.map((a, i) => (
                  <li key={`assume-${i}`}>
                    <IconAlert size={12} color="var(--color-ink-dim)" style={{ marginRight: "0.3rem", verticalAlign: "-1px" }} />
                    Assumption: {a}
                  </li>
                ))}
              </ul>
            </>
          )}

          <BasedOnFootnote response={response} status={status} />

          {/* ── Room-scoped follow-up conversation ─────────────────────── */}
          <SectionHeading>Ask about this room</SectionHeading>

          {turns.length > 0 && (
            <div
              data-testid="room-ai-followup-thread"
              style={{ display: "flex", flexDirection: "column", gap: "0.55rem", marginBottom: "0.6rem" }}
            >
              {turns.map((t) => (
                <TurnView key={t.id} turn={t} sending={sending} onRetry={submit} />
              ))}
            </div>
          )}

          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem", marginBottom: "0.55rem" }}>
            {SUGGESTED_QUESTIONS.map((q) => (
              <button
                key={q}
                type="button"
                data-testid="room-ai-followup-suggestion"
                disabled={sending}
                onClick={() => submit(q)}
                style={{
                  fontSize: "0.72rem",
                  padding: "0.3rem 0.55rem",
                  borderRadius: "20px",
                  border: "1px solid var(--color-line)",
                  background: "var(--color-panel-3)",
                  color: "var(--color-ink-muted)",
                  cursor: sending ? "not-allowed" : "pointer",
                  opacity: sending ? 0.6 : 1,
                }}
              >
                {q}
              </button>
            ))}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit(draft);
            }}
            style={{ display: "flex", gap: "0.45rem", alignItems: "flex-start" }}
          >
            <textarea
              data-testid="room-ai-followup-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit(draft);
                }
              }}
              rows={2}
              maxLength={2000}
              aria-label="Ask a follow-up about this room"
              placeholder="Ask a follow-up about this room…"
              style={{
                flex: 1,
                resize: "vertical",
                minHeight: "2.4rem",
                padding: "0.45rem 0.65rem",
                borderRadius: "8px",
                border: "1px solid var(--color-line)",
                background: "var(--color-panel)",
                color: "var(--color-ink)",
                fontSize: "0.82rem",
                lineHeight: 1.5,
                fontFamily: "inherit",
              }}
            />
            <button
              type="submit"
              data-testid="room-ai-followup-send"
              disabled={sending || draft.trim().length === 0}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.35rem",
                padding: "0.45rem 0.8rem",
                borderRadius: "8px",
                border: "1px solid rgba(79, 176, 138, 0.5)",
                background: "rgba(79, 176, 138, 0.14)",
                color: "#8fd8b8",
                fontWeight: 700,
                fontSize: "0.8rem",
                cursor: sending || draft.trim().length === 0 ? "not-allowed" : "pointer",
                opacity: sending || draft.trim().length === 0 ? 0.55 : 1,
              }}
            >
              <IconSend size={14} />
              {sending ? "Sending…" : "Ask"}
            </button>
          </form>
        </>
      )}

      {/* A stale-but-usable analysis still offers an explicit refresh. */}
      {isStale && ok && (
        <div style={{ marginTop: "0.5rem" }}>
          <RetryButton onClick={retry} label="Refresh analysis" />
        </div>
      )}

      {/* Explicit refresh affordance whenever we have a usable analysis. */}
      {!isStale && ok && (
        <div style={{ marginTop: "0.5rem", display: "flex", flexDirection: "column", gap: "0.3rem" }}>
          <span style={{ fontSize: "0.66rem", color: "var(--color-ink-dim)" }}>
            The analysis refreshes automatically when the room state changes materially.
          </span>
        </div>
      )}
    </section>
  );
}

function TurnView({
  turn,
  sending,
  onRetry,
}: {
  turn: RoomTurn;
  sending: boolean;
  onRetry: (q: string) => void;
}) {
  return (
    <div data-testid="room-ai-followup-turn">
      <div style={{ fontSize: "0.8rem", color: "var(--accent-cyan)", fontWeight: 700, marginBottom: "0.15rem" }}>
        {turn.question}
      </div>
      {turn.error ? (
        <div data-testid="room-ai-followup-error" style={{ fontSize: "0.8rem", lineHeight: 1.55, color: "var(--color-warn)" }}>
          {turn.error}
          <div style={{ marginTop: "0.35rem" }}>
            <button
              type="button"
              data-testid="room-ai-followup-retry"
              disabled={sending}
              onClick={() => onRetry(turn.question)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.3rem",
                padding: "0.28rem 0.55rem",
                borderRadius: "8px",
                border: "1px solid var(--color-line)",
                background: "var(--color-panel-3)",
                color: "var(--color-ink)",
                fontWeight: 600,
                fontSize: "0.72rem",
                cursor: sending ? "not-allowed" : "pointer",
                opacity: sending ? 0.6 : 1,
              }}
            >
              <IconRefresh size={12} />
              Retry
            </button>
          </div>
        </div>
      ) : (
        <div
          data-testid="room-ai-followup-answer"
          style={{ fontSize: "0.82rem", lineHeight: 1.6, color: "var(--color-ink)", whiteSpace: "pre-wrap" }}
        >
          {turn.answer?.answer}
        </div>
      )}
    </div>
  );
}

// Re-exported for tests that want to build history payloads.
export type { RoomTurn, AiConversationTurn };
