// Tests for the reactive room-intelligence hook.
//
// The AI provider is mocked at the `api` boundary, so no network call and no
// API key is ever involved. A short policy keeps the suite fast while still
// exercising debounce, dedup, throttle, cancellation and retry.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { AiResponse } from "../api/types";
import type { RoomStatus } from "../lib/roomStatus";
import type { OccupancyObservation } from "../components/vision/visionTypes";

const { aiRoom } = vi.hoisted(() => ({ aiRoom: vi.fn() }));
vi.mock("../api", () => ({ api: { aiRoom } }));

import {
  useRoomIntelligence,
  type UseRoomIntelligenceParams,
} from "./useRoomIntelligence";
import type { TriggerPolicy } from "./roomIntelligence";

const ROOM = "space_3U1W8Xs6L9pRXU5Afk5MW1";
const OTHER = "space_ZZZZZZZZZZZZZZZZZZZZZZ";
const POLICY: TriggerPolicy = { debounceMs: 20, minRefreshMs: 40, cooldownMs: 20 };

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

function okResponse(stateVersion: string, answer = "Room looks normal."): AiResponse {
  return {
    status: "OK",
    provider: "openrouter",
    model: "nvidia/nemotron-3.5-lightning:free",
    message: null,
    answer,
    evidence: [
      {
        claim: "Camera occupancy 3",
        source: "webcam",
        value: "3",
        provenance: "WEBCAM_ESTIMATE",
        reference: null,
      },
    ],
    likely_causes: [],
    recommendations: [],
    next_checks: [],
    assumptions: [],
    limitations: [],
    provenance: {
      data_freshness: "live",
      sources: ["webcam"],
      is_hypothetical: false,
      model: "m",
    },
    deterministic_status: null,
    context: null,
    based_on: {
      space_id: ROOM,
      state_version: stateVersion,
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

function notConfiguredResponse(): AiResponse {
  return {
    ...okResponse("v"),
    status: "NOT_CONFIGURED",
    answer: null,
    message: "No AI provider is configured on the server.",
    based_on: null,
  };
}

/** Echo the client's state_version so a response is never spuriously stale. */
function echoVersions(answer = "Room looks normal.") {
  aiRoom.mockImplementation((body: { state_version?: string; question?: string }) =>
    Promise.resolve(
      okResponse(body.state_version ?? "v", body.question ? "Because reasons." : answer),
    ),
  );
}

function baseParams(
  overrides: Partial<UseRoomIntelligenceParams> = {},
): UseRoomIntelligenceParams {
  return {
    spaceId: ROOM,
    status: roomStatus(),
    observation: observation(),
    enabled: true,
    policy: POLICY,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("useRoomIntelligence — automatic analysis", () => {
  it("analyses a room once on open, sending the room id + state version + association", async () => {
    echoVersions();
    const { result } = renderHook((p: UseRoomIntelligenceParams) => useRoomIntelligence(p), {
      initialProps: baseParams(),
    });

    await waitFor(() => expect(aiRoom).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.phase).toBe("CURRENT"));

    const body = aiRoom.mock.calls[0][0];
    expect(body.space_id).toBe(ROOM);
    expect(typeof body.state_version).toBe("string");
    expect(body.trigger).toBe("INITIAL");
    expect(body.question).toBeNull();
    expect(body.observation).toMatchObject({
      count: 3,
      space_id: ROOM,
      mapping_kind: "DEMO_MAPPING",
    });
    expect(result.current.response?.answer).toBe("Room looks normal.");
  });

  it("does not re-request for repeated identical detections (dedup)", async () => {
    echoVersions();
    const { rerender } = renderHook(
      (p: UseRoomIntelligenceParams) => useRoomIntelligence(p),
      { initialProps: baseParams() },
    );
    await waitFor(() => expect(aiRoom).toHaveBeenCalledTimes(1));

    // Same occupancy count, only a newer observation timestamp.
    rerender(
      baseParams({ observation: observation({ timestamp: "2026-01-01T10:00:05" }) }),
    );
    rerender(
      baseParams({ observation: observation({ timestamp: "2026-01-01T10:00:09" }) }),
    );
    await new Promise((r) => setTimeout(r, 80));

    expect(aiRoom).toHaveBeenCalledTimes(1);
  });

  it("does not re-request while the count flickers without settling", async () => {
    echoVersions();
    const { rerender } = renderHook(
      (p: UseRoomIntelligenceParams) => useRoomIntelligence(p),
      { initialProps: baseParams() },
    );
    await waitFor(() => expect(aiRoom).toHaveBeenCalledTimes(1));

    // Oscillate within the debounce window, then return to the original value.
    const withCount = (c: number) =>
      baseParams({
        status: roomStatus({ occupancy: { ...roomStatus().occupancy!, count: c } }),
      });
    rerender(withCount(4));
    rerender(withCount(3));
    rerender(withCount(5));
    rerender(withCount(3));

    await new Promise((r) => setTimeout(r, 80));
    expect(aiRoom).toHaveBeenCalledTimes(1);
  });

  it("schedules exactly one throttled re-analysis after a sustained change", async () => {
    echoVersions();
    const { rerender } = renderHook(
      (p: UseRoomIntelligenceParams) => useRoomIntelligence(p),
      { initialProps: baseParams() },
    );
    await waitFor(() => expect(aiRoom).toHaveBeenCalledTimes(1));

    rerender(
      baseParams({
        status: roomStatus({
          level: "OVER_CAPACITY",
          occupancy: {
            ...roomStatus().occupancy!,
            level: "OVER_CAPACITY",
            count: 12,
          },
        }),
      }),
    );

    await waitFor(() => expect(aiRoom).toHaveBeenCalledTimes(2));
    expect(aiRoom.mock.calls[1][0].trigger).toBe("MATERIAL_CHANGE");
    // The deterministic over-capacity status is sent as context only.
    expect(aiRoom.mock.calls[1][0].state_version).toEqual(expect.any(String));
  });
});

describe("useRoomIntelligence — camera association", () => {
  it("never attaches an observation associated with a different room", async () => {
    echoVersions();
    renderHook((p: UseRoomIntelligenceParams) => useRoomIntelligence(p), {
      initialProps: baseParams({ observation: observation({ space_id: OTHER }) }),
    });
    await waitFor(() => expect(aiRoom).toHaveBeenCalledTimes(1));
    expect(aiRoom.mock.calls[0][0].observation).toBeNull();
  });

  it("attaches no observation when there is none", async () => {
    echoVersions();
    renderHook((p: UseRoomIntelligenceParams) => useRoomIntelligence(p), {
      initialProps: baseParams({ observation: null }),
    });
    await waitFor(() => expect(aiRoom).toHaveBeenCalledTimes(1));
    expect(aiRoom.mock.calls[0][0].observation).toBeNull();
  });
});

describe("useRoomIntelligence — room switching", () => {
  it("discards a late response from a room the operator has left", async () => {
    let releaseRoomA!: (v: AiResponse) => void;
    const pendingRoomA = new Promise<AiResponse>((resolve) => {
      releaseRoomA = resolve;
    });
    aiRoom.mockImplementation((body: { space_id: string; state_version?: string }) =>
      body.space_id === ROOM
        ? pendingRoomA
        : Promise.resolve(okResponse(body.state_version ?? "v", "ROOM B ANSWER")),
    );

    const props = baseParams();
    const { result, rerender } = renderHook(
      (p: UseRoomIntelligenceParams) => useRoomIntelligence(p),
      { initialProps: props },
    );
    await waitFor(() => expect(aiRoom).toHaveBeenCalledTimes(1));

    rerender(
      baseParams({
        spaceId: OTHER,
        status: roomStatus({ spaceId: OTHER }),
        observation: observation({ space_id: OTHER }),
      }),
    );
    await waitFor(() => expect(result.current.response?.answer).toBe("ROOM B ANSWER"));

    // Room A's response arrives after the switch — it must be ignored.
    await act(async () => {
      releaseRoomA(okResponse("room-a-version", "ROOM A LATE ANSWER"));
    });
    expect(result.current.response?.answer).toBe("ROOM B ANSWER");
  });

  it("resets the conversation when the room changes", async () => {
    echoVersions();
    const { result, rerender } = renderHook(
      (p: UseRoomIntelligenceParams) => useRoomIntelligence(p),
      { initialProps: baseParams() },
    );
    await waitFor(() => expect(result.current.phase).toBe("CURRENT"));

    await act(async () => {
      await result.current.ask("Why?");
    });
    expect(result.current.turns).toHaveLength(1);

    rerender(
      baseParams({
        spaceId: OTHER,
        status: roomStatus({ spaceId: OTHER }),
        observation: observation({ space_id: OTHER }),
      }),
    );
    await waitFor(() => expect(result.current.turns).toHaveLength(0));
  });
});

describe("useRoomIntelligence — failures and retry", () => {
  it("reports FAILED, then recovers on an explicit retry", async () => {
    aiRoom.mockResolvedValueOnce(notConfiguredResponse());
    aiRoom.mockImplementation((body: { state_version?: string }) =>
      Promise.resolve(okResponse(body.state_version ?? "v", "Recovered.")),
    );

    const { result } = renderHook(
      (p: UseRoomIntelligenceParams) => useRoomIntelligence(p),
      { initialProps: baseParams() },
    );

    await waitFor(() => expect(result.current.phase).toBe("FAILED"));
    expect(result.current.error).toBeTruthy();

    await act(async () => {
      result.current.retry();
    });
    await waitFor(() => expect(result.current.phase).toBe("CURRENT"));
    expect(result.current.response?.answer).toBe("Recovered.");
  });

  it("reports FAILED when the provider throws", async () => {
    aiRoom.mockRejectedValueOnce(new Error("API unreachable — is the backend running?"));
    const { result } = renderHook(
      (p: UseRoomIntelligenceParams) => useRoomIntelligence(p),
      { initialProps: baseParams() },
    );
    await waitFor(() => expect(result.current.phase).toBe("FAILED"));
    expect(result.current.error).toContain("unreachable");
  });

  it("does not auto-request when disabled", async () => {
    echoVersions();
    const { result } = renderHook(
      (p: UseRoomIntelligenceParams) => useRoomIntelligence(p),
      { initialProps: baseParams({ enabled: false }) },
    );
    await new Promise((r) => setTimeout(r, 60));
    expect(aiRoom).not.toHaveBeenCalled();
    expect(result.current.phase).toBe("NOT_ANALYZED");
  });
});

describe("useRoomIntelligence — follow-ups", () => {
  it("keeps a follow-up scoped to the room and carries the prior answer", async () => {
    echoVersions();
    const { result } = renderHook(
      (p: UseRoomIntelligenceParams) => useRoomIntelligence(p),
      { initialProps: baseParams() },
    );
    await waitFor(() => expect(result.current.phase).toBe("CURRENT"));

    await act(async () => {
      await result.current.ask("Why is that?");
    });

    const lastBody = aiRoom.mock.calls.at(-1)![0];
    expect(lastBody.space_id).toBe(ROOM);
    expect(lastBody.question).toBe("Why is that?");
    expect(lastBody.trigger).toBe("follow_up");
    expect(
      (lastBody.history as Array<{ role: string; content: string }>).some(
        (t) => t.role === "assistant" && t.content === "Room looks normal.",
      ),
    ).toBe(true);

    expect(result.current.turns).toHaveLength(1);
    expect(result.current.turns[0].answer?.answer).toBe("Because reasons.");
  });

  it("records a follow-up failure without losing the thread", async () => {
    echoVersions();
    const { result } = renderHook(
      (p: UseRoomIntelligenceParams) => useRoomIntelligence(p),
      { initialProps: baseParams() },
    );
    await waitFor(() => expect(result.current.phase).toBe("CURRENT"));

    aiRoom.mockRejectedValueOnce(new Error("boom"));
    await act(async () => {
      await result.current.ask("Why?");
    });
    expect(result.current.turns).toHaveLength(1);
    expect(result.current.turns[0].error).toContain("boom");
    expect(result.current.turns[0].answer).toBeNull();
  });
});
