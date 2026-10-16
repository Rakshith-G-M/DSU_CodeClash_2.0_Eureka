// Tests for the room-intelligence trigger policy.
//
// This module has no React and no I/O, so every rule — the state-version
// fingerprint, the anti-flicker occupancy bucket, dedup, minimum refresh,
// failure cooldown and phase derivation — is asserted deterministically.
// No provider is ever called and no API key is needed.

import { describe, expect, it } from "vitest";
import type { RoomStatus } from "../lib/roomStatus";
import {
  DEFAULT_TRIGGER_POLICY,
  buildMaterialState,
  derivePhase,
  isMaterialChange,
  materialStateVersion,
  observationPayloadFor,
  responseIsStale,
  scheduleDecision,
  type TriggerPolicy,
} from "./roomIntelligence";

const ROOM = "space_3U1W8Xs6L9pRXU5Afk5MW1";
const POLICY: TriggerPolicy = { debounceMs: 2500, minRefreshMs: 20000, cooldownMs: 8000 };

function status(overrides: Partial<RoomStatus> = {}): RoomStatus {
  return {
    spaceId: ROOM,
    level: "NORMAL",
    occupancy: {
      level: "NORMAL",
      count: 3,
      capacity: 10,
      capacitySource: "DESIGN",
      demo: true,
      source: "LIVE_CAMERA",
      stale: false,
    },
    issue: null,
    ...overrides,
  };
}

describe("materialStateVersion", () => {
  it("is null when no room is selected", () => {
    expect(buildMaterialState(null, status())).toBeNull();
    expect(materialStateVersion(null)).toBeNull();
  });

  it("is stable for the same material state", () => {
    const a = buildMaterialState(ROOM, status());
    const b = buildMaterialState(ROOM, status());
    expect(materialStateVersion(a)).toBe(materialStateVersion(b));
    expect(isMaterialChange(a, b)).toBe(false);
  });

  it("changes when the occupancy count changes", () => {
    const a = buildMaterialState(ROOM, status({ occupancy: { ...status().occupancy!, count: 2 } }));
    const b = buildMaterialState(ROOM, status({ occupancy: { ...status().occupancy!, count: 3 } }));
    expect(isMaterialChange(a, b)).toBe(true);
  });

  it("does not change when the count is identical (repeated detections)", () => {
    const a = buildMaterialState(ROOM, status({ occupancy: { ...status().occupancy!, count: 4 } }));
    const b = buildMaterialState(ROOM, status({ occupancy: { ...status().occupancy!, count: 4 } }));
    expect(isMaterialChange(a, b)).toBe(false);
    // Flicker (2↔3 repeatedly) is absorbed by the hook's dwell, not here — the
    // oscillating value is never committed, so no version ever fires.
  });

  it("changes when the deterministic status level changes", () => {
    const a = buildMaterialState(ROOM, status({ level: "NORMAL" }));
    const b = buildMaterialState(ROOM, status({ level: "OVER_CAPACITY" }));
    expect(isMaterialChange(a, b)).toBe(true);
  });

  it("changes when occupancy becomes stale", () => {
    const a = buildMaterialState(ROOM, status());
    const b = buildMaterialState(
      ROOM,
      status({ occupancy: { ...status().occupancy!, stale: true } }),
    );
    expect(isMaterialChange(a, b)).toBe(true);
  });

  it("changes when a rule-based issue is attributed or cleared", () => {
    const a = buildMaterialState(ROOM, status({ issue: null }));
    const b = buildMaterialState(
      ROOM,
      status({
        level: "WARNING",
        issue: {
          level: "WARNING",
          severity: "HIGH",
          count: 2,
          recommendationId: "rec-1",
          action: "Check the room.",
        },
      }),
    );
    expect(isMaterialChange(a, b)).toBe(true);
  });

  it("changes when the room changes", () => {
    const a = buildMaterialState(ROOM, status());
    const b = buildMaterialState("space_other", status({ spaceId: "space_other" }));
    expect(isMaterialChange(a, b)).toBe(true);
  });
});

describe("scheduleDecision — controlled trigger policy", () => {
  it("schedules immediately for the first state ever seen", () => {
    const d = scheduleDecision({
      targetVersion: "v1",
      lastAttemptedVersion: null,
      lastAttemptedAt: null,
      failed: false,
      manual: false,
      now: 1000,
      policy: POLICY,
    });
    expect(d).toEqual({ schedule: true, delayMs: 0, reason: "INITIAL" });
  });

  it("never re-schedules an unchanged state (dedup for repeated detections)", () => {
    const d = scheduleDecision({
      targetVersion: "v1",
      lastAttemptedVersion: "v1",
      lastAttemptedAt: 1000,
      failed: false,
      manual: false,
      now: 999_999,
      policy: POLICY,
    });
    expect(d.schedule).toBe(false);
    expect(d.reason).toBe("UNCHANGED");
  });

  it("does not auto-retry the same version after a failure (manual only)", () => {
    const d = scheduleDecision({
      targetVersion: "v1",
      lastAttemptedVersion: "v1",
      lastAttemptedAt: 1000,
      failed: true,
      manual: false,
      now: 999_999,
      policy: POLICY,
    });
    expect(d.schedule).toBe(false);
  });

  it("throttles a changed state by the minimum refresh interval", () => {
    const d = scheduleDecision({
      targetVersion: "v2",
      lastAttemptedVersion: "v1",
      lastAttemptedAt: 1000,
      failed: false,
      manual: false,
      now: 1000 + 5000, // only 5s since the last attempt
      policy: POLICY,
    });
    expect(d.schedule).toBe(true);
    expect(d.reason).toBe("MATERIAL_CHANGE");
    expect(d.delayMs).toBe(POLICY.minRefreshMs - 5000);
  });

  it("schedules immediately when the refresh window has already elapsed", () => {
    const d = scheduleDecision({
      targetVersion: "v2",
      lastAttemptedVersion: "v1",
      lastAttemptedAt: 1000,
      failed: false,
      manual: false,
      now: 1000 + POLICY.minRefreshMs + 1,
      policy: POLICY,
    });
    expect(d.schedule).toBe(true);
    expect(d.delayMs).toBe(0);
  });

  it("applies the failure cooldown after a failed attempt", () => {
    const d = scheduleDecision({
      targetVersion: "v2",
      lastAttemptedVersion: "v1",
      lastAttemptedAt: 1000,
      failed: true,
      manual: false,
      now: 1000 + 1000,
      policy: POLICY,
    });
    expect(d.schedule).toBe(true);
    expect(d.delayMs).toBe(Math.max(POLICY.minRefreshMs - 1000, POLICY.cooldownMs - 1000));
  });

  it("a manual action always schedules immediately", () => {
    const d = scheduleDecision({
      targetVersion: "v1",
      lastAttemptedVersion: "v1",
      lastAttemptedAt: 1000,
      failed: true,
      manual: true,
      now: 1001,
      policy: POLICY,
    });
    expect(d).toEqual({ schedule: true, delayMs: 0, reason: "MANUAL" });
  });

  it("never schedules without a target version", () => {
    const d = scheduleDecision({
      targetVersion: null,
      lastAttemptedVersion: null,
      lastAttemptedAt: null,
      failed: false,
      manual: false,
      now: 1,
      policy: POLICY,
    });
    expect(d.schedule).toBe(false);
  });

  it("exposes sane default policy values", () => {
    expect(DEFAULT_TRIGGER_POLICY.debounceMs).toBeGreaterThan(0);
    expect(DEFAULT_TRIGGER_POLICY.minRefreshMs).toBeGreaterThanOrEqual(
      DEFAULT_TRIGGER_POLICY.debounceMs,
    );
    expect(DEFAULT_TRIGGER_POLICY.cooldownMs).toBeGreaterThan(0);
  });
});

describe("derivePhase", () => {
  it("reports ANALYZING while a request is in flight", () => {
    expect(
      derivePhase({
        analyzing: true,
        scheduled: false,
        hasResponse: true,
        failed: false,
        responseIsStale: false,
      }),
    ).toBe("ANALYZING");
  });

  it("reports FAILED when the latest attempt failed", () => {
    expect(
      derivePhase({
        analyzing: false,
        scheduled: false,
        hasResponse: true,
        failed: true,
        responseIsStale: false,
      }),
    ).toBe("FAILED");
  });

  it("reports STALE when the response no longer matches the room", () => {
    expect(
      derivePhase({
        analyzing: false,
        scheduled: false,
        hasResponse: true,
        failed: false,
        responseIsStale: true,
      }),
    ).toBe("STALE");
  });

  it("reports CURRENT when the response matches the room", () => {
    expect(
      derivePhase({
        analyzing: false,
        scheduled: false,
        hasResponse: true,
        failed: false,
        responseIsStale: false,
      }),
    ).toBe("CURRENT");
  });

  it("reports SCHEDULED when nothing has been produced yet", () => {
    expect(
      derivePhase({
        analyzing: false,
        scheduled: true,
        hasResponse: false,
        failed: false,
        responseIsStale: false,
      }),
    ).toBe("SCHEDULED");
  });
});

describe("responseIsStale", () => {
  it("is false when the versions match", () => {
    expect(responseIsStale("v1", "v1")).toBe(false);
  });
  it("is true when the versions differ", () => {
    expect(responseIsStale("v1", "v2")).toBe(true);
  });
  it("never marks a response without a version as stale", () => {
    expect(responseIsStale(null, "v2")).toBe(false);
    expect(responseIsStale(undefined, "v2")).toBe(false);
  });
  it("never marks a response stale when no room is selected", () => {
    expect(responseIsStale("v1", null)).toBe(false);
  });
});

describe("observationPayloadFor — camera association is never inferred", () => {
  const observation = {
    count: 4,
    source: "LIVE_CAMERA",
    timestamp: "2026-01-01T10:00:00",
    space_id: ROOM,
    mapping_kind: "DEMO_MAPPING" as const,
  };

  it("attaches the observation only when it is associated with this room", () => {
    expect(observationPayloadFor(ROOM, observation)).toEqual({
      count: 4,
      source: "LIVE_CAMERA",
      timestamp: "2026-01-01T10:00:00",
      space_id: ROOM,
      mapping_kind: "DEMO_MAPPING",
    });
  });

  it("refuses an observation associated with a different room", () => {
    expect(observationPayloadFor("space_other", observation)).toBeNull();
  });

  it("refuses an unassociated observation (space_id null)", () => {
    expect(
      observationPayloadFor(ROOM, { ...observation, space_id: null }),
    ).toBeNull();
  });

  it("refuses an observation without a mapping kind", () => {
    expect(
      observationPayloadFor(ROOM, { ...observation, mapping_kind: null }),
    ).toBeNull();
  });

  it("returns null when there is no observation", () => {
    expect(observationPayloadFor(ROOM, null)).toBeNull();
  });
});
