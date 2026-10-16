// CV-1 — camera stream lifecycle hook.
//
// Owns getUserMedia, the permission/error state machine and cleanup. Kept in
// its own hook (and its own module) so the camera path can never destabilize
// the rest of the app: nothing is imported by twin/telemetry code.

import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { CameraStatus } from "../components/vision/visionTypes";

// 720p is plenty for person counting and keeps per-frame CPU cost low.
const VIDEO_CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  video: {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    facingMode: "environment",
  },
};

/** Map a getUserMedia rejection to a specific, surfaceable status. */
export function mapCameraError(err: unknown): CameraStatus {
  const name = err instanceof DOMException ? err.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "DENIED";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return "NO_DEVICE";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "IN_USE";
    default:
      return "ERROR";
  }
}

/** True when the browser exposes the camera API and we are in a secure context. */
function initialStatus(): CameraStatus {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return "UNSUPPORTED";
  }
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    return "INSECURE_CONTEXT";
  }
  return "IDLE";
}

export interface CameraStreamState {
  status: CameraStatus;
  error: string | null;
  /** The live MediaStream, or null when the camera is not streaming. */
  stream: MediaStream | null;
  /** Attach to the <video> element that should receive the stream. */
  videoRef: RefObject<HTMLVideoElement | null>;
  start: () => Promise<void>;
  stop: () => void;
}

export function useCameraStream(): CameraStreamState {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState<CameraStatus>(initialStatus);
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);

  const stop = useCallback(() => {
    const stream = streamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setStream(null);
    setStatus((prev) =>
      prev === "STREAMING" || prev === "REQUESTING" ? "IDLE" : prev,
    );
    setError(null);
  }, []);

  const start = useCallback(async () => {
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      setStatus("UNSUPPORTED");
      setError("This browser does not support camera access.");
      return;
    }
    if (typeof window !== "undefined" && window.isSecureContext === false) {
      setStatus("INSECURE_CONTEXT");
      setError("Camera access requires a secure context (HTTPS or localhost).");
      return;
    }

    setStatus("REQUESTING");
    setError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia(VIDEO_CONSTRAINTS);
      streamRef.current = stream;
      setStream(stream);
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        video.muted = true;
        try {
          await video.play();
        } catch {
          // Autoplay may require a user gesture; the click that started the
          // camera normally satisfies this. Safe to ignore.
        }
      }
      setStatus("STREAMING");
    } catch (err) {
      setStatus(mapCameraError(err));
      setError(err instanceof Error ? err.message : "Camera could not be started.");
    }
  }, []);

  // Always release the hardware when the component unmounts.
  useEffect(() => {
    return () => {
      const stream = streamRef.current;
      if (stream) {
        for (const track of stream.getTracks()) track.stop();
        streamRef.current = null;
      }
    };
  }, []);

  return { status, error, stream, videoRef, start, stop };
}
