import { describe, expect, it } from "vitest";
import type { Recommendation } from "../api/types";
import type { OccupancyObservation } from "../components/vision/visionTypes";
import {
  buildRoomStatusMap,
  capacityFromSpace,
  isObservationStale,
  resolveRoomStatus,
  resolveSpaceAppearance,
  resolveSpaceStorey,
  ROOM_STATUS_COLOR_HEX,
  verifiedSpaceIdOf,
} from "./roomStatus";

const ROOM = "space_3U1W8Xs6L9pRXU5Afk5MW1";
const OTHER = "space_OTHER_ROOM";
const STOREY = "storey_1mnZnZ29v9QRze4pjg0g3S";
const BASE = "#4fb08a";
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

function observation(
  overrides: Partial<OccupancyObservation> = {},
): OccupancyObservation {
  return {
    count: 1,
    confidence: 0.9,
    source: "LIVE_CAMERA",
    source_id: "dev-webcam",
    model: "test",
    scoreThreshold: 0.4,
    timestamp: new Date(NOW).toISOString(),
    space_id: ROOM,
    mapping_kind: "DEMO_MAPPING",
    mapping_status: "DEMO_MAPPING",
    ...overrides,
  };
}

function rec(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    recommendation_id: "rec-1",
    candidate_id: "cand-1",
    priority: "HIGH",
    priority_score: 0.5,
    priority_factors: {},
    ranking: {
      priority_score: 0.5,
      weights: {},
      factors: {},
      factor_basis: {},
      formula_version: "v1",
      explanation: "",
    },
    recommendation_category: "Energy & comfort",
    problem_type: "lighting_overrun",
    source: "decision_candidates",
    affected_entity: { type: "space", space_id: ROOM },
    location_status: "VERIFIED_BIM",
    location: { status: "VERIFIED_BIM", space_id: ROOM },
    recommended_action: "Reduce lighting overrun.",
    reason: "Deviation observed.",
    evidence: {},
    evidence_chain: [],
    constraints: [],
    expected_impact: [],
    confidence: { value: null, basis: "unknown" },
    data_quality: {},
    ...overrides,
  };
}

describe("capacityFromSpace", () => {
  it("accepts a positive finite value and defaults to the DESIGN source", () => {
    expect(capacityFromSpace(4)).toEqual({ value: 4, source: "DESIGN" });
    expect(capacityFromSpace(4, "OPERATIONAL")).toEqual({
      value: 4,
      source: "OPERATIONAL",
    });
  });

  it("rejects missing, zero, negative and non-finite values", () => {
    for (const v of [null, undefined, 0, -3, Number.NaN, Infinity]) {
      expect(capacityFromSpace(v)).toBeNull();
    }
  });
});

describe("isObservationStale", () => {
  it("treats a fresh observation as not stale", () => {
    expect(isObservationStale(observation(), NOW)).toBe(false);
  });

  it("treats an old observation as stale", () => {
    const old = observation({ timestamp: new Date(NOW - 60_000).toISOString() });
    expect(isObservationStale(old, NOW)).toBe(true);
  });

  it("treats a missing timestamp as stale", () => {
    expect(isObservationStale(observation({ timestamp: null }), NOW)).toBe(true);
  });
});

describe("resolveRoomStatus — occupancy", () => {
  it("is OVER_CAPACITY when valid demo occupancy exceeds the configured capacity", () => {
    const status = resolveRoomStatus({
      spaceId: ROOM,
      capacity: 4,
      observation: observation({ count: 5 }),
      now: NOW,
    });
    expect(status.level).toBe("OVER_CAPACITY");
    expect(status.occupancy).toMatchObject({
      level: "OVER_CAPACITY",
      count: 5,
      capacity: 4,
      demo: true,
    });
  });

  it("returns to NORMAL once occupancy falls below the warning threshold", () => {
    const status = resolveRoomStatus({
      spaceId: ROOM,
      capacity: 4,
      observation: observation({ count: 2 }),
      now: NOW,
    });
    expect(status.level).toBe("NORMAL");
    expect(status.occupancy?.level).toBe("NORMAL");
  });

  it("is WARNING when occupancy reaches the configurable warning threshold", () => {
    const status = resolveRoomStatus({
      spaceId: ROOM,
      capacity: 4,
      warningRatio: 0.8,
      observation: observation({ count: 4 }),
      now: NOW,
    });
    expect(status.occupancy?.level).toBe("WARNING");
    expect(status.level).toBe("WARNING");
  });

  it("does not produce an overload state when capacity is unknown", () => {
    const status = resolveRoomStatus({
      spaceId: ROOM,
      capacity: null,
      observation: observation({ count: 9 }),
      now: NOW,
    });
    expect(status.occupancy?.level).toBe("UNKNOWN");
    expect(status.occupancy?.capacity).toBeNull();
    expect(status.level).toBe("UNKNOWN");
  });

  it("does not produce an overload state from a stale observation", () => {
    const status = resolveRoomStatus({
      spaceId: ROOM,
      capacity: 4,
      observation: observation({
        count: 9,
        timestamp: new Date(NOW - 120_000).toISOString(),
      }),
      now: NOW,
    });
    expect(status.occupancy?.stale).toBe(true);
    expect(status.occupancy?.level).toBe("UNKNOWN");
    expect(status.level).toBe("UNKNOWN");
  });

  it("ignores a count that is not explicitly associated with the room", () => {
    const mismatched = resolveRoomStatus({
      spaceId: ROOM,
      capacity: 4,
      observation: observation({ space_id: OTHER }),
      now: NOW,
    });
    expect(mismatched.occupancy).toBeNull();

    const unmapped = resolveRoomStatus({
      spaceId: ROOM,
      capacity: 4,
      observation: observation({ mapping_kind: null, mapping_status: "UNASSIGNED" }),
      now: NOW,
    });
    expect(unmapped.occupancy).toBeNull();
  });

  it("marks a demo association and never presents it as verified occupancy", () => {
    const status = resolveRoomStatus({
      spaceId: ROOM,
      capacity: 4,
      observation: observation({ count: 5 }),
      now: NOW,
    });
    expect(status.occupancy?.demo).toBe(true);
  });
});

describe("resolveRoomStatus — rule-based issues", () => {
  it("applies a non-critical severity as WARNING when legitimately associated", () => {
    const status = resolveRoomStatus({
      spaceId: ROOM,
      capacity: 4,
      recommendations: [rec({ priority: "MEDIUM" })],
      now: NOW,
    });
    expect(status.issue).toMatchObject({ level: "WARNING", severity: "MEDIUM", count: 1 });
    expect(status.level).toBe("WARNING");
  });

  it("applies a CRITICAL issue as CRITICAL", () => {
    const status = resolveRoomStatus({
      spaceId: ROOM,
      recommendations: [rec({ priority: "CRITICAL" })],
      now: NOW,
    });
    expect(status.issue?.level).toBe("CRITICAL");
    expect(status.level).toBe("CRITICAL");
  });

  it("ignores an issue whose location is not verified BIM, even if it names a space", () => {
    const status = resolveRoomStatus({
      spaceId: ROOM,
      recommendations: [
        rec({
          location_status: "UNKNOWN_LOCATION",
          location: { status: "UNKNOWN_LOCATION", space_id: ROOM },
        }),
      ],
      now: NOW,
    });
    expect(status.issue).toBeNull();
    expect(status.level).toBe("UNKNOWN");
  });

  it("ignores an issue attributed to a different room", () => {
    const status = resolveRoomStatus({
      spaceId: ROOM,
      recommendations: [rec({ location: { status: "VERIFIED_BIM", space_id: OTHER } })],
      now: NOW,
    });
    expect(status.issue).toBeNull();
  });

  it("keeps a critical issue and an over-capacity state both visible and distinct", () => {
    const status = resolveRoomStatus({
      spaceId: ROOM,
      capacity: 4,
      observation: observation({ count: 6 }),
      recommendations: [rec({ priority: "CRITICAL" })],
      now: NOW,
    });
    // Deterministic precedence: the critical issue is primary…
    expect(status.level).toBe("CRITICAL");
    // …without overwriting the over-capacity occupancy signal.
    expect(status.occupancy?.level).toBe("OVER_CAPACITY");
    expect(ROOM_STATUS_COLOR_HEX.CRITICAL).not.toBe(
      ROOM_STATUS_COLOR_HEX.OVER_CAPACITY,
    );
  });
});

describe("verifiedSpaceIdOf", () => {
  it("returns the space only for a VERIFIED_BIM location", () => {
    expect(verifiedSpaceIdOf(rec())).toBe(ROOM);
    expect(
      verifiedSpaceIdOf(
        rec({ location_status: "UNKNOWN", location: { status: "UNKNOWN", space_id: ROOM } }),
      ),
    ).toBeNull();
  });
});

describe("resolveSpaceAppearance (mesh colouring)", () => {
  it("colours an idle over-capacity room red and more opaque than normal", () => {
    const over = resolveSpaceAppearance({
      baseColorHex: BASE,
      statusLevel: "OVER_CAPACITY",
      isSelected: false,
      isHovered: false,
    });
    const normal = resolveSpaceAppearance({
      baseColorHex: BASE,
      statusLevel: "NORMAL",
      isSelected: false,
      isHovered: false,
    });
    expect(over.colorHex).toBe(ROOM_STATUS_COLOR_HEX.OVER_CAPACITY);
    expect(over.opacity).toBeGreaterThan(normal.opacity);
  });

  it("uses a distinct colour for a critical issue vs over-capacity", () => {
    const critical = resolveSpaceAppearance({
      baseColorHex: BASE,
      statusLevel: "CRITICAL",
      isSelected: false,
      isHovered: false,
    });
    expect(critical.colorHex).toBe(ROOM_STATUS_COLOR_HEX.CRITICAL);
    expect(critical.colorHex).not.toBe(ROOM_STATUS_COLOR_HEX.OVER_CAPACITY);
  });

  it("keeps the storey base colour for a normal or unstatused room", () => {
    for (const level of [null, "NORMAL"] as const) {
      const ap = resolveSpaceAppearance({
        baseColorHex: BASE,
        statusLevel: level,
        isSelected: false,
        isHovered: false,
      });
      expect(ap.colorHex).toBe(BASE);
      expect(ap.opacity).toBe(0.12);
    }
  });

  it("uses a neutral colour (not green or red) for an unknown status", () => {
    const ap = resolveSpaceAppearance({
      baseColorHex: BASE,
      statusLevel: "UNKNOWN",
      isSelected: false,
      isHovered: false,
    });
    expect(ap.colorHex).toBe(ROOM_STATUS_COLOR_HEX.UNKNOWN);
    expect(ap.opacity).toBe(0.22);
  });

  it("preserves the selection highlight while tinting it with the status colour", () => {
    const selected = resolveSpaceAppearance({
      baseColorHex: BASE,
      statusLevel: "OVER_CAPACITY",
      isSelected: true,
      isHovered: false,
    });
    expect(selected.brightness).toBeGreaterThan(1);
    expect(selected.opacity).toBe(0.72);
    expect(selected.colorHex).toBe(ROOM_STATUS_COLOR_HEX.OVER_CAPACITY);
    expect(selected.emissiveScale).toBeGreaterThan(0);
  });
});

describe("resolveSpaceStorey", () => {
  it("resolves the canonical storey from IFC data", () => {
    const spaces = [
      { space_id: ROOM, storey_id: STOREY },
      { space_id: OTHER, storey_id: null },
    ];
    expect(resolveSpaceStorey(spaces, ROOM)).toBe(STOREY);
    expect(resolveSpaceStorey(spaces, OTHER)).toBeNull();
    expect(resolveSpaceStorey(spaces, "space_missing")).toBeNull();
    expect(resolveSpaceStorey(spaces, null)).toBeNull();
  });
});

describe("buildRoomStatusMap", () => {
  it("includes the associated room and verified-issue rooms, and nothing else", () => {
    const map = buildRoomStatusMap({
      spaces: [
        { space_id: ROOM, capacity_occupants: 4 },
        { space_id: OTHER, capacity_occupants: 2 },
        { space_id: "space_unrelated", capacity_occupants: 10 },
      ],
      observation: observation({ count: 5 }),
      recommendations: [
        rec({ location: { status: "VERIFIED_BIM", space_id: OTHER } }),
      ],
      now: NOW,
    });

    expect(Object.keys(map).sort()).toEqual([OTHER, ROOM].sort());
    expect(map[ROOM].level).toBe("OVER_CAPACITY");
    expect(map[OTHER].level).toBe("WARNING");
    expect(map["space_unrelated"]).toBeUndefined();
  });
});
