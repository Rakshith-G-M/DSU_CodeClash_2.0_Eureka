# Green Twin — Contributor Package: BIM & Digital Twin

**Package:** `GreenTwin_BIM_DigitalTwin.zip`
**Role:** `role-bim-twin` — BIM and Digital Twin
**Application root (central repository):** the Green Twin project root that contains `scripts/`, `tests/`, `docs/`, `output/`, `frontend/`, `DS3_TalTech_V4.ifc` and `Taltech.zip`.

---

## 1. Purpose

This package owns everything that turns the raw IFC4 building model into the
spatial foundation used by the rest of Green Twin:

* IFC4 space/storey extraction from `DS3_TalTech_V4.ifc`.
* The canonical campus registry (`campus_registry.json`, `spaces.json`).
* The resource/geometry state (`resource_state.json`).
* The sensor↔IFC mapping investigation (`sensor_ifc_mapping.json`).
* The 3D digital twin artifacts (glTF/GLB meshes + manifests).
* The Twin UI pieces: 3D viewer, BIM space panel, Digital Twin page,
  floor navigation, room selection and geometry data access.

## 2. Included files

See `MANIFEST.json` for the exact list with sizes and SHA-256 checksums.

| Area | Files |
|---|---|
| Source model | `DS3_TalTech_V4.ifc` (the real IFC4 model, ~37 MB) |
| Extraction | `scripts/extract_ifc_spaces.py`, `scripts/investigate_sensor_ifc_mapping.py` |
| Twin build | `scripts/build_twin.py`, `scripts/build_real_twin.py` |
| State | `scripts/resource_state.py` |
| Shared config | `scripts/telemetry_config.py` (required import of `resource_state.py`) |
| Tests | `tests/test_campus_registry.py`, `tests/test_sensor_ifc_mapping.py` |
| Data outputs | `output/campus_registry.json`, `output/spaces.json`, `output/resource_state.json`, `output/sensor_ifc_mapping.json` |
| 3D assets | `frontend/public/models/campus_twin.glb`, `campus_twin_schematic.glb`, `twin_manifest.json`, `twin_manifest_schematic.json` |
| Twin UI | `frontend/src/components/TwinViewer.tsx`, `frontend/src/components/BimSpacePanel.tsx` (+ test), `frontend/src/pages/DigitalTwin.tsx` (+ deep-link test), `frontend/src/lib/spacesData.ts` |
| Docs | `docs/M2_EXTERNAL_MAPPING_RESEARCH.md`, `docs/SENSOR_IFC_MAPPING_REPORT.md` |

## 3. Excluded files (and how to obtain them)

To avoid duplicating large datasets, the following **shared assets are owned by
other packages** and are intentionally *not* inside this ZIP. Obtain them from
the central repository at the paths shown:

| Excluded asset | Owned by | How to obtain |
|---|---|---|
| `Taltech.zip` (~5.5 MB raw sensor export) | Analytics (`GreenTwin_Analytics_Backend.zip`) | Copy the file from the repository root, or from the analytics package. |
| `data/extracted/*.csv` (69 CSVs, ~112 MB) | regenerable | `unzip Taltech.zip -d data/extracted` (the archive stores the CSVs flat at its root). |
| `output/*.json` other than the four listed above | Analytics | Copy from `output/` in the repository root, or run the analytics pipeline. |
| Full React app, CV workflow, AI UI | Frontend (`GreenTwin_Frontend_CV_GenAI.zip`) | The Twin UI files listed above are also carried by the frontend package so it builds; keep them identical. |

> **Note:** `tests/test_sensor_ifc_mapping.py` reads `Taltech.zip` **and**
> `data/extracted/*.csv`. Those are analytics-owned/regenerable, so this test
> requires the two steps in the table above before it will pass in isolation.

## 4. Setup

```bash
# 1. Work in the application root of the central repository.
# 2. Python environment
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
# build_real_twin.py also needs the IFC geometry engine:
pip install ifcopenshell

# 3. Materialise the shared telemetry assets (if you want the full test suite)
unzip -o Taltech.zip -d data/extracted
```

## 5. Tests

```bash
# from the application root
python -m pytest tests/test_campus_registry.py -q
python -m pytest tests/test_sensor_ifc_mapping.py -q   # needs Taltech.zip + data/extracted
```

Both test modules are **read-only** with respect to the source data (the IFC size
and SHA-256, and the ZIP size, are pinned by the tests).

Rebuild the twin after editing geometry code:

```bash
python scripts/extract_ifc_spaces.py     # -> output/campus_registry.json, output/spaces.json
python scripts/build_real_twin.py        # -> frontend/public/models/*.glb + manifests
python scripts/resource_state.py         # -> output/resource_state.json
```

## 6. Required environment variables

None for BIM/twin code. (The `.env` file belongs to Analytics/GenAI and is
**never** shipped in any package.)

## 7. Shared dependencies & cross-role contracts

* `scripts/telemetry_config.py` — shared path/constant module. `resource_state.py`
  imports `RESOURCE_STATE` from it. Treat it as a **shared contract**; do not
  rename its public constants.
* `scripts/investigate_sensor_ifc_mapping.py` — produces `output/sensor_ifc_mapping.json`
  and is imported by `scripts/extract_ifc_spaces.py` (this package) and by
  Analytics (`ingest_sensor_data.py`, `telemetry_profile.py`).
* **API contract:** the FastAPI backend (Analytics) serves `spaces.json`,
  `campus_registry.json`, `resource_state.json` and `sensor_ifc_mapping.json`
  under `/api/*`. The JSON shapes are the contract — do not change keys/units
  without updating the backend and the frontend consumers in lockstep.
* **Frontend contract:** `TwinViewer.tsx` / `BimSpacePanel.tsx` /
  `spacesData.ts` are also published by the frontend package. Keep the copies
  byte-identical; coordinate before changing props or JSON expectations.

## 8. Files that must NOT be overwritten when applying this package

When applying this package onto the central repository, it must **not** replace:

* anything under `frontend/src/` **other than** the Twin UI files this package
  ships (`TwinViewer.tsx`, `BimSpacePanel.tsx`(+test), `DigitalTwin.tsx`
  (+test), `spacesData.ts`);
* Analytics-owned scripts (`api_app.py`, `ingest_sensor_data.py`,
  `telemetry_*.py`, `decision_*.py`, `recommendation_engine.py`,
  `linkage_engine.py`, `replay_engine.py`, `room_status.py`, `building_context.py`,
  `ai_*.py`, `forecaster.py`);
* AI/CV docs and the CV assets under `frontend/public/vision/`;
* `.env`, `.git`, or any credentials.

If a conflict occurs on a shared file (`telemetry_config.py`,
`investigate_sensor_ifc_mapping.py`), stop and reconcile manually — do not
blindly overwrite.
