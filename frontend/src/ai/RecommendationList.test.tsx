// Tests for the shared, action-first recommendation renderer.
//
// Presentation only: the primary (highest-priority) action is shown as the
// "Next action"; the rest become a compact ordered list. The content of each
// recommendation is never changed.

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { AiRecommendation } from "../api/types";
import { byPriority } from "./presentation";
import { RecommendationList } from "./RecommendationList";

function rec(overrides: Partial<AiRecommendation>): AiRecommendation {
  return {
    title: "Action",
    opportunity: "",
    evidence: "",
    action: "Do the thing.",
    expected_impact_direction: "unknown",
    assumptions: "",
    limitations: "",
    impact_status: "UNKNOWN",
    ...overrides,
  };
}

describe("byPriority", () => {
  it("orders HIGH before MEDIUM before LOW and keeps unknown last", () => {
    const ordered = byPriority([
      rec({ title: "low", priority: "LOW" }),
      rec({ title: "none" }),
      rec({ title: "high", priority: "HIGH" }),
      rec({ title: "med", priority: "MEDIUM" }),
    ]);
    expect(ordered.map((r) => r.title)).toEqual(["high", "med", "low", "none"]);
  });

  it("keeps the model's original order for equal priority", () => {
    const ordered = byPriority([
      rec({ title: "first", priority: "HIGH" }),
      rec({ title: "second", priority: "HIGH" }),
    ]);
    expect(ordered.map((r) => r.title)).toEqual(["first", "second"]);
  });
});

describe("RecommendationList", () => {
  it("renders the primary action prominently with why and verify", () => {
    render(
      <RecommendationList
        itemTestId="r-rec"
        additionalTestId="r-extra"
        recommendations={[
          rec({ title: "Secondary step", priority: "LOW", action: "later" }),
          rec({
            title: "Turn down the setpoint",
            priority: "HIGH",
            action: "Lower the supply-air setpoint by 1°C.",
            why_relevant: "Room is above its comfort band.",
            verification: "Confirm the trend settles within the band.",
            confidence: "MEDIUM",
            impact_status: "QUALITATIVE",
          }),
        ]}
      />,
    );

    const items = screen.getAllByTestId("r-rec");
    expect(items).toHaveLength(2);
    // Highest priority is first, and it is the one the operator sees first.
    expect(items[0]).toHaveTextContent("Turn down the setpoint");
    expect(items[0]).toHaveTextContent("Next action");
    expect(items[0]).toHaveTextContent("Why: Room is above its comfort band.");
    expect(items[0]).toHaveTextContent("Verify: Confirm the trend settles within the band.");
    expect(items[0]).toHaveTextContent("High priority");
    expect(items[0]).toHaveTextContent("Medium confidence");

    // The rest are a compact ordered list.
    expect(screen.getByTestId("r-extra").tagName).toBe("OL");
    expect(items[1]).toHaveTextContent("Secondary step");
  });

  it("renders nothing when there are no recommendations", () => {
    const { container } = render(
      <RecommendationList itemTestId="r-rec" recommendations={[]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
