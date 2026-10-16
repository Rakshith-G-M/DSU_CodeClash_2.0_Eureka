import { describe, expect, it } from "vitest";
import {
  LIVE_SOURCE_LABEL,
  SAMPLE_SOURCE_LABEL,
  cameraStatusInfo,
  meanDetectionConfidence,
  monitoringState,
  monitoringStateLabel,
  monitoringStateTone,
  occupancyHeadline,
  occupancySourceLabel,
  occupancySourceTone,
  personCount,
  simulatedCount,
} from "./provenance";

describe("CV provenance helpers", () => {
  it("labels live and sample sources distinctly and never conflates them", () => {
    expect(occupancySourceLabel("LIVE_CAMERA")).toBe(LIVE_SOURCE_LABEL);
    expect(occupancySourceLabel("SAMPLE")).toBe(SAMPLE_SOURCE_LABEL);
    expect(LIVE_SOURCE_LABEL).not.toBe(SAMPLE_SOURCE_LABEL);
    // Sample labelling must explicitly say it is not a camera observation.
    expect(SAMPLE_SOURCE_LABEL.toLowerCase()).toContain("not a camera observation");
  });

  it("tones live as ok and sample as warn", () => {
    expect(occupancySourceTone("LIVE_CAMERA")).toBe("ok");
    expect(occupancySourceTone("SAMPLE")).toBe("warn");
  });

  it("describes occupancy with correct plurality and marks simulated data", () => {
    expect(occupancyHeadline(1, "LIVE_CAMERA")).toBe("1 person detected");
    expect(occupancyHeadline(3, "LIVE_CAMERA")).toBe("3 people detected");
    expect(occupancyHeadline(2, "SAMPLE")).toContain("simulated");
  });

  it("maps camera failure states to distinct, actionable info", () => {
    expect(cameraStatusInfo("DENIED").label).toMatch(/denied/i);
    expect(cameraStatusInfo("NO_DEVICE").label).toMatch(/no camera/i);
    expect(cameraStatusInfo("UNSUPPORTED").label).toMatch(/unsupported/i);
    expect(cameraStatusInfo("INSECURE_CONTEXT").label).toMatch(/insecure/i);
    expect(cameraStatusInfo("IN_USE").label).toMatch(/busy/i);
    expect(cameraStatusInfo("STREAMING").tone).toBe("ok");
    // Every state carries a non-empty hint for the UI.
    for (const s of [
      "UNSUPPORTED",
      "INSECURE_CONTEXT",
      "IDLE",
      "REQUESTING",
      "STREAMING",
      "DENIED",
      "NO_DEVICE",
      "IN_USE",
      "ERROR",
    ] as const) {
      expect(cameraStatusInfo(s).hint.length).toBeGreaterThan(0);
    }
  });

  it("produces bounded, integral simulated counts", () => {
    for (let t = 0; t <= 60_000; t += 500) {
      const n = simulatedCount(t);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(4);
    }
  });

  it("counts one person per detection", () => {
    expect(personCount([])).toBe(0);
    expect(personCount([{}, {}, {}])).toBe(3);
  });
});

describe("CV monitoring states", () => {
  it("collapses camera status into operator-facing states", () => {
    expect(monitoringState("IDLE", false)).toBe("NOT_STARTED");
    expect(monitoringState("IDLE", true)).toBe("STOPPED");
    expect(monitoringState("REQUESTING", false)).toBe("REQUESTING");
    expect(monitoringState("STREAMING", true)).toBe("MONITORING");
    for (const s of ["UNSUPPORTED", "INSECURE_CONTEXT", "DENIED", "NO_DEVICE", "IN_USE", "ERROR"] as const) {
      expect(monitoringState(s, true)).toBe("UNAVAILABLE");
    }
  });

  it("labels and tones each monitoring state distinctly", () => {
    expect(monitoringStateLabel("MONITORING")).toMatch(/monitoring/i);
    expect(monitoringStateLabel("REQUESTING")).toMatch(/request/i);
    expect(monitoringStateLabel("STOPPED")).toMatch(/stopped/i);
    expect(monitoringStateLabel("NOT_STARTED")).toMatch(/not started/i);
    expect(monitoringStateLabel("UNAVAILABLE")).toMatch(/unavailable/i);
    expect(monitoringStateTone("MONITORING")).toBe("ok");
    expect(monitoringStateTone("UNAVAILABLE")).toBe("danger");
    expect(monitoringStateTone("NOT_STARTED")).toBe("dim");
  });

  it("never invents a confidence for an empty detection set", () => {
    expect(meanDetectionConfidence([])).toBeNull();
    expect(meanDetectionConfidence([0.5, 0.7])).toBe(0.6);
    expect(meanDetectionConfidence([0.42])).toBe(0.42);
  });
});
