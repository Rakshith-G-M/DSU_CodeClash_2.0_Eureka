// CV-1 — presentational camera + occupancy panel.
//
// Receives all state from the Vision page; it never fetches or touches the
// network itself. The live/sample provenance badge is driven purely by the
// `reading.source` it is handed, so simulated data can never be mislabelled.

import { useEffect, useRef, useState } from "react";
import { Badge } from "../common";
import { OccupancyOverlay } from "./OccupancyOverlay";
import {
  cameraStatusInfo,
  occupancyHeadline,
  occupancySourceLabel,
  occupancySourceTone,
} from "./provenance";
import type {
  CameraStatus,
  OccupancyObservation,
  PersonDetection,
} from "./visionTypes";
import type { DetectorStatus } from "../../hooks/useObjectDetector";

export function CameraPanel({
  status,
  error,
  stream,
  sourceLabel,
  detections,
  observation,
  detectorStatus,
  detectorError,
  onStart,
  onStop,
}: {
  status: CameraStatus;
  error: string | null;
  stream: MediaStream | null;
  /** Human label of the active camera source, e.g. "Development webcam". */
  sourceLabel: string;
  detections: PersonDetection[];
  observation: OccupancyObservation | null;
  detectorStatus: DetectorStatus;
  detectorError: string | null;
  onStart: () => void;
  onStop: () => void;
}) {
  const [videoSize, setVideoSize] = useState({ width: 0, height: 0 });
  const displayRef = useRef<HTMLVideoElement | null>(null);
  const info = cameraStatusInfo(status);
  const streaming = status === "STREAMING";
  const busy = status === "REQUESTING";
  const reading = observation;

  // The stream is owned by the VisionProvider; this element is a display sink.
  useEffect(() => {
    const video = displayRef.current;
    if (!video) return;
    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }
    if (stream) {
      void video.play().catch(() => {
        // Autoplay may need a gesture; safe to ignore.
      });
    }
  }, [stream]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: "16 / 9",
          background: "rgba(2, 6, 23, 0.85)",
          border: "1px solid var(--color-line)",
          borderRadius: "12px",
          overflow: "hidden",
        }}
      >
        <video
          ref={displayRef}
          data-testid="camera-video"
          playsInline
          muted
          autoPlay
          onLoadedMetadata={(e) =>
            setVideoSize({
              width: e.currentTarget.videoWidth,
              height: e.currentTarget.videoHeight,
            })
          }
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            display: streaming ? "block" : "none",
          }}
        />
        {streaming && (
          <OccupancyOverlay
            detections={detections}
            videoWidth={videoSize.width}
            videoHeight={videoSize.height}
          />
        )}

        {/* Status chip */}
        <div style={{ position: "absolute", top: "0.6rem", left: "0.6rem" }}>
          <Badge
            label={
              <>
                <span
                  className="status-dot-live"
                  style={{
                    display: "inline-block",
                    marginRight: "0.4rem",
                    background:
                      info.tone === "ok"
                        ? "var(--color-ok)"
                        : info.tone === "danger"
                          ? "var(--color-danger)"
                          : "var(--color-warn)",
                  }}
                />
                {info.label}
              </>
            }
            tone={info.tone}
          />
        </div>

        {!streaming && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: "0.5rem",
              padding: "1.5rem",
              textAlign: "center",
              color: "var(--color-ink-muted)",
            }}
          >
            <span style={{ fontSize: "0.85rem", fontWeight: 600 }}>
              {info.label}
            </span>
            <span style={{ fontSize: "0.78rem", maxWidth: "30rem" }}>
              {info.hint}
            </span>
          </div>
        )}
      </div>

      {/* Occupancy readout */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "1rem",
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: "0.75rem" }}>
          <span
            data-testid="occupancy-count"
            style={{
              fontSize: "2.4rem",
              fontWeight: 800,
              lineHeight: 1,
              color: reading ? "var(--color-ink)" : "var(--color-ink-dim)",
            }}
          >
            {reading ? reading.count : "—"}
          </span>
          <span style={{ fontSize: "0.85rem", color: "var(--color-ink-muted)" }}>
            {reading
              ? occupancyHeadline(reading.count, reading.source)
              : "No occupancy reading"}
          </span>
        </div>

        {reading && (
          <Badge
            label={occupancySourceLabel(reading.source)}
            tone={occupancySourceTone(reading.source)}
          />
        )}
      </div>

      {/* Controls */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
        {streaming ? (
          <button className="btn-secondary" onClick={onStop} data-testid="camera-stop">
            Stop camera
          </button>
        ) : (
          <button
            className="btn-primary"
            onClick={onStart}
            disabled={busy || status === "UNSUPPORTED" || status === "INSECURE_CONTEXT"}
            style={{
              opacity:
                busy || status === "UNSUPPORTED" || status === "INSECURE_CONTEXT"
                  ? 0.4
                  : 1,
            }}
            data-testid="camera-start"
          >
            Start camera
          </button>
        )}

        <span style={{ fontSize: "0.72rem", color: "var(--color-ink-dim)" }}>
          Source: {sourceLabel} ·{" "}
          {detectorStatus === "LOADING"
            ? "loading occupancy model…"
            : detectorStatus === "READY"
              ? "model ready · processed locally"
              : detectorStatus === "ERROR"
                ? "model unavailable"
                : "model idle"}
        </span>
      </div>

      {(error || detectorError) && (
        <div
          data-testid="camera-error"
          style={{
            fontSize: "0.78rem",
            color: "#fda4af",
            background: "rgba(244, 63, 94, 0.08)",
            border: "1px solid rgba(244, 63, 94, 0.25)",
            borderRadius: "10px",
            padding: "0.6rem 0.85rem",
            fontFamily: "var(--font-mono)",
          }}
        >
          {error ?? detectorError}
        </div>
      )}
    </div>
  );
}
