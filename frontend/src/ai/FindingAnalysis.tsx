// Green Twin — AI analysis for ONE diagnostic finding.
//
// This is the integrated GenAI surface: it is rendered inside the Sustainability
// Insights finding detail page and analyses the finding that is already open, so
// the operator never has to restate the problem in a separate chat window.
//
// Design contract:
//   * the component only ever sends the finding ID — the backend resolves all
//     measurements from its own datapack, so the model is grounded in the same
//     authoritative data the page shows;
//   * follow-up questions are bound to this finding and this finding only
//     (`key={findingId}` on the parent resets the whole conversation);
//   * loading / empty / provider-error states are explicit, duplicate submits are
//     disabled, and failures always offer a retry;
//   * the section is advisory: nothing here can change occupancy, room status,
//     geometry, mappings or measured values.

import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type {
  AiConversationTurn,
  AiResponse,
} from "../api/types";
import { Badge, LoadingState } from "../components/common";
import {
  IconAlert,
  IconRefresh,
  IconSend,
  IconSparkles,
} from "../components/icons";
import {
  aiStatusIsUnavailable,
  aiStatusMessage,
  causeStatusLabel,
  causeStatusTone,
  impactLabel,
  provenanceLabel,
  provenanceTone,
  scopeLabel,
} from "./presentation";
import { RecommendationList } from "./RecommendationList";

// Compact follow-ups relevant to a diagnostic finding.
const SUGGESTED_QUESTIONS = [
  "What should we inspect first?",
  "How can we verify the issue is resolved?",
  "What evidence supports this diagnosis?",
  "What could be the likely cause of this issue?",
  "How does this issue affect sustainability performance?",
];

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: "0.72rem",
        fontWeight: 800,
        letterSpacing: "0.05em",
        textTransform: "uppercase",
        color: "var(--color-ink-dim)",
        margin: "1.15rem 0 0.45rem",
      }}
    >
      {children}
    </div>
  );
}

/** Inline callout used for unavailable / error / empty states. */
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
        padding: "0.7rem 0.85rem",
        fontSize: "0.84rem",
        lineHeight: 1.55,
        color: "var(--color-ink-muted)",
        marginTop: "0.6rem",
      }}
    >
      {children}
    </div>
  );
}

/** A prior question and its answer (or the failure that replaced it). */
interface Turn {
  id: string;
  question: string;
  answer: AiResponse | null;
  error: string | null;
}

export function FindingAnalysis({ findingId }: { findingId: string }) {
  const [response, setResponse] = useState<AiResponse | null>(null);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  // NOTE: the parent mounts this section with `key={findingId}`, so switching
  // findings remounts it and starts from a clean conversation. This effect only
  // runs the automatic analysis (and re-runs it on retry).
  useEffect(() => {
    let alive = true;

    api
      .aiFinding({ finding_id: findingId })
      .then((res) => {
        if (!alive) return;
        setNetworkError(null);
        setResponse(res);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setResponse(null);
        setNetworkError(
          err instanceof Error ? err.message : "The AI service could not be reached.",
        );
      });

    return () => {
      alive = false;
    };
  }, [findingId, attempt]);

  // Loading while nothing has come back yet for the current attempt.
  const phase: "LOADING" | "READY" | "ERROR" = networkError
    ? "ERROR"
    : response
      ? "READY"
      : "LOADING";

  const retry = useCallback(() => {
    setResponse(null);
    setNetworkError(null);
    setTurns([]);
    setDraft("");
    setSending(false);
    setAttempt((n) => n + 1);
  }, []);

  /** Send a follow-up, keeping the conversation scoped to this finding. */
  const submit = useCallback(
    async (raw: string) => {
      const question = raw.trim();
      if (!question || sending) return; // never allow duplicate submissions
      setSending(true);

      const history: AiConversationTurn[] = [
        { role: "user", content: "Analyse this diagnostic finding." },
        ...(response?.answer
          ? [{ role: "assistant" as const, content: response.answer }]
          : []),
        ...turns.flatMap(
          (t): AiConversationTurn[] => [
            { role: "user", content: t.question },
            ...(t.answer?.answer
              ? [{ role: "assistant" as const, content: t.answer.answer }]
              : []),
          ],
        ),
      ];

      try {
        const res = await api.aiFinding({
          finding_id: findingId,
          question,
          history,
        });
        const error =
          res.status !== "OK"
            ? aiStatusMessage(res.status, res.message)
            : !res.answer?.trim()
              ? "The model returned an empty response, so it was not shown."
              : null;
        setTurns((prev) => [
          ...prev,
          { id: `${prev.length + 1}-${Date.now()}`, question, answer: res, error },
        ]);
      } catch (err) {
        setTurns((prev) => [
          ...prev,
          {
            id: `${prev.length + 1}-${Date.now()}`,
            question,
            answer: null,
            error:
              err instanceof Error
                ? err.message
                : "The follow-up could not be sent. Please try again.",
          },
        ]);
      } finally {
        setSending(false);
        setDraft("");
      }
    },
    [findingId, response, sending, turns],
  );

  const config = response?.context;

  return (
    <section
      data-testid="finding-analysis"
      style={{
        marginTop: "1.5rem",
        background: "var(--color-panel-2)",
        border: "1px solid var(--color-line)",
        borderRadius: "12px",
        padding: "1.1rem 1.2rem",
      }}
    >
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.55rem",
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.45rem",
            fontSize: "0.95rem",
            fontWeight: 800,
            color: "#ffffff",
          }}
        >
          <IconSparkles size={16} color="var(--color-ok)" />
          AI Analysis &amp; Recommended Actions
        </span>
        {config && (
          <>
            <Badge tone="info" label={scopeLabel(config.scope)} />
            <Badge
              tone={config.sensor_location_mapping === "UNRESOLVED" ? "warn" : "ok"}
              label={
                config.sensor_location_mapping === "UNRESOLVED"
                  ? "Sensor-to-room mapping unresolved"
                  : "Sensor-to-room mapping verified"
              }
            />
          </>
        )}
      </div>
      <p
        style={{
          fontSize: "0.78rem",
          color: "var(--color-ink-dim)",
          margin: "0.3rem 0 0",
          lineHeight: 1.5,
        }}
      >
        Generated from this finding's own evidence — advisory only, nothing is applied
        automatically.
      </p>

      {/* ── Loading ────────────────────────────────────────────────────── */}
      {phase === "LOADING" && (
        <div data-testid="finding-analysis-loading" style={{ marginTop: "0.9rem" }}>
          <LoadingState label="Analysing this finding from the available evidence…" />
        </div>
      )}

      {/* ── Network / API failure ──────────────────────────────────────── */}
      {phase === "ERROR" && (
        <Notice tone="danger" testId="finding-analysis-error">
          {networkError ?? "The AI service could not be reached."}
          <div style={{ marginTop: "0.6rem" }}>
            <RetryButton onClick={retry} />
          </div>
        </Notice>
      )}

      {/* ── Provider not configured / rate limited / malformed, etc. ───── */}
      {phase === "READY" &&
        response &&
        aiStatusIsUnavailable(response.status) && (
          <Notice tone="warn" testId="finding-analysis-unavailable">
            {aiStatusMessage(response.status, response.message)}
            <div style={{ marginTop: "0.6rem" }}>
              <RetryButton onClick={retry} />
            </div>
          </Notice>
        )}

      {/* ── Successful analysis ────────────────────────────────────────── */}
      {phase === "READY" && response && response.status === "OK" && (
        <>
          {response.answer ? (
            <div
              data-testid="finding-diagnosis"
              style={{
                fontSize: "0.92rem",
                lineHeight: 1.65,
                color: "var(--color-ink)",
                marginTop: "0.85rem",
              }}
            >
              {response.answer}
            </div>
          ) : (
            <Notice tone="info" testId="finding-analysis-empty">
              The model returned no grounded analysis for this finding. The
              deterministic findings on this page remain the source of truth.
              <div style={{ marginTop: "0.6rem" }}>
                <RetryButton onClick={retry} />
              </div>
            </Notice>
          )}

          {/* Evidence — collapsed by default so the diagnosis stays quiet; the
              detail is one click away. */}
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
                data-testid="finding-evidence"
                style={{ display: "flex", flexDirection: "column", gap: "0.4rem", marginTop: "0.4rem" }}
              >
                {response.evidence.map((e, i) => (
                  <div
                    key={`${e.claim}-${i}`}
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: "0.5rem",
                      flexWrap: "wrap",
                      fontSize: "0.85rem",
                      lineHeight: 1.55,
                    }}
                  >
                    <Badge
                      tone={provenanceTone(e.provenance)}
                      label={provenanceLabel(e.provenance)}
                    />
                    <span style={{ color: "var(--color-ink)" }}>{e.claim}</span>
                    {e.value && (
                      <span style={{ color: "var(--color-ink-muted)" }}>· {e.value}</span>
                    )}
                    {e.source && (
                      <span
                        style={{
                          fontSize: "0.74rem",
                          color: "var(--color-ink-dim)",
                        }}
                      >
                        ({e.source})
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </details>
          )}

          {/* Likely causes — hypotheses unless confirmed by data */}
          {(response.likely_causes?.length ?? 0) > 0 && (
            <>
              <SectionHeading>Likely causes</SectionHeading>
              <div
                data-testid="finding-causes"
                style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}
              >
                {(response.likely_causes ?? []).map((c, i) => (
                  <div
                    key={`${c.cause}-${i}`}
                    data-testid="finding-cause"
                    style={{
                      borderLeft: "2px solid var(--color-line)",
                      paddingLeft: "0.7rem",
                      fontSize: "0.87rem",
                      lineHeight: 1.55,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.45rem",
                        flexWrap: "wrap",
                      }}
                    >
                      <Badge
                        tone={causeStatusTone(c.status)}
                        label={causeStatusLabel(c.status)}
                      />
                      <strong style={{ color: "var(--color-ink)" }}>{c.cause}</strong>
                    </div>
                    {c.basis && (
                      <div style={{ color: "var(--color-ink-muted)", marginTop: "0.15rem" }}>
                        Based on: {c.basis}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Recommended actions, ordered by priority (primary action first) */}
          {response.recommendations.length > 0 && (
            <>
              <SectionHeading>Recommended actions</SectionHeading>
              <RecommendationList
                recommendations={response.recommendations}
                itemTestId="finding-recommendation"
                containerTestId="finding-recommendations"
                additionalTestId="finding-additional-actions"
              />
            </>
          )}

          {/* What to inspect / measure next */}
          {(response.next_checks?.length ?? 0) > 0 && (
            <>
              <SectionHeading>What to inspect or measure next</SectionHeading>
              <ul
                data-testid="finding-next-checks"
                style={{
                  margin: 0,
                  paddingLeft: "1.1rem",
                  fontSize: "0.86rem",
                  color: "var(--color-ink)",
                  lineHeight: 1.7,
                }}
              >
                {(response.next_checks ?? []).map((check, i) => (
                  <li key={`${check}-${i}`}>{check}</li>
                ))}
              </ul>
            </>
          )}

          {/* Expected impact — only when the data supports it */}
          <SectionHeading>Expected impact</SectionHeading>
          <div data-testid="finding-impact" style={{ fontSize: "0.85rem", lineHeight: 1.6 }}>
            {(() => {
              const quantified = response.recommendations.filter(
                (r) => r.impact_status !== "UNKNOWN" && r.expected_impact_direction,
              );
              if (quantified.length > 0) {
                return (
                  <ul
                    style={{
                      margin: 0,
                      paddingLeft: "1.1rem",
                      color: "var(--color-ink-muted)",
                    }}
                  >
                    {quantified.map((r, i) => (
                      <li key={`${r.title}-${i}`}>
                        {r.title} — {r.expected_impact_direction} ·{" "}
                        {impactLabel(r.impact_status)}
                      </li>
                    ))}
                  </ul>
                );
              }
              return (
                <span style={{ color: "var(--color-ink-dim)" }}>
                  The available data does not support a quantified sustainability or cost
                  impact for this finding, so none is claimed.
                </span>
              );
            })()}
          </div>

          {/* Limitations & missing evidence */}
          {(response.limitations.length > 0 || response.assumptions.length > 0) && (
            <>
              <SectionHeading>Limitations &amp; missing evidence</SectionHeading>
              <ul
                data-testid="finding-limitations"
                style={{
                  margin: 0,
                  paddingLeft: "1.1rem",
                  fontSize: "0.84rem",
                  color: "var(--color-ink-muted)",
                  lineHeight: 1.7,
                }}
              >
                {response.limitations.map((l, i) => (
                  <li key={`limit-${i}`}>
                    <IconAlert
                      size={12}
                      color="var(--color-warn)"
                      style={{ marginRight: "0.3rem", verticalAlign: "-1px" }}
                    />
                    {l}
                  </li>
                ))}
                {response.assumptions.map((a, i) => (
                  <li key={`assume-${i}`}>
                    <IconAlert
                      size={12}
                      color="var(--color-ink-dim)"
                      style={{ marginRight: "0.3rem", verticalAlign: "-1px" }}
                    />
                    Assumption: {a}
                  </li>
                ))}
              </ul>
            </>
          )}

          {/* ── Issue-scoped follow-up conversation ────────────────────── */}
          <SectionHeading>Ask about this finding</SectionHeading>

          {turns.length > 0 && (
            <div
              data-testid="finding-followup-thread"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.6rem",
                marginBottom: "0.7rem",
              }}
            >
              {turns.map((t) => (
                <div key={t.id} data-testid="finding-followup-turn">
                  <div
                    style={{
                      fontSize: "0.85rem",
                      color: "var(--accent-cyan)",
                      fontWeight: 700,
                      marginBottom: "0.2rem",
                    }}
                  >
                    {t.question}
                  </div>
                  {t.error ? (
                    <div
                      data-testid="finding-followup-error"
                      style={{
                        fontSize: "0.84rem",
                        lineHeight: 1.6,
                        color: "var(--color-warn)",
                      }}
                    >
                      {t.error}
                      <div style={{ marginTop: "0.4rem" }}>
                        <button
                          type="button"
                          data-testid="finding-followup-retry"
                          disabled={sending}
                          onClick={() => void submit(t.question)}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "0.35rem",
                            padding: "0.3rem 0.6rem",
                            borderRadius: "8px",
                            border: "1px solid var(--color-line)",
                            background: "var(--color-panel-3)",
                            color: "var(--color-ink)",
                            fontWeight: 600,
                            fontSize: "0.76rem",
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
                      data-testid="finding-followup-answer"
                      style={{
                        fontSize: "0.87rem",
                        lineHeight: 1.65,
                        color: "var(--color-ink)",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {t.answer?.answer}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Suggested follow-ups */}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "0.4rem",
              marginBottom: "0.6rem",
            }}
          >
            {SUGGESTED_QUESTIONS.map((q) => (
              <button
                key={q}
                type="button"
                data-testid="finding-followup-suggestion"
                disabled={sending}
                onClick={() => void submit(q)}
                style={{
                  fontSize: "0.76rem",
                  padding: "0.32rem 0.6rem",
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

          {/* Follow-up input */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit(draft);
            }}
            style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}
          >
            <textarea
              data-testid="finding-followup-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void submit(draft);
                }
              }}
              rows={2}
              maxLength={2000}
              aria-label="Ask a follow-up about this finding"
              placeholder="Ask a follow-up about this finding…"
              style={{
                flex: 1,
                resize: "vertical",
                minHeight: "2.6rem",
                padding: "0.5rem 0.7rem",
                borderRadius: "8px",
                border: "1px solid var(--color-line)",
                background: "var(--color-panel)",
                color: "var(--color-ink)",
                fontSize: "0.86rem",
                lineHeight: 1.5,
                fontFamily: "inherit",
              }}
            />
            <button
              type="submit"
              data-testid="finding-followup-send"
              disabled={sending || draft.trim().length === 0}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.4rem",
                padding: "0.5rem 0.85rem",
                borderRadius: "8px",
                border: "1px solid rgba(79, 176, 138, 0.5)",
                background: "rgba(79, 176, 138, 0.14)",
                color: "#8fd8b8",
                fontWeight: 700,
                fontSize: "0.82rem",
                cursor:
                  sending || draft.trim().length === 0 ? "not-allowed" : "pointer",
                opacity: sending || draft.trim().length === 0 ? 0.55 : 1,
              }}
            >
              <IconSend size={14} />
              {sending ? "Sending…" : "Ask"}
            </button>
          </form>
        </>
      )}
    </section>
  );
}

function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid="finding-retry"
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.4rem",
        padding: "0.4rem 0.7rem",
        borderRadius: "8px",
        border: "1px solid var(--color-line)",
        background: "var(--color-panel-3)",
        color: "var(--color-ink)",
        fontWeight: 600,
        fontSize: "0.78rem",
        cursor: "pointer",
      }}
    >
      <IconRefresh size={13} />
      Retry
    </button>
  );
}
