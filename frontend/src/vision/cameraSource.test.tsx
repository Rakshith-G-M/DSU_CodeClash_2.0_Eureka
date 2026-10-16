import { afterEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  DEV_WEBCAM_SOURCE,
  IP_CAMERA_NOT_IMPLEMENTED,
  cameraSourceKindLabel,
  requiresGateway,
  type CameraSourceDescriptor,
} from "./cameraSource";
import { useCameraSource } from "../hooks/useCameraSource";

afterEach(() => {
  // jsdom has no navigator.mediaDevices; leave it undefined.
});

describe("camera-source contract", () => {
  it("describes the development webcam without secrets or a stream URL", () => {
    expect(DEV_WEBCAM_SOURCE.kind).toBe("DEV_WEBCAM");
    expect(DEV_WEBCAM_SOURCE.label).toBe("Development webcam");
    expect(DEV_WEBCAM_SOURCE.stream_url).toBeNull();
    expect(requiresGateway(DEV_WEBCAM_SOURCE)).toBe(false);
  });

  it("labels source kinds for the UI", () => {
    expect(cameraSourceKindLabel("DEV_WEBCAM")).toBe("Development webcam");
    expect(cameraSourceKindLabel("IP_CAMERA")).toBe("IP camera");
  });

  it("runs the dev webcam through the contract (unsupported in jsdom, never fake)", () => {
    const { result } = renderHook(() => useCameraSource(DEV_WEBCAM_SOURCE));
    expect(result.current.descriptor.kind).toBe("DEV_WEBCAM");
    // jsdom exposes no MediaDevices API, so the honest state is UNSUPPORTED.
    expect(result.current.status).toBe("UNSUPPORTED");
    expect(result.current.stream).toBeNull();
  });

  it("returns an honest not-implemented state for a declared IP camera", () => {
    const ip: CameraSourceDescriptor = {
      source_id: "cam-storey-1-01",
      kind: "IP_CAMERA",
      label: "IP camera",
      stream_url: null,
      note: null,
    };
    expect(requiresGateway(ip)).toBe(true);

    const { result } = renderHook(() => useCameraSource(ip));
    expect(result.current.status).toBe("UNSUPPORTED");
    expect(result.current.error).toBe(IP_CAMERA_NOT_IMPLEMENTED);
    // No fake connection: there is no stream and start is a no-op.
    expect(result.current.stream).toBeNull();
    expect(typeof result.current.start).toBe("function");
  });
});
