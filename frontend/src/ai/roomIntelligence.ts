// Room-scoped AI trigger policy — pure, dependency-free, unit-testable.
//
// This module answers one question: *when* should the operator's current room
// state trigger a new (expensive) AI analysis, and when is an already-shown
// analysis stale? It deliberately contains no React and no I/O so the exact
// trigger behaviour — debounce, dedup, minimum refresh interval, failure
// cooldown and the state-version fingerprint — can be tested in isolation.
//
// Design contract:
//   * The deterministic room status (occupancy vs capacity + rule-based issues)
//     is the authoritative signal. It is computed in `lib/roomStatus.ts` and is
//     never derived from anything the model says.
//   * A camera observation only ever contributes to *this* room's material
//     state when it is explicitly associated with it (the association lives in
//     the observation/status, never inferred here).
//   * The model is advisory: it cannot change occupancy, capacity, geometry,
//     mappings or the resolved status.

import type { RoomStatus, RoomStatusLevel } from "../lib/roomStatus";

// ──────────────────────────────────────────────────────────────────
// Material state + version fingerprint
// ──────────────────────────────────────────────────────────────────

/**
 * Every dimension of a room's situation that makes an AI analysis "materially"
 * different from the previous one. Transient noise (the exact detection
 * timestamp) is deliberately excluded so tearing/flicker cannot churn a request.
 */
export interface RoomMaterialState {
  spaceId: string;
  statusLevel: RoomStatusLevel | null;
  occupancyCount: number | null;
  capacity: number | null;
  occupancyLevel: string | null;
  occupancyStale: boolean;
  occupancyDemo: boolean;
  occupancySource: string | null;
  /** A stable signature of the rule-based issue attributed to this room. */
  issueSignature: string | null;
}

const VERSION_SCHEMA = "campusiq.room_state/v1";

/**
 * Build the material state for a room from its already-resolved deterministic
 * status. Returns null when no room is selected.
 *
 * The exact occupancy count is included. Transient flicker does not cause
 * churn because the *dwell* in the hook (`debounceMs`) only adopts a state
 * that stays stable — a value that keeps oscillating is never committed.
 */
export function buildMaterialState(
  spaceId: string | null,
  status: RoomStatus | null,
): RoomMaterialState | null {
  if (!spaceId) return null;
  const occ = status?.occupancy ?? null;
  return {
    spaceId,
    statusLevel: status?.level ?? null,
    occupancyCount: occ?.count ?? null,
    capacity: occ?.capacity ?? null,
    occupancyLevel: occ?.level ?? null,
    occupancyStale: occ?.stale ?? false,
    occupancyDemo: occ?.demo ?? false,
    occupancySource: occ?.source ?? null,
    issueSignature: status?.issue
      ? `${status.issue.level}:${status.issue.severity}:${status.issue.recommendationId}:${status.issue.count}`
      : null,
  };
}

/**
 * A stable, opaque fingerprint of a room's material state. Sent to the backend
 * as `state_version` and echoed back inside `based_on`, so the UI can tell
 * whether a shown analysis still matches the current state.
 */
export function materialStateVersion(state: RoomMaterialState | null): string | null {
  if (!state) return null;
  return [
    VERSION_SCHEMA,
    state.spaceId,
    `status:${state.statusLevel ?? "-"}`,
    `occ:${state.occupancyCount ?? "-"}`,
    `olevel:${state.occupancyLevel ?? "-"}`,
    `stale:${state.occupancyStale ? "1" : "0"}`,
    `demo:${state.occupancyDemo ? "1" : "0"}`,
    `osrc:${state.occupancySource ?? "-"}`,
    `cap:${state.capacity ?? "-"}`,
    `issue:${state.issueSignature ?? "-"}`,
  ].join("|");
}

/** True when two material states differ in any way that warrants a re-analysis. */
export function isMaterialChange(
  prev: RoomMaterialState | null,
  next: RoomMaterialState | null,
): boolean {
  return materialStateVersion(prev) !== materialStateVersion(next);
}

// ──────────────────────────────────────────────────────────────────
// Trigger policy
// ──────────────────────────────────────────────────────────────────

/** How the AI trigger is throttled. All values are milliseconds. */
export interface TriggerPolicy {
  /** A change must persist this long before it counts (absorbs flicker). */
  debounceMs: number;
  /** Minimum gap between two *automatic* analyses of the same room. */
  minRefreshMs: number;
  /** After a failure, wait this long before an automatic retry on a new change. */
  cooldownMs: number;
}

export const DEFAULT_TRIGGER_POLICY: TriggerPolicy = {
  debounceMs: 2500,
  minRefreshMs: 20000,
  cooldownMs: 8000,
};

export type ScheduleReason =
  | "MANUAL"
  | "INITIAL"
  | "MATERIAL_CHANGE"
  | "UNCHANGED";

export interface ScheduleDecision {
  schedule: boolean;
  /** Delay before the request should fire; the caller arms a timer. */
  delayMs: number;
  reason: ScheduleReason;
}

export interface ScheduleInput {
  /** The fingerprint the operator is currently looking at. */
  targetVersion: string | null;
  /** The fingerprint of the most recent attempt (success or failure). */
  lastAttemptedVersion: string | null;
  /** When that attempt started. */
  lastAttemptedAt: number | null;
  /** True when the most recent attempt failed (not configured / error / empty). */
  failed: boolean;
  /** True for an explicit user action (retry / refresh). */
  manual: boolean;
  now: number;
  policy: TriggerPolicy;
}

/**
 * Decide whether a (re)analysis should be scheduled, and after how long.
 *
 * Rules, in order:
 *   1. A manual action always schedules immediately.
 *   2. An unchanged material version never auto-schedules — this is the dedup
 *      that stops repeated identical detections re-requesting the model.
 *   3. The first state ever seen for a room schedules immediately.
 *   4. A changed state schedules after the remaining minimum-refresh interval
 *      (and, following a failure, not before the cooldown has elapsed).
 */
export function scheduleDecision(input: ScheduleInput): ScheduleDecision {
  const {
    targetVersion,
    lastAttemptedVersion,
    lastAttemptedAt,
    failed,
    manual,
    now,
    policy,
  } = input;

  if (manual) return { schedule: true, delayMs: 0, reason: "MANUAL" };
  if (targetVersion === null) return { schedule: false, delayMs: 0, reason: "UNCHANGED" };
  if (targetVersion === lastAttemptedVersion) {
    return { schedule: false, delayMs: 0, reason: "UNCHANGED" };
  }
  if (lastAttemptedVersion === null || lastAttemptedAt === null) {
    return { schedule: true, delayMs: 0, reason: "INITIAL" };
  }

  let delay = Math.max(0, policy.minRefreshMs - (now - lastAttemptedAt));
  if (failed) {
    delay = Math.max(delay, policy.cooldownMs - (now - lastAttemptedAt));
  }
  return { schedule: true, delayMs: delay, reason: "MATERIAL_CHANGE" };
}

// ──────────────────────────────────────────────────────────────────
// Analysis phase
// ──────────────────────────────────────────────────────────────────

/**
 * The operator-visible state of the room analysis.
 *
 * NOT_ANALYZED — a room is selected but no analysis has been produced yet
 * SCHEDULED    — a (re)analysis is waiting out the debounce/throttle window
 * ANALYZING    — a request is in flight
 * CURRENT      — the shown analysis matches the current room state
 * STALE        — the room state has changed since the shown analysis
 * FAILED       — the latest attempt failed; the operator can retry
 */
export type AiAnalysisPhase =
  | "NOT_ANALYZED"
  | "SCHEDULED"
  | "ANALYZING"
  | "CURRENT"
  | "STALE"
  | "FAILED";

/** Derive the phase shown to the operator from the raw hook state. */
export function derivePhase(input: {
  analyzing: boolean;
  scheduled: boolean;
  hasResponse: boolean;
  failed: boolean;
  /** True when the shown response was computed from a different state version. */
  responseIsStale: boolean;
}): AiAnalysisPhase {
  if (input.analyzing) return "ANALYZING";
  if (input.failed) return "FAILED";
  if (input.hasResponse) return input.responseIsStale ? "STALE" : "CURRENT";
  if (input.scheduled) return "SCHEDULED";
  return "NOT_ANALYZED";
}

/**
 * True when a shown response no longer matches the current material version.
 * An analysis without `based_on` is treated as current (best effort) so older
 * cached responses are never wrongly hidden as stale.
 */
export function responseIsStale(
  responseVersion: string | null | undefined,
  currentVersion: string | null,
): boolean {
  if (!responseVersion) return false;
  if (!currentVersion) return false;
  return responseVersion !== currentVersion;
}

// ──────────────────────────────────────────────────────────────────
// Request payload shaping
// ──────────────────────────────────────────────────────────────────

export interface RoomObservationPayload {
  count: number | null;
  source: string | null;
  timestamp: string | null;
  space_id: string | null;
  mapping_kind: string | null;
}

/**
 * Shape the raw vision observation into the minimal payload the backend needs.
 *
 * The observation is only attached when it is *explicitly* associated with the
 * requested room — a camera is never retargeted by proximity, name or detection.
 * The backend enforces the same rule independently.
 */
export function observationPayloadFor(
  spaceId: string | null,
  observation: {
    count: number;
    source: string;
    timestamp: string | null;
    space_id: string | null;
    mapping_kind: string | null;
  } | null,
): RoomObservationPayload | null {
  if (!spaceId || !observation) return null;
  if (observation.space_id !== spaceId) return null;
  if (observation.mapping_kind === null) return null;
  return {
    count: observation.count,
    source: observation.source,
    timestamp: observation.timestamp,
    space_id: observation.space_id,
    mapping_kind: observation.mapping_kind,
  };
}
