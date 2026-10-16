// CV-1 — Camera occupancy module types.
//
// These types are intentionally self-contained so the computer-vision feature
// can be added or removed without touching the digital-twin, telemetry or
// rule-based intelligence code paths.

/**
 * Lifecycle of the local camera stream.
 *
 * UNSUPPORTED      — `navigator.mediaDevices` is not available in this browser
 * INSECURE_CONTEXT — getUserMedia requires HTTPS or http://localhost
 * IDLE             — camera is available and ready to start
 * REQUESTING       — awaiting the user's permission decision
 * STREAMING        — camera is live and frames are being processed locally
 * DENIED           — the user (or policy) blocked camera access
 * NO_DEVICE        — no camera device is attached / constraints unsatisfiable
 * IN_USE           — the camera is held by another application
 * ERROR            — any other unexpected failure
 */
export type CameraStatus =
  | "UNSUPPORTED"
  | "INSECURE_CONTEXT"
  | "IDLE"
  | "REQUESTING"
  | "STREAMING"
  | "DENIED"
  | "NO_DEVICE"
  | "IN_USE"
  | "ERROR";

/**
 * Where an occupancy reading came from.
 *
 * LIVE_CAMERA — produced by the on-device detector from the live camera frame.
 * SAMPLE      — deterministic synthetic data used only for demos with no
 *               camera. The two must never be conflated in the UI.
 */
export type OccupancySource = "LIVE_CAMERA" | "SAMPLE";

/**
 * How a camera is associated with an IFC space.
 *
 * DEMO_MAPPING           — an operator explicitly configured this association
 *                          in the UI (stored client-side). It is NOT a verified
 *                          physical installation and is NOT evidence that any
 *                          telemetry belongs to the room.
 * VERIFIED_INSTALLATION  — a mapping confirmed by the backend sensor→space
 *                          artefact. None exists in the current data release
 *                          (0 verified), so this is never shown today.
 */
export type MappingKind = "DEMO_MAPPING" | "VERIFIED_INSTALLATION";

/**
 * A single person detection, in *pixels* relative to the captured video frame
 * (i.e. origin (0,0) is the top-left of `videoWidth x videoHeight`).
 */
export interface PersonDetection {
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
}

/**
 * An occupancy reading.
 *
 * `space_id` is only ever populated when the operator has explicitly configured
 * a demo camera association; it is `null` otherwise. `mapping_kind` records
 * whether that association is an operator demo mapping or a backend-verified
 * installation. A count is never attributed to a room because of what the
 * detector saw.
 */
export interface OccupancyObservation {
  count: number;
  /** Mean detector confidence across matched persons, or null when unsupported. */
  confidence: number | null;
  source: OccupancySource;
  /** Identifier of the camera source that produced this observation. */
  source_id: string;
  model: string;
  scoreThreshold: number;
  timestamp: string | null;
  space_id: string | null;
  mapping_kind: MappingKind | null;
  mapping_status: string;
}
