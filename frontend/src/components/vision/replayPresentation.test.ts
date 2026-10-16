import { describe, expect, it } from "vitest";
import type { ReplayChannel } from "../../api/types";
import {
  ENERGY_TYPES,
  REPLAY_RUNNING_LABEL,
  REPLAY_SOURCE_LABEL,
  ROOM_TELEMETRY_UNMAPPED_LABEL,
  UNAVAILABLE_LABEL,
  formatLag,
  hasEnergy,
  latestByType,
  pickTypes,
  replayLagSeconds,
  roomTelemetryLabel,
  roomTelemetryState,
} from "./replayPresentation";

function channel(over: Partial<ReplayChannel>): ReplayChannel {
  return {
    sensor_id: "s1",
    measurement_type: "temperature",
    unit: "C",
    value: 21.5,
    timestamp: "2025-06-01T00:00:00",
    location_status: "UNKNOWN_LOCATION",
    ...over,
  };
}

describe("replay presentation", () => {
  it("never attributes room telemetry without a verified mapping", () => {
    expect(roomTelemetryState(0)).toBe("UNMAPPED");
    expect(roomTelemetryState(null)).toBe("UNMAPPED");
    expect(roomTelemetryState(undefined)).toBe("UNMAPPED");
    expect(roomTelemetryLabel("UNMAPPED")).toBe(ROOM_TELEMETRY_UNMAPPED_LABEL);
    // Only a positive verified count is treated as mapped.
    expect(roomTelemetryState(2)).toBe("ROOM_MAPPED");
  });

  it("labels replayed data distinctly from live measurement", () => {
    expect(REPLAY_SOURCE_LABEL).toBe("HISTORICAL REPLAY");
    expect(REPLAY_RUNNING_LABEL).toBe("SIMULATED LIVE");
    expect(REPLAY_SOURCE_LABEL).not.toBe(REPLAY_RUNNING_LABEL);
    expect(UNAVAILABLE_LABEL).toBe("UNAVAILABLE");
  });

  it("keeps the most recent channel per measurement type, verbatim", () => {
    const views = latestByType(
      [
        channel({ measurement_type: "temperature", value: 20, timestamp: "2025-06-01T00:00:00" }),
        channel({ measurement_type: "temperature", value: 23.4, timestamp: "2025-06-01T03:00:00" }),
        channel({ measurement_type: "co2", unit: "ppm", value: 640, timestamp: "2025-06-01T02:00:00" }),
      ],
      "2025-06-01T03:00:00",
    );

    expect(views.map((v) => v.measurement_type)).toEqual(["co2", "temperature"]);
    const temp = views.find((v) => v.measurement_type === "temperature");
    expect(temp?.value).toBe(23.4);
    expect(temp?.unit).toBe("C");
    expect(temp?.timestamp).toBe("2025-06-01T03:00:00");
    expect(temp?.lag_seconds).toBe(0);
  });

  it("computes replay lag in replay time, never negative", () => {
    expect(replayLagSeconds("2025-06-01T03:00:00", "2025-06-01T00:30:00")).toBe(9000);
    expect(replayLagSeconds("2025-06-01T00:00:00", "2025-06-01T03:00:00")).toBe(0);
    expect(replayLagSeconds(null, "2025-06-01T03:00:00")).toBeNull();
    expect(replayLagSeconds("bad", "also-bad")).toBeNull();
  });

  it("formats lag at human scales", () => {
    expect(formatLag(45)).toBe("45s");
    expect(formatLag(120)).toBe("2m");
    expect(formatLag(3600)).toBe("1h");
    expect(formatLag(5400)).toBe("1h 30m");
    expect(formatLag(90000)).toBe("1d 1h");
    expect(formatLag(null)).toBe("—");
  });

  it("selects environmental and energy channels", () => {
    const views = latestByType(
      [
        channel({ measurement_type: "temperature" }),
        channel({ measurement_type: "energy", unit: "kWh", value: 12 }),
        channel({ measurement_type: "pm2.5", unit: "ug/m3", value: 4 }),
      ],
      "2025-06-01T00:00:00",
    );
    expect(pickTypes(views, ["temperature", "pm2.5"]).map((v) => v.measurement_type)).toEqual([
      "pm2.5",
      "temperature",
    ]);
    expect(hasEnergy(views)).toBe(true);
    expect(pickTypes(views, ENERGY_TYPES)).toHaveLength(1);

    const noEnergy = latestByType([channel({ measurement_type: "humidity" })], "2025-06-01T00:00:00");
    expect(hasEnergy(noEnergy)).toBe(false);
  });
});
