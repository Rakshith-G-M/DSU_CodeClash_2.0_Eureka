import { afterEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { AiResponse } from "../api/types";
import { RecommendationsTab } from "./intelligenceTabs";
import {
  mockFetch,
  sampleRecommendation,
  unmockFetch,
} from "../test/setup";

/** A grounded AI analysis response for a single diagnostic finding. */
function findingResponse(overrides: Partial<AiResponse> = {}): AiResponse {
  return {
    status: "OK",
    provider: "openrouter",
    model: "nvidia/nemotron-3.5-lightning:free",
    message: null,
    answer: "The sensor stream is degraded.",
    evidence: [
      {
        claim: "Only 49 distinct values in 15465 readings",
        source: "sensor_health",
        value: "49 distinct",
        provenance: "HISTORICAL_REPLAY",
        reference: null,
      },
    ],
    likely_causes: [
      {
        cause: "Power or connectivity interruption",
        basis: "long gaps in the stream",
        status: "HYPOTHESIS",
        confidence: "medium",
      },
    ],
    recommendations: [
      {
        title: "Check sensor power and connectivity",
        opportunity: "",
        evidence: "Largest gap 66.0 h.",
        action: "Inspect the sensor's power supply and network link.",
        expected_impact_direction: "unknown",
        assumptions: "",
        limitations: "",
        impact_status: "UNKNOWN",
        priority: "HIGH",
        component: "humidity sensor",
        why_relevant: "Gaps suggest dropout.",
        verification: "Confirm readings resume at the expected interval.",
      },
    ],
    next_checks: ["Verify the sensor's power supply"],
    assumptions: [],
    limitations: ["No verified sensor location."],
    provenance: {
      data_freshness: "historical",
      sources: ["sensor_health"],
      is_hypothetical: false,
      model: "nvidia/nemotron-3.5-lightning:free",
    },
    deterministic_status: null,
    context: {
      scope: "FINDING",
      space_id: null,
      storey_id: null,
      finding_id: "rec-1",
      sensor_location_mapping: "UNRESOLVED",
      mapped_sensors: 0,
      total_sensors: 36,
      measured_energy_available: false,
      historical_replay: true,
      has_webcam_occupancy: false,
      room_telemetry_available: false,
      data_sources: ["DIAGNOSTIC_FINDING", "SENSOR_HEALTH"],
    },
    finding_id: "rec-1",
    generated_at: "2026-01-01T10:00:00",
    ...overrides,
  };
}

function ruleBasedPage() {
  return {
    items: [sampleRecommendation()],
    total: 1,
    limit: 20,
    offset: 0,
    generated_at: "2026-01-01T10:00:00",
    data_status: { sensor_location_mapping: "UNRESOLVED" },
  };
}

afterEach(() => {
  unmockFetch();
});

function renderTab(route: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <RecommendationsTab />
    </MemoryRouter>,
  );
}

describe("Intelligence — deterministic recommendations list", () => {
  it("renders the rule-based findings as links to the detail page", async () => {
    mockFetch((method, url) => {
      if (method === "GET" && url.includes("/api/recommendations"))
        return { status: 200, body: ruleBasedPage() };
      return { status: 404, body: { detail: "not found" } };
    });

    renderTab("/intelligence?tab=recommendations");

    expect(
      await screen.findByRole("link", { name: /priority/ }),
    ).toHaveAttribute("href", "/intelligence?rec=rec-1");
    expect(
      screen.getByText(/Sensor-to-room mapping not yet verified/),
    ).toBeInTheDocument();
  });

  it("does not render the removed floating-chat advisor surfaces", async () => {
    mockFetch((method, url) => {
      if (method === "GET" && url.includes("/api/recommendations"))
        return { status: 200, body: ruleBasedPage() };
      return { status: 404, body: { detail: "not found" } };
    });

    renderTab("/intelligence?tab=recommendations");
    await screen.findByRole("link", { name: /priority/ });

    expect(screen.queryByTestId("ai-advisor")).not.toBeInTheDocument();
    expect(screen.queryByTestId("advisor-ok")).not.toBeInTheDocument();
    expect(screen.queryByTestId("advisor-fallback")).not.toBeInTheDocument();
    expect(screen.queryByTestId("advisor-empty")).not.toBeInTheDocument();
  });

  it("shows the loading state while the list is fetched", () => {
    mockFetch(() => new Promise(() => {}));
    renderTab("/intelligence?tab=recommendations");
    expect(screen.getByTestId("loading-state")).toBeInTheDocument();
  });
});

describe("Intelligence — recommendation deep link", () => {
  it("keeps ?rec=<id> opening the detail view with the integrated analysis", async () => {
    mockFetch((method, url) => {
      if (url.includes("/api/ai/finding"))
        return { status: 200, body: findingResponse() };
      if (url.includes("/api/recommendations/rec-1"))
        return { status: 200, body: sampleRecommendation() };
      if (method === "GET" && url.includes("/api/recommendations"))
        return { status: 200, body: ruleBasedPage() };
      return { status: 404, body: { detail: "not found" } };
    });

    renderTab("/intelligence?tab=recommendations&rec=rec-1");

    const back = await screen.findByRole("link", {
      name: /Back to Recommendations/,
    });
    expect(back).toHaveAttribute(
      "href",
      "/intelligence?tab=recommendations",
    );

    // The detail page keeps its diagnostic structure and hosts the analysis.
    expect(await screen.findByText(/WHAT HAPPENED\?/i)).toBeInTheDocument();
    const analysis = await screen.findByTestId("finding-analysis");
    await waitFor(() =>
      expect(analysis).toHaveTextContent("The sensor stream is degraded."),
    );
  });

  it("does not open a separate chat panel from the detail page", async () => {
    mockFetch((method, url) => {
      if (url.includes("/api/ai/finding"))
        return { status: 200, body: findingResponse() };
      if (url.includes("/api/recommendations/rec-1"))
        return { status: 200, body: sampleRecommendation() };
      if (method === "GET" && url.includes("/api/recommendations"))
        return { status: 200, body: ruleBasedPage() };
      return { status: 404, body: { detail: "not found" } };
    });

    renderTab("/intelligence?tab=recommendations&rec=rec-1");
    await screen.findByTestId("finding-analysis");

    expect(screen.queryByTestId("assistant-launcher")).not.toBeInTheDocument();
    expect(screen.queryByTestId("assistant-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("assistant-header-open")).not.toBeInTheDocument();
    expect(screen.queryByTestId("assistant-explain-room")).not.toBeInTheDocument();
  });
});
