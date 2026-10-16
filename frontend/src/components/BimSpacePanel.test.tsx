import { afterEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { BimSpacePanel } from "./BimSpacePanel";
import { VisionProvider } from "../vision/VisionProvider";
import type { RoomStatus } from "../lib/roomStatus";
import {
  mockFetch,
  sampleDashboard,
  sampleReplayState,
  unmockFetch,
} from "../test/setup";

const ROOM = "space_3U1W8Xs6L9pRXU5Afk5MW1";

const OVER_CAPACITY_STATUS: RoomStatus = {
  spaceId: ROOM,
  level: "OVER_CAPACITY",
  occupancy: {
    level: "OVER_CAPACITY",
    count: 5,
    capacity: 4,
    capacitySource: "DESIGN",
    demo: true,
    source: "LIVE_CAMERA",
    stale: false,
  },
  issue: null,
};

afterEach(() => {
  unmockFetch();
  try {
    window.localStorage.clear();
  } catch {
    // ignore
  }
});

function renderPanel() {
  return render(
    <MemoryRouter>
      <VisionProvider>
        <BimSpacePanel
          spaceId={ROOM}
          spaceName="114"
          storey="Floor 3"
          storeyId="storey_3"
          area={3.07}
          volume={9.21}
          height={3}
          capacity={0.767}
          occupiable={true}
          conditioning="Heated and cooled"
        />
      </VisionProvider>
    </MemoryRouter>,
  );
}

describe("BimSpacePanel", () => {
  it("renders a clean room overview with the primary occupancy monitor", async () => {
    mockFetch((_m, url) => {
      if (url.includes("/api/dashboard/summary")) return sampleDashboard();
      if (url.includes("/api/replay/current")) return sampleReplayState();
      if (url.includes("bim-design")) return { design: { design_cooling_load_w: 0 } };
      if (url.includes("/api/recommendations")) {
        return { items: [], total: 0, limit: 200, offset: 0, generated_at: "", data_status: {} };
      }
      return { status: 404, body: { detail: "not found" } };
    });

    renderPanel();

    // Header uses a human name, and does not leak the raw space identifier.
    expect(screen.getByText(/space inspector/i)).toBeInTheDocument();
    expect(screen.getByText(/Room 114/)).toBeInTheDocument();
    expect(screen.queryByText(ROOM)).toBeNull();

    await waitFor(() => expect(screen.getByTestId("room-live-monitor")).toBeInTheDocument());
    expect(screen.getByTestId("room-live-monitor-wrap")).toBeInTheDocument();

    // Building telemetry is present but secondary (collapsed <details>).
    const telemetry = screen.getByTestId("building-telemetry");
    expect(telemetry.tagName.toLowerCase()).toBe("details");
    expect((telemetry as HTMLDetailsElement).open).toBe(false);

    // Detailed specs live behind a collapsed section.
    const specs = screen.getByTestId("building-specifications");
    expect(specs.tagName.toLowerCase()).toBe("details");
    expect((specs as HTMLDetailsElement).open).toBe(false);
  });

  it("states room conditions are unavailable rather than fabricating readings", async () => {
    mockFetch((_m, url) => {
      if (url.includes("/api/replay/current")) return sampleReplayState();
      if (url.includes("bim-design")) return { design: { design_cooling_load_w: 500 } };
      if (url.includes("/api/recommendations")) {
        return { items: [], total: 0, limit: 200, offset: 0, generated_at: "", data_status: {} };
      }
      return { status: 404, body: { detail: "not found" } };
    });

    renderPanel();

    await waitFor(() =>
      expect(screen.getByText(/no sensor has a verified location/i)).toBeInTheDocument(),
    );
    // No room-level temperature reading is invented.
    expect(screen.queryByText(/°C/)).toBeNull();
    // Room-scoped insights are honestly reported as unavailable.
    await waitFor(() =>
      expect(screen.getByText(/No rule-based recommendation is attributed/i)).toBeInTheDocument(),
    );
  });

  it("treats zero specification values as 'not specified', not as absence", async () => {
    mockFetch((_m, url) => {
      if (url.includes("/api/replay/current")) return sampleReplayState();
      if (url.includes("bim-design")) {
        return { design: { design_cooling_load_w: 0, design_heating_load_w: 1200 } };
      }
      if (url.includes("/api/recommendations")) {
        return { items: [], total: 0, limit: 200, offset: 0, generated_at: "", data_status: {} };
      }
      return { status: 404, body: { detail: "not found" } };
    });

    renderPanel();

    await waitFor(() => expect(screen.getByText("Not specified")).toBeInTheDocument());
    expect(screen.getByText(/1,200 W/)).toBeInTheDocument();
    expect(screen.getByText(/does not specify this property/i)).toBeInTheDocument();
  });

  it("shows the resolved room status from the same source as the mesh", async () => {
    mockFetch((_m, url) => {
      if (url.includes("/api/dashboard/summary")) return sampleDashboard();
      if (url.includes("/api/replay/current")) return sampleReplayState();
      if (url.includes("bim-design")) return { design: {} };
      if (url.includes("/api/recommendations")) {
        return { items: [], total: 0, limit: 200, offset: 0, generated_at: "", data_status: {} };
      }
      return { status: 404, body: { detail: "not found" } };
    });

    render(
      <MemoryRouter>
        <VisionProvider>
          <BimSpacePanel
            spaceId={ROOM}
            spaceName="114"
            storey="Floor 3"
            storeyId="storey_3"
            area={3.07}
            volume={9.21}
            height={3}
            capacity={4}
            occupiable={true}
            conditioning="Heated and cooled"
            status={OVER_CAPACITY_STATUS}
          />
        </VisionProvider>
      </MemoryRouter>,
    );

    const pill = await screen.findByTestId("room-status-pill");
    expect(pill.getAttribute("data-status-level")).toBe("OVER_CAPACITY");
    // The headline is honest about the demo association.
    expect(screen.getByText(/Over capacity \(DEMO estimate\)/i)).toBeInTheDocument();
    expect(screen.getByText(/declared design capacity 4/)).toBeInTheDocument();
  });
});
