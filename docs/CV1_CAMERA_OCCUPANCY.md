# CV-1 — Camera Occupancy Estimation

Additive, **fully client-side** computer-vision capability. It does not alter
the IFC digital twin, floor filtering, space selection, telemetry, forecasts or
the rule-based intelligence engine.

## What it does

A new `/vision` route ("Camera" in the sidebar) opens the local camera, runs an
on-device person detector over the live frame, and displays a clearly labelled
occupancy estimate with bounding boxes.

- **Model:** EfficientDet-Lite0 (COCO), executed by MediaPipe Tasks Vision
  `ObjectDetector` (WASM, `delegate: "CPU"`). Only the `person` class is kept.
- **Library:** `@mediapipe/tasks-vision@0.10.17` — pinned explicitly in
  `package.json`. The same version is already a dependency of
  `@react-three/drei`, so no new copy is introduced.
- **Where it runs:** entirely in the browser. No frame is uploaded and there is
  no new backend endpoint. The only server call on this page is the existing
  `GET /api/dashboard/summary`, used to read the *real* sensor→space mapping
  status.

## Assets (vendored, offline-capable)

```
frontend/public/vision/wasm/    # MediaPipe WASM runtime (copied from
                                # node_modules/@mediapipe/tasks-vision/wasm)
frontend/public/vision/models/  # efficientdet_lite0_int8.tflite (~4.5 MB)
```

MediaPipe model source: `https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite`
(Apache-2.0). To refresh, re-download to
`frontend/public/vision/models/efficientdet_lite0_int8.tflite`.

## Honesty rules (enforced in code)

1. **Live vs sample are never conflated.** Every reading carries a `source` of
   `LIVE_CAMERA` or `SAMPLE`. Sample mode is badged
   *"SAMPLE DATA — not a camera observation"* and is off by default
   (`src/components/vision/provenance.ts`).
2. **No room attribution.** `OccupancyObservation.space_id` is always `null`.
   The page shows the real mapping status from the API
   (`CAMERA→ROOM MAPPING: UNRESOLVED`) and states that counts are never
   attributed to an IFC space. See `docs/M2_EXTERNAL_MAPPING_RESEARCH.md` —
   the sensor→space mapping is unresolved in this deployment.
3. **Graceful failure.** Permission denial, missing device, insecure context,
   camera-in-use and detector load errors are all mapped to explicit, surfaced
   states (`useCameraStream.mapCameraError`, `cameraStatusInfo`).

## Files

Added:

```
src/pages/Vision.tsx
src/pages/Vision.test.tsx
src/components/vision/CameraPanel.tsx
src/components/vision/OccupancyOverlay.tsx
src/components/vision/provenance.ts
src/components/vision/provenance.test.ts
src/components/vision/visionTypes.ts
src/hooks/useCameraStream.ts
src/hooks/useCameraStream.test.tsx
src/hooks/useObjectDetector.ts
src/hooks/useObjectDetector.test.tsx
public/vision/**
```

Changed (additive only):

```
src/App.tsx            # one lazy /vision route
src/components/layout.tsx   # one nav item
src/components/icons.tsx    # IconCamera
package.json           # explicit @mediapipe/tasks-vision pin
.oxlintrc.json         # ignore vendored public/** in lint
```

## Isolation

The route is `React.lazy`-loaded, so the MediaPipe bundle is code-split
(`dist/assets/vision_bundle-*.js`, ~138 kB) and never enters the main bundle or
the three.js twin chunk. Camera state lives in dedicated hooks; no twin or
telemetry module imports any CV code.

## Verification

```
cd frontend && npm run typecheck && npm test && npm run lint && npm run build
cd .. && pytest -q
```

## Limitations

- Camera→space mapping is unresolved, so occupancy is **unassigned** by design.
- Accuracy depends on camera placement, lighting and crowd density; the count
  is an estimate, not a certified occupancy measurement.
- jsdom has no camera, so automated tests cover the state machine, provenance
  rules and detector mapping; live capture is verified manually in a browser
  over `localhost`/HTTPS.
