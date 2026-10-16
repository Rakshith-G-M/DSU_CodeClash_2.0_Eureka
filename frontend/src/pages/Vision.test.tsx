import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { VisionPage } from "./Vision";
import { VisionProvider } from "../vision/VisionProvider";
import {
  DEMO_MAPPING_SCHEMA_VERSION,
  DEMO_MAPPING_STORAGE_KEY,
} from "../vision/demoMapping";
import {
  mockFetch,
  sampleDashboard,
  sampleSpaces,
  unmockFetch,
} from "../test/setup";

const ROOM = "space_3U1W8Xs6L9pRXU5Afk5MW1";

afterEach(() => {
  unmockFetch();
  try {
    window.localStorage.clear();
  } catch {
    // ignore
  }
});

function renderVision() {
  mockFetch((_method, url) => {
    if (url.includes("/api/dashboard/summary")) return sampleDashboard();
    if (url.includes("/api/spaces")) return sampleSpaces();
    return { status: 404, body: { detail: "not found" } };
  });
  return render(
    <MemoryRouter>
      <VisionProvider>
        <VisionPage />
      </VisionProvider>
    </MemoryRouter>,
  );
}

function seedMapping() {
  window.localStorage.setItem(
    DEMO_MAPPING_STORAGE_KEY,
    JSON.stringify({
      schema_version: DEMO_MAPPING_SCHEMA_VERSION,
      kind: "DEMO_MAPPING",
      space_id: ROOM,
      space_name: "114",
      storey_id: "storey_1",
      storey_name: "3. korrus",
      created_at: "2026-01-01T00:00:00.000Z",
      note: "demo",
    }),
  );
}

describe("VisionPage (CV-1 → CV-2)", () => {
  it("surfaces the real, unresolved camera→room mapping status from the API", async () => {
    renderVision();
    await waitFor(() =>
      expect(screen.getByTestId("mapping-banner").textContent).toContain("UNRESOLVED"),
    );
    expect(screen.getByTestId("mapping-banner").textContent).toContain("0 verified");
    expect(screen.getByTestId("mapping-banner").textContent).toContain("38 unresolved");
  });

  it("handles a missing camera gracefully and shows no occupancy reading", async () => {
    renderVision();
    expect(screen.getAllByText(/camera unsupported/i).length).toBeGreaterThan(0);
    expect((screen.getByTestId("camera-start") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("occupancy-count").textContent).toBe("—");
  });

  it("labels simulated data clearly and never as a live camera observation", async () => {
    renderVision();
    fireEvent.click(screen.getByTestId("sample-toggle"));

    await waitFor(() =>
      expect(screen.getByTestId("occupancy-count").textContent).toBe("3"),
    );
    expect(screen.getByText(/SAMPLE DATA — not a camera observation/i)).toBeTruthy();
    expect(screen.queryByText(/LIVE CAMERA — observed/i)).toBeNull();
  });

  it("states that counts are never attributed to an IFC space by detection", async () => {
    renderVision();
    await waitFor(() =>
      expect(screen.getByTestId("mapping-banner").textContent).toContain(
        "never attributed to an IFC space",
      ),
    );
  });

  it("keeps room association read-only and points configuration to the Digital Twin", async () => {
    renderVision();

    // The old picker is gone; association is configured from the room itself.
    expect(screen.queryByTestId("demo-mapping-select")).toBeNull();
    expect(screen.queryByTestId("demo-mapping-picker")).toBeNull();
    await waitFor(() =>
      expect(screen.getByText(/No room is associated with the camera/i)).toBeInTheDocument(),
    );
  });

  it("reflects an existing association without offering to edit it here", async () => {
    seedMapping();
    renderVision();

    await waitFor(() => expect(screen.getByTestId("demo-mapping-clear")).toBeInTheDocument());
    expect(screen.getAllByText(/DEMO MAPPING/i).length).toBeGreaterThan(0);
    expect(screen.queryByTestId("demo-mapping-select")).toBeNull();
  });
});
