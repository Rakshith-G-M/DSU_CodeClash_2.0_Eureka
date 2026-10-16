// Tests for the integrated, room-scoped AI surface.
//
// The vision context is mocked (no camera / no MediaPipe) and every provider
// response is served from a fetch stub — the suite never touches OpenRouter and
// never needs a real API key.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AiResponse } from "../api/types";
import type { OccupancyObservation } from "../components/vision/visionTypes";
import type { RoomStatus } from "../lib/roomStatus";
import { unmockFetch } from "../test/setup";

// ── vision context stub (no camera in jsdom) ─────────────────────────────────
let mockVisionState: {
  demoMapping: { space_id: string } | null;
  observation: OccupancyObservation | null;
} = { demoMapping: null, observation: null };

vi.mock("../vision/visionContext", () => ({
  useVision: () => mockVisionState,
}));

import { RoomAnalysis } from "./RoomAnalysis";

const ROOM = "space_3U1W8Xs6L9pRXU5Afk5MW1";
const OTHER = "space_ZZZZZZZZZZZZZZZZZZZZZZ";

// ── fetch stub that captures request bodies ──────────────────────────────────
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
        out !== null && typeof out === "object" && "status" in (out as object);
      const body = wrapped ? (out as { body: unknown }).body : out;
      const status = wrapped ? (out as { status: number }).status : 200;
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    },
  );
}

// ── fixtures ─────────────────────────────────────────────────────────────────
function roomStatus(overrides: Partial<RoomStatus> = {}): RoomStatus {
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

function observation(overrides: Partial<OccupancyObservation> = {}): OccupancyObservation {
  return {
    count: 3,
    confidence: 0.8,
    source: "LIVE_CAMERA",
    source_id: "webcam",
    model: "m",
    scoreThreshold: 0.3,
    timestamp: "2026-01-01T10:00:00",
    space_id: ROOM,
    mapping_kind: "DEMO_MAPPING",
    mapping_status: "DEMO_MAPPING",
    ...overrides,
  };
}

function analysisResponse(version: string, answer = "Room looks normal."): AiResponse {
  return {
    status: "OK",
    provider: "openrouter",
    model: "nvidia/nemotron-3.5-lightning:free",
    message: null,
    answer,
    evidence: [
      {
        claim: "Camera occupancy estimate",
        source: "webcam",
        value: "3 people",
        provenance: "WEBCAM_ESTIMATE",
        reference: null,
      },
      {
        claim: "Declared design capacity",
        source: "ifc_design",
        value: "10 people",
        provenance: "IFC_DESIGN",
        reference: "space-1",
      },
    ],
    likely_causes: [
      {
        cause: "Normal working occupancy",
        basis: "count within design capacity",
        status: "HYPOTHESIS",
        confidence: "low",
      },
    ],
    recommendations: [],
    next_checks: ["Confirm the camera association is still correct"],
    assumptions: [],
    limitations: ["Webcam occupancy is an estimate, not a verified sensor."],
    provenance: {
      data_freshness: "live",
      sources: ["webcam", "ifc_design"],
      is_hypothetical: false,
      model: "m",
    },
    deterministic_status: null,
    context: null,
    based_on: {
      space_id: ROOM,
      state_version: version,
      trigger: "INITIAL",
      occupancy_count: 3,
      occupancy_timestamp: "2026-01-01T10:00:00",
      occupancy_source: "LIVE_CAMERA",
      occupancy_is_demo: true,
      occupancy_stale: false,
      status_level: "NORMAL",
      generated_at: "2026-01-01T10:00:01",
    },
    generated_at: "2026-01-01T10:00:01",
  };
}

/** Serve an OK response echoing the client's state_version (never stale). */
function serveEchoing(handler?: (body: Record<string, unknown> | null) => unknown) {
  stubFetch((method, url, body) => {
    if (method === "POST" && url.includes("/api/ai/room")) {
      if (handler) {
        const custom = handler(body);
        if (custom !== undefined) return custom;
      }
      const version = String(body?.state_version ?? "v");
      const question = typeof body?.question === "string" ? body.question : null;
      return {
        status: 200,
        body: analysisResponse(version, question ? "Because reasons." : "Room looks normal."),
      };
    }
    return { status: 404, body: { detail: "not found" } };
  });
}

afterEach(() => {
  unmockFetch();
  mockVisionState = { demoMapping: null, observation: null };
});

describe("RoomAnalysis — automatic, room-scoped analysis", () => {
  it("analyses the room the operator is viewing without restating the problem", async () => {
    mockVisionState = { demoMapping: { space_id: ROOM }, observation: observation() };
    serveEchoing();

    render(<RoomAnalysis spaceId={ROOM} status={roomStatus()} />);

    expect(await screen.findByTestId("room-ai-answer")).toHaveTextContent(
      "Room looks normal.",
    );

    expect(CALLS).toHaveLength(1);
    expect(CALLS[0].url).toContain("/api/ai/room");
    expect(CALLS[0].body?.space_id).toBe(ROOM);
    expect(typeof CALLS[0].body?.state_version).toBe("string");
    expect(CALLS[0].body?.question).toBeNull();
    // The explicitly-associated camera observation travels with the request.
    expect(CALLS[0].body?.observation).toMatchObject({
      count: 3,
      space_id: ROOM,
      mapping_kind: "DEMO_MAPPING",
    });

    // Evidence carries its provenance; limitations are shown; the status the
    // analysis was based on is stated.
    expect(screen.getByTestId("room-ai-evidence")).toHaveTextContent("Webcam estimate");
    expect(screen.getByTestId("room-ai-evidence")).toHaveTextContent("IFC design spec");
    expect(screen.getByTestId("room-ai-limitations")).toHaveTextContent(
      "Webcam occupancy is an estimate",
    );
    expect(screen.getByTestId("room-ai-based-on")).toHaveTextContent("Status:");

    // No secret ever leaves the browser.
    expect(JSON.stringify(CALLS[0].body)).not.toMatch(/sk-or-|authorization|api[_-]?key/i);
  });

  it("never attaches an observation that belongs to another room", async () => {
    mockVisionState = {
      demoMapping: { space_id: OTHER },
      observation: observation({ space_id: OTHER }),
    };
    serveEchoing();

    render(<RoomAnalysis spaceId={ROOM} status={roomStatus()} />);
    await waitFor(() => expect(CALLS).toHaveLength(1));

    expect(CALLS[0].body?.observation).toBeNull();
  });

  it("stays quiet for a room with no determined status, then analyses on request", async () => {
    mockVisionState = { demoMapping: null, observation: null };
    serveEchoing();

    render(<RoomAnalysis spaceId={ROOM} status={null} />);

    expect(screen.getByTestId("room-ai-not-analyzed")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 60));
    expect(CALLS).toHaveLength(0); // nothing was scheduled automatically

    fireEvent.click(screen.getByTestId("room-ai-retry"));
    expect(await screen.findByTestId("room-ai-answer")).toBeInTheDocument();
    expect(CALLS).toHaveLength(1);
    expect(CALLS[0].body?.trigger).toBe("manual");
  });
});

describe("RoomAnalysis — failures and staleness", () => {
  it("shows a retryable error when the provider is not configured", async () => {
    mockVisionState = { demoMapping: { space_id: ROOM }, observation: observation() };
    stubFetch((method, url) => {
      if (method === "POST" && url.includes("/api/ai/room")) {
        return {
          status: 200,
          body: {
            ...analysisResponse("v"),
            status: "NOT_CONFIGURED",
            answer: null,
            message: "No AI provider is configured on the server.",
            based_on: null,
          },
        };
      }
      return { status: 404, body: { detail: "not found" } };
    });

    render(<RoomAnalysis spaceId={ROOM} status={roomStatus()} />);
    expect(await screen.findByTestId("room-ai-error")).toHaveTextContent(
      "No AI provider is configured",
    );
    expect(screen.getByTestId("room-ai-retry")).toBeInTheDocument();
  });

  it("marks the analysis stale when the room state changes", async () => {
    mockVisionState = { demoMapping: { space_id: ROOM }, observation: observation() };
    serveEchoing();

    const { rerender } = render(<RoomAnalysis spaceId={ROOM} status={roomStatus()} />);
    await screen.findByTestId("room-ai-answer");

    // A sustained occupancy change makes the shown analysis stale immediately.
    rerender(
      <RoomAnalysis
        spaceId={ROOM}
        status={roomStatus({
          level: "OVER_CAPACITY",
          occupancy: { ...roomStatus().occupancy!, level: "OVER_CAPACITY", count: 12 },
        })}
      />,
    );

    expect(await screen.findByTestId("room-ai-stale")).toBeInTheDocument();
  });
});

describe("RoomAnalysis — compact status and action-first presentation", () => {
  it("shows a single compact status pill that reads 'Current' when up to date", async () => {
    mockVisionState = { demoMapping: { space_id: ROOM }, observation: observation() };
    serveEchoing();

    render(<RoomAnalysis spaceId={ROOM} status={roomStatus()} />);
    await screen.findByTestId("room-ai-answer");

    expect(screen.getByTestId("room-ai-status")).toHaveTextContent("Current");
    // A stale marker is NOT also shown while the analysis is current.
    expect(screen.queryByTestId("room-ai-stale")).not.toBeInTheDocument();
  });

  it("presents the highest-priority recommendation as the Next action", async () => {
    mockVisionState = { demoMapping: { space_id: ROOM }, observation: observation() };
    serveEchoing((body) => {
      const base = analysisResponse(String(body?.state_version ?? "v"));
      base.recommendations = [
        {
          title: "Log an equipment check",
          opportunity: "",
          evidence: "",
          action: "Add the room to the weekly walk-through.",
          expected_impact_direction: "unknown",
          assumptions: "",
          limitations: "",
          impact_status: "UNKNOWN",
          priority: "LOW",
        },
        {
          title: "Measure CO2 during occupancy",
          opportunity: "",
          evidence: "",
          action: "Take a spot CO2 reading while the room is occupied.",
          expected_impact_direction: "unknown",
          assumptions: "",
          limitations: "",
          impact_status: "UNKNOWN",
          priority: "HIGH",
          why_relevant: "Ventilation cannot be inferred from the camera count.",
          verification: "Compare the reading against the design guideline.",
          confidence: "MEDIUM",
        },
      ];
      return { status: 200, body: base };
    });

    render(<RoomAnalysis spaceId={ROOM} status={roomStatus()} />);
    await screen.findByTestId("room-ai-answer");

    const recs = screen.getAllByTestId("room-ai-recommendation");
    expect(recs).toHaveLength(2);
    // The HIGH action is promoted to the top, ahead of the model's own order.
    expect(recs[0]).toHaveTextContent("Next action");
    expect(recs[0]).toHaveTextContent("Measure CO2 during occupancy");
    expect(recs[0]).toHaveTextContent("High priority");
    expect(recs[0]).toHaveTextContent("Medium confidence");
    // The remaining action is a compact ordered list, not another big card.
    expect(screen.getByTestId("room-ai-additional-actions").tagName).toBe("OL");
    expect(recs[1]).toHaveTextContent("Log an equipment check");
  });

  it("keeps detailed evidence collapsed until the operator expands it", async () => {
    mockVisionState = { demoMapping: { space_id: ROOM }, observation: observation() };
    serveEchoing();

    render(<RoomAnalysis spaceId={ROOM} status={roomStatus()} />);
    await screen.findByTestId("room-ai-answer");

    const evidence = screen.getByTestId("room-ai-evidence");
    const details = evidence.closest("details");
    expect(details).not.toBeNull();
    // Collapsed by default: the detail is available but not shouted.
    expect((details as HTMLDetailsElement).open).toBe(false);
    // The provenance is still present for an operator who looks.
    expect(evidence).toHaveTextContent("Webcam estimate");
  });
});

describe("RoomAnalysis — in-workflow follow-ups", () => {
  it("keeps follow-ups scoped to this room and renders the answer", async () => {
    mockVisionState = { demoMapping: { space_id: ROOM }, observation: observation() };
    serveEchoing();

    render(<RoomAnalysis spaceId={ROOM} status={roomStatus()} />);
    await screen.findByTestId("room-ai-answer");

    fireEvent.change(screen.getByTestId("room-ai-followup-input"), {
      target: { value: "Why is occupancy over capacity?" },
    });
    fireEvent.click(screen.getByTestId("room-ai-followup-send"));

    expect(await screen.findByTestId("room-ai-followup-answer")).toHaveTextContent(
      "Because reasons.",
    );

    const last = CALLS.at(-1)!;
    expect(last.url).toContain("/api/ai/room");
    expect(last.body?.space_id).toBe(ROOM);
    expect(last.body?.question).toBe("Why is occupancy over capacity?");
    expect(last.body?.trigger).toBe("follow_up");
    const history = last.body?.history as Array<{ role: string; content: string }>;
    expect(history.some((t) => t.role === "assistant")).toBe(true);
  });

  it("offers suggestion chips that ask a scoped follow-up", async () => {
    mockVisionState = { demoMapping: { space_id: ROOM }, observation: observation() };
    serveEchoing();

    render(<RoomAnalysis spaceId={ROOM} status={roomStatus()} />);
    await screen.findByTestId("room-ai-answer");

    const chips = screen.getAllByTestId("room-ai-followup-suggestion");
    expect(chips.length).toBeGreaterThan(0);
    fireEvent.click(chips[0]);

    expect(await screen.findByTestId("room-ai-followup-answer")).toBeInTheDocument();
    expect(CALLS.at(-1)!.body?.question).toBe(chips[0].textContent);
  });
});
