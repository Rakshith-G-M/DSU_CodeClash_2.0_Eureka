import { describe, expect, it } from "vitest";
import type { AiStatus } from "../api/types";
import {
  IMPACT_LABELS,
  aiStatusIsUnavailable,
  aiStatusMessage,
  causeStatusLabel,
  causeStatusTone,
  impactLabel,
  impactTone,
  priorityLabel,
  priorityTone,
  provenanceIsEstimate,
  provenanceLabel,
  provenanceTone,
  roomStatusLevelLabel,
  scopeLabel,
} from "./presentation";

describe("assistant presentation — honesty labelling", () => {
  it("labels every data category, keeping replay/estimate/design distinct", () => {
    expect(provenanceLabel("VERIFIED_SENSOR")).toBe("Verified sensor");
    expect(provenanceLabel("WEBCAM_ESTIMATE")).toBe("Webcam estimate");
    expect(provenanceLabel("SAMPLE_SIMULATION")).toBe("Sample / simulated");
    expect(provenanceLabel("HISTORICAL_REPLAY")).toBe("Historical replay");
    expect(provenanceLabel("IFC_DESIGN")).toBe("IFC design spec");
    expect(provenanceLabel("PREDICTION")).toBe("Prediction");
    // A historical replay must never be presented as a live reading.
    expect(provenanceLabel("HISTORICAL_REPLAY")).not.toBe(
      provenanceLabel("VERIFIED_SENSOR"),
    );
  });

  it("falls back safely for an unknown provenance kind", () => {
    expect(provenanceLabel("NOT_A_REAL_KIND" as never)).toBe("Not available");
    expect(provenanceTone("NOT_A_REAL_KIND" as never)).toBe("dim");
  });

  it("marks estimates as non-measured figures", () => {
    expect(provenanceIsEstimate("WEBCAM_ESTIMATE")).toBe(true);
    expect(provenanceIsEstimate("SAMPLE_SIMULATION")).toBe(true);
    expect(provenanceIsEstimate("PREDICTION")).toBe(true);
    expect(provenanceIsEstimate("VERIFIED_SENSOR")).toBe(false);
    expect(provenanceIsEstimate("HISTORICAL_REPLAY")).toBe(false);
    expect(provenanceIsEstimate("IFC_DESIGN")).toBe(false);
  });

  it("never implies an unverified saving", () => {
    expect(impactLabel("UNKNOWN")).toBe("Unknown — not verified");
    expect(impactLabel("MEASURED")).toBe("Measured outcome");
    expect(impactLabel("ESTIMATED")).toBe("Estimated");
    expect(impactLabel("NOT_A_STATUS" as never)).toBe(
      IMPACT_LABELS.UNKNOWN,
    );
    // ESTIMATED/UNKNOWN must not share the 'ok' tone used for measured data.
    expect(impactTone("UNKNOWN")).not.toBe(impactTone("MEASURED"));
  });

  it("labels deterministic room-status levels", () => {
    expect(roomStatusLevelLabel("OVER_CAPACITY")).toBe("Over capacity");
    expect(roomStatusLevelLabel("NORMAL")).toBe("Normal");
    expect(roomStatusLevelLabel("SOMETHING_ELSE")).toBe("SOMETHING_ELSE");
  });

  it("distinguishes room scope from building scope", () => {
    expect(scopeLabel("ROOM")).toBe("Room context");
    expect(scopeLabel("BUILDING")).toBe("Building context");
    expect(scopeLabel("FINDING")).toBe("Finding context");
    // Finding scope must never be presented as room-level telemetry.
    expect(scopeLabel("FINDING")).not.toBe(scopeLabel("ROOM"));
  });

  it("marks likely causes as hypotheses unless data confirms them", () => {
    expect(causeStatusLabel("HYPOTHESIS")).toBe("Hypothesis — to verify");
    expect(causeStatusLabel("CONFIRMED")).toBe("Confirmed by data");
    expect(causeStatusLabel("UNKNOWN")).toBe("Unconfirmed");
    expect(causeStatusLabel("NOT_A_STATUS" as never)).toBe("Unconfirmed");
    // A hypothesis must not carry the confident 'ok' tone.
    expect(causeStatusTone("HYPOTHESIS")).not.toBe(causeStatusTone("CONFIRMED"));
  });

  it("labels recommendation priority in descending severity", () => {
    expect(priorityLabel("HIGH")).toBe("High priority");
    expect(priorityLabel("medium")).toBe("Medium priority");
    expect(priorityLabel("LOW")).toBe("Low priority");
    expect(priorityLabel("")).toBeNull();
    expect(priorityLabel("NOT_A_PRIORITY")).toBeNull();
    expect(priorityTone("HIGH")).toBe("danger");
    expect(priorityTone("LOW")).toBe("info");
  });
});

describe("assistant presentation — status messages", () => {
  const ALL: AiStatus[] = [
    "OK",
    "NOT_CONFIGURED",
    "RATE_LIMITED",
    "QUOTA_EXHAUSTED",
    "TIMEOUT",
    "PROVIDER_ERROR",
    "MALFORMED",
    "INVALID_INPUT",
  ];

  it("tells the user how to configure a missing key without leaking secrets", () => {
    const msg = aiStatusMessage("NOT_CONFIGURED", null);
    expect(msg).toContain("OPENROUTER_API_KEY");
    expect(msg).not.toMatch(/sk-or-v1|bearer|api[_-]?key\s*[:=]\s*\S+/i);
  });

  it("prefers the backend-provided message when present", () => {
    expect(aiStatusMessage("RATE_LIMITED", "Provider busy, retry soon.")).toBe(
      "Provider busy, retry soon.",
    );
    // Blank messages fall back to the standard copy.
    expect(aiStatusMessage("RATE_LIMITED", "   ")).toContain("rate-limited");
  });

  it("has user-friendly copy for every failure code", () => {
    for (const status of ALL) {
      const msg = aiStatusMessage(status, null);
      expect(msg.length).toBeGreaterThan(10);
      // No stack traces, no internal paths, no secrets.
      expect(msg).not.toMatch(/Traceback|File "\/|sk-or-v1/);
    }
  });

  it("marks every non-OK status as unavailable", () => {
    expect(aiStatusIsUnavailable("OK")).toBe(false);
    for (const status of ALL.filter((s) => s !== "OK")) {
      expect(aiStatusIsUnavailable(status)).toBe(true);
    }
  });
});
