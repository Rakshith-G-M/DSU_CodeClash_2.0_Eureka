# Green Twin — Contributor Package: Frontend, Computer Vision & GenAI UI

**Package:** `GreenTwin_Frontend_CV_GenAI.zip`
**Role:** `role-frontend` — React frontend, Computer Vision workflow and integrated AI user experience
**Application root (central repository):** the Green Twin project root that contains `frontend/`, `scripts/`, `tests/`, `docs/`, `output/`, `DS3_TalTech_V4.ifc` and `Taltech.zip`.

---

## 1. Purpose

This package owns the entire browser experience of Green Twin:

* The React + TypeScript + Vite application (pages, layout, styling).
* The Digital Twin room inspector UI (room selection, floor navigation, live
  status), which consumes the BIM-owned geometry.
* The Computer Vision / camera occupancy workflow (camera source, object
  detection, occupancy overlay, room live monitor, provenance badges).
* The integrated AI user experience: room analysis, finding analysis,
  recommendation lists, confidence badges, action-first "next action" surfacing
  and collapsible evidence.
* The frontend test suite.

## 2. Included files

See `MANIFEST.json` for the exact list with sizes and SHA-256 checksums.

| Area | Files |
|---|---|
| App root | `frontend/index.html`, `frontend/package.json`, `frontend/package-lock.json`, `frontend/vite.config.ts`, `frontend/tsconfig*.json`, `frontend/vercel.json`, `frontend/.oxlintrc.json`, `frontend/.gitignore`, `frontend/README.md` |
| Pages | `frontend/src/pages/*` (Overview, DigitalTwin, Intelligence, Vision, RecDetail, …) |
| Components | `frontend/src/components/*` (layout, common, icons, TwinViewer, BimSpacePanel, ReplayBar, `vision/*`) |
| AI UX | `frontend/src/ai/*` (RoomAnalysis, FindingAnalysis, RecommendationList, presentation, roomIntelligence, hooks) |
| CV / vision | `frontend/src/vision/*`, `frontend/src/hooks/useCamera*`, `useObjectDetector`, `frontend/src/components/vision/*` |
| API client | `frontend/src/api/*` (client, types, index) |
| State / lib | `frontend/src/lib/*`, `frontend/src/hooks/useApi.ts`, `useReplay.ts`, `frontend/src/test/setup.ts` |
| 3D assets | `frontend/public/models/*` (glTF meshes + manifests) |
| CV assets | `frontend/public/vision/models/efficientdet_lite0_int8.tflite`, `frontend/public/vision/wasm/*` (MediaPipe vision task) |
| Misc | `frontend/public/favicon.svg` |
| Docs | `docs/CV1_CAMERA_OCCUPANCY.md`, `CV2_ROOM_OCCUPANCY_TELEMETRY.md`, `CV3_CAMERA_SOURCE_ARCHITECTURE.md`, `M8_PRODUCT_UI.md` |

## 3. Excluded files (and how to obtain them)

| Excluded asset | Owned by | How to obtain |
|---|---|---|
| `frontend/node_modules/` | regenerable | `npm ci` (or `npm install`) inside `frontend/`. |
| `frontend/dist/` | regenerable | `npm run build`. |
| Backend Python (`scripts/*.py`) | Analytics (`GreenTwin_Analytics_Backend.zip`) | The frontend talks to it over HTTP (`/api/*`); run the backend from the analytics package or the central repo. |
| `scripts/room_status.py` | Analytics | The frontend mirror `frontend/src/lib/roomStatus.ts` must stay in sync with it. |
| IFC model & twin build scripts | BIM (`GreenTwin_BIM_DigitalTwin.zip`) | The GLB meshes are shipped here so the app runs; regenerate them only via the BIM package. |
| `.env`, credentials, `.git`, caches | — | Never shipped in any package. |

## 4. Setup

```bash
cd frontend
npm ci                # or: npm install
npm run dev           # Vite dev server (expects the backend on http://localhost:8000)
```

The dev server proxies API calls to the backend; start the Analytics package's
`uvicorn scripts.api_app:app --port 8000` first (or point the client at your
backend URL).

## 5. Tests & quality gates

```bash
cd frontend
npm test              # vitest run
npm run typecheck     # tsc -b
npm run lint          # oxlint
npm run build         # tsc -b && vite build
```

> The CV end-to-end path needs a real camera + MediaPipe. In jsdom there is no
> `getUserMedia`/MediaPipe, so tests use fakes; do not claim live-camera success
> from CI alone.

## 6. Required environment variables

None required for the frontend build. If you point the app at a non-default
backend, configure the API base URL in the Vite/client config (`frontend/src/api/client.ts`).
The AI provider key lives **only** in the backend `.env` and is never exposed to
the browser.

## 7. Shared dependencies & cross-role contracts

* **API contract** — `frontend/src/api/types.ts` mirrors the backend response
  models (`api_app.py` / `ai_schemas.py`). Field renames must be coordinated with
  Analytics.
* **Room status** — `frontend/src/lib/roomStatus.ts` mirrors
  `scripts/room_status.py` (Analytics). Keep the decision rules identical.
* **Recommendations** — the AI surfaces render `AiRecommendation` items and the
  normalized `confidence` field (HIGH/MEDIUM/LOW/UNKNOWN); `recommendations[0]`
  is promoted as the single "NEXT ACTION". This matches the backend contract.
* **Twin UI** — `TwinViewer.tsx`, `BimSpacePanel.tsx`, `DigitalTwin.tsx` and
  `spacesData.ts` are also carried by the BIM package; keep the copies identical.
* **JSON fixtures** — pages read from the API, not from `output/` directly.

## 8. Files that must NOT be overwritten when applying this package

When applying this package onto the central repository, it must **not** replace:

* any backend Python (`scripts/**`), the IFC model, or `output/**`;
* the BIM-owned copies of the twin UI files with divergent versions — reconcile
  with the BIM package;
* `.env`, `.git`, `node_modules`, or credentials;
* the CV model/WASM assets with different versions (the detector expects the
  bundled MediaPipe files).

If a conflict occurs on a shared file (`roomStatus.ts` vs `room_status.py`,
`api/types.ts` vs backend schemas), stop and reconcile manually.
