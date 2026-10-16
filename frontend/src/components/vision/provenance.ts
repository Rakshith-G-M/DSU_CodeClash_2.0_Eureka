// CV-1 — pure presentation/provenance helpers for the camera occupancy module.
//
// Kept dependency-free (like src/lib/format.ts) so the honesty rules around
// "live vs sample" data are unit-testable in isolation.

import type { CameraStatus, MappingKind, OccupancySource } from "./visionTypes";

/** Exact model identity reported in the UI. */
export const OCCUPANCY_MODEL_NAME =
  "EfficientDet-Lite0 (MediaPipe Tasks Vision)";

/** Detections below this score are ignored by the detector. */
export const OCCUPANCY_SCORE_THRESHOLD = 0.4;

/** Badge text for a real camera observation. */
export const LIVE_SOURCE_LABEL = "LIVE CAMERA — observed";
/** Badge text for simulated demo data. Never shown for real detections. */
export const SAMPLE_SOURCE_LABEL = "SAMPLE DATA — not a camera observation";

/**
 * Badge/label for an operator-configured demo camera→room association. It must
 * never be presented as a verified physical installation.
 */
export const DEMO_MAPPING_LABEL = "DEMO MAPPING — operator configured, not verified";
/** Badge text for a backend-confirmed camera/sensor→room installation. */
export const VERIFIED_INSTALLATION_LABEL = "VERIFIED INSTALLATION";

/** Explanation shown wherever a demo mapping is surfaced. */
export const DEMO_MAPPING_DISCLAIMER =
  "Demo association only: the operator selected this room. It is not a verified " +
  "physical camera installation, and it does not attribute any telemetry to this room.";

export function occupancySourceLabel(source: OccupancySource): string {
  return source === "LIVE_CAMERA" ? LIVE_SOURCE_LABEL : SAMPLE_SOURCE_LABEL;
}

export function occupancySourceTone(source: OccupancySource): "ok" | "warn" {
  return source === "LIVE_CAMERA" ? "ok" : "warn";
}

/** Human label for an association kind; empty string when there is none. */
export function mappingKindLabel(kind: MappingKind | null): string {
  if (kind === "DEMO_MAPPING") return DEMO_MAPPING_LABEL;
  if (kind === "VERIFIED_INSTALLATION") return VERIFIED_INSTALLATION_LABEL;
  return "UNMAPPED";
}

/** Only a backend-verified installation is shown in a positive (ok) tone. */
export function mappingKindTone(kind: MappingKind | null): "ok" | "warn" | "dim" {
  if (kind === "VERIFIED_INSTALLATION") return "ok";
  if (kind === "DEMO_MAPPING") return "warn";
  return "dim";
}

/** Headline string for a reading, e.g. "3 people detected". */
export function occupancyHeadline(
  count: number,
  source: OccupancySource,
): string {
  const noun = count === 1 ? "person" : "people";
  return source === "LIVE_CAMERA"
    ? `${count} ${noun} detected`
    : `${count} ${noun} (simulated)`;
}

/**
 * Operator-facing monitoring state, collapsed from the lower-level camera
 * statuses into the handful of states the room interface needs to show:
 * not started, requesting permission, monitoring, stopped, unavailable.
 */
export type MonitoringState =
  | "NOT_STARTED"
  | "REQUESTING"
  | "MONITORING"
  | "STOPPED"
  | "UNAVAILABLE";

export function monitoringState(
  status: CameraStatus,
  hasStarted: boolean,
): MonitoringState {
  switch (status) {
    case "STREAMING":
      return "MONITORING";
    case "REQUESTING":
      return "REQUESTING";
    case "IDLE":
      return hasStarted ? "STOPPED" : "NOT_STARTED";
    default:
      return "UNAVAILABLE";
  }
}

export function monitoringStateLabel(state: MonitoringState): string {
  switch (state) {
    case "MONITORING":
      return "Monitoring";
    case "REQUESTING":
      return "Requesting permission…";
    case "STOPPED":
      return "Stopped";
    case "NOT_STARTED":
      return "Not started";
    case "UNAVAILABLE":
      return "Camera unavailable";
  }
}

export function monitoringStateTone(
  state: MonitoringState,
): "ok" | "info" | "warn" | "dim" | "danger" {
  switch (state) {
    case "MONITORING":
      return "ok";
    case "REQUESTING":
      return "info";
    case "STOPPED":
    case "NOT_STARTED":
      return "dim";
    case "UNAVAILABLE":
      return "danger";
  }
}

/**
 * Mean detector confidence across matched persons, rounded to 2dp. Returns
 * null when a source does not report scores (so we never invent a confidence).
 */
export function meanDetectionConfidence(
  scores: ReadonlyArray<number>,
): number | null {
  if (scores.length === 0) return null;
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  return Math.round(mean * 100) / 100;
}

export interface CameraStatusInfo {
  label: string;
  tone: "ok" | "warn" | "danger" | "dim" | "info";
  hint: string;
}

/** Human-readable label/tone/hint for a camera lifecycle state. */
export function cameraStatusInfo(status: CameraStatus): CameraStatusInfo {
  switch (status) {
    case "UNSUPPORTED":
      return {
        label: "Camera unsupported",
        tone: "danger",
        hint: "This browser does not expose the MediaDevices API.",
      };
    case "INSECURE_CONTEXT":
      return {
        label: "Insecure context",
        tone: "danger",
        hint: "Camera access requires HTTPS or http://localhost.",
      };
    case "IDLE":
      return {
        label: "Camera idle",
        tone: "dim",
        hint: "Start the camera to begin estimating occupancy.",
      };
    case "REQUESTING":
      return {
        label: "Requesting camera…",
        tone: "info",
        hint: "Waiting for camera permission.",
      };
    case "STREAMING":
      return {
        label: "Camera live",
        tone: "ok",
        hint: "Frames are processed locally in this browser and never uploaded.",
      };
    case "DENIED":
      return {
        label: "Camera permission denied",
        tone: "warn",
        hint: "Allow camera access in the browser, then try again.",
      };
    case "NO_DEVICE":
      return {
        label: "No camera found",
        tone: "warn",
        hint: "No camera device is available on this machine.",
      };
    case "IN_USE":
      return {
        label: "Camera busy",
        tone: "warn",
        hint: "Another application is using the camera.",
      };
    case "ERROR":
    default:
      return {
        label: "Camera error",
        tone: "danger",
        hint: "The camera could not be started.",
      };
  }
}

/**
 * Deterministic, clearly-synthetic occupancy curve for demo mode. Bounded to
 * [0, 4] and varies slowly so it is obviously not a real measurement.
 */
export function simulatedCount(elapsedMs: number): number {
  const seconds = Math.max(0, elapsedMs) / 1000;
  return Math.max(0, Math.round(1 + 1.5 * (1 + Math.sin(seconds / 2))));
}

/** Number of people in a detection set (each entry is one person). */
export function personCount(detections: ReadonlyArray<unknown>): number {
  return detections.length;
}
