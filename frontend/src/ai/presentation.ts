// Green Twin assistant — presentation helpers.
//
// Pure functions mapping the AI response vocabulary (provenance categories,
// impact status, error codes) to human labels and tones. Kept separate from the
// components so the honesty labelling is unit-testable.

import type {
  AiCauseStatus,
  AiImpactStatus,
  AiProvenanceKind,
  AiRecommendation,
  AiStatus,
} from "../api/types";
import type { Tone } from "../lib/format";

// ── Provenance (data category) labelling ─────────────────────────────────────
// The product's honesty contract: every figure carries a stated origin. These
// labels are shown next to evidence chips so a historical replay is never read
// as a live reading, and an IFC design value is never read as a measurement.
export const PROVENANCE_LABELS: Record<AiProvenanceKind, string> = {
  VERIFIED_SENSOR: "Verified sensor",
  WEBCAM_ESTIMATE: "Webcam estimate",
  SAMPLE_SIMULATION: "Sample / simulated",
  HISTORICAL_REPLAY: "Historical replay",
  IFC_DESIGN: "IFC design spec",
  PREDICTION: "Prediction",
  RULE_BASED: "Rule-based",
  UNAVAILABLE: "Not available",
};

const PROVENANCE_TONES: Record<AiProvenanceKind, Tone> = {
  VERIFIED_SENSOR: "ok",
  WEBCAM_ESTIMATE: "warn",
  SAMPLE_SIMULATION: "warn",
  HISTORICAL_REPLAY: "info",
  IFC_DESIGN: "info",
  PREDICTION: "warn",
  RULE_BASED: "dim",
  UNAVAILABLE: "dim",
};

export function provenanceLabel(kind: AiProvenanceKind): string {
  return PROVENANCE_LABELS[kind] ?? PROVENANCE_LABELS.UNAVAILABLE;
}

export function provenanceTone(kind: AiProvenanceKind): Tone {
  return PROVENANCE_TONES[kind] ?? "dim";
}

/** True when a provenance category is an estimate / non-measured figure. */
export function provenanceIsEstimate(kind: AiProvenanceKind): boolean {
  return (
    kind === "WEBCAM_ESTIMATE" ||
    kind === "SAMPLE_SIMULATION" ||
    kind === "PREDICTION"
  );
}

// ── Impact status labelling ──────────────────────────────────────────────────
// Sustainability recommendations must state whether an impact is measured,
// calculated, estimated, qualitative or unknown. UNKNOWN is rendered as an
// explicit "not verified" so no saving is implied.
export const IMPACT_LABELS: Record<AiImpactStatus, string> = {
  MEASURED: "Measured outcome",
  CALCULATED: "Calculated (model)",
  ESTIMATED: "Estimated",
  QUALITATIVE: "Qualitative direction only",
  UNKNOWN: "Unknown — not verified",
};

const IMPACT_TONES: Record<AiImpactStatus, Tone> = {
  MEASURED: "ok",
  CALCULATED: "info",
  ESTIMATED: "warn",
  QUALITATIVE: "info",
  UNKNOWN: "dim",
};

export function impactLabel(status: AiImpactStatus): string {
  return IMPACT_LABELS[status] ?? IMPACT_LABELS.UNKNOWN;
}

export function impactTone(status: AiImpactStatus): Tone {
  return IMPACT_TONES[status] ?? "dim";
}

// ── Likely-cause labelling ───────────────────────────────────────────────────
// The backend only lets a cause be CONFIRMED when the data actually confirms
// it, so the UI can render the distinction without second-guessing it. The
// common case is HYPOTHESIS: something to investigate, not a proven fact.
export const CAUSE_STATUS_LABELS: Record<AiCauseStatus, string> = {
  CONFIRMED: "Confirmed by data",
  HYPOTHESIS: "Hypothesis — to verify",
  UNKNOWN: "Unconfirmed",
};

const CAUSE_STATUS_TONES: Record<AiCauseStatus, Tone> = {
  CONFIRMED: "ok",
  HYPOTHESIS: "warn",
  UNKNOWN: "dim",
};

export function causeStatusLabel(status: AiCauseStatus): string {
  return CAUSE_STATUS_LABELS[status] ?? CAUSE_STATUS_LABELS.UNKNOWN;
}

export function causeStatusTone(status: AiCauseStatus): Tone {
  return CAUSE_STATUS_TONES[status] ?? "dim";
}

// ── Recommendation priority labelling ───────────────────────────────────────
export const PRIORITY_LABELS: Record<string, string> = {
  HIGH: "High priority",
  MEDIUM: "Medium priority",
  LOW: "Low priority",
};

/** Human priority label, or null when the model did not state one. */
export function priorityLabel(priority: string | null | undefined): string | null {
  const key = (priority ?? "").trim().toUpperCase();
  return PRIORITY_LABELS[key] ?? null;
}

export function priorityTone(priority: string | null | undefined): Tone {
  switch ((priority ?? "").trim().toUpperCase()) {
    case "HIGH":
      return "danger";
    case "MEDIUM":
      return "warn";
    case "LOW":
      return "info";
    default:
      return "dim";
  }
}

// ── Recommendation confidence labelling ─────────────────────────────────────
/** Short confidence label, or null when the model stated no usable value. */
export function confidenceLabel(confidence: string | null | undefined): string | null {
  switch ((confidence ?? "").trim().toUpperCase()) {
    case "HIGH":
      return "High confidence";
    case "MEDIUM":
      return "Medium confidence";
    case "LOW":
      return "Low confidence";
    default:
      return null;
  }
}

export function confidenceTone(confidence: string | null | undefined): Tone {
  switch ((confidence ?? "").trim().toUpperCase()) {
    case "HIGH":
      return "ok";
    case "MEDIUM":
      return "info";
    case "LOW":
      return "warn";
    default:
      return "dim";
  }
}

// ── Recommendation ordering ──────────────────────────────────────────────────
const PRIORITY_RANK: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/** Highest priority first; equal priorities keep the model's original order. */
export function byPriority(recs: AiRecommendation[]): AiRecommendation[] {
  return recs
    .map((rec, index) => ({ rec, index }))
    .sort((a, b) => {
      const ra = PRIORITY_RANK[(a.rec.priority ?? "").toUpperCase()] ?? 3;
      const rb = PRIORITY_RANK[(b.rec.priority ?? "").toUpperCase()] ?? 3;
      return ra - rb || a.index - b.index;
    })
    .map((entry) => entry.rec);
}

// ── Assistant status / errors ────────────────────────────────────────────────
/** Short, user-facing copy for a non-OK assistant response. */
export function aiStatusMessage(status: AiStatus, message?: string | null): string {
  if (message && message.trim()) return message;
  switch (status) {
    case "NOT_CONFIGURED":
      return "The AI assistant is not configured. Set OPENROUTER_API_KEY on the backend to enable it.";
    case "RATE_LIMITED":
      return "The AI model is rate-limited right now. Please try again shortly.";
    case "QUOTA_EXHAUSTED":
      return "The free AI quota is exhausted. It may recover later.";
    case "TIMEOUT":
      return "The AI model took too long to respond. Please try again.";
    case "PROVIDER_ERROR":
      return "The AI provider is temporarily unavailable. The rest of the application keeps working.";
    case "MALFORMED":
      return "The AI model returned an answer that could not be validated, so it was not shown.";
    case "INVALID_INPUT":
      return "That request could not be processed. Please rephrase and try again.";
    default:
      return "The AI service is unavailable.";
  }
}

export function aiStatusIsUnavailable(status: AiStatus): boolean {
  return status !== "OK";
}

/** Human label for the deterministic room-status level (mirrors the twin). */
export const ROOM_STATUS_LEVEL_LABELS: Record<string, string> = {
  UNKNOWN: "Unknown",
  NORMAL: "Normal",
  WARNING: "Warning",
  OVER_CAPACITY: "Over capacity",
  CRITICAL: "Critical",
};

export function roomStatusLevelLabel(level: string): string {
  return ROOM_STATUS_LEVEL_LABELS[level] ?? level;
}

/** Plain-language scope label for the context chip. */
export function scopeLabel(scope: "BUILDING" | "ROOM" | "FINDING"): string {
  if (scope === "FINDING") return "Finding context";
  return scope === "ROOM" ? "Room context" : "Building context";
}
