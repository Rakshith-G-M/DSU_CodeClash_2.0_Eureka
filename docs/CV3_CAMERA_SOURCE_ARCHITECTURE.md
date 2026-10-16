# CV-3 — Camera-source architecture: webcam now, CCTV/IP cameras in production

Status: **implemented** (abstraction + room workflow) / **designed only** (IP-camera ingestion).

This document first records the inspection of the existing CV implementation, then
describes the source abstraction that was added, then the *smallest* production
extension for real CCTV/IP cameras. It is explicit about what is genuinely
supported today versus what is only designed for the future.

## 1. What existed before

- **Acquisition** lived inside a single hook, `frontend/src/hooks/useCameraStream.ts`
  (`navigator.mediaDevices.getUserMedia`), returning `{ status, error, stream, videoRef, start, stop }`.
- **Detection** lived in `frontend/src/hooks/useObjectDetector.ts` (MediaPipe
  EfficientDet-Lite0), reading frames from a `videoRef`.
- **State + occupancy** were assembled in `frontend/src/vision/VisionProvider.tsx`,
  which also held the operator's demo camera→room association
  (`frontend/src/vision/demoMapping.ts`, `localStorage` key
  `campusiq.demoCameraMapping/v1`).
- **Room association** used the canonical IFC id `space_id === "space_" + <IfcGlobalId>`.
- **UI**: `BimSpacePanel` (room inspector) and `pages/Vision.tsx` (camera page),
  with presentation helpers in `components/vision/provenance.ts` and
  `components/vision/replayPresentation.ts`.

Acquisition, detection and reporting were coupled: the webcam was the only
possible source, hard-wired in the provider.

## 2. The abstraction that was added (implemented, tested)

Acquisition is now separated from detection and reporting behind a typed
contract.

### 2.1 Contract — `frontend/src/vision/cameraSource.ts` (new)

```ts
export type CameraSourceKind = "DEV_WEBCAM" | "IP_CAMERA";

export interface CameraSourceDescriptor {
  source_id: string;                 // stable id, e.g. "dev-webcam"
  kind: CameraSourceKind;            // source type
  label: string;                     // "Development webcam" / "IP camera"
  stream_url: string | null;         // browser-playable URL for IP cameras; never credentials
  note: string | null;               // short, non-secret origin description
}

export interface CameraSourceState {
  descriptor: CameraSourceDescriptor;
  status: CameraStatus;              // start/stop + connection/error lifecycle
  error: string | null;
  stream: MediaStream | null;        // frames for the CV engine when available
  videoRef: RefObject<HTMLVideoElement | null>; // frame sink for the CV engine
  start: () => Promise<void>;
  stop: () => void;                  // stops all tracks
}
```

- `DEV_WEBCAM_SOURCE` is the default source.
- `IP_CAMERA_NOT_IMPLEMENTED` is the honest, non-fake error for a declared IP
  source. `requiresGateway()` marks sources that need backend infrastructure.
- `IpCameraSourceConfig` documents the intended production shape, including the
  IFC `space_id` binding.

### 2.2 Adapter — `frontend/src/hooks/useCameraSource.ts` (new)

Realises a descriptor as a live `CameraSourceState`:

- `DEV_WEBCAM` → delegates to the existing `useCameraStream`, so the webcam keeps
  working unchanged through the new contract.
- `IP_CAMERA` → returns `status: "UNSUPPORTED"` with `IP_CAMERA_NOT_IMPLEMENTED`.
  It does **not** open a socket or claim RTSP works.

### 2.3 Observations — `OccupancyObservation`

Occupancy is now reported as a `CameraSource`-agnostic observation
(`components/vision/visionTypes.ts`) carrying:

- `count`, `confidence` (mean detector score where supported, else `null`),
- `timestamp` (when the reading was produced),
- `source` (`LIVE_CAMERA` | `SAMPLE`) — provenance, never conflated,
- `source_id` (which camera source produced it),
- `space_id` + `mapping_kind`/`mapping_status` (explicit canonical IFC association),
- `model`, `scoreThreshold`.

Room association comes **only** from the operator's explicit demo mapping. It is
never inferred from what the model saw, and it is never moved between rooms
silently.

### 2.4 Provider — `frontend/src/vision/VisionProvider.tsx`

Takes an optional `source` prop (defaults to `DEV_WEBCAM_SOURCE`) and consumes
`useCameraSource`. Detector, sample mode and demo mapping are unchanged in
behaviour. Added `hasStarted` so the UI can distinguish *Not started* from
*Stopped*.

### 2.5 UI changes (room-first workflow)

- `components/vision/RoomLiveMonitor.tsx` — now the room's occupancy **and**
  camera control card: source badge (`Development webcam`), monitoring-state
  badge (not started / requesting / monitoring / stopped / unavailable), live
  count + `LIVE`/`SAMPLE` badge + last update + confidence, Start/Stop, and
  *Enable occupancy monitoring* (which creates the demo association for the
  selected room and starts the camera in one explicit step).
- `pages/Vision.tsx` — the camera page is now a dedicated camera/testing page.
  The association picker was removed; it shows a read-only association summary
  and points configuration back to the room.
- `components/BimSpacePanel.tsx` — the selected-room overview is now the primary
  home for occupancy monitoring.
- `pages/DigitalTwin.tsx` — the demo-camera association appears as a compact strip
  inside the inspector panel (no floating badge, single scroll region).

## 3. CCTV/IP production extension (designed only — not implemented)

Browsers generally cannot play RTSP. The smallest suitable production extension
keeps the same frontend contract and adds a **secure backend gateway**:

```
IP camera ──RTSP/ONVIF──▶ Camera gateway ──HLS / WebRTC(WHEP)──▶ Browser
                          (FFmpeg/MediaMTX/etc.)
                                  │
                                  └── snapshot/annotation API (optional)
```

Recommended minimal shape:

1. **Gateway service** (new backend component, operator-hosted) that:
   - holds camera credentials (never sent to the browser),
   - ingests RTSP/ONVIF (or an IP-camera vendor gateway),
   - re-publishes each camera as a browser-playable stream (HLS or WebRTC/WHEP),
   - exposes a health/reconnect status per camera.
2. **Backend config endpoint** (e.g. `GET /api/cameras`) returning, per camera,
   a `CameraSourceDescriptor`-shaped record: `source_id`, `kind: "IP_CAMERA"`,
   `label`, `stream_url` (gateway URL, no secrets), `space_id` (canonical IFC id),
   and current health.
3. **Frontend** already supports this shape: pass the descriptor into
   `VisionProvider source={...}` / `useCameraSource`, and implement the
   `IP_CAMERA` branch of the adapter to attach the browser-playable URL to the
   `videoRef` (e.g. `<video src>` for HLS, or a WHEP/WebRTC `srcObject`).

What still requires additional work (not done here):

- Authentication/authorisation and secret storage.
- Connection health, reconnection/backoff UI states (the contract has the
  `status`/`error` fields, but no IP implementation fills them yet).
- Multi-camera fan-out and per-camera room coverage (each camera assigned to its
  actual coverage area via canonical IFC `space_id`).
- Gateway deployment/hosting. **No streaming server was added to this demo.**

## 4. Data-integrity rules (unchanged, re-affirmed)

- Camera occupancy is a separate stream from environmental sensor telemetry.
- Unmapped historical sensor values are never attributed to the camera's room;
  they stay under the clearly-labelled **Building telemetry** section.
- Actual measurements, historical replay, simulated data and IFC design
  specifications remain visually distinct.
- The rule-based intelligence engine is unchanged; **no GenAI** was added.

## 5. Files

Added:

- `frontend/src/vision/cameraSource.ts` — the contract.
- `frontend/src/hooks/useCameraSource.ts` — the adapter.
- `frontend/src/vision/cameraSource.test.tsx` — contract/adapter tests.
- `frontend/src/components/vision/BuildingTelemetry.tsx` (+ test) — secondary,
  honest building-level telemetry section.

Changed:

- `frontend/src/vision/VisionProvider.tsx`, `frontend/src/vision/visionContext.ts`
- `frontend/src/components/vision/visionTypes.ts` (observation fields),
  `.../RoomLiveMonitor.tsx`, `.../provenance.ts`, `.../CameraPanel.tsx`
- `frontend/src/components/BimSpacePanel.tsx`
- `frontend/src/pages/Vision.tsx`, `frontend/src/pages/DigitalTwin.tsx`
- tests in `.../RoomLiveMonitor.test.tsx`, `.../BimSpacePanel.test.tsx`,
  `.../Vision.test.tsx`, `.../provenance.test.ts`

Left in place (not deleted): `components/vision/DemoMappingPicker.tsx`
(no longer used by the camera page).

## 6. Verification

- `npx tsc -b` — clean.
- `npm run lint` (oxlint) — exit 0.
- `npx vitest run` — all tests pass (see the report accompanying this change).
- `npm run build` — succeeds.
- Live webcam end-to-end detection requires a real browser + camera; it is
  exercised through the same code path but is not covered by the jsdom tests.
