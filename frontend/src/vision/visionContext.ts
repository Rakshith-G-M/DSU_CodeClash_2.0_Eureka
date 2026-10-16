// Shared vision state contract.
//
// Kept in its own module (no component exports) so the context value and hook
// can be imported without tripping the react-refresh export rule, and so pages
// and components depend only on this contract.

import { createContext, useContext } from "react";
import type {
  CameraStatus,
  OccupancyObservation,
  PersonDetection,
} from "../components/vision/visionTypes";
import type { DetectorStatus } from "../hooks/useObjectDetector";
import type { CameraSourceDescriptor } from "./cameraSource";
import type { DemoCameraMapping, DemoSpaceInput } from "./demoMapping";

export interface VisionContextValue {
  /** The active camera source (development webcam today). */
  source: CameraSourceDescriptor;
  cameraStatus: CameraStatus;
  cameraError: string | null;
  /** Live MediaStream for display sinks (the provider itself never shows it). */
  stream: MediaStream | null;
  detectorStatus: DetectorStatus;
  detectorError: string | null;
  detections: PersonDetection[];
  /**
   * Latest occupancy observation with provenance and any canonical room
   * association. Null when neither the camera nor sample mode is producing one.
   */
  observation: OccupancyObservation | null;
  sampleMode: boolean;
  setSampleMode: (value: boolean) => void;
  /** True once the operator has started a camera at least once. */
  hasStarted: boolean;
  startCamera: () => Promise<void>;
  stopCamera: () => void;
  /** Operator-configured demo association, or null. */
  demoMapping: DemoCameraMapping | null;
  setDemoSpace: (input: DemoSpaceInput) => void;
  clearDemoSpace: () => void;
}

export const VisionContext = createContext<VisionContextValue | null>(null);

export function useVision(): VisionContextValue {
  const ctx = useContext(VisionContext);
  if (!ctx) throw new Error("useVision must be used inside <VisionProvider>");
  return ctx;
}
