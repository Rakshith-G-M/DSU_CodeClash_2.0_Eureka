import { vi } from "vitest";

import "@testing-library/jest-dom/vitest";

// Reusable fetch helpers for tests. Kept tiny so pages/components can be
// tested against realistic responses without a live backend.
export interface MockRoute {
  path: string;
  method?: string;
  body: unknown;
  status?: number;
}

class MockRouter {
  routes: MockRoute[] = [];
  register(r: MockRoute) {
    this.routes.push(r);
  }
  find(method: string, fullUrl: string) {
    return this.routes.find(
      (r) =>
        (r.method ?? "GET") === method &&
        (r.path === "*" || fullUrl.includes(r.path)),
    );
  }
}

export const mockRouter = new MockRouter();

export function sampleSpaces() {
  return {
    items: [
      {
        space_id: "space_3U1W8Xs6L9pRXU5Afk5MW1",
        ifc_global_id: "3U1W8Xs6L9pRXU5Afk5MW1",
        ifc_name: "114",
        ifc_long_name: null,
        storey_name: "3. korrus",
        building_id: "building_1",
        storey_id: "storey_1",
        area_m2: 3.07,
        volume_m3: 9.21,
        capacity_occupants: 0.767,
        occupiable: true,
        conditioning: "Heated and cooled",
      },
    ],
    total: 1,
    limit: 500,
    offset: 0,
  };
}

export function sampleReplayState() {
  return {
    sim_timestamp: "2025-06-01T03:00:00",
    running: false,
    speed: 1,
    readings_replayed: 10,
    anomalies_detected: 0,
    channels: [
      {
        sensor_id: "04f80f82-e206-427c-a913-69758a1ec283",
        measurement_type: "temperature",
        unit: "C",
        value: 23.4,
        timestamp: "2025-06-01T03:00:00",
        location_status: "UNKNOWN_LOCATION",
      },
      {
        sensor_id: "421151cb-043f-4ccc-844d-ff94cd659f2b",
        measurement_type: "humidity",
        unit: "%RH",
        value: 40,
        timestamp: "2025-06-01T03:00:00",
        location_status: "UNKNOWN_LOCATION",
      },
      {
        sensor_id: "08e2d921-2317-4642-b003-90bc1fce878a",
        measurement_type: "pm2.5",
        unit: "ug/m3",
        value: 4,
        timestamp: "2025-06-01T03:00:00",
        location_status: "UNKNOWN_LOCATION",
      },
      {
        sensor_id: "065931eb-3930-492c-ac91-85a0936fcf82",
        measurement_type: "energy",
        unit: "kWh",
        value: 12,
        timestamp: "2025-06-01T03:00:00",
        location_status: "UNKNOWN_LOCATION",
      },
    ],
    summaries: {},
    active_anomalies: [],
    location_note: "All readings shown as building/channel-level; location status UNKNOWN_LOCATION.",
  };
}

// Handler may return the body directly, or { body, status } to simulate errors.
export function mockFetch(handler: (method: string, url: string) => unknown) {
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url;
      const method =
        typeof input === "string"
          ? init?.method ?? "GET"
          : input.method ?? "GET";
      const out = await handler(method, url);
      const { body, status } =
        out !== null && typeof out === "object" && "status" in (out as object)
          ? (out as { body: unknown; status: number })
          : { body: out, status: 200 };
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    },
  );
}

export function unmockFetch() {
  vi.unstubAllGlobals();
}

export const sampleRecommendationCategory = (
  category: string,
  i: number,
) => ({
  recommendation_id: `rec-${category}-${i}`,
  candidate_id: `cand-${i}`,
  priority: "HIGH",
  priority_score: 0.7,
  priority_factors: {},
  ranking: {
    priority_score: 0.7,
    weights: {},
    factors: {},
    factor_basis: {},
    formula_version: "campusiq.weighted-linear/v1",
    explanation: "Weighted linear rank",
  },
  recommendation_category: category,
  problem_type: "detected_anomaly",
  source: "decision_candidates",
  affected_entity: { type: "space", space_id: `sp-${i}` },
  location_status: "UNKNOWN_LOCATION",
  location: { status: "UNKNOWN_LOCATION", space_id: null },
  recommended_action: `Action ${i} for ${category}.`,
  reason: "Detected via telemetry intelligence.",
  evidence: {},
  evidence_chain: [],
  constraints: [],
  expected_impact: [],
  confidence: { value: null, basis: "unknown" },
  data_quality: {},
});

export function sampleDashboard() {
  return {
    campus: { building_count: 1, storey_count: 5, space_count: 115 },
    telemetry: {
      sensor_count: 38,
      channel_count: 42,
      total_readings: 500000,
      time_span: { first: "2026-01-01T00:00:00Z", last: "2026-01-31T00:00:00Z" },
    },
    anomalies: {
      by_severity: { CRITICAL: 2, HIGH: 4, MEDIUM: 10, LOW: 3 },
      channels_with_anomalies: 7,
    },
    decision_candidates: {
      total: 98,
      by_severity: { CRITICAL: 2, HIGH: 55, MEDIUM: 36, LOW: 5 },
    },
    sensor_health: { status: "DEGRADED", healthy: 33, degraded: 5 },
    forecasts: { available: true, channels_forecasted: 30, channels_total: 42 },
    mapping: {
      status: "UNRESOLVED",
      unresolved: 38,
      resolved: 0,
      verified_locations: 0,
    },
    recommendations: { total: 98 },
    data_status: {
      availability_present: false,
      measured_energy_available: false,
      recommendation_records: 98,
    },
    generated_at: "2026-01-31T12:00:00Z",
  };
}

export const sampleRecommendation = (overrides: Record<string, unknown> = {}) => ({
  recommendation_id: "rec-1",
  candidate_id: "cand-1",
  priority: "HIGH",
  priority_score: 0.72,
  priority_factors: {},
  ranking: {
    priority_score: 0.72,
    weights: {},
    factors: {},
    factor_basis: {},
    formula_version: "campusiq.weighted-linear/v1",
    explanation: "Weighted linear rank",
  },
  recommendation_category: "Energy & comfort",
  problem_type: "lighting_overrun",
  source: "decision_candidates",
  affected_entity: { type: "space", space_id: "sp-1" },
  location_status: "VERIFIED_BIM",
  location: { status: "VERIFIED_BIM", space_id: "sp-1" },
  recommended_action: "Confirm actual office occupancy and update resource state.",
  reason: "Space capacity is not declared.",
  evidence: {},
  evidence_chain: [
    {
      step: "sensor_location",
      entity: "sensor-1",
      value: "sp-1",
      note: "Mapped to space sp-1",
    },
  ],
  constraints: [],
  expected_impact: [],
  confidence: { value: null, basis: "unknown" },
  data_quality: {},
  ...overrides,
});