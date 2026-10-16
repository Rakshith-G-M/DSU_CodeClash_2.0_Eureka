// Realises a `CameraSourceDescriptor` as a live `CameraSourceState`.
//
// Today only DEV_WEBCAM is functional (it delegates to the existing
// useCameraStream hook, so the browser webcam keeps working unchanged through
// the new contract). IP_CAMERA is declared so the abstraction is real, but it
// returns an honest "not implemented" state rather than a fake connection.

import { useCameraStream } from "./useCameraStream";
import { IP_CAMERA_NOT_IMPLEMENTED } from "../vision/cameraSource";
import type {
  CameraSourceDescriptor,
  CameraSourceState,
} from "../vision/cameraSource";

// Stable no-op callbacks (module scope) so they never change identity.
const noop = () => {};
const noopAsync = async () => {};

export function useCameraSource(
  descriptor: CameraSourceDescriptor,
): CameraSourceState {
  // Always called (rules of hooks). For non-webcam sources its stream is simply
  // not used.
  const webcam = useCameraStream();

  if (descriptor.kind === "DEV_WEBCAM") {
    return {
      descriptor,
      status: webcam.status,
      error: webcam.error,
      stream: webcam.stream,
      videoRef: webcam.videoRef,
      start: webcam.start,
      stop: webcam.stop,
    };
  }

  // IP_CAMERA — designed, not implemented. Never fake a stream.
  return {
    descriptor,
    status: "UNSUPPORTED",
    error: IP_CAMERA_NOT_IMPLEMENTED,
    stream: null,
    videoRef: webcam.videoRef,
    start: noopAsync,
    stop: noop,
  };
}
