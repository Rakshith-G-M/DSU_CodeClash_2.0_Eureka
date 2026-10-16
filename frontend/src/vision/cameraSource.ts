// Camera-source abstraction.
//
// Acquisition (how frames are obtained) is separated from detection
// (useObjectDetector) and occupancy reporting (the VisionProvider). A source is
// described by a `CameraSourceDescriptor` and realised by a `CameraSourceState`
// that the provider consumes.
//
// The development source is THIS browser's webcam. Production buildings would
// use IP/CCTV cameras; that path is described here as a typed contract but is
// NOT implemented in this build (see docs/CV2_CAMERA_SOURCE_ARCHITECTURE.md).
// We never open a connection we cannot actually serve.

import type { RefObject } from "react";
import type { CameraStatus } from "../components/vision/visionTypes";

/**
 * Where the frames come from.
 *
 * DEV_WEBCAM — the operator's local browser camera (what ships today).
 * IP_CAMERA  — a CCTV/IP camera delivered to the browser through a gateway.
 *              Reserved for production; requires backend ingestion.
 */
export type CameraSourceKind = "DEV_WEBCAM" | "IP_CAMERA";

export interface CameraSourceDescriptor {
  /** Stable identifier, e.g. "dev-webcam" or "cam-<ifc-storey>-01". */
  source_id: string;
  kind: CameraSourceKind;
  /** Human label shown in the UI, e.g. "Development webcam". */
  label: string;
  /**
   * Browser-playable delivery URL for a production IP camera (for example an
   * HLS `.m3u8` or a WebRTC/WHEP endpoint fronted by a gateway). Always null
   * for the development webcam. Must never contain credentials.
   */
  stream_url: string | null;
  /** Short, non-secret description of where this source comes from. */
  note: string | null;
}

/** Live state of one camera source, as consumed by the CV engine. */
export interface CameraSourceState {
  descriptor: CameraSourceDescriptor;
  status: CameraStatus;
  error: string | null;
  stream: MediaStream | null;
  /** The element the CV engine reads frames from. */
  videoRef: RefObject<HTMLVideoElement | null>;
  start: () => Promise<void>;
  stop: () => void;
}

/** The dev webcam that ships today. */
export const DEV_WEBCAM_SOURCE: CameraSourceDescriptor = {
  source_id: "dev-webcam",
  kind: "DEV_WEBCAM",
  label: "Development webcam",
  stream_url: null,
  note: "This laptop's camera, processed locally in the browser. Used for development.",
};

/**
 * Honest state for an IP camera that has been declared but is not wired to a
 * gateway. We never simulate a connection or claim RTSP support works.
 */
export const IP_CAMERA_NOT_IMPLEMENTED =
  "IP camera ingestion needs a secure backend gateway (RTSP/ONVIF → " +
  "browser-playable stream). It is designed but not implemented in this build.";

export function cameraSourceKindLabel(kind: CameraSourceKind): string {
  return kind === "IP_CAMERA" ? "IP camera" : "Development webcam";
}

/** True for sources that require production infrastructure to serve frames. */
export function requiresGateway(descriptor: CameraSourceDescriptor): boolean {
  return descriptor.kind === "IP_CAMERA";
}

/**
 * Anatomy of a production IP-camera source, kept next to the contract so the
 * intended shape is documented in code. Nothing here performs I/O.
 */
export interface IpCameraSourceConfig {
  source_id: string;
  /** Camera-to-room binding using the canonical IFC space identifier. */
  space_id: string;
  /** Gateway-delivered, browser-playable URL (never the raw RTSP URL). */
  stream_url: string;
  /** Non-secret camera metadata for display/audit. */
  vendor: string | null;
  model: string | null;
}
