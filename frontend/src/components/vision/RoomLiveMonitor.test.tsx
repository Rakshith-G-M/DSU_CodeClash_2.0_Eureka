import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RoomLiveMonitor } from "./RoomLiveMonitor";
import { VisionProvider } from "../../vision/VisionProvider";
import {
  DEMO_MAPPING_STORAGE_KEY,
  DEMO_MAPPING_SCHEMA_VERSION,
} from "../../vision/demoMapping";
import { mockFetch, sampleDashboard, sampleSpaces, sampleReplayState, unmockFetch } from "../../test/setup";

const ROOM = "space_3U1W8Xs6L9pRXU5Afk5MW1";

function renderMonitor(spaceId: string = ROOM, storeyId: string | null = "storey_3. korrus") {
  return render(
    <VisionProvider>
      <RoomLiveMonitor spaceId={spaceId} storeyId={storeyId} />
    </VisionProvider>,
  );
}

function seedMappingToOtherRoom() {
  window.localStorage.setItem(
    DEMO_MAPPING_STORAGE_KEY,
    JSON.stringify({
      schema_version: DEMO_MAPPING_SCHEMA_VERSION,
      kind: "DEMO_MAPPING",
      space_id: "space_OTHER_ROOM",
      space_name: "999",
      storey_id: "storey_1",
      storey_name: "1. korrus",
      created_at: "2026-01-01T00:00:00.000Z",
      note: "demo",
    }),
  );
}

afterEach(() => {
  unmockFetch();
  try {
    window.localStorage.clear();
  } catch {
    // ignore
  }
});

describe("RoomLiveMonitor", () => {
  it("shows the camera as not set up when no demo mapping exists", async () => {
    mockFetch((_m, url) => {
      if (url.includes("/api/dashboard/summary")) return sampleDashboard();
      if (url.includes("/api/replay/current")) return sampleReplayState();
      return { status: 404, body: { detail: "not found" } };
    });

    renderMonitor();

    await waitFor(() => expect(screen.getByTestId("room-live-monitor")).toBeInTheDocument());
    expect(screen.getByTestId("room-camera-unmapped")).toBeInTheDocument();
    expect(screen.getByTestId("room-camera-associate")).toBeInTheDocument();
    // The active camera source is always explicit.
    expect(screen.getByText(/Development webcam/i)).toBeInTheDocument();
  });

  it("associates the current room and reveals the occupancy card", async () => {
    mockFetch((_m, url) => {
      if (url.includes("/api/dashboard/summary")) return sampleDashboard();
      if (url.includes("/api/replay/current")) return sampleReplayState();
      if (url.includes("/api/spaces")) return sampleSpaces();
      return { status: 404, body: { detail: "not found" } };
    });

    renderMonitor();

    await waitFor(() => screen.getByTestId("room-camera-associate"));
    fireEvent.click(screen.getByTestId("room-camera-associate"));

    await waitFor(() => expect(screen.getByTestId("room-camera")).toBeInTheDocument());
    expect(screen.queryByTestId("room-camera-unmapped")).toBeNull();
    expect(screen.getAllByText(/DEMO MAPPING/i).length).toBeGreaterThan(0);
  });

  it("never silently transfers an association made for another room", async () => {
    seedMappingToOtherRoom();
    mockFetch((_m, url) => {
      if (url.includes("/api/dashboard/summary")) return sampleDashboard();
      if (url.includes("/api/replay/current")) return sampleReplayState();
      return { status: 404, body: { detail: "not found" } };
    });

    renderMonitor(ROOM);

    await waitFor(() => expect(screen.getByTestId("room-camera-unmapped")).toBeInTheDocument());
    // The other room is named, and the card is NOT auto-attributed.
    expect(screen.getByText(/Room 999/)).toBeInTheDocument();
    expect(screen.queryByTestId("room-camera")).toBeNull();
    expect(screen.getByTestId("room-camera-associate").textContent).toMatch(/move camera/i);
  });

  it("lets the operator remove the association and sample data stays labelled", async () => {
    mockFetch((_m, url) => {
      if (url.includes("/api/dashboard/summary")) return sampleDashboard();
      if (url.includes("/api/replay/current")) return sampleReplayState();
      if (url.includes("/api/spaces")) return sampleSpaces();
      return { status: 404, body: { detail: "not found" } };
    });

    renderMonitor();
    await waitFor(() => screen.getByTestId("room-camera-associate"));
    fireEvent.click(screen.getByTestId("room-camera-associate"));
    await waitFor(() => screen.getByTestId("room-camera"));

    fireEvent.click(screen.getByTestId("room-sample-toggle"));
    await waitFor(() =>
      expect(screen.getByTestId("room-occupancy-count").textContent).toBe("3"),
    );
    expect(screen.getByText(/not a camera observation/i)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("room-camera-unlink"));
    await waitFor(() => expect(screen.getByTestId("room-camera-unmapped")).toBeInTheDocument());
  });
});
