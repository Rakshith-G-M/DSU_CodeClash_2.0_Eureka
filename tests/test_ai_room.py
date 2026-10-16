"""Green Twin — room-scoped AI workflow tests.

Covers the room-intelligence GenAI surface: the automatic analysis of the room
the operator is viewing, occupancy-vs-capacity grounding, staleness, the
``based_on`` state fingerprint, room-scoped follow-ups, the occupancy/ventilation
guardrail, and the API endpoint.

No test here touches the network or needs a real API key: the OpenRouter client
is exercised through an injected fake client returning canned text.
"""

import json
import os
import sys
from datetime import datetime, timezone

import pytest

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(BASE_DIR, "scripts"))

import api_app  # noqa: E402
from ai_config import load_config  # noqa: E402
from ai_service import AiService  # noqa: E402

SECRET = "sk-or-v1-ROOM-SECRET-DO-NOT-LEAK-12345"

ROOM_A = "space_room_A"          # capacity 10
ROOM_B = "space_room_B"          # no declared capacity
STOREY_ID = "storey_1"

NOW_MS = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc).timestamp() * 1000.0


# ── synthetic application data ────────────────────────────────────────────────
def make_datapack() -> dict:
    return {
        "campus_registry": {
            "campus": {"name": "TalTech", "space_count": 2, "storey_count": 1},
            "buildings": [{"id": "b1", "name": "Ehituse Mäemaja", "space_count": 2,
                           "storey_ids": [STOREY_ID]}],
            "storeys": [{"id": STOREY_ID, "name": "1. korrus", "space_count": 2,
                         "elevation": 0.0}],
        },
        "resource_state": {
            "summary": {"total_area_m2": 90.0, "total_capacity_occupants": 10.0,
                        "metric_origin_note": "design metrics only"},
            "availability": {"present": False},
            "spaces": [
                {"space_id": ROOM_A, "ifc_name": "A", "storey_id": STOREY_ID,
                 "storey_name": "1. korrus", "building_id": "b1",
                 "geometry": {"area_m2": 50.0, "volume_m3": 150.0, "height_m": 3.0},
                 "capacity_occupants": 10.0,
                 "occupancy": {"occupiable": True, "capacity_occupants": 10.0},
                 "conditioning": {"condition_type": "Heated and cooled"}},
                {"space_id": ROOM_B, "ifc_name": "B", "storey_id": STOREY_ID,
                 "storey_name": "1. korrus", "building_id": "b1",
                 "geometry": {"area_m2": 40.0, "volume_m3": 120.0, "height_m": 3.0},
                 "capacity_occupants": None,
                 "occupancy": {"occupiable": True}},
            ],
        },
        "spaces_bim": {
            "spaces": [
                {"space_id": ROOM_A, "ifc_name": "A", "storey_id": STOREY_ID,
                 "capacity": 10.0, "occupiable": True,
                 "bim_properties": {"Energy Analysis.Number of People": 10.0}},
                {"space_id": ROOM_B, "ifc_name": "B", "storey_id": STOREY_ID,
                 "occupiable": True, "bim_properties": {}},
            ]
        },
        "sensors": {"count": 1, "sensors": [
            {"sensor_id": "s1", "type": "co2", "unit": "ppm", "status": "unmapped",
             "channel_count": 1}]},
        "sensor_health": {"summary": {"devices": 1, "healthy": 1, "degraded": 0,
                                      "overall": "OK"}, "devices": []},
        "telemetry_profile": {"summary": {"channels": 1}, "channels": []},
        "sensor_space_mapping": {
            "summary": {"total": 1, "resolved": 0, "unresolved": 1,
                        "verified_locations": 0}
        },
        "telemetry_intelligence_summary": {"dataset": {}, "intelligence": {}},
        "decision_candidates": {"records": []},
        "recommendations": {"records": []},
    }


def _structured_text(**overrides) -> str:
    base = {
        "answer": "The room is lightly occupied and its air quality is unmeasured.",
        "evidence": [
            {"claim": "Camera occupancy estimate", "source": "webcam_occupancy",
             "value": "3 people", "provenance": "WEBCAM_ESTIMATE",
             "reference": "demo association"}
        ],
        "likely_causes": [
            {"cause": "Routine occupancy", "basis": "count below capacity",
             "status": "HYPOTHESIS", "confidence": "low"}
        ],
        "recommendations": [
            {"title": "Confirm ventilation with a CO2 measurement",
             "opportunity": "Room-level air quality is unmeasured.",
             "evidence": "No verified room-level sensor exists.",
             "action": "Take a spot CO2 reading during occupancy.",
             "component": "room A", "why_relevant": "Ventilation cannot be "
             "inferred from a camera count.",
             "verification": "Compare CO2 against the design guideline.",
             "expected_impact_direction": "unknown", "priority": "MEDIUM",
             "assumptions": "", "limitations": "", "impact_status": "UNKNOWN"},
        ],
        "next_checks": ["Measure CO2 during peak occupancy"],
        "assumptions": [],
        "limitations": ["Room-level telemetry unavailable."],
        "provenance": {"data_freshness": "live", "sources": ["webcam_occupancy"],
                       "is_hypothetical": False},
    }
    base.update(overrides)
    return json.dumps(base)


class FakeClient:
    def __init__(self, content=None, error=None, config=None):
        self._content = content if content is not None else _structured_text()
        self._error = error
        self.config = config or load_config(env={"OPENROUTER_API_KEY": SECRET})
        self.calls = []

    def chat(self, messages, *, temperature=0.2, max_tokens=1200, json_mode=False):
        self.calls.append(messages)
        if self._error is not None:
            raise self._error
        return self._content


def make_service(client, dp=None):
    cfg = client.config
    return AiService(dp if dp is not None else make_datapack(), client=client,
                     config=cfg)


def _observation(space_id, count, *, ts=None, stale=False, kind="DEMO_MAPPING"):
    stamp = ts if ts is not None else datetime.fromtimestamp(
        NOW_MS / 1000.0, tz=timezone.utc).isoformat()
    return {"count": count, "source": "LIVE_CAMERA", "timestamp": stamp,
            "space_id": space_id, "mapping_kind": kind}


def _last_prompt(client) -> str:
    return client.calls[-1][-1]["content"]


# ── 1. automatic analysis is grounded in the room ─────────────────────────────
def test_automatic_analysis_is_room_scoped_and_returns_based_on():
    client = FakeClient()
    svc = make_service(client)
    resp = svc.room_analysis(ROOM_A, state_version="v1:roomA", now_ms=NOW_MS,
                             observation=_observation(ROOM_A, 3))

    assert resp.status == "OK"
    assert resp.context is not None and resp.context.scope == "ROOM"
    assert resp.context.space_id == ROOM_A
    assert resp.deterministic_status is not None
    assert resp.deterministic_status.space_id == ROOM_A
    assert resp.based_on is not None
    assert resp.based_on.space_id == ROOM_A
    assert resp.based_on.state_version == "v1:roomA"
    assert resp.based_on.occupancy_count == 3.0
    assert resp.based_on.occupancy_is_demo is True
    assert resp.answer and resp.recommendations

    prompt = _last_prompt(client)
    assert "room A" in prompt or ROOM_A in prompt


# ── 2. over-capacity is detected deterministically, not by the model ───────────
def test_over_capacity_is_computed_server_side():
    svc = make_service(FakeClient())
    resp = svc.room_analysis(ROOM_A, now_ms=NOW_MS,
                             observation=_observation(ROOM_A, 12))
    assert resp.deterministic_status is not None
    assert resp.deterministic_status.level == "OVER_CAPACITY"
    assert resp.deterministic_status.capacity == 10.0
    assert resp.deterministic_status.occupancy_is_demo is True
    assert resp.based_on.status_level == "OVER_CAPACITY"


# ── 3. a stale camera observation never counts as live ────────────────────────
def test_stale_observation_is_flagged_and_not_over_capacity():
    old = "2020-01-01T00:00:00+00:00"
    svc = make_service(FakeClient())
    resp = svc.room_analysis(ROOM_A, now_ms=NOW_MS,
                             observation=_observation(ROOM_A, 50, ts=old))
    assert resp.deterministic_status is not None
    assert resp.deterministic_status.occupancy_stale is True
    assert resp.deterministic_status.level == "UNKNOWN"
    assert resp.based_on.occupancy_stale is True


# ── 4. a room without a declared capacity still analyses honestly ─────────────
def test_room_without_capacity_does_not_invent_a_limit():
    svc = make_service(FakeClient())
    resp = svc.room_analysis(ROOM_B, now_ms=NOW_MS,
                             observation=_observation(ROOM_B, 4))
    assert resp.status == "OK"
    assert resp.deterministic_status is not None
    assert resp.deterministic_status.capacity is None
    assert resp.deterministic_status.level == "UNKNOWN"


# ── 5. the camera association is never applied to the wrong room ──────────────
def test_observation_for_another_room_is_ignored():
    svc = make_service(FakeClient())
    resp = svc.room_analysis(ROOM_B, now_ms=NOW_MS,
                             observation=_observation(ROOM_A, 12))
    assert resp.deterministic_status is not None
    # The count belongs to ROOM_A, so ROOM_B gets no occupancy.
    assert resp.deterministic_status.occupancy_count is None
    assert resp.deterministic_status.level == "UNKNOWN"


# ── 6. the occupancy/ventilation guardrail is enforced in the prompt ──────────
def test_prompt_forbids_ventilation_claims_from_camera_count():
    client = FakeClient()
    svc = make_service(client)
    svc.room_analysis(ROOM_A, now_ms=NOW_MS, observation=_observation(ROOM_A, 12))
    prompt = _last_prompt(client).lower()
    assert "ventilation" in prompt
    assert "cannot be determined" in prompt
    assert "capacity" in prompt


def test_room_prompt_is_action_first_and_not_a_seven_part_essay():
    client = FakeClient()
    svc = make_service(client)
    svc.room_analysis(ROOM_A, now_ms=NOW_MS, observation=_observation(ROOM_A, 3))
    prompt = _last_prompt(client)
    # The primary action is explicitly requested first …
    assert "NEXT ACTION" in prompt
    # … and the old seven-section essay structure is gone.
    assert "a plain-language summary of what is happening" not in prompt
    assert "limitations and missing evidence" not in prompt
    assert "the expected impact ONLY where" not in prompt


# ── 7. follow-ups stay scoped to the room and carry history ───────────────────
def test_follow_up_is_room_scoped_with_history():
    client = FakeClient()
    svc = make_service(client)
    history = [
        {"role": "user", "content": "What is happening here?"},
        {"role": "assistant", "content": "Light occupancy."},
    ]
    resp = svc.room_analysis(ROOM_A, question="Should I open a window?",
                             history=history, now_ms=NOW_MS,
                             observation=_observation(ROOM_A, 3))
    assert resp.status == "OK"
    messages = client.calls[-1]
    roles = [m["role"] for m in messages]
    assert "system" in roles
    assert roles.count("user") >= 2  # the history turn + the current question
    prompt = _last_prompt(client)
    assert "open a window" in prompt
    assert "THIS room" in prompt or "this room" in prompt


# ── 8. unknown room / missing id are rejected without a model call ────────────
def test_unknown_room_is_invalid_input():
    client = FakeClient()
    svc = make_service(client)
    resp = svc.room_analysis("space_does_not_exist")
    assert resp.status == "INVALID_INPUT"
    assert client.calls == []


def test_missing_room_id_is_invalid_input():
    client = FakeClient()
    svc = make_service(client)
    assert svc.room_analysis("").status == "INVALID_INPUT"
    assert client.calls == []


# ── 9. not-configured degrades honestly but keeps the deterministic status ────
def test_not_configured_returns_deterministic_status():
    cfg = load_config(env={"OPENROUTER_API_KEY": ""})
    client = FakeClient(config=cfg)
    svc = AiService(make_datapack(), client=client, config=cfg)
    resp = svc.room_analysis(ROOM_A, now_ms=NOW_MS,
                             observation=_observation(ROOM_A, 12))
    assert resp.status == "NOT_CONFIGURED"
    assert resp.deterministic_status is not None
    assert resp.deterministic_status.level == "OVER_CAPACITY"
    assert resp.based_on is not None


# ── 10. no secrets ────────────────────────────────────────────────────────────
def test_room_response_never_contains_the_api_key():
    svc = make_service(FakeClient())
    resp = svc.room_analysis(ROOM_A, now_ms=NOW_MS, observation=_observation(ROOM_A, 3))
    blob = resp.model_dump_json()
    assert SECRET not in blob
    assert "api_key" not in blob.lower()


# ── 11. API endpoint ──────────────────────────────────────────────────────────
def _api_client(svc=None):
    from fastapi.testclient import TestClient

    app = api_app.create_app(datapack=make_datapack(),
                             ai_service=svc or make_service(FakeClient()))
    return TestClient(app)


def test_api_room_endpoint_returns_structured_response():
    client = _api_client()
    r = client.post("/api/ai/room", json={"space_id": ROOM_A,
                                          "state_version": "v1:x"})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "OK"
    assert body["context"]["scope"] == "ROOM"
    assert body["based_on"]["state_version"] == "v1:x"
    assert body["deterministic_status"]["space_id"] == ROOM_A


def test_api_room_endpoint_rejects_missing_space_id():
    client = _api_client()
    r = client.post("/api/ai/room", json={"question": "hi"})
    assert r.status_code == 422
