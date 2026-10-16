// VisionProvider.
//
// Owns the camera source + occupancy detector and the operator's demo room
// association, so the same live state is shared between the Digital Twin room
// overview and the dedicated Camera page. It renders a hidden analysis <video>
// so person detection keeps running while the operator is on another page.
//
// Acquisition goes through the camera-source contract (useCameraSource), so a
// production IP camera can be swapped in later without touching detection or
// the UI. All processing stays in this browser; no frame is ever uploaded.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useCameraSource } from "../hooks/useCameraSource";
import { useObjectDetector } from "../hooks/useObjectDetector";
import {
  DEV_WEBCAM_SOURCE,
  type CameraSourceDescriptor,
} from "./cameraSource";
import {
  OCCUPANCY_MODEL_NAME,
  OCCUPANCY_SCORE_THRESHOLD,
  meanDetectionConfidence,
  simulatedCount,
} from "../components/vision/provenance";
import type { OccupancyObservation } from "../components/vision/visionTypes";
import {
  clearDemoMapping,
  loadDemoMapping,
  saveDemoMapping,
} from "./demoMapping";
import type { DemoSpaceInput } from "./demoMapping";
import { VisionContext } from "./visionContext";
import type { VisionContextValue } from "./visionContext";

export function VisionProvider({
  children,
  source = DEV_WEBCAM_SOURCE,
}: {
  children: ReactNode;
  /** Camera source; defaults to the development webcam. */
  source?: CameraSourceDescriptor;
}) {
  // Destructure so we never touch a hook result that carries a ref during
  // render (avoids the react(refs) lint rule and keeps deps stable).
  const {
    status: cameraStatus,
    error: cameraError,
    stream: cameraStream,
    videoRef,
    start: startSource,
    stop: stopSource,
  } = useCameraSource(source);
  const streaming = cameraStatus === "STREAMING";
  const detector = useObjectDetector(videoRef, streaming);

  const [sampleMode, setSampleMode] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [hasStarted, setHasStarted] = useState(false);
  const [demoMapping, setDemoMapping] = useState(() => loadDemoMapping());

  // Synthetic demo clock while sample mode is on.
  useEffect(() => {
    if (!sampleMode) return;
    const startedAt = performance.now();
    const id = window.setInterval(
      () => setElapsedMs(performance.now() - startedAt),
      500,
    );
    return () => window.clearInterval(id);
  }, [sampleMode]);

  // An observation is derived, not stored: the memo re-runs whenever the
  // detector returns a new detection set (live) or the demo clock ticks
  // (sample), so the reported timestamp is the moment that reading was
  // produced. Room association comes only from the operator's demo mapping.
  const observation = useMemo<OccupancyObservation | null>(() => {
    const spaceId = demoMapping?.space_id ?? null;
    const mappingKind = demoMapping ? ("DEMO_MAPPING" as const) : null;
    const mappingStatus = demoMapping ? "DEMO_MAPPING" : "UNASSIGNED";

    if (sampleMode) {
      return {
        count: simulatedCount(elapsedMs),
        confidence: null,
        source: "SAMPLE",
        source_id: source.source_id,
        model: OCCUPANCY_MODEL_NAME,
        scoreThreshold: OCCUPANCY_SCORE_THRESHOLD,
        timestamp: new Date().toISOString(),
        space_id: spaceId,
        mapping_kind: mappingKind,
        mapping_status: mappingStatus,
      };
    }
    if (streaming) {
      return {
        count: detector.detections.length,
        confidence: meanDetectionConfidence(
          detector.detections.map((d) => d.score),
        ),
        source: "LIVE_CAMERA",
        source_id: source.source_id,
        model: OCCUPANCY_MODEL_NAME,
        scoreThreshold: OCCUPANCY_SCORE_THRESHOLD,
        timestamp: new Date().toISOString(),
        space_id: spaceId,
        mapping_kind: mappingKind,
        mapping_status: mappingStatus,
      };
    }
    return null;
  }, [
    sampleMode,
    elapsedMs,
    streaming,
    detector.detections,
    source.source_id,
    demoMapping,
  ]);

  const setDemoSpace = useCallback((input: DemoSpaceInput) => {
    setDemoMapping(saveDemoMapping(input));
  }, []);

  const clearDemoSpace = useCallback(() => {
    clearDemoMapping();
    setDemoMapping(null);
  }, []);

  const changeSampleMode = useCallback((value: boolean) => {
    setElapsedMs(0);
    setSampleMode(value);
  }, []);

  const startCamera = useCallback(async () => {
    setHasStarted(true);
    await startSource();
  }, [startSource]);

  const stopCamera = useCallback(() => {
    stopSource();
  }, [stopSource]);

  const value = useMemo<VisionContextValue>(
    () => ({
      source,
      cameraStatus,
      cameraError,
      stream: cameraStream,
      detectorStatus: detector.status,
      detectorError: detector.error,
      detections: detector.detections,
      observation,
      sampleMode,
      setSampleMode: changeSampleMode,
      hasStarted,
      startCamera,
      stopCamera,
      demoMapping,
      setDemoSpace,
      clearDemoSpace,
    }),
    [
      source,
      cameraStatus,
      cameraError,
      cameraStream,
      detector.status,
      detector.error,
      detector.detections,
      observation,
      sampleMode,
      changeSampleMode,
      hasStarted,
      startCamera,
      stopCamera,
      demoMapping,
      setDemoSpace,
      clearDemoSpace,
    ],
  );

  return (
    <VisionContext.Provider value={value}>
      {children}
      {/*
        Hidden analysis sink. Rendered (not display:none) so the browser keeps
        decoding frames for the detector regardless of the current route. It is
        screen-reader hidden and never receives pointer events.
      */}
      <video
        ref={videoRef}
        data-testid="vision-analysis-video"
        aria-hidden="true"
        playsInline
        muted
        autoPlay
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          width: "2px",
          height: "2px",
          opacity: 0,
          pointerEvents: "none",
        }}
      />
    </VisionContext.Provider>
  );
}
