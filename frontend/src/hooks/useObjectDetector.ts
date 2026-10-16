// CV-1 — on-device person-detection hook.
//
// Loads MediaPipe Tasks Vision (ObjectDetector + EfficientDet-Lite0) lazily,
// runs throttled inference over the live <video> frame and returns only the
// `person` detections. All processing stays in this browser; no frame is ever
// uploaded. The heavy imports happen inside this hook so the detector code is
// only pulled into the (already lazy) Vision route chunk.

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { ObjectDetector } from "@mediapipe/tasks-vision";
import type { PersonDetection } from "../components/vision/visionTypes";
import { OCCUPANCY_SCORE_THRESHOLD } from "../components/vision/provenance";

export type DetectorStatus = "IDLE" | "LOADING" | "READY" | "ERROR";

export interface ObjectDetectorState {
  status: DetectorStatus;
  error: string | null;
  detections: PersonDetection[];
}

// Vendored under frontend/public/vision/ (see docs/CV1_CAMERA_OCCUPANCY.md).
const WASM_PATH = "/vision/wasm";
const MODEL_PATH = "/vision/models/efficientdet_lite0_int8.tflite";

// ~3 inferences/second is ample for occupancy and keeps CPU/battery sane.
const INFERENCE_INTERVAL_MS = 300;
const MAX_RESULTS = 20;

interface RawDetection {
  categories?: Array<{ categoryName?: string; score?: number }>;
  boundingBox?: { originX: number; originY: number; width: number; height: number };
}

/** Map raw MediaPipe detections to person boxes (pure, unit-testable). */
export function toPersonDetections(
  detections: ReadonlyArray<RawDetection>,
): PersonDetection[] {
  const people: PersonDetection[] = [];
  for (const d of detections) {
    const top = d.categories?.[0];
    if (!top || top.categoryName !== "person") continue;
    const bb = d.boundingBox;
    if (!bb) continue;
    people.push({
      x: bb.originX,
      y: bb.originY,
      width: bb.width,
      height: bb.height,
      score: top.score ?? 0,
    });
  }
  return people;
}

export function useObjectDetector(
  videoRef: RefObject<HTMLVideoElement | null>,
  active: boolean,
): ObjectDetectorState {
  const [status, setStatus] = useState<DetectorStatus>("IDLE");
  const [error, setError] = useState<string | null>(null);
  const [detections, setDetections] = useState<PersonDetection[]>([]);

  // Hold the video ref without reacting to its object identity, so a consumer
  // that recreates the ref each render cannot cause an effect loop.
  const videoRefHolder = useRef(videoRef);
  useEffect(() => {
    videoRefHolder.current = videoRef;
  }, [videoRef]);

  useEffect(() => {
    if (!active) {
      return;
    }

    let cancelled = false;
    let raf = 0;
    // Run the first inference immediately, then throttle.
    let lastRun = Number.NEGATIVE_INFINITY;
    let lastTs = 0;
    let detector: ObjectDetector | null = null;

    setStatus("LOADING");
    setError(null);

    const run = async () => {
      try {
        const vision = await import("@mediapipe/tasks-vision");
        const fileset = await vision.FilesetResolver.forVisionTasks(WASM_PATH);
        const created = await vision.ObjectDetector.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_PATH, delegate: "CPU" },
          runningMode: "VIDEO",
          scoreThreshold: OCCUPANCY_SCORE_THRESHOLD,
          maxResults: MAX_RESULTS,
          categoryAllowlist: ["person"],
        });
        if (cancelled) {
          created.close();
          return;
        }
        detector = created;
        setStatus("READY");

        const tick = () => {
          raf = requestAnimationFrame(tick);
          const video = videoRefHolder.current.current;
          if (!video || video.readyState < 2) return;
          const now = performance.now();
          if (now - lastRun < INFERENCE_INTERVAL_MS) return;
          lastRun = now;
          const timestamp = Math.max(now, lastTs + 1);
          lastTs = timestamp;
          try {
            const result = detector?.detectForVideo(video, timestamp);
            if (result) setDetections(toPersonDetections(result.detections));
          } catch {
            // A single undecodable frame must not kill the loop.
          }
        };
        raf = requestAnimationFrame(tick);
      } catch (err) {
        if (cancelled) return;
        setStatus("ERROR");
        setError(
          err instanceof Error
            ? err.message
            : "The occupancy detector could not be loaded.",
        );
      }
    };

    void run();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      detector?.close();
      detector = null;
    };
  }, [active, videoRefHolder]);

  // When inactive we present a neutral state without mutating state inside the
  // effect (avoids cascading renders).
  if (!active) {
    return { status: "IDLE", error: null, detections: [] };
  }

  return { status, error, detections };
}
