// Tests for the integrated, issue-scoped AI analysis.
//
// Every provider response is mocked — the suite never touches OpenRouter and
// never needs a real API key.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AiResponse } from "../api/types";
import { FindingAnalysis } from "./FindingAnalysis";
import { unmockFetch } from "../test/setup";

// ── fetch stub that also captures request bodies ─────────────────────────────
interface RecordedCall {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

let CALLS: RecordedCall[] = [];

function stubFetch(
  handler: (method: string, url: string, body: Record<string, unknown> | null) => unknown,
) {
  CALLS = [];
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url;
      const method =
        typeof input === "string" ? init?.method ?? "GET" : input.method ?? "GET";
      let parsed: Record<string, unknown> | null = null;
      if (init?.body) {
        try {
          parsed = JSON.parse(String(init.body)) as Record<string, unknown>;
        } catch {
          parsed = null;
        }
      }
      CALLS.push({ method, url, body: parsed });

      const out = await handler(method, url, parsed);
      const wrapped =
        out !== null &&
        typeof out === "object" &&
        "status" in (out as object) &&
        "body" in (out as object);
      const body = wrapped ? (out as { body: unknown }).body : out;
      const status = wrapped ? (out as { status: number }).status : 200;
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    },
  );
}

/** Resolve an AI response only after `gate` resolves (for pending-state tests). */
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}

// ── fixtures ─────────────────────────────────────────────────────────────────
function analysisResponse(overrides: Partial<AiResponse> = {}): AiResponse {
  return {
    status: "OK",
    provider: "openrouter",
    model: "nvidia/nemotron-3.5-lightning:free",
    message: null,
    answer: "The humidity sensor stream is degraded: readings are repeating, intervals are irregular and the stream has long gaps.",
    evidence: [
      {
        claim: "Repeated constant readings",
        source: "sensor_health",
        value: "only 49 distinct values in 15465",
        provenance: "HISTORICAL_REPLAY",
        reference: null,
      },
      {
        claim: "Room temperature held at 21 °C for 40 minutes",
        source: "telemetry",
        value: "21 °C",
        provenance: "VERIFIED_SENSOR",
        reference: null,
      },
    ],
    likely_causes: [
      {
        cause: "Power or connectivity interruption",
        basis: "largest gap 66.0 h",
        status: "HYPOTHESIS",
        confidence: "medium",
      },
      {
        cause: "Calibration drift",
        basis: "constant values",
        status: "HYPOTHESIS",
        confidence: "low",
      },
    ],
    recommendations: [
      {
        title: "Inspect data-ingestion pipeline",
        opportunity: "",
        evidence: "interval CV 2.59",
        action: "Check whether the ingestion job dropped messages.",
        expected_impact_direction: "unknown",
        assumptions: "",
        limitations: "",
        impact_status: "UNKNOWN",
        priority: "MEDIUM",
        component: "data-ingestion service",
        why_relevant: "Irregular intervals point at transport, not the sensor.",
        verification: "Confirm samples arrive every 15 minutes.",
      },
      {
        title: "Check sensor power and connectivity",
        opportunity: "",
        evidence: "largest gap 66.0 h",
        action: "Inspect the sensor's power supply and network link.",
        expected_impact_direction: "unknown",
        assumptions: "",
        limitations: "",
        impact_status: "UNKNOWN",
        priority: "HIGH",
        component: "humidity sensor",
        why_relevant: "Long gaps are consistent with a dropout.",
        verification: "Confirm readings resume at the expected interval.",
      },
    ],
    next_checks: [
      "Verify the sensor's power supply",
      "Check the data-ingestion log for dropped batches",
      "Verify the calibration certificate",
    ],
    assumptions: [],
    limitations: [
      "Root causes marked as confirmed were downgraded to hypotheses: no diagnostic test confirms a single cause.",
      "No verified sensor location.",
    ],
    provenance: {
      data_freshness: "historical",
      sources: ["sensor_health", "telemetry_profile"],
      is_hypothetical: false,
      model: "nvidia/nemotron-3.5-lightning:free",
    },
    deterministic_status: null,
    context: {
      scope: "FINDING",
      space_id: null,
      storey_id: null,
      finding_id: "F-DEGRADED",
      sensor_location_mapping: "UNRESOLVED",
      mapped_sensors: 0,
      total_sensors: 36,
      measured_energy_available: false,
      historical_replay: true,
      has_webcam_occupancy: false,
      room_telemetry_available: false,
      data_sources: ["DIAGNOSTIC_FINDING", "SENSOR_HEALTH"],
    },
    finding_id: "F-DEGRADED",
    generated_at: "2026-01-01T10:00:00",
    ...overrides,
  };
}

afterEach(() => {
  unmockFetch();
});

/** Mirrors how RecDetail mounts the section: keyed so switching resets state. */
function Harness({ findingId }: { findingId: string }) {
  return <FindingAnalysis key={findingId} findingId={findingId} />;
}

function okAnalysis() {
  stubFetch((method, url) => {
    if (method === "POST" && url.includes("/api/ai/finding"))
      return { status: 200, body: analysisResponse() };
    return { status: 404, body: { detail: "not found" } };
  });
}

describe("FindingAnalysis — automatic analysis", () => {
  it("analyses the selected finding without the user re-typing the problem", async () => {
    okAnalysis();
    render(<Harness findingId="F-DEGRADED" />);

    expect(await screen.findByTestId("finding-diagnosis")).toHaveTextContent(
      "humidity sensor stream is degraded",
    );
    // It was an automatic analysis: no question, only the finding id.
    expect(CALLS).toHaveLength(1);
    expect(CALLS[0].url).toContain("/api/ai/finding");
    expect(CALLS[0].body).toEqual({ finding_id: "F-DEGRADED" });
    expect(CALLS[0].body).not.toHaveProperty("question");

    // Content: diagnosis, evidence with provenance, causes, actions, next steps.
    expect(screen.getByTestId("finding-evidence")).toHaveTextContent(
      "Historical replay",
    );
    expect(screen.getByTestId("finding-evidence")).toHaveTextContent(
      "Verified sensor",
    );
    expect(screen.getAllByTestId("finding-cause")).toHaveLength(2);
    expect(screen.getAllByTestId("finding-cause")[0]).toHaveTextContent(
      "Hypothesis — to verify",
    );
    // Recommended actions are ordered HIGH before MEDIUM.
    const recs = screen.getAllByTestId("finding-recommendation");
    expect(recs).toHaveLength(2);
    expect(recs[0]).toHaveTextContent("Check sensor power and connectivity");
    expect(recs[0]).toHaveTextContent("High priority");
    expect(recs[1]).toHaveTextContent("Inspect data-ingestion pipeline");
    // Each action says why it is relevant and how to verify it.
    expect(recs[0]).toHaveTextContent("Long gaps are consistent with a dropout.");
    expect(recs[0]).toHaveTextContent("Verify: Confirm readings resume");
    expect(screen.getByTestId("finding-next-checks")).toHaveTextContent(
      "Check the data-ingestion log",
    );
    // Limitations / missing evidence are shown.
    expect(screen.getByTestId("finding-limitations")).toHaveTextContent(
      "downgraded to hypotheses",
    );
    expect(screen.getByTestId("finding-limitations")).toHaveTextContent(
      "No verified sensor location.",
    );
  });

  it("shows a clean loading state and disables duplicate submissions", async () => {
    stubFetch(() => new Promise(() => {})); // never resolves
    render(<Harness findingId="F-DEGRADED" />);

    expect(await screen.findByTestId("finding-analysis-loading")).toBeInTheDocument();
    // No follow-up surface is offered before the analysis arrives.
    expect(screen.queryByTestId("finding-followup-input")).not.toBeInTheDocument();
  });

  it("reports an unverified sensor-to-room mapping and does not claim a room", async () => {
    okAnalysis();
    render(<Harness findingId="F-DEGRADED" />);
    await screen.findByTestId("finding-diagnosis");

    expect(screen.getByText("Sensor-to-room mapping unresolved")).toBeInTheDocument();
    expect(screen.getByText("Finding context")).toBeInTheDocument();
    expect(screen.queryByText("Room context")).not.toBeInTheDocument();
  });

  it("never presents an unverified savings figure", async () => {
    okAnalysis();
    render(<Harness findingId="F-DEGRADED" />);
    await screen.findByTestId("finding-diagnosis");

    // All recommendations have UNKNOWN impact → no quantified impact is claimed.
    expect(screen.getAllByTestId("finding-recommendation")[0]).toHaveTextContent(
      "Unknown — not verified",
    );
    expect(screen.getByTestId("finding-impact")).toHaveTextContent(
      "does not support a quantified",
    );
  });
});

describe("FindingAnalysis — empty and provider failures", () => {
  it("handles an empty model response without fabricating an answer", async () => {
    stubFetch(() => ({
      status: 200,
      body: analysisResponse({ answer: "", evidence: [], recommendations: [], likely_causes: [] }),
    }));
    render(<Harness findingId="F-DEGRADED" />);

    expect(await screen.findByTestId("finding-analysis-empty")).toHaveTextContent(
      "no grounded analysis",
    );
    expect(screen.getByTestId("finding-retry")).toBeInTheDocument();
    expect(screen.queryByTestId("finding-diagnosis")).not.toBeInTheDocument();
  });

  it("handles an authentication failure and offers a retry", async () => {
    stubFetch(() => ({
      status: 200,
      body: analysisResponse({
        status: "PROVIDER_ERROR",
        message: "The AI provider rejected the credentials.",
        answer: null,
        evidence: [],
        recommendations: [],
        likely_causes: [],
      }),
    }));
    render(<Harness findingId="F-DEGRADED" />);

    expect(await screen.findByTestId("finding-analysis-unavailable")).toHaveTextContent(
      "rejected the credentials",
    );
    expect(screen.getByTestId("finding-retry")).toBeInTheDocument();
    expect(screen.queryByTestId("finding-diagnosis")).not.toBeInTheDocument();
  });

  it("handles a missing API key with actionable guidance", async () => {
    stubFetch(() => ({
      status: 200,
      body: analysisResponse({
        status: "NOT_CONFIGURED",
        message: null,
        answer: null,
        evidence: [],
        recommendations: [],
        likely_causes: [],
      }),
    }));
    render(<Harness findingId="F-DEGRADED" />);

    const notice = await screen.findByTestId("finding-analysis-unavailable");
    expect(notice.textContent ?? "").toContain("OPENROUTER_API_KEY");
    expect(notice.textContent ?? "").not.toMatch(/sk-or-v1|bearer/i);
  });

  it("handles a timeout and offers a retry that re-requests", async () => {
    let first = true;
    stubFetch(() => {
      if (first) {
        first = false;
        return {
          status: 200,
          body: analysisResponse({
            status: "TIMEOUT",
            answer: null,
            evidence: [],
            recommendations: [],
            likely_causes: [],
          }),
        };
      }
      return { status: 200, body: analysisResponse() };
    });
    render(<Harness findingId="F-DEGRADED" />);

    expect(await screen.findByTestId("finding-analysis-unavailable")).toHaveTextContent(
      "too long",
    );
    fireEvent.click(screen.getByTestId("finding-retry"));

    expect(await screen.findByTestId("finding-diagnosis")).toBeInTheDocument();
    expect(CALLS).toHaveLength(2);
  });

  it("handles a rate limit", async () => {
    stubFetch(() => ({
      status: 200,
      body: analysisResponse({
        status: "RATE_LIMITED",
        answer: null,
        evidence: [],
        recommendations: [],
        likely_causes: [],
      }),
    }));
    render(<Harness findingId="F-DEGRADED" />);
    expect(await screen.findByTestId("finding-analysis-unavailable")).toHaveTextContent(
      "rate-limited",
    );
  });

  it("handles a network failure", async () => {
    stubFetch(() => {
      throw new Error("connection refused");
    });
    render(<Harness findingId="F-DEGRADED" />);

    expect(await screen.findByTestId("finding-analysis-error")).toHaveTextContent(
      "API unreachable",
    );
    expect(screen.getByTestId("finding-retry")).toBeInTheDocument();
  });
});

describe("FindingAnalysis — issue-scoped follow-ups", () => {
  it("keeps follow-ups bound to the selected finding and its conversation", async () => {
    okAnalysis();
    render(<Harness findingId="F-DEGRADED" />);
    await screen.findByTestId("finding-diagnosis");

    fireEvent.change(screen.getByTestId("finding-followup-input"), {
      target: { value: "What should we inspect first?" },
    });
    fireEvent.click(screen.getByTestId("finding-followup-send"));

    await waitFor(() => expect(CALLS).toHaveLength(2));
    const followup = CALLS[1].body!;
    expect(followup.finding_id).toBe("F-DEGRADED");
    expect(followup.question).toBe("What should we inspect first?");
    const history = followup.history as Array<{ role: string; content: string }>;
    expect(Array.isArray(history)).toBe(true);
    expect(history[0].role).toBe("user");
    expect(history).toContainEqual({
      role: "assistant",
      content: expect.stringContaining("degraded"),
    });

    // The answer is appended to the same issue's thread.
    const thread = await screen.findByTestId("finding-followup-thread");
    expect(thread).toHaveTextContent("What should we inspect first?");
    expect(screen.getAllByTestId("finding-followup-turn")).toHaveLength(1);
  });

  it("disables duplicate submissions while a follow-up is in flight", async () => {
    const gate = deferred();
    let calls = 0;
    stubFetch(async (method, url) => {
      if (method === "POST" && url.includes("/api/ai/finding")) {
        calls += 1;
        if (calls === 1) return { status: 200, body: analysisResponse() };
        await gate.promise;
        return {
          status: 200,
          body: analysisResponse({ answer: "Inspect the power first." }),
        };
      }
      return { status: 404, body: { detail: "not found" } };
    });
    render(<Harness findingId="F-DEGRADED" />);
    await screen.findByTestId("finding-diagnosis");

    const input = screen.getByTestId("finding-followup-input");
    const send = screen.getByTestId("finding-followup-send");

    // Empty question → button stays disabled.
    expect(send).toBeDisabled();

    fireEvent.change(input, { target: { value: "   " } });
    expect(send).toBeDisabled();

    fireEvent.change(input, { target: { value: "What should we inspect first?" } });
    expect(send).not.toBeDisabled();

    fireEvent.click(send);
    await waitFor(() => expect(send).toBeDisabled());
    expect(send).toHaveTextContent("Sending");

    // Rapid re-submissions are ignored while pending.
    fireEvent.click(send);
    fireEvent.click(send);

    gate.release();
    await screen.findByTestId("finding-followup-thread");
    expect(screen.getAllByTestId("finding-followup-turn")).toHaveLength(1);
    expect(CALLS).toHaveLength(2);
  });

  it("surfaces a per-question provider failure inside the thread", async () => {
    let calls = 0;
    stubFetch((method, url) => {
      if (method !== "POST" || !url.includes("/api/ai/finding"))
        return { status: 404, body: { detail: "not found" } };
      calls += 1;
      if (calls === 1) return { status: 200, body: analysisResponse() };
      return {
        status: 200,
        body: analysisResponse({
          status: "RATE_LIMITED",
          answer: null,
          evidence: [],
          recommendations: [],
          likely_causes: [],
        }),
      };
    });
    render(<Harness findingId="F-DEGRADED" />);
    await screen.findByTestId("finding-diagnosis");

    fireEvent.change(screen.getByTestId("finding-followup-input"), {
      target: { value: "How can we verify the issue is resolved?" },
    });
    fireEvent.click(screen.getByTestId("finding-followup-send"));

    const err = await screen.findByTestId("finding-followup-error");
    expect(err).toHaveTextContent("rate-limited");
    // The conversation stays visible and usable.
    expect(screen.getByTestId("finding-analysis")).toBeInTheDocument();
  });

  it("offers the suggested follow-up questions for the finding", async () => {
    okAnalysis();
    render(<Harness findingId="F-DEGRADED" />);
    await screen.findByTestId("finding-diagnosis");

    const suggestions = screen.getAllByTestId("finding-followup-suggestion");
    const labels = suggestions.map((s) => s.textContent);
    expect(labels).toContain("What should we inspect first?");
    expect(labels).toContain("How can we verify the issue is resolved?");
    expect(labels).toContain("What evidence supports this diagnosis?");
    expect(labels).toContain("What could be the likely cause of this issue?");
    expect(labels).toContain("How does this issue affect sustainability performance?");
  });
});

describe("FindingAnalysis — switching findings", () => {
  it("resets the conversation and evidence when a different issue is opened", async () => {
    stubFetch((method, _url, body) => {
      if (method !== "POST") return { status: 404, body: { detail: "not found" } };
      const id = String(body?.finding_id ?? "");
      return {
        status: 200,
        body: analysisResponse({
          answer: `Analysis for ${id}.`,
          finding_id: id,
          context: {
            scope: "FINDING",
            space_id: null,
            storey_id: null,
            finding_id: id,
            sensor_location_mapping: "UNRESOLVED",
            mapped_sensors: 0,
            total_sensors: 36,
            measured_energy_available: false,
            historical_replay: false,
            has_webcam_occupancy: false,
            room_telemetry_available: false,
            data_sources: ["DIAGNOSTIC_FINDING"],
          },
        }),
      };
    });

    const view = render(<Harness findingId="F-DEGRADED" />);
    expect(await screen.findByTestId("finding-diagnosis")).toHaveTextContent(
      "Analysis for F-DEGRADED.",
    );

    // Ask a follow-up on the first finding.
    fireEvent.change(screen.getByTestId("finding-followup-input"), {
      target: { value: "Tell me more about this sensor." },
    });
    fireEvent.click(screen.getByTestId("finding-followup-send"));
    await waitFor(() => expect(screen.getAllByTestId("finding-followup-turn")).toHaveLength(1));

    // Open a different finding.
    view.rerender(<Harness findingId="F-ROOM" />);

    expect(await screen.findByTestId("finding-diagnosis")).toHaveTextContent(
      "Analysis for F-ROOM.",
    );
    // No leakage of the previous issue's conversation.
    expect(screen.queryByTestId("finding-followup-thread")).not.toBeInTheDocument();
    expect(screen.queryByText("Tell me more about this sensor.")).not.toBeInTheDocument();
    expect(CALLS[CALLS.length - 1].body).toEqual({ finding_id: "F-ROOM" });
  });
});
