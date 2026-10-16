import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { mapCameraError, useCameraStream } from "./useCameraStream";

function stubMediaDevices(getUserMedia: () => Promise<MediaStream>) {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
}

function clearMediaDevices() {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: undefined,
  });
}

function domError(name: string) {
  return new DOMException("nope", name);
}

// `isSecureContext` may live on the window or its prototype; capture whatever
// own descriptor exists so we can restore it after each test.
const ownIsSecureContext = Object.getOwnPropertyDescriptor(window, "isSecureContext");

function forceInsecureContext() {
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    get: () => false,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (ownIsSecureContext) {
    Object.defineProperty(window, "isSecureContext", ownIsSecureContext);
  } else {
    Reflect.deleteProperty(window as object, "isSecureContext");
  }
  clearMediaDevices();
});

describe("mapCameraError", () => {
  it("maps MediaDevices errors to specific camera states", () => {
    expect(mapCameraError(domError("NotAllowedError"))).toBe("DENIED");
    expect(mapCameraError(domError("SecurityError"))).toBe("DENIED");
    expect(mapCameraError(domError("NotFoundError"))).toBe("NO_DEVICE");
    expect(mapCameraError(domError("OverconstrainedError"))).toBe("NO_DEVICE");
    expect(mapCameraError(domError("NotReadableError"))).toBe("IN_USE");
    expect(mapCameraError(domError("AbortError"))).toBe("IN_USE");
    expect(mapCameraError(new Error("boom"))).toBe("ERROR");
  });
});

describe("useCameraStream", () => {
  it("reports UNSUPPORTED when the MediaDevices API is missing", () => {
    clearMediaDevices();
    const { result } = renderHook(() => useCameraStream());
    expect(result.current.status).toBe("UNSUPPORTED");
  });

  it("reports INSECURE_CONTEXT outside a secure context", () => {
    stubMediaDevices(async () => ({}) as MediaStream);
    forceInsecureContext();
    const { result } = renderHook(() => useCameraStream());
    expect(result.current.status).toBe("INSECURE_CONTEXT");
  });

  it("transitions to DENIED and surfaces an error when permission is refused", async () => {
    stubMediaDevices(async () => {
      throw domError("NotAllowedError");
    });
    const { result } = renderHook(() => useCameraStream());
    expect(result.current.status).toBe("IDLE");

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.status).toBe("DENIED");
    expect(result.current.error).toBeTruthy();
  });

  it("transitions to NO_DEVICE when no camera is present", async () => {
    stubMediaDevices(async () => {
      throw domError("NotFoundError");
    });
    const { result } = renderHook(() => useCameraStream());
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status).toBe("NO_DEVICE");
  });

  it("streams on success and stops every track on stop()", async () => {
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }, { stop }] } as unknown as MediaStream;
    stubMediaDevices(async () => stream);

    const { result } = renderHook(() => useCameraStream());
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status).toBe("STREAMING");

    act(() => {
      result.current.stop();
    });
    expect(stop).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe("IDLE");
  });
});
