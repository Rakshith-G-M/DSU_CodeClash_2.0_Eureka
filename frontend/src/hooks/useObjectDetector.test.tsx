import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { toPersonDetections, useObjectDetector } from "./useObjectDetector";

const mocks = vi.hoisted(() => ({
  forVisionTasks: vi.fn(),
  createFromOptions: vi.fn(),
  detectForVideo: vi.fn(),
  close: vi.fn(),
}));

vi.mock("@mediapipe/tasks-vision", () => ({
  FilesetResolver: { forVisionTasks: mocks.forVisionTasks },
  ObjectDetector: { createFromOptions: mocks.createFromOptions },
}));

function fakeVideoRef() {
  return { current: { readyState: 4 } as unknown as HTMLVideoElement };
}

beforeEach(() => {
  mocks.forVisionTasks.mockResolvedValue({});
  mocks.detectForVideo.mockReturnValue({
    detections: [
      {
        categories: [{ categoryName: "person", score: 0.91 }],
        boundingBox: { originX: 10, originY: 20, width: 30, height: 40 },
      },
    ],
  });
  mocks.createFromOptions.mockResolvedValue({
    detectForVideo: mocks.detectForVideo,
    close: mocks.close,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("toPersonDetections", () => {
  it("keeps only high-confidence person boxes and maps their pixels", () => {
    const people = toPersonDetections([
      {
        categories: [{ categoryName: "person", score: 0.9 }],
        boundingBox: { originX: 1, originY: 2, width: 3, height: 4 },
      },
      {
        categories: [{ categoryName: "car", score: 0.99 }],
        boundingBox: { originX: 5, originY: 6, width: 7, height: 8 },
      },
      {
        categories: [{ categoryName: "person", score: 0.8 }],
        // no bounding box -> ignored
      },
    ]);

    expect(people).toHaveLength(1);
    expect(people[0]).toEqual({ x: 1, y: 2, width: 3, height: 4, score: 0.9 });
  });

  it("returns an empty list when nothing is detected", () => {
    expect(toPersonDetections([])).toEqual([]);
  });
});

describe("useObjectDetector", () => {
  it("stays idle (and loads nothing) while inactive", () => {
    const { result } = renderHook(() => useObjectDetector(fakeVideoRef(), false));
    expect(result.current.status).toBe("IDLE");
    expect(result.current.detections).toEqual([]);
    expect(mocks.createFromOptions).not.toHaveBeenCalled();
  });

  it("loads the model and reports person detections when active", async () => {
    const { result } = renderHook(() => useObjectDetector(fakeVideoRef(), true));

    await waitFor(() => expect(result.current.status).toBe("READY"));
    await waitFor(() => expect(result.current.detections).toHaveLength(1), {
      timeout: 2000,
    });

    expect(mocks.detectForVideo).toHaveBeenCalled();
    expect(mocks.createFromOptions).toHaveBeenCalled();
  });

  it("reports an error when the detector cannot be created", async () => {
    mocks.createFromOptions.mockRejectedValue(new Error("wasm missing"));
    const { result } = renderHook(() => useObjectDetector(fakeVideoRef(), true));

    await waitFor(() => expect(result.current.status).toBe("ERROR"));
    expect(result.current.error).toContain("wasm missing");
  });

  it("closes the detector on unmount", async () => {
    const { unmount, result } = renderHook(() => useObjectDetector(fakeVideoRef(), true));
    await waitFor(() => expect(result.current.status).toBe("READY"));
    unmount();
    expect(mocks.close).toHaveBeenCalled();
  });
});
