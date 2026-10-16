# CV-2 — Room-Level Occupancy & Live Telemetry Integration

## Summary
- Client-side DEMO MAPPING (operator-configured, per-browser) associates the webcam with a real IFC space using the canonical `space_id = "space_" + IfcGlobalId`.
- Shared camera+detector state via `VisionProvider` (hidden analysis `<video>` keeps detections running off-page).
- Room Live Monitor integrates into `BimSpacePanel` (Digital Twin inspector) showing camera occupancy only for the configured demo room and building-level replayed telemetry.
- Replay reused from the existing engine (`useReplay`/`/api/replay/*`), clearly labelled `HISTORICAL REPLAY` (or `SIMULATED LIVE`), preserves original timestamps/source; never attributed to rooms.

## Key constraints honored
- No backend or TwinViewer geometry changes. No CSV/artifact modifications.
- Never infer room identity from detections; never call demo observations verified TalTech occupancy.
- Room-specific telemetry only when verified sensor→room mapping exists (current: 0 confirmed; always UNMAPPED).
- Avoid unrelated refactoring; no GenAI.

## Files changed/added
- `frontend/src/vision/demoMapping.ts` (store)
- `frontend/src/vision/visionContext.ts`, `frontend/src/vision/VisionProvider.tsx`
- `frontend/src/components/vision/replayPresentation.ts`
- `frontend/src/components/vision/DemoMappingPicker.tsx`
- `frontend/src/components/vision/RoomLiveMonitor.tsx`
- `frontend/src/components/vision/CameraPanel.tsx` (accepts `stream` prop)
- `frontend/src/hooks/useCameraStream.ts` (exposes `stream`)
- `frontend/src/components/BimSpacePanel.tsx` (adds monitor, `storeyId` prop)
- `frontend/src/pages/DigitalTwin.tsx` (demo floating badge, passes `storeyId`)
- `frontend/src/pages/Vision.tsx` (uses context, demo picker)
- `frontend/src/App.tsx` (wraps with `VisionProvider`)
- `frontend/src/api/types.ts` (extended `SpaceListItem` fields)
- `frontend/src/test/setup.ts` (sample helpers)

## Acceptance mapping
- (1) LIVE + SAMPLE provenance visible; (2) operator can select a real IFC space for demo mapping (picker); (3) mapping persists across views (localStorage); (4-5) room telemetry is UNMAPPED; (6) replay labelled clearly; (7) existing features intact; (8) suites pass.
