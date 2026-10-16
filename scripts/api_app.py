"""CampusIQ — M7 product API (FastAPI).

Thin HTTP projection over the pure recommendation logic in
recommendation_engine.py — no business logic lives here, and every endpoint is
read-only (it never fabricates availability or schedules).

Read endpoints never dump whole 18MB anomaly files: they return
summarised, filterable, paginated projections:
    {"items": [...], "total": N, "limit": L, "offset": O}

Run (dev):
    uvicorn api_app:app --reload
"""

import asyncio
import json
import os
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from telemetry_config import OUTPUT_DIR
from recommendation_engine import build_dashboard_summary
from replay_engine import get_controller
from ai_service import AiService

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(BASE_DIR, "output")


def _num(value) -> float | None:
    """Coerce a scalar to float, or None for empty/None/bool values."""
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _paginate(items: list, limit: int, offset: int) -> dict:
    limit = max(0, min(int(limit), 1000))
    offset = max(0, int(offset))
    return {
        "items": items[offset : offset + limit],
        "total": len(items),
        "limit": limit,
        "offset": offset,
    }


def load_datapack(out_dir: str = OUT) -> dict:
    def _load(name: str) -> Any:
        path = os.path.join(out_dir, name)
        if not os.path.exists(path):
            return {}
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)

    return {
        "sensors": _load("sensors.json"),
        "sensor_health": _load("sensor_health.json"),
        "sensor_space_mapping": _load("sensor_space_mapping.json"),
        "campus_registry": _load("campus_registry.json"),
        "resource_state": _load("resource_state.json"),
        "forecasts": _load("forecasts.json"),
        "anomalies": _load("anomalies.json"),
        "telemetry_profile": _load("telemetry_profile.json"),
        "telemetry_intelligence_summary": _load("telemetry_intelligence_summary.json"),
        "decision_candidates": _load("decision_candidates.json"),
        "recommendations": _load("recommendations.json"),
        "spaces_bim": _load("spaces.json"),
    }


def create_app(datapack: dict | None = None, ai_service: AiService | None = None) -> FastAPI:
    dp = datapack if datapack is not None else load_datapack()
    app = FastAPI(
        title="CampusIQ Decision API",
        version="v1",
        description="Read-only decision-support API for the CampusIQ frontend (M7).",
    )

    # Cross-origin access for the deployed Vercel frontend and local dev.
    # Explicit origins only (never "*"); the render.com service does not serve
    # the UI, so every browser request carries an Origin header we enumerate.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "https://campusiq-black.vercel.app",
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://localhost:4173",
            "http://127.0.0.1:4173",
        ],
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "Accept"],
        expose_headers=["Content-Type", "Content-Length"],
    )

    def generated_at() -> str:
        return datetime.now(timezone.utc).isoformat(timespec="seconds")

    # Generative AI (OpenRouter). The key is read from the environment on the
    # backend only; `ai_service` is injectable for tests so no network/key is
    # needed in the automated suite.
    ai = ai_service if ai_service is not None else AiService(
        dp, replay_provider=get_controller().get_current_state
    )

    def mapping_status() -> str:
        m = dp.get("sensor_space_mapping", {}).get("summary", {})
        return "UNRESOLVED" if (m.get("unresolved") or 0) >= (m.get("total") or 1) else "PARTIAL"

    @app.get("/")
    def root():
        return {
            "name": "CampusIQ Decision API",
            "schema_version": "campusiq.api/v1",
            "endpoints": sorted(
                ["/api/campus", "/api/spaces", "/api/resources", "/api/telemetry/summary",
                 "/api/anomalies", "/api/forecasts", "/api/recommendations",
                 "/api/recommendations/{id}", "/api/health", "/api/decision-candidates",
                 "/api/dashboard/summary",
                 "/api/ai/status", "/api/ai/assistant", "/api/ai/recommendations",
                 "/api/ai/explain-status", "/api/ai/finding", "/api/ai/room",
                 "/api/spaces/{space_id}/bim-design"]
            ),
        }

    @app.get("/api/campus")
    def api_campus():
        reg = dp.get("campus_registry", {})
        campus = reg.get("campus") or {}
        buildings = reg.get("buildings") or []
        storeys = reg.get("storeys") or []
        return {
            "campus": {"campus_id": campus.get("campus_id"), "name": campus.get("name")},
            "buildings": [
                {"building_id": b.get("id"), "name": b.get("name"),
                 "space_count": b.get("space_count"),
                 "storey_ids": b.get("storey_ids", [])}
                for b in buildings
            ],
            "storeys": [
                {"storey_id": s.get("storey_id"), "name": s.get("storey_name") or s.get("name"),
                 "space_count": s.get("space_count")}
                for s in storeys
            ],
            "building_count": len(buildings),
            "storey_count": len(storeys),
        }

    @app.get("/api/spaces")
    def api_spaces(
        storey_id: str | None = None,
        occupiable: bool | None = None,
        min_capacity: float | None = None,
        limit: int = Query(50, ge=1, le=1000),
        offset: int = Query(0, ge=0),
    ):
        spaces = dp.get("resource_state", {}).get("spaces", [])
        items = [
            {
                "space_id": s["space_id"],
                "ifc_global_id": s.get("ifc_global_id"),
                "ifc_name": s.get("ifc_name"),
                "ifc_long_name": s.get("ifc_long_name"),
                "storey_name": s.get("storey_name"),
                "building_id": s.get("building_id"),
                "storey_id": s.get("storey_id"),
                "area_m2": (s.get("geometry") or {}).get("area_m2"),
                "volume_m3": (s.get("geometry") or {}).get("volume_m3"),
                "capacity_occupants": s.get("capacity_occupants") or (s.get("occupancy") or {}).get("capacity_occupants"),
                "occupiable": (s.get("occupancy") or {}).get("occupiable", True),
                "conditioning": (s.get("conditioning") or {}).get("condition_type"),
            }
            for s in sorted(spaces, key=lambda s: s["space_id"])
        ]
        if storey_id:
            items = [i for i in items if i["storey_id"] == storey_id]
        if occupiable is not None:
            items = [i for i in items if i["occupiable"] is occupiable]
        if min_capacity is not None:
            items = [i for i in items if (i["capacity_occupants"] or 0) >= min_capacity]
        return _paginate(items, limit, offset)

    _DESIGN_FIELDS = [
        ("lighting_design_load_w", "Energy Analysis.Specified Lighting Load"),
        ("lighting_design_load_w_per_area", "Energy Analysis.Specified Lighting Load per area"),
        ("power_design_load_w", "Energy Analysis.Specified Power Load"),
        ("power_design_load_w_per_area", "Energy Analysis.Specified Power Load per area"),
        ("illumination_lx", "Electrical - Lighting.Average Estimated Illumination"),
        ("design_cooling_load_w", "Energy Analysis.Design Cooling Load"),
        ("design_heating_load_w", "Energy Analysis.Design Heating Load"),
        ("air_changes_per_hour", "Energy Analysis.Air Changes per Hour"),
        ("design_occupancy_people", "Energy Analysis.Number of People"),
        ("area_per_person_m2", "Energy Analysis.Area per Person"),
    ]

    @app.get("/api/spaces/{space_id}/bim-design")
    def api_space_bim_design(space_id: str):
        """BIM design/specification values for one space, from the IFC model.

        Additive read-only endpoint (M8.1). Returns design values only — never
        measured operational values. Telemetry is deliberately not bound here.
        """
        spaces = dp.get("spaces_bim", {}).get("spaces", [])
        space = next((s for s in spaces if s.get("space_id") == space_id), None)
        if space is None:
            raise HTTPException(status_code=404, detail="space_id not found")
        bp = space.get("bim_properties") or {}
        design = {}
        for key, src in _DESIGN_FIELDS:
            val = bp.get(src)
            if val is not None and not isinstance(val, bool):
                try:
                    design[key] = round(float(val), 4)
                except (TypeError, ValueError):
                    design[key] = val
        conditioning = (
            bp.get("Energy Analysis.Condition Type")
            or (space.get("bim_properties", {}).get("Space Schedule.Condition Type"))
        )
        return {
            "space_id": space_id,
            "origin": "IFC_DESIGN",
            "measured": False,
            "note": (
                "BIM design/specification values from the IFC model; not measured "
                "operational values. Telemetry location mapping unavailable."
            ),
            "space": {
                "ifc_name": space.get("ifc_name"),
                "storey_id": space.get("storey_id"),
                "area_m2": _num(space.get("area_m2")),
                "volume_m3": _num(space.get("volume_m3")),
                "height_m": _num(space.get("height_m")),
                "capacity_occupants": _num(space.get("capacity")),
                "occupiable": space.get("occupiable"),
            },
            "design": design,
            "conditioning": conditioning,
        }

    @app.get("/api/resources")
    def api_resources(
        limit: int = Query(50, ge=1, le=1000),
        offset: int = Query(0, ge=0),
    ):
        rs = dp.get("resource_state", {})
        spaces = rs.get("spaces", [])
        return {
            "summary": rs.get("summary"),
            "availability": rs.get("availability"),
            "design_metrics": rs.get("design_metrics"),
            "storeys": rs.get("storeys"),
            **{"items": _paginate(
                [
                    {
                        "space_id": s["space_id"],
                        "area_m2": (s.get("geometry") or {}).get("area_m2"),
                        "capacity_occupants": s.get("capacity_occupants"),
                        "metric_origin": s.get("design_metrics", {}).get("metric_origin"),
                    }
                    for s in sorted(spaces, key=lambda s: s["space_id"])
                ],
                limit,
                offset,
            )["items"],
               "total": len(spaces), "limit": limit, "offset": offset,
            },
        }

    @app.get("/api/telemetry/summary")
    def api_telemetry_summary():
        tis = dp.get("telemetry_intelligence_summary", {})
        profile = dp.get("telemetry_profile", {})
        sensors = dp.get("sensors", {})
        return {
            "dataset": tis.get("dataset"),
            "intelligence": {
                "anomalies": tis.get("intelligence", {}).get("anomalies", {}),
            },
            "profile_channels": profile.get("summary"),
            "sensor_count": sensors.get("count", len(sensors.get("sensors", []))),
            "generated_at": generated_at(),
        }

    @app.get("/api/anomalies")
    def api_anomalies(
        severity: str | None = None,
        measurement_type: str | None = None,
        sensor_id: str | None = None,
        location_status: str | None = None,
        limit: int = Query(50, ge=1, le=1000),
        offset: int = Query(0, ge=0),
    ):
        anomalies = dp.get("anomalies", {}).get("anomalies", [])
        items = [
            a for a in anomalies
            if (severity is None or a.get("severity") == severity)
            and (measurement_type is None or a.get("measurement_type") == measurement_type)
            and (sensor_id is None or a.get("sensor_id") == sensor_id)
            and (location_status is None or a.get("location_status") == location_status)
        ]
        slim = [
            {
                "sensor_id": a.get("sensor_id"),
                "timestamp": a.get("timestamp"),
                "measurement_type": a.get("measurement_type"),
                "unit": a.get("unit"),
                "value": a.get("value"),
                "expected": a.get("expected"),
                "deviation": a.get("deviation"),
                "score": a.get("score"),
                "severity": a.get("severity"),
                "category": a.get("category"),
                "method": a.get("method"),
                "persistence": a.get("persistence"),
                "location_status": a.get("location_status"),
            }
            for a in items
        ]
        return _paginate(slim, limit, offset)

    @app.get("/api/forecasts")
    def api_forecasts(
        sensor_id: str | None = None,
        measurement_type: str | None = None,
        horizon_hours: float | None = None,
        location_status: str | None = None,
        limit: int = Query(50, ge=1, le=1000),
        offset: int = Query(0, ge=0),
    ):
        recs = dp.get("forecasts", {}).get("forecast", {}).get("records", [])
        recs = [
            r for r in recs
            if _rec_match(r, sensor_id, measurement_type, horizon_hours, location_status)
        ]
        return _paginate(recs, limit, offset)

    @app.get("/api/recommendations")
    def api_recommendations(
        priority: str | None = None,
        category: str | None = None,
        problem_type: str | None = None,
        location_status: str | None = None,
        sensor_id: str | None = None,
        limit: int = Query(50, ge=1, le=1000),
        offset: int = Query(0, ge=0),
    ):
        recs = dp.get("recommendations", {}).get("records", [])
        item = [r for r in recs if
                (priority is None or r.get("priority") == priority)
                and (category is None or r.get("recommendation_category") == category)
                and (problem_type is None or r.get("problem_type") == problem_type)
                and (location_status is None or r.get("location_status") == location_status)
                and (sensor_id is None or (r.get("affected_entity") or {}).get("sensor_id") == sensor_id)]
        page = _paginate(item, limit, offset)
        page.update({
            "generated_at": generated_at(),
            "data_status": {"sensor_location_mapping": mapping_status()},
        })
        return page

    @app.get("/api/recommendations/{recommendation_id}")
    def api_recommendation(recommendation_id: str):
        for r in dp.get("recommendations", {}).get("records", []):
            if r.get("recommendation_id") == recommendation_id:
                return r
        raise HTTPException(status_code=404, detail=f"no recommendation {recommendation_id}")

    @app.get("/api/health")
    def api_health(
        health_status: str | None = None,
        sensor_id: str | None = None,
        limit: int = Query(50, ge=1, le=1000),
        offset: int = Query(0, ge=0),
    ):
        devices = dp.get("sensor_health", {}).get("devices", [])
        items = [
            {
                "sensor_id": d.get("sensor_id"),
                "health_status": d.get("health_status"),
                "coverage_fraction": d.get("coverage_fraction"),
                "missing_ratio": d.get("missing_ratio"),
                "valid_readings": d.get("valid_readings"),
                "missing_readings": d.get("missing_readings"),
                "issues": d.get("issues"),
            }
            for d in sorted(devices, key=lambda x: x.get("sensor_id", ""))
            if (health_status is None or d.get("health_status") == health_status)
            and (sensor_id is None or d.get("sensor_id") == sensor_id)
        ]
        page = _paginate(items, limit, offset)
        return {**page, "summary": dp.get("sensor_health", {}).get("summary")}

    @app.get("/api/decision-candidates")
    def api_decision_candidates(
        candidate_type: str | None = None,
        severity: str | None = None,
        problem_type: str | None = None,
        location_status: str | None = None,
        limit: int = Query(50, ge=1, le=1000),
        offset: int = Query(0, ge=0),
    ):
        recs = dp.get("decision_candidates", {}).get("records", [])
        items = [r for r in recs if
                 (candidate_type is None or r.get("candidate_type") == candidate_type)
                 and (severity is None or r.get("severity") == severity)
                 and (problem_type is None or r.get("problem_type") == problem_type)
                 and (location_status is None or r.get("location_status") == location_status)]
        page = _paginate(items, limit, offset)
        return {**page, "summary": dp.get("decision_candidates", {}).get("summary")}

    @app.get("/api/dashboard/summary")
    def api_dashboard_summary():
        db = build_dashboard_summary(dp)
        db["generated_at"] = generated_at()
        return db

    # ── Generative AI Endpoints ────────────────────────────────────────────────
    class AiObservation(BaseModel):
        """Client-supplied camera occupancy — always treated as an estimate."""

        count: float | None = None
        source: str | None = Field(None, max_length=40)
        timestamp: str | None = Field(None, max_length=40)
        space_id: str | None = Field(None, max_length=200)
        mapping_kind: str | None = Field(None, max_length=40)

    class AiAssistantRequest(BaseModel):
        question: str = Field(..., min_length=1, max_length=2000)
        space_id: str | None = Field(None, max_length=200)
        observation: AiObservation | None = None

    class AiRecommendationsRequest(BaseModel):
        space_id: str | None = Field(None, max_length=200)
        focus: str | None = Field(None, max_length=300)

    class AiExplainStatusRequest(BaseModel):
        space_id: str = Field(..., min_length=1, max_length=200)
        observation: AiObservation | None = None

    class AiConversationTurn(BaseModel):
        role: Literal["user", "assistant"]
        content: str = Field(..., min_length=1, max_length=4000)

    class AiFindingRequest(BaseModel):
        finding_id: str = Field(..., min_length=1, max_length=200)
        question: str | None = Field(None, max_length=2000)
        history: list[AiConversationTurn] | None = Field(None, max_length=12)
        observation: AiObservation | None = None

    class AiRoomRequest(BaseModel):
        """Room-scoped analysis request (auto-analysis + follow-ups).

        ``state_version`` is the client's material room-state fingerprint. It is
        echoed back in ``based_on`` so the UI can mark an analysis stale when the
        room state has since changed; it never overrides server-side values.
        """

        space_id: str = Field(..., min_length=1, max_length=200)
        question: str | None = Field(None, max_length=2000)
        history: list[AiConversationTurn] | None = Field(None, max_length=12)
        observation: AiObservation | None = None
        state_version: str | None = Field(None, max_length=200)
        trigger: str | None = Field(None, max_length=40)

    def _obs_dict(obs: AiObservation | None) -> dict | None:
        return obs.model_dump() if obs is not None else None

    @app.get("/api/ai/status")
    def api_ai_status():
        """Non-secret AI configuration status, so the UI can degrade honestly."""
        return ai.status()

    @app.post("/api/ai/assistant")
    def api_ai_assistant(req: AiAssistantRequest):
        return ai.assistant(
            req.question,
            space_id=req.space_id,
            observation=_obs_dict(req.observation),
        )

    @app.post("/api/ai/recommendations")
    def api_ai_recommendations(req: AiRecommendationsRequest):
        return ai.sustainability_recommendations(
            space_id=req.space_id, focus=req.focus
        )

    @app.post("/api/ai/explain-status")
    def api_ai_explain_status(req: AiExplainStatusRequest):
        return ai.explain_status(
            req.space_id, observation=_obs_dict(req.observation)
        )

    @app.post("/api/ai/finding")
    def api_ai_finding(req: AiFindingRequest):
        """Automatic analysis + follow-ups for one diagnostic finding.

        The finding is resolved from the backend datapack (authoritative); the
        client only supplies its id, never the measurements.
        """
        return ai.finding_analysis(
            req.finding_id,
            question=req.question,
            history=[t.model_dump() for t in req.history] if req.history else None,
            observation=_obs_dict(req.observation),
        )

    @app.post("/api/ai/room")
    def api_ai_room(req: AiRoomRequest):
        """Automatic analysis + follow-ups for the room the operator is viewing.

        The room identifiers, capacity and design values are resolved from the
        backend datapack; the client only supplies the room id, the (optional)
        camera observation and a material state-version fingerprint. The
        deterministic room status is computed server-side and cannot be changed
        by the model.
        """
        return ai.room_analysis(
            req.space_id,
            question=req.question,
            history=[t.model_dump() for t in req.history] if req.history else None,
            observation=_obs_dict(req.observation),
            state_version=req.state_version,
            trigger=req.trigger,
        )

    # ── Replay / Simulation Endpoints ──────────────────────────────────────────
    replay_ctrl = get_controller()

    @app.get("/api/replay/status")
    def api_replay_status():
        st = replay_ctrl.get_status()
        return {
            "running": st.running,
            "speed": st.speed,
            "sim_timestamp": st.sim_timestamp,
            "readings_replayed": st.readings_replayed,
            "anomalies_detected": st.anomalies_detected,
            "channels_active": st.channels_active,
        }

    @app.post("/api/replay/start")
    def api_replay_start():
        replay_ctrl.start()
        st = replay_ctrl.get_status()
        return {
            "status": "started",
            "running": st.running,
            "speed": st.speed,
            "sim_timestamp": st.sim_timestamp,
        }

    @app.post("/api/replay/pause")
    def api_replay_pause():
        replay_ctrl.pause()
        st = replay_ctrl.get_status()
        return {
            "status": "paused",
            "running": st.running,
            "speed": st.speed,
            "sim_timestamp": st.sim_timestamp,
        }

    @app.post("/api/replay/reset")
    def api_replay_reset():
        replay_ctrl.reset()
        st = replay_ctrl.get_status()
        return {
            "status": "reset",
            "running": st.running,
            "speed": st.speed,
            "sim_timestamp": st.sim_timestamp,
        }

    class SpeedRequest(BaseModel):
        speed: float = Field(..., gt=0)

    @app.post("/api/replay/speed")
    def api_replay_speed(req: SpeedRequest):
        replay_ctrl.set_speed(req.speed)
        st = replay_ctrl.get_status()
        return {"speed": st.speed, "running": st.running}

    @app.get("/api/replay/current")
    def api_replay_current():
        return replay_ctrl.get_current_state()

    @app.get("/api/replay/history")
    def api_replay_history(
        sensor_id: str = Query(...),
        measurement_type: str = Query(...),
        limit: int = Query(100, ge=1, le=500),
    ):
        hist = replay_ctrl.get_rolling_history(sensor_id, measurement_type, limit=limit)
        return {
            "sensor_id": sensor_id,
            "measurement_type": measurement_type,
            "count": len(hist),
            "history": hist,
        }

    @app.websocket("/ws/replay")
    async def ws_replay(websocket: WebSocket):
        await websocket.accept()
        try:
            while True:
                state = replay_ctrl.get_current_state()
                await websocket.send_json(state)
                await asyncio.sleep(0.8)
        except (WebSocketDisconnect, Exception):
            pass

    return app


def _rec_match(r, sensor_id, measurement_type, horizon_hours, location_status):
    if sensor_id is not None and r.get("sensor_id") != sensor_id:
        return False
    if measurement_type is not None and r.get("measurement_type") != measurement_type:
        return False
    if horizon_hours is not None and r.get("horizon_hours") != horizon_hours:
        return False
    if location_status is not None and r.get("location_status") != location_status:
        return False
    return True


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("api_app:app", host="127.0.0.1", port=8000, reload=False)
