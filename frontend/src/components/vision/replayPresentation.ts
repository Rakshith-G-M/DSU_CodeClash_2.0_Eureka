// CV-2 — pure presentation helpers for replayed building telemetry.
//
// The replay engine emits readings verbatim from the historical CSVs; every
// channel is `location_status: "UNKNOWN_LOCATION"`. These helpers only reshape
// that data for display. They never invent values, units or timestamps, and
// they keep the "historical replay" framing explicit.

import type { ReplayChannel } from "../../api/types";

/** Label for values that come from the historical replay engine. */
export const REPLAY_SOURCE_LABEL = "HISTORICAL REPLAY";
/** Label used while the replay clock is advancing. */
export const REPLAY_RUNNING_LABEL = "SIMULATED LIVE";
/** Room telemetry cannot be attributed to a room without a verified mapping. */
export const ROOM_TELEMETRY_UNMAPPED_LABEL = "ROOM TELEMETRY: UNMAPPED";
/** A verified mapping exists (never the case in the current release). */
export const ROOM_TELEMETRY_MAPPED_LABEL = "ROOM TELEMETRY: MAPPED";
/** No legitimate value can be shown for this measurement. */
export const UNAVAILABLE_LABEL = "UNAVAILABLE";

export const ENVIRONMENTAL_TYPES = ["temperature", "humidity", "co2", "pm2.5"] as const;
export const ENERGY_TYPES = ["energy", "power"] as const;

export interface MeasurementView {
  measurement_type: string;
  unit: string;
  value: number;
  timestamp: string;
  sensor_id: string;
  /** Replay-time age of this reading relative to the replay clock, in seconds. */
  lag_seconds: number | null;
}

export type RoomTelemetryState = "ROOM_MAPPED" | "UNMAPPED";

/**
 * Room-level attribution is only legitimate when the backend reports verified
 * locations. Anything else resolves to UNMAPPED.
 */
export function roomTelemetryState(
  verifiedLocations: number | null | undefined,
): RoomTelemetryState {
  return (verifiedLocations ?? 0) > 0 ? "ROOM_MAPPED" : "UNMAPPED";
}

export function roomTelemetryLabel(state: RoomTelemetryState): string {
  return state === "ROOM_MAPPED"
    ? ROOM_TELEMETRY_MAPPED_LABEL
    : ROOM_TELEMETRY_UNMAPPED_LABEL;
}

/** Replay-clock lag between the current simulated time and a reading. */
export function replayLagSeconds(
  simTimestamp: string | null | undefined,
  timestamp: string | null | undefined,
): number | null {
  if (!simTimestamp || !timestamp) return null;
  const sim = Date.parse(simTimestamp);
  const ts = Date.parse(timestamp);
  if (Number.isNaN(sim) || Number.isNaN(ts)) return null;
  return Math.max(0, Math.round((sim - ts) / 1000));
}

export function formatLag(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return "—";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 24) return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d ${remHours}h` : `${days}d`;
}

/**
 * One view per measurement type: the most recent channel for that type, with
 * its verbatim value/unit/timestamp and the replay-clock lag.
 */
export function latestByType(
  channels: readonly ReplayChannel[],
  simTimestamp: string | null | undefined,
): MeasurementView[] {
  const best = new Map<string, ReplayChannel>();
  for (const ch of channels) {
    const current = best.get(ch.measurement_type);
    if (!current || ch.timestamp > current.timestamp) {
      best.set(ch.measurement_type, ch);
    }
  }
  return Array.from(best.values())
    .map((ch) => ({
      measurement_type: ch.measurement_type,
      unit: ch.unit,
      value: ch.value,
      timestamp: ch.timestamp,
      sensor_id: ch.sensor_id,
      lag_seconds: replayLagSeconds(simTimestamp, ch.timestamp),
    }))
    .sort((a, b) => a.measurement_type.localeCompare(b.measurement_type));
}

/** Filter measurement views to a fixed set of measurement types. */
export function pickTypes(
  views: readonly MeasurementView[],
  types: readonly string[],
): MeasurementView[] {
  const wanted = new Set(types);
  return views.filter((v) => wanted.has(v.measurement_type));
}

/** True when at least one energy channel is available in the replay stream. */
export function hasEnergy(views: readonly MeasurementView[]): boolean {
  return pickTypes(views, ENERGY_TYPES).length > 0;
}
