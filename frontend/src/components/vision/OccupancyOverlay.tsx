// CV-1 — bounding-box overlay drawn on a <canvas> above the live <video>.
// Purely presentational: it renders whatever detections it is given.

import { useEffect, useRef } from "react";
import type { PersonDetection } from "./visionTypes";

export function OccupancyOverlay({
  detections,
  videoWidth,
  videoHeight,
  mirrored = false,
}: {
  detections: PersonDetection[];
  videoWidth: number;
  videoHeight: number;
  mirrored?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = videoWidth || 1;
    canvas.height = videoHeight || 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const scale = Math.max(1, canvas.width / 640);
    ctx.lineWidth = 2 * scale;
    const fontSize = Math.max(12, 14 * scale);
    ctx.font = `${fontSize}px ui-monospace, monospace`;
    ctx.textBaseline = "middle";

    for (const d of detections) {
      const x = mirrored ? canvas.width - d.x - d.width : d.x;
      const label = `person ${(d.score * 100).toFixed(0)}%`;

      ctx.fillStyle = "rgba(52, 211, 153, 0.16)";
      ctx.fillRect(x, d.y, d.width, d.height);
      ctx.strokeStyle = "#34d399";
      ctx.strokeRect(x, d.y, d.width, d.height);

      const textWidth = ctx.measureText(label).width;
      ctx.fillStyle = "rgba(2, 6, 23, 0.78)";
      ctx.fillRect(x, Math.max(0, d.y - fontSize - 4), textWidth + 10, fontSize + 4);
      ctx.fillStyle = "#a7f3d0";
      ctx.fillText(label, x + 5, Math.max(fontSize / 2, d.y - fontSize / 2 - 2));
    }
  }, [detections, videoWidth, videoHeight, mirrored]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="occupancy-overlay"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
      }}
    />
  );
}
