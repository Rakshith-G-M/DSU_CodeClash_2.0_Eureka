import { afterEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { BuildingTelemetry } from "./BuildingTelemetry";
import { mockFetch, sampleReplayState, unmockFetch } from "../../test/setup";

afterEach(() => {
  unmockFetch();
});

describe("BuildingTelemetry", () => {
  it("renders a secondary, collapsible building-telemetry section", async () => {
    mockFetch((_m, url) => {
      if (url.includes("/api/replay/current")) return sampleReplayState();
      return { status: 404, body: { detail: "not found" } };
    });

    render(<BuildingTelemetry />);

    const section = await waitFor(() => screen.getByTestId("building-telemetry"));
    expect(section.tagName.toLowerCase()).toBe("details");
    // Collapsed by default so it stays visually secondary.
    expect((section as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByText(/not room-specific/i)).toBeInTheDocument();
  });

  it("shows friendly channel names and never a raw sensor UUID", async () => {
    mockFetch((_m, url) => {
      if (url.includes("/api/replay/current")) return sampleReplayState();
      return { status: 404, body: { detail: "not found" } };
    });

    render(<BuildingTelemetry />);

    await waitFor(() => expect(screen.getByText(/Temperature Sensor/i)).toBeInTheDocument());
    expect(screen.getByText(/Humidity Sensor/i)).toBeInTheDocument();
    // The seed UUIDs in the replay payload must not leak into the UI.
    expect(screen.queryByText(/04f80f82/i)).toBeNull();
    expect(screen.queryByText(/04f80f82-e206-427c-a913-69758a1ec283/i)).toBeNull();
    // Values keep their verbatim unit.
    expect(screen.getByText(/23.4 C/)).toBeInTheDocument();
  });
});
