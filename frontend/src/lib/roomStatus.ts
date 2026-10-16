// Room status resolution for the Digital Twin.
//
// Single, explicit source of truth that turns the *available, valid* room data
// into one visual status per room, so the 3D IFC room meshes can be coloured
// consistently with the inspector. Two independent signals are combined:
//
//   1. Camera occupancy — only when the operator explicitly associated a camera
//      with the room (a DEMO association today), compared against the room's
//      declared capacity.
//   2. Rule-based issues — only when a recommendation is legitimately attributed
//      to the room (a VERIFIED_BIM location that names the room). Nothing is
//      invented and no unrelated data is used to derive severity.
//
// Honesty rules (mirroring the rest of the product):
//   • `capacity_occupants` is the IFC *design* occupancy (Energy Analysis
//     "Number of People", or area / area-per-person). It is a declared model
//     value — NOT a verified legal or operational maximum. It is therefore
//     labelled as a design capacity, never as a confirmed limit.
//   • A camera association created in the UI is a DEMO association. Occupancy
//     derived from it is presented as a DEMO estimate, never as verified
//     physical occupancy.
//   • Missing/stale occupancy or a missing capacity resolves to UNKNOWN, never
//     to a silent "safe" or "overloaded" verdict.
//
// Pure and dependency-free so the precedence and colour rules are unit-testable
// in isolation.

import type { OccupancyObservation, OccupancySource } from "../components/vision/visionTypes";
import type { Recommendation } from "../api/types";

// ──────────────────────────────────────────────────────────────────
// Levels, config and colours
// ──────────────────────────────────────────────────────────────────

/** Occupancy sub-status, derived only from a valid, associated observation. */
export type OccupancyStatusLevel =
  | "UNKNOWN"
  | "NORMAL"
  | "WARNING"
  | "OVER_CAPACITY";

/** Combined room status used for the room mesh + inspector. */
export type RoomStatusLevel =
  | "UNKNOWN"
  | "NORMAL"
  | "WARNING"
  | "OVER_CAPACITY"
  | "CRITICAL";

/** Provenance of a capacity value. */
export type CapacitySource = "OPERATIONAL" | "DESIGN";

export interface RoomCapacity {
  value: number;
  source: CapacitySource;
}

/** Fraction of capacity at/above which occupancy is shown as WARNING. */
export const DEFAULT_WARNING_RATIO = 0.8;

/** An observation older than this is treated as stale (occupancy unknown). */
export const DEFAULT_MAX_OBSERVATION_AGE_MS = 20_000;

/**
 * Mesh/HUD colours per resolved level. OVER_CAPACITY (red) and CRITICAL
 * (magenta) are deliberately different hues so a critical issue and an
 * over-capacity state are visually distinguishable, never silently merged.
 * NORMAL intentionally reuses the storey base colour (see
 * `resolveSpaceAppearance`) to preserve the twin's per-storey palette.
 */
export const ROOM_STATUS_COLOR_HEX: Record<RoomStatusLevel, string> = {
  UNKNOWN: "#94a3b8",
  NORMAL: "#34d399",
  WARNING: "#f59e0b",
  OVER_CAPACITY: "#ef4444",
  CRITICAL: "#c026d3",
};

// Deterministic precedence when several conditions apply.
const LEVEL_RANK: Record<RoomStatusLevel, number> = {
  NORMAL: 0,
  UNKNOWN: 1,
  WARNING: 2,
  OVER_CAPACITY: 3,
  CRITICAL: 4,
};

// ──────────────────────────────────────────────────────────────────
// Derived shapes
// ──────────────────────────────────────────────────────────────────

export interface RoomOccupancyStatus {
  level: OccupancyStatusLevel;
  count: number | null;
  capacity: number | null;
  capacitySource: CapacitySource | null;
  /** True when the count comes from an operator DEMO association. */
  demo: boolean;
  source: OccupancySource | null;
  /** True when the latest observation is older than the freshness window. */
  stale: boolean;
}

export interface RoomIssueStatus {
  /** Only WARNING (non-critical severity) or CRITICAL are ever produced. */
  level: "WARNING" | "CRITICAL";
  /** Raw highest severity label, e.g. "CRITICAL" / "HIGH" / "MEDIUM". */
  severity: string;
  /** Number of issues legitimately attributed to this room. */
  count: number;
  recommendationId: string;
  action: string;
}

export interface RoomStatus {
  spaceId: string;
  level: RoomStatusLevel;
  /** Null when no camera is explicitly associated with this room. */
  occupancy: RoomOccupancyStatus | null;
  /** Null when no rule-based issue is legitimately attributed to this room. */
  issue: RoomIssueStatus | null;
}

export interface SpaceCapacityRef {
  space_id: string;
  capacity_occupants?: number | null;
}

// ──────────────────────────────────────────────────────────────────
// Small pure helpers
// ──────────────────────────────────────────────────────────────────

/** Valid positive finite capacity, else null (never assume a value). */
export function capacityFromSpace(
  value: number | null | undefined,
  source: CapacitySource = "DESIGN",
): RoomCapacity | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return { value, source };
}

export function isObservationStale(
  observation: OccupancyObservation,
  now: number,
  maxAgeMs: number = DEFAULT_MAX_OBSERVATION_AGE_MS,
): boolean {
  if (!observation.timestamp) return true;
  const t = Date.parse(observation.timestamp);
  if (!Number.isFinite(t)) return true;
  return now - t > maxAgeMs;
}

/**
 * The canonical space a recommendation is *legitimately* attributed to.
 *
 * Only a VERIFIED_BIM location counts: sensor-derived candidates report
 * UNKNOWN_LOCATION (their M4 mapping is unresolved), so they must never colour
 * an arbitrary room. Returns null when there is no verified room association.
 */
export function verifiedSpaceIdOf(r: Recommendation): string | null {
  const status = r.location?.status ?? r.location_status ?? null;
  if (status !== "VERIFIED_BIM") return null;
  return r.location?.space_id ?? r.affected_entity?.space_id ?? null;
}

const SEVERITY_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO", "UNKNOWN"];

function severityRank(severity: string | null | undefined): number {
  const idx = SEVERITY_ORDER.indexOf((severity ?? "UNKNOWN").toUpperCase());
  return idx === -1 ? SEVERITY_ORDER.length : idx;
}

/**
 * Resolve the canonical storey for a space from IFC data. Never infers the
 * floor from a name/label/index — only from the manifest's space→storey link.
 */
export function resolveSpaceStorey(
  spaces: ReadonlyArray<{ space_id: string; storey_id: string | null }>,
  spaceId: string | null | undefined,
): string | null {
  if (!spaceId) return null;
  return spaces.find((s) => s.space_id === spaceId)?.storey_id ?? null;
}

// ──────────────────────────────────────────────────────────────────
// Status resolution
// ──────────────────────────────────────────────────────────────────

export interface RoomStatusInput {
  spaceId: string;
  /** Raw capacity value from the room record (e.g. capacity_occupants). */
  capacity?: number | null;
  /** Provenance of the capacity value; defaults to the IFC design value. */
  capacitySource?: CapacitySource;
  /** Latest occupancy observation (with its own association), or null. */
  observation?: OccupancyObservation | null;
  /** Rule-based recommendations (filtered internally to this room). */
  recommendations?: Recommendation[];
  /** Injectable clock for deterministic staleness handling. */
  now?: number;
  warningRatio?: number;
  maxObservationAgeMs?: number;
}

function occupancyStatus(
  input: RoomStatusInput,
): RoomOccupancyStatus | null {
  const { spaceId, observation } = input;
  // Only an explicit association (a mapping kind) may colour a room. An
  // unassociated count is never attributed to a space.
  if (
    !observation ||
    observation.mapping_kind === null ||
    observation.space_id !== spaceId
  ) {
    return null;
  }

  const now = input.now ?? Date.now();
  const maxAge = input.maxObservationAgeMs ?? DEFAULT_MAX_OBSERVATION_AGE_MS;
  const stale = isObservationStale(observation, now, maxAge);
  const capacity = capacityFromSpace(
    input.capacity,
    input.capacitySource ?? "DESIGN",
  );
  const count =
    observation.count !== null && Number.isFinite(observation.count)
      ? observation.count
      : null;

  let level: OccupancyStatusLevel = "UNKNOWN";
  if (!stale && capacity && count !== null) {
    const warningRatio = input.warningRatio ?? DEFAULT_WARNING_RATIO;
    if (count > capacity.value) level = "OVER_CAPACITY";
    else if (count >= capacity.value * warningRatio) level = "WARNING";
    else level = "NORMAL";
  }

  return {
    level,
    count,
    capacity: capacity?.value ?? null,
    capacitySource: capacity?.source ?? null,
    demo: observation.mapping_kind === "DEMO_MAPPING",
    source: observation.source,
    stale,
  };
}

function issueStatus(
  recommendations: Recommendation[] | undefined,
  spaceId: string,
): RoomIssueStatus | null {
  const matches = (recommendations ?? []).filter(
    (r) => verifiedSpaceIdOf(r) === spaceId,
  );
  if (matches.length === 0) return null;

  const highest = matches.reduce((a, b) =>
    severityRank(b.priority) < severityRank(a.priority) ? b : a,
  );
  const severity = (highest.priority ?? "UNKNOWN").toUpperCase();
  return {
    level: severity === "CRITICAL" ? "CRITICAL" : "WARNING",
    severity,
    count: matches.length,
    recommendationId: highest.recommendation_id,
    action: highest.recommended_action,
  };
}

function combineLevel(
  occupancy: RoomOccupancyStatus | null,
  issue: RoomIssueStatus | null,
): RoomStatusLevel {
  const candidates: RoomStatusLevel[] = [];
  if (occupancy) candidates.push(occupancy.level);
  if (issue) candidates.push(issue.level);
  if (candidates.length === 0) return "UNKNOWN";
  return candidates.reduce((a, b) => (LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a));
}

/** Resolve one room's combined status from the available, valid data. */
export function resolveRoomStatus(input: RoomStatusInput): RoomStatus {
  const occupancy = occupancyStatus(input);
  const issue = issueStatus(input.recommendations, input.spaceId);
  return {
    spaceId: input.spaceId,
    level: combineLevel(occupancy, issue),
    occupancy,
    issue,
  };
}

/**
 * Build the status map the viewer consumes. Only rooms we can legitimately say
 * something about get an entry (an explicitly associated camera, and/or a
 * verified rule-based issue); every other room keeps the storey base colour.
 */
export function buildRoomStatusMap(params: {
  spaces?: ReadonlyArray<SpaceCapacityRef>;
  observation?: OccupancyObservation | null;
  recommendations?: Recommendation[];
  now?: number;
  warningRatio?: number;
  maxObservationAgeMs?: number;
}): Record<string, RoomStatus> {
  const {
    spaces = [],
    observation = null,
    recommendations = [],
    now,
    warningRatio,
    maxObservationAgeMs,
  } = params;

  const capacityById = new Map<string, number | null>();
  for (const s of spaces) capacityById.set(s.space_id, s.capacity_occupants ?? null);

  const ids = new Set<string>();

  // A camera association is only counted when the operator explicitly created
  // one AND the observation is attributed to a specific space.
  const associatedId =
    observation && observation.mapping_kind !== null ? observation.space_id : null;
  if (associatedId) ids.add(associatedId);

  for (const r of recommendations) {
    const sid = verifiedSpaceIdOf(r);
    if (sid) ids.add(sid);
  }

  const map: Record<string, RoomStatus> = {};
  for (const spaceId of ids) {
    map[spaceId] = resolveRoomStatus({
      spaceId,
      capacity: capacityById.get(spaceId) ?? null,
      observation,
      recommendations,
      now,
      warningRatio,
      maxObservationAgeMs,
    });
  }
  return map;
}

// ──────────────────────────────────────────────────────────────────
// Mesh appearance
// ──────────────────────────────────────────────────────────────────

export interface SpaceAppearance {
  /** Base colour for the material (hex). */
  colorHex: string;
  /** Multiplier applied to `colorHex` (selection/hover brighten). */
  brightness: number;
  opacity: number;
  emissiveHex: string;
  /** Multiplier applied to `emissiveHex` before it is set. */
  emissiveScale: number;
  emissiveIntensity: number;
}

/**
 * Decide how a single room mesh should look. Status colour and the existing
 * selection/hover highlight are combined here (not in the render loop) so the
 * exact behaviour is unit-testable without a WebGL context.
 *
 * Precedence: an active hover/selection highlight always wins over the idle
 * status fill, but it is tinted with the status colour so the status stays
 * legible while the room is highlighted. NORMAL keeps the storey base colour;
 * every other known level uses its status colour.
 */
export function resolveSpaceAppearance(opts: {
  baseColorHex: string;
  statusLevel: RoomStatusLevel | null;
  isSelected: boolean;
  isHovered: boolean;
}): SpaceAppearance {
  const { baseColorHex, statusLevel, isSelected, isHovered } = opts;
  const colorHex =
    statusLevel && statusLevel !== "NORMAL"
      ? ROOM_STATUS_COLOR_HEX[statusLevel]
      : baseColorHex;

  if (isSelected) {
    return {
      colorHex,
      brightness: 3.5,
      opacity: 0.72,
      emissiveHex: colorHex,
      emissiveScale: 0.45,
      emissiveIntensity: 1,
    };
  }
  if (isHovered) {
    return {
      colorHex,
      brightness: 2.5,
      opacity: 0.55,
      emissiveHex: colorHex,
      emissiveScale: 0.2,
      emissiveIntensity: 1,
    };
  }

  const problem =
    statusLevel === "WARNING" ||
    statusLevel === "OVER_CAPACITY" ||
    statusLevel === "CRITICAL";
  const neutral = statusLevel === "UNKNOWN";
  return {
    colorHex,
    brightness: 1,
    opacity: problem ? 0.34 : neutral ? 0.22 : 0.12,
    emissiveHex: problem ? colorHex : "#000000",
    emissiveScale: problem ? 0.16 : 0,
    emissiveIntensity: problem ? 0.6 : 0,
  };
}

// ──────────────────────────────────────────────────────────────────
// Presentation helpers
// ──────────────────────────────────────────────────────────────────

export function roomStatusLabel(level: RoomStatusLevel): string {
  switch (level) {
    case "NORMAL":
      return "Normal";
    case "WARNING":
      return "Needs attention";
    case "OVER_CAPACITY":
      return "Over capacity";
    case "CRITICAL":
      return "Critical issue";
    case "UNKNOWN":
      return "Status unknown";
  }
}

/**
 * Human headline for a resolved status. Occupancy-derived text is always
 * suffixed "(DEMO estimate)" for a demo association so it is never mistaken
 * for verified physical occupancy.
 */
export function roomStatusHeadline(status: RoomStatus): string {
  const occ = status.occupancy;
  const demo = occ?.demo ? " (DEMO estimate)" : "";
  if (occ?.level === "OVER_CAPACITY") return `Over capacity${demo}`;
  if (occ?.level === "WARNING") return `Near capacity${demo}`;
  if (occ?.level === "UNKNOWN") return "Occupancy unknown";
  if (status.issue) {
    return status.issue.level === "CRITICAL"
      ? "Critical rule-based issue"
      : "Active rule-based issue";
  }
  if (status.level === "NORMAL") return "Within capacity";
  return roomStatusLabel(status.level);
}

/** Supporting detail lines for the inspector. */
export function roomStatusDetail(status: RoomStatus): string[] {
  const out: string[] = [];
  const occ = status.occupancy;
  if (occ) {
    if (occ.count !== null && occ.capacity !== null) {
      // Never present the IFC design value as a confirmed legal/operational max.
      const capLabel =
        occ.capacitySource === "OPERATIONAL"
          ? "operational capacity"
          : "declared design capacity";
      out.push(
        `Occupancy ${occ.count} / ${capLabel} ${occ.capacity}${
          occ.demo ? " (DEMO estimate)" : ""
        }`,
      );
    } else if (occ.stale) {
      out.push("Latest occupancy reading is stale");
    } else if (occ.capacity === null) {
      out.push("No declared capacity for this room");
    }
  }
  if (status.issue) {
    out.push(
      `${status.issue.count} rule-based issue${
        status.issue.count === 1 ? "" : "s"
      } · highest ${status.issue.severity}`,
    );
  }
  if (out.length === 0) {
    out.push("No camera association or room-level rule-based issue");
  }
  return out;
}
