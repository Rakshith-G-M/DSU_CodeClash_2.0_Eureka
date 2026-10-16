"""Green Twin — Generative AI service tests.

These tests never touch the network and never require a real API key: the
OpenRouter client is exercised through an injected fake transport, and the AI
service through a fake client that returns canned text.

Coverage (maps to the milestone acceptance criteria):
  1. missing API key
  2. valid mocked OpenRouter response
  3. rate-limit and provider failures
  4. malformed model output
  5. selected-room context
  6. unmapped room telemetry
  7. historical replay vs live observations
  8. unsupported energy/carbon savings claims
  9. explanations of existing room status
 10. no secrets exposed in responses / frontend
"""

import json
import os
import sys

import pytest

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(BASE_DIR, "scripts"))

import ai_schemas  # noqa: E402
import api_app  # noqa: E402
import building_context as bc  # noqa: E402
import room_status  # noqa: E402
from ai_config import load_config  # noqa: E402
from ai_openrouter import (  # noqa: E402
    MALFORMED,
    NOT_CONFIGURED,
    PROVIDER_ERROR,
    RATE_LIMITED,
    TIMEOUT,
    OpenRouterClient,
)
from ai_service import AiService  # noqa: E402

SECRET = "sk-or-v1-SECRET-DO-NOT-LEAK-12345"

ROOM_ID = "space_room_A"
STOREY_ID = "storey_1"
OTHER_ROOM = "space_room_B"


# ── synthetic application data ────────────────────────────────────────────────
def make_datapack() -> dict:
    return {
        "campus_registry": {
            "campus": {"name": "TalTech", "space_count": 2, "storey_count": 1},
            "buildings": [
                {"id": "b1", "name": "Ehituse Mäemaja", "space_count": 2,
                 "storey_ids": [STOREY_ID]}
            ],
            "storeys": [
                {"id": STOREY_ID, "name": "1. korrus", "space_count": 2, "elevation": 0.0}
            ],
        },
        "resource_state": {
            "summary": {
                "total_area_m2": 100.0,
                "total_capacity_occupants": 30.0,
                "metric_origin_note": "design metrics only",
            },
            "availability": {"present": False},
            "spaces": [
                {
                    "space_id": ROOM_ID,
                    "ifc_name": "101",
                    "storey_id": STOREY_ID,
                    "storey_name": "1. korrus",
                    "building_id": "b1",
                    "geometry": {"area_m2": 50.0, "volume_m3": 150.0, "height_m": 3.0},
                    "capacity_occupants": 10.0,
                    "occupancy": {"occupiable": True, "capacity_occupants": 10.0},
                    "conditioning": {"condition_type": "Heated and cooled"},
                },
            ],
        },
        "spaces_bim": {
            "spaces": [
                {
                    "space_id": ROOM_ID,
                    "ifc_name": "101",
                    "storey_id": STOREY_ID,
                    "area_m2": 50.0,
                    "volume_m3": 150.0,
                    "height_m": 3.0,
                    "capacity": 10.0,
                    "occupiable": True,
                    "bim_properties": {
                        "Energy Analysis.Number of People": 10.0,
                        "Energy Analysis.Specified Lighting Load": 120.0,
                    },
                }
            ]
        },
        "sensor_space_mapping": {
            "summary": {
                "total": 36, "resolved": 0, "unresolved": 36,
                "verified_locations": 0,
            }
        },
        "telemetry_intelligence_summary": {
            "dataset": {
                "devices": 36, "channels": 69, "total_readings": 1390297,
                "channels_by_type": {"temperature": 29, "co2": 7},
                "time_span": {"first": "2024-01-01T00:00:00", "last": "2025-06-30T00:00:00"},
            },
            "intelligence": {
                "anomalies": {
                    "by_severity": {"CRITICAL": 3, "HIGH": 2},
                    "by_measurement_type": {"co2": 4, "temperature": 1},
                }
            },
        },
        "telemetry_profile": {"summary": {"channels": 69, "sensors": 36}},
        "sensors": {"count": 36},
        "sensor_health": {
            "summary": {"devices": 36, "healthy": 33, "degraded": 3, "overall": "DEGRADED"}
        },
        "recommendations": {
            "records": [
                {
                    "recommendation_id": "R-room",
                    "priority": "HIGH",
                    "recommendation_category": "ENVIRONMENTAL",
                    "problem_type": "detected_anomaly",
                    "recommended_action": "Investigate ventilation for this room.",
                    "reason": "CO2 deviation above baseline.",
                    "location_status": "VERIFIED_BIM",
                    "location": {"status": "VERIFIED_BIM", "space_id": ROOM_ID},
                    "affected_entity": {"type": "space", "space_id": ROOM_ID},
                    "expected_impact": [{"type": "risk_reduction", "status": "QUALITATIVE",
                                         "value": None, "unit": None}],
                },
                {
                    "recommendation_id": "R-sensor",
                    "priority": "HIGH",
                    "recommendation_category": "SENSOR_HEALTH",
                    "problem_type": "sensor_degraded",
                    "recommended_action": "Service sensor.",
                    "reason": "Constant value detected.",
                    "location_status": "UNKNOWN_LOCATION",
                    "location": {"status": "UNKNOWN_LOCATION", "space_id": None},
                    "affected_entity": {"type": "sensor", "sensor_id": "s1"},
                },
            ]
        },
        "decision_candidates": {"records": []},
        "forecasts": {},
        "anomalies": {},
    }


def _structured_text(**overrides) -> str:
    base = {
        "answer": "Grounded answer.",
        "evidence": [
            {"claim": "Mapping unresolved", "source": "mapping",
             "value": "0 resolved", "provenance": "UNAVAILABLE"}
        ],
        "recommendations": [],
        "assumptions": [],
        "limitations": ["No verified room telemetry."],
        "provenance": {"data_freshness": "static", "sources": ["IFC"], "is_hypothetical": False},
    }
    base.update(overrides)
    return json.dumps(base)


class FakeResponse:
    def __init__(self, status_code: int, body):
        self.status_code = status_code
        self._body = body
        self.text = body if isinstance(body, str) else json.dumps(body)

    def json(self):
        if isinstance(self._body, str):
            return json.loads(self._body)
        return self._body


def _ok_body(content: str) -> dict:
    return {"choices": [{"message": {"content": content}}]}


class FakeTransport:
    """Records the last request and returns a queued response."""

    def __init__(self, response: FakeResponse):
        self.response = response
        self.last = None

    def __call__(self, url, headers, payload, timeout):
        self.last = {"url": url, "headers": headers, "payload": payload, "timeout": timeout}
        return self.response


class FakeClient:
    """Minimal OpenRouterClient stand-in for service-level tests."""

    def __init__(self, content: str = None, error=None, config=None):
        self._content = content if content is not None else _structured_text()
        self._error = error
        self.config = config or load_config(env={"OPENROUTER_API_KEY": SECRET})
        self.calls = []

    def chat(self, messages, *, temperature=0.2, max_tokens=1200, json_mode=False):
        self.calls.append({"messages": messages, "json_mode": json_mode})
        if self._error is not None:
            raise self._error
        return self._content


def make_service(client, dp=None, replay=None):
    cfg = client.config if hasattr(client, "config") else load_config(
        env={"OPENROUTER_API_KEY": SECRET}
    )
    return AiService(
        dp if dp is not None else make_datapack(),
        client=client,
        config=cfg,
        replay_provider=(lambda: replay) if replay is not None else None,
    )


# ── 1. missing API key ────────────────────────────────────────────────────────
def test_missing_api_key_reports_not_configured():
    cfg = load_config(env={})
    client = OpenRouterClient(cfg, transport=FakeTransport(FakeResponse(200, _ok_body("{}"))))
    svc = AiService(make_datapack(), client=client, config=cfg)
    assert svc.status()["configured"] is False

    resp = svc.assistant("Summarize the building.")
    assert resp.status == NOT_CONFIGURED
    assert resp.answer is None
    assert "not configured" in (resp.message or "").lower()


def test_client_chat_without_key_raises_not_configured():
    cfg = load_config(env={})
    client = OpenRouterClient(cfg, transport=FakeTransport(FakeResponse(200, _ok_body("{}"))))
    from ai_openrouter import AiError

    with pytest.raises(AiError) as exc:
        client.chat([{"role": "user", "content": "hi"}], json_mode=True)
    assert exc.value.code == NOT_CONFIGURED


# ── 2. valid mocked OpenRouter response ───────────────────────────────────────
def test_valid_openrouter_response_is_parsed_and_validated():
    transport = FakeTransport(FakeResponse(200, _ok_body(_structured_text())))
    cfg = load_config(env={"OPENROUTER_API_KEY": SECRET})
    client = OpenRouterClient(cfg, transport=transport)
    svc = AiService(make_datapack(), client=client, config=cfg)

    resp = svc.assistant("Summarize the building status.")
    assert resp.status == "OK"
    assert resp.answer == "Grounded answer."
    assert resp.model == "nvidia/nemotron-3.5-lightning:free"
    assert len(resp.evidence) == 1
    # The request goes to the configured OpenRouter chat-completions URL.
    assert transport.last["url"].endswith("/chat/completions")
    assert transport.last["url"].startswith("https://openrouter.ai/api/v1")
    # JSON mode is requested.
    assert transport.last["payload"]["response_format"] == {"type": "json_object"}


def test_openrouter_client_sends_bearer_auth_from_config():
    transport = FakeTransport(FakeResponse(200, _ok_body(_structured_text())))
    cfg = load_config(env={"OPENROUTER_API_KEY": SECRET})
    OpenRouterClient(cfg, transport=transport).chat([{"role": "user", "content": "x"}])
    assert transport.last["headers"]["Authorization"] == f"Bearer {SECRET}"


# ── 3. rate-limit and provider failures ───────────────────────────────────────
def test_rate_limit_is_mapped():
    transport = FakeTransport(FakeResponse(429, {"error": "rate limited"}))
    cfg = load_config(env={"OPENROUTER_API_KEY": SECRET})
    svc = AiService(make_datapack(), client=OpenRouterClient(cfg, transport=transport), config=cfg)
    resp = svc.assistant("hello")
    assert resp.status == RATE_LIMITED
    assert resp.answer is None


def test_provider_server_error_is_mapped():
    transport = FakeTransport(FakeResponse(500, {"error": "boom"}))
    cfg = load_config(env={"OPENROUTER_API_KEY": SECRET})
    svc = AiService(make_datapack(), client=OpenRouterClient(cfg, transport=transport), config=cfg)
    resp = svc.assistant("hello")
    assert resp.status == PROVIDER_ERROR


def test_timeout_is_mapped():
    def boom(url, headers, payload, timeout):
        raise TimeoutError("timed out")

    cfg = load_config(env={"OPENROUTER_API_KEY": SECRET})
    svc = AiService(make_datapack(), client=OpenRouterClient(cfg, transport=boom), config=cfg)
    resp = svc.assistant("hello")
    assert resp.status == TIMEOUT


def test_total_deadline_bounds_a_slow_transport():
    """A transport that never returns must still be abandoned at the deadline."""
    import time

    def slow(url, headers, payload, timeout):
        time.sleep(1.0)
        return FakeResponse(200, _ok_body(_structured_text()))

    cfg = load_config(
        env={
            "OPENROUTER_API_KEY": SECRET,
            "OPENROUTER_TIMEOUT": "0.2",
            "OPENROUTER_DEADLINE": "0.2",
        }
    )
    assert cfg.deadline_seconds == 0.2
    svc = AiService(make_datapack(), client=OpenRouterClient(cfg, transport=slow), config=cfg)

    started = time.monotonic()
    resp = svc.assistant("hello")
    elapsed = time.monotonic() - started

    assert resp.status == TIMEOUT
    assert resp.answer is None
    # The operator waits for the deadline, not for the stalled transport.
    assert elapsed < 0.9


def test_deadline_config_is_clamped_to_the_per_phase_timeout():
    low = load_config(
        env={"OPENROUTER_API_KEY": SECRET, "OPENROUTER_TIMEOUT": "30",
             "OPENROUTER_DEADLINE": "5"}
    )
    assert low.timeout_seconds == 30.0
    # A total deadline below the per-phase timeout is meaningless: clamp it up.
    assert low.deadline_seconds == 30.0

    high = load_config(
        env={"OPENROUTER_API_KEY": SECRET, "OPENROUTER_TIMEOUT": "10",
             "OPENROUTER_DEADLINE": "45"}
    )
    assert high.deadline_seconds == 45.0


def test_quota_exhausted_is_mapped():
    transport = FakeTransport(FakeResponse(402, {"error": "payment required"}))
    cfg = load_config(env={"OPENROUTER_API_KEY": SECRET})
    svc = AiService(make_datapack(), client=OpenRouterClient(cfg, transport=transport), config=cfg)
    resp = svc.assistant("hello")
    assert resp.status == "QUOTA_EXHAUSTED"


# ── 4. malformed model output ─────────────────────────────────────────────────
def test_malformed_model_output_is_rejected():
    svc = make_service(FakeClient(content="not json at all, sorry!"))
    resp = svc.assistant("hello")
    assert resp.status == MALFORMED
    assert resp.answer is None


def test_partial_json_is_recovered_when_valid():
    wrapped = "Sure! Here you go:\n" + _structured_text(answer="Recovered.")
    svc = make_service(FakeClient(content=wrapped))
    resp = svc.assistant("hello")
    assert resp.status == "OK"
    assert resp.answer == "Recovered."


def test_unknown_provenance_and_impact_labels_are_downgraded():
    text = _structured_text(
        recommendations=[
            {"title": "T", "action": "A", "impact_status": "MADE_UP",
             "expected_impact_direction": "improve"}
        ]
    )
    structured = ai_schemas.parse_structured(text)
    assert structured.recommendations[0].impact_status == "UNKNOWN"


def test_recommendation_confidence_is_normalized():
    text = _structured_text(
        recommendations=[
            {"title": "A", "action": "Do it", "impact_status": "UNKNOWN",
             "confidence": "high"},
            {"title": "B", "action": "Do it too", "impact_status": "UNKNOWN",
             "confidence": "nonsense"},
            {"title": "C", "action": "And this", "impact_status": "UNKNOWN"},
        ]
    )
    structured = ai_schemas.parse_structured(text)
    assert structured.recommendations[0].confidence == "HIGH"
    # An unrecognised value is never presented as a real confidence.
    assert structured.recommendations[1].confidence == "UNKNOWN"
    # A missing value defaults to UNKNOWN too.
    assert structured.recommendations[2].confidence == "UNKNOWN"


def test_context_does_not_duplicate_integrity_instructions():
    """Provenance rules live once (in the system prompt), not in every payload.

    The per-object *notes* that carry the actual provenance facts stay.
    """
    client = FakeClient()
    svc = make_service(client)
    svc.assistant("Which environmental readings are available?", space_id=ROOM_ID)
    sent = client.calls[0]["messages"][1]["content"]
    payload = json.loads(sent.split("```json", 1)[1].split("```", 1)[0])

    assert "data_integrity_rules" not in payload
    # The provenance facts themselves are preserved for grounding.
    assert "location_note" in payload["building_telemetry"]


# ── 5. selected-room context ──────────────────────────────────────────────────
def test_selected_room_context_includes_ifc_metadata():
    client = FakeClient()
    svc = make_service(client)
    resp = svc.assistant("What do we know about this room?", space_id=ROOM_ID)
    assert resp.status == "OK"
    assert resp.context.scope == "ROOM"
    assert resp.context.space_id == ROOM_ID
    assert resp.context.storey_id == STOREY_ID

    sent = client.calls[0]["messages"][1]["content"]
    assert ROOM_ID in sent
    assert "design_capacity_occupants" in sent
    assert "101" in sent  # ifc name


def test_assistant_without_room_is_building_scope():
    client = FakeClient()
    svc = make_service(client)
    resp = svc.assistant("Summarize the building.")
    assert resp.context.scope == "BUILDING"
    assert resp.context.space_id is None


# ── 6. unmapped room telemetry ────────────────────────────────────────────────
def test_unmapped_room_telemetry_is_not_attributed():
    client = FakeClient()
    svc = make_service(client)
    svc.assistant("Which environmental readings are available?", space_id=ROOM_ID)
    sent = client.calls[0]["messages"][1]["content"]
    payload = json.loads(sent.split("```json", 1)[1].split("```", 1)[0])

    assert payload["sensor_location_mapping"]["status"] == "UNRESOLVED"
    assert payload["room_environmental"]["room_level_readings_available"] is False
    # Sensor readings are never bound to the room.
    assert "room_environmental" in payload
    assert payload["building_telemetry"]["location_note"].lower().find("never attributed") != -1


# ── 7. historical replay vs live observations ─────────────────────────────────
def test_replay_context_is_labelled_historical():
    replay = {
        "sim_timestamp": "2025-06-01T00:00:00",
        "running": False,
        "readings_replayed": 10,
        "channels": [{"sensor_id": "s", "measurement_type": "co2"}],
        "anomalies_detected": 1,
    }
    client = FakeClient()
    svc = make_service(client, replay=replay)
    resp = svc.assistant("Is this live?")
    assert resp.context.historical_replay is True
    sent = client.calls[0]["messages"][1]["content"]
    payload = json.loads(sent.split("```json", 1)[1].split("```", 1)[0])
    assert payload["replay"]["is_historical"] is True
    assert "NOT live" in payload["replay"]["note"]


def test_live_webcam_observation_is_labelled_estimate():
    obs = {
        "count": 4,
        "source": "LIVE_CAMERA",
        "timestamp": "2026-01-01T00:00:00Z",
        "space_id": ROOM_ID,
        "mapping_kind": "DEMO_MAPPING",
    }
    client = FakeClient()
    svc = make_service(client)
    svc.assistant("How busy is this room?", space_id=ROOM_ID, observation=obs)
    sent = client.calls[0]["messages"][1]["content"]
    payload = json.loads(sent.split("```json", 1)[1].split("```", 1)[0])
    occ = payload["webcam_occupancy"]
    assert occ["is_demo_association"] is True
    assert "estimate" in occ["note"].lower()
    assert "not verified" in occ["note"].lower()


# ── 8. unsupported energy/carbon savings claims ───────────────────────────────
def test_numeric_savings_claims_are_flagged_as_unknown():
    text = _structured_text(
        recommendations=[
            {
                "title": "Reduce HVAC",
                "opportunity": "Ventilation overrun",
                "evidence": "CO2 deviation",
                "action": "Lower setpoint",
                "expected_impact_direction": "achieve 20% energy savings and 5 tonnes CO2 reduction",
                "impact_status": "CALCULATED",
            }
        ]
    )
    svc = make_service(FakeClient(content=text))
    resp = svc.assistant("How can we save energy?")
    assert resp.status == "OK"
    rec = resp.recommendations[0]
    assert rec.impact_status == "UNKNOWN"
    assert any("not verified" in lim.lower() for lim in resp.limitations)


def test_clean_recommendation_keeps_unknown_impact_without_fabrication():
    text = _structured_text(
        recommendations=[
            {"title": "Check ventilation", "action": "Inspect dampers",
             "impact_status": "QUALITATIVE", "expected_impact_direction": "improve comfort"}
        ]
    )
    svc = make_service(FakeClient(content=text))
    resp = svc.sustainability_recommendations()
    assert resp.status == "OK"
    assert resp.recommendations[0].impact_status == "QUALITATIVE"


# ── 9. explanations of existing room status ───────────────────────────────────
def test_explain_status_uses_deterministic_status_and_never_overrides():
    obs = {
        "count": 25,  # design capacity is 10 -> OVER_CAPACITY
        "source": "LIVE_CAMERA",
        "timestamp": "2026-01-01T00:00:00Z",
        "space_id": ROOM_ID,
        "mapping_kind": "DEMO_MAPPING",
    }
    client = FakeClient()
    svc = make_service(client)
    # freeze the clock to just after the observation so it is not stale
    import datetime as _dt

    now_ms = _dt.datetime(2026, 1, 1, 0, 0, 5, tzinfo=_dt.timezone.utc).timestamp() * 1000
    resp = svc.explain_status(ROOM_ID, observation=obs, now_ms=now_ms)
    assert resp.status == "OK"
    assert resp.deterministic_status is not None
    assert resp.deterministic_status.level == "OVER_CAPACITY"
    assert resp.deterministic_status.occupancy_is_demo is True
    assert resp.deterministic_status.capacity == 10.0

    sent = client.calls[0]["messages"][1]["content"]
    assert "OVER_CAPACITY" in sent
    assert "only explain" in (sent + " ").lower() or "do not decide" in sent.lower()


def test_explain_status_unknown_room_is_invalid_input():
    svc = make_service(FakeClient())
    resp = svc.explain_status("space_does_not_exist")
    assert resp.status == "INVALID_INPUT"


def test_deterministic_status_is_returned_even_when_ai_is_unavailable():
    """The room status is computed by the backend, so an unavailable or
    unconfigured model must not hide it."""
    import datetime as _dt

    obs = {
        "count": 25,
        "source": "LIVE_CAMERA",
        "timestamp": "2026-01-01T00:00:00Z",
        "space_id": ROOM_ID,
        "mapping_kind": "DEMO_MAPPING",
    }
    now_ms = _dt.datetime(2026, 1, 1, 0, 0, 5, tzinfo=_dt.timezone.utc).timestamp() * 1000

    # Not configured at all.
    cfg = load_config(env={})
    unconfigured = AiService(
        make_datapack(),
        client=OpenRouterClient(cfg, transport=FakeTransport(FakeResponse(200, _ok_body("{}")))),
        config=cfg,
    )
    resp = unconfigured.explain_status(ROOM_ID, observation=obs, now_ms=now_ms)
    assert resp.status == NOT_CONFIGURED
    assert resp.deterministic_status is not None
    assert resp.deterministic_status.level == "OVER_CAPACITY"

    # Configured but the provider fails (rate limited).
    from ai_openrouter import AiError

    failing = make_service(FakeClient(error=AiError(RATE_LIMITED, "slow down")))
    resp2 = failing.explain_status(ROOM_ID, observation=obs, now_ms=now_ms)
    assert resp2.status == RATE_LIMITED
    assert resp2.deterministic_status is not None
    assert resp2.deterministic_status.level == "OVER_CAPACITY"


def test_deterministic_status_precedence_critical_beats_over_capacity():
    recs = [
        {"recommendation_id": "R", "priority": "CRITICAL", "recommended_action": "x",
         "location_status": "VERIFIED_BIM",
         "location": {"status": "VERIFIED_BIM", "space_id": ROOM_ID}}
    ]
    status = room_status.resolve_room_status(
        ROOM_ID,
        capacity=10.0,
        recommendations=recs,
        observation={"count": 25, "space_id": ROOM_ID, "mapping_kind": "DEMO_MAPPING",
                     "timestamp": "2026-01-01T00:00:00Z", "source": "LIVE_CAMERA"},
        now_ms=0.0,
    )
    assert status["level"] == "CRITICAL"
    assert status["occupancy"]["level"] == "OVER_CAPACITY"
    assert status["issue"]["level"] == "CRITICAL"


def test_unverified_recommendation_does_not_colour_a_room():
    recs = [
        {"recommendation_id": "R", "priority": "CRITICAL", "recommended_action": "x",
         "location_status": "UNKNOWN_LOCATION",
         "location": {"status": "UNKNOWN_LOCATION", "space_id": ROOM_ID}}
    ]
    status = room_status.resolve_room_status(ROOM_ID, capacity=10.0, recommendations=recs, now_ms=0.0)
    assert status["level"] == "UNKNOWN"


# ── 10. no secrets exposed ────────────────────────────────────────────────────
def test_response_never_contains_api_key():
    svc = make_service(FakeClient())
    for resp in (
        svc.assistant("hi"),
        svc.sustainability_recommendations(),
        svc.explain_status(ROOM_ID),
        svc.assistant("hi", space_id=ROOM_ID),
    ):
        blob = resp.model_dump_json()
        assert SECRET not in blob
        assert "api_key" not in blob.lower()


def test_status_endpoint_shape_has_no_secret():
    cfg = load_config(env={"OPENROUTER_API_KEY": SECRET})
    svc = AiService(make_datapack(), client=FakeClient(config=cfg), config=cfg)
    status = svc.status()
    assert set(status) == {"configured", "provider", "model", "base_host"}
    assert SECRET not in json.dumps(status)


# ── API endpoints (FastAPI TestClient) ────────────────────────────────────────
def _client_for(svc: AiService):
    from fastapi.testclient import TestClient

    app = api_app.create_app(datapack=make_datapack(), ai_service=svc)
    return TestClient(app)


def test_api_assistant_endpoint_returns_structured_response():
    svc = make_service(FakeClient())
    client = _client_for(svc)
    r = client.post("/api/ai/assistant", json={"question": "Summarize the building."})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "OK"
    assert body["answer"] == "Grounded answer."
    assert SECRET not in r.text


def test_api_ai_status_endpoint():
    cfg = load_config(env={"OPENROUTER_API_KEY": SECRET})
    svc = AiService(make_datapack(), client=FakeClient(config=cfg), config=cfg)
    client = _client_for(svc)
    body = client.get("/api/ai/status").json()
    assert body["configured"] is True
    assert body["model"] == "nvidia/nemotron-3.5-lightning:free"


def test_api_assistant_rejects_empty_question():
    svc = make_service(FakeClient())
    client = _client_for(svc)
    r = client.post("/api/ai/assistant", json={"question": ""})
    assert r.status_code == 422


def test_api_explain_status_endpoint():
    svc = make_service(FakeClient())
    client = _client_for(svc)
    r = client.post("/api/ai/explain-status", json={"space_id": ROOM_ID})
    assert r.status_code == 200
    assert r.json()["deterministic_status"]["space_id"] == ROOM_ID


def test_api_recommendations_endpoint():
    svc = make_service(FakeClient())
    client = _client_for(svc)
    r = client.post("/api/ai/recommendations", json={"space_id": ROOM_ID})
    assert r.status_code == 200
    assert r.json()["status"] == "OK"


# ── config / env loader ───────────────────────────────────────────────────────
def test_env_loader_does_not_override_real_env(tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text("OPENROUTER_MODEL=from-file\nOPENROUTER_API_KEY=file-key\n")
    # Isolate from any real developer `.env`: this unit test asserts that a
    # *missing* value is filled from the file and an existing one is not
    # overridden, so the ambient environment must not pre-set OPENROUTER_MODEL.
    os.environ.pop("OPENROUTER_MODEL", None)
    os.environ["OPENROUTER_API_KEY"] = "real-key"
    try:
        from ai_config import load_env_files

        load_env_files([str(env_file)])
        # Real env wins; missing values are filled from file.
        assert os.environ["OPENROUTER_API_KEY"] == "real-key"
        assert os.environ["OPENROUTER_MODEL"] == "from-file"
    finally:
        os.environ.pop("OPENROUTER_API_KEY", None)
        os.environ.pop("OPENROUTER_MODEL", None)


def test_default_model_is_the_free_nemotron_endpoint():
    cfg = load_config(env={})
    assert cfg.model == "nvidia/nemotron-3.5-lightning:free"
    assert cfg.base_url == "https://openrouter.ai/api/v1"
