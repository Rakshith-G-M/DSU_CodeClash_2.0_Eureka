"""Green Twin — diagnostic-finding AI workflow tests.

Covers the integrated *issue detail* workflow: the automatic analysis of a
selected finding, issue-scoped follow-ups, provider success/empty/failure
handling, honest provenance (unmapped sensors, replay), and the guards that stop
the model asserting unverified savings or confirmed root causes.

No test here touches the network or needs a real API key: the OpenRouter client
is exercised through an injected fake transport and the service through a fake
client returning canned text.
"""

import json
import os
import sys

import pytest

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(BASE_DIR, "scripts"))

import api_app  # noqa: E402
import building_context as bc  # noqa: E402
from ai_config import load_config  # noqa: E402
from ai_openrouter import (  # noqa: E402
    MALFORMED,
    NOT_CONFIGURED,
    PROVIDER_ERROR,
    QUOTA_EXHAUSTED,
    RATE_LIMITED,
    TIMEOUT,
    AiError,
    OpenRouterClient,
)
from ai_service import MAX_HISTORY_TURNS, AiService  # noqa: E402

SECRET = "sk-or-v1-FINDING-SECRET-DO-NOT-LEAK-98765"

SENSOR_ID = "dfd7a151-1cae-4cd6-b3af-91ff110a21b2"
OTHER_SENSOR = "aaaa1111-2222-3333-4444-555566667777"
ROOM_ID = "space_room_101"
STOREY_ID = "storey_1"

DEGRADED = "F-DEGRADED"
ROOM_FINDING = "F-ROOM"


# ── synthetic application data (mirrors the real sensor-degradation shape) ────
def make_datapack() -> dict:
    degraded_issues = [
        {"type": "CONSTANT_VALUE", "affected_channels": 2, "max_severity": "HIGH",
         "severity_distribution": {"HIGH": 2},
         "example": {"channel": "humidity.csv", "detail": "only 49 distinct values in 15465"}},
        {"type": "IRREGULAR_SAMPLING", "affected_channels": 2, "max_severity": "LOW",
         "severity_distribution": {"LOW": 2},
         "example": {"channel": "humidity.csv", "detail": "interval CV 2.59 >= 0.25"}},
        {"type": "LONG_GAP", "affected_channels": 2, "max_severity": "MEDIUM",
         "severity_distribution": {"MEDIUM": 2},
         "example": {"channel": "humidity.csv", "detail": "largest gap 66.0 h"}},
    ]
    return {
        "campus_registry": {
            "campus": {"name": "TalTech", "space_count": 2, "storey_count": 1},
            "buildings": [{"id": "b1", "name": "Ehituse Mäemaja", "space_count": 2,
                           "storey_ids": [STOREY_ID]}],
            "storeys": [{"id": STOREY_ID, "name": "1. korrus", "space_count": 2,
                         "elevation": 0.0}],
        },
        "resource_state": {
            "summary": {"total_area_m2": 100.0, "total_capacity_occupants": 30.0,
                        "metric_origin_note": "design metrics only"},
            "availability": {"present": False},
            "spaces": [
                {"space_id": ROOM_ID, "ifc_name": "101", "storey_id": STOREY_ID,
                 "storey_name": "1. korrus", "building_id": "b1",
                 "geometry": {"area_m2": 50.0, "volume_m3": 150.0, "height_m": 3.0},
                 "capacity_occupants": 10.0,
                 "occupancy": {"occupiable": True, "capacity_occupants": 10.0},
                 "conditioning": {"condition_type": "Heated and cooled"}},
            ],
        },
        "spaces_bim": {
            "spaces": [
                {"space_id": ROOM_ID, "ifc_name": "101", "storey_id": STOREY_ID,
                 "area_m2": 50.0, "volume_m3": 150.0, "height_m": 3.0, "capacity": 10.0,
                 "occupiable": True,
                 "bim_properties": {
                     "Energy Analysis.Number of People": 10.0,
                     "Energy Analysis.Specified Lighting Load": 120.0,
                 }},
            ]
        },
        "sensors": {
            "count": 2,
            "sensors": [
                {"sensor_id": SENSOR_ID, "type": "humidity,temperature", "unit": "%,C",
                 "status": "unmapped", "channel_count": 2},
                {"sensor_id": OTHER_SENSOR, "type": "co2", "unit": "ppm",
                 "status": "unmapped", "channel_count": 1},
            ],
        },
        "sensor_health": {
            "summary": {"devices": 36, "healthy": 33, "degraded": 3,
                        "overall": "DEGRADED"},
            "devices": [
                {"sensor_id": SENSOR_ID, "channels": ["humidity", "temperature"],
                 "channel_count": 2, "health_status": "DEGRADED",
                 "valid_readings": 124933, "missing_readings": 0,
                 "time_gaps": 13303, "suspect_readings": 199,
                 "anomaly_candidates": 406, "missing_ratio": 0.0,
                 "coverage_fraction": 0.999999,
                 "first_report": "2024-03-18T02:05:00",
                 "last_report": "2025-06-30T23:45:22",
                 "issues": degraded_issues},
            ],
        },
        "telemetry_profile": {
            "summary": {"channels": 3, "sensors": 2},
            "channels": [
                {"sensor_id": SENSOR_ID, "measurement_type": "humidity", "unit": "%",
                 "record_count": 15465, "duration_hours": 3443.5,
                 "min": 8.0, "max": 58.0, "mean": 29.4, "median": 28.0, "std": 9.8,
                 "quality": {"VALID": 15465, "MISSING": 0, "DUPLICATE": 0,
                             "OUT_OF_RANGE": 0, "TIME_GAP": 43},
                 "interval_stats": {"count": 15464, "min": 1.0, "max": 237597.0,
                                    "median": 900.0, "mean": 801.6, "std": 2078.2},
                 "expected_interval_seconds": 900.0,
                 "gaps": {"count": 43, "largest_seconds": 237597.0},
                 "health": {"distinct_values": 49, "longest_identical_run": 151,
                            "issues": [
                                {"type": "IRREGULAR_SAMPLING", "severity": "LOW",
                                 "detail": "interval CV 2.59 >= 0.25"},
                                {"type": "LONG_GAP", "severity": "MEDIUM",
                                 "detail": "largest gap 66.0 h"},
                                {"type": "CONSTANT_VALUE", "severity": "HIGH",
                                 "detail": "only 49 distinct values in 15465"},
                            ]},
                 "anomaly_summary": {"candidates_surviving": 8}},
            ],
        },
        "sensor_space_mapping": {
            "summary": {"total": 36, "resolved": 0, "unresolved": 36,
                        "verified_locations": 0}
        },
        "telemetry_intelligence_summary": {
            "dataset": {"devices": 36, "channels": 69, "total_readings": 1390297,
                        "channels_by_type": {"temperature": 29, "co2": 7},
                        "time_span": {"first": "2024-01-01T00:00:00",
                                      "last": "2025-06-30T00:00:00"}},
            "intelligence": {"anomalies": {"by_severity": {"CRITICAL": 3, "HIGH": 2},
                                           "by_measurement_type": {"co2": 4}}},
        },
        "decision_candidates": {"records": []},
        "recommendations": {
            "records": [
                {
                    "recommendation_id": DEGRADED,
                    "candidate_id": "DC-1",
                    "priority": "HIGH",
                    "priority_score": 0.73,
                    "recommendation_category": "SENSOR_HEALTH",
                    "problem_type": "MAINTENANCE",
                    "recommended_action": "Service the sensor to restore a "
                                          "consistent measurement stream.",
                    "reason": "The sensor's data stream is degraded.",
                    "location_status": "UNKNOWN_LOCATION",
                    "location": {"status": "UNKNOWN_LOCATION", "space_id": None,
                                 "location_verified": False},
                    "affected_entity": {"type": "sensor", "sensor_id": SENSOR_ID},
                    "evidence": {"health_status": "DEGRADED",
                                 "issue_types": ["CONSTANT_VALUE",
                                                 "IRREGULAR_SAMPLING", "LONG_GAP"],
                                 "anomaly_candidates": 406,
                                 "location": {"location_status": "UNKNOWN_LOCATION",
                                              "space_id": None}},
                    "evidence_chain": [
                        {"step": "SENSOR_HEALTH", "entity": SENSOR_ID,
                         "value": "DEGRADED", "note": "M5 device health status"},
                        {"step": "HEALTH_ISSUE", "entity": SENSOR_ID,
                         "value": ["CONSTANT_VALUE", "IRREGULAR_SAMPLING", "LONG_GAP"],
                         "note": "issue types detected"},
                    ],
                    "constraints": ["Location cannot be targeted without a verified "
                                    "sensor->space mapping."],
                    "expected_impact": [{"type": "data_quality_improvement",
                                         "status": "QUALITATIVE", "value": None,
                                         "unit": None,
                                         "reason": "Restoring measurements improves "
                                                   "observability."}],
                    "confidence": {"value": 0.5,
                                   "basis": "RULE_BASED_HEURISTIC (not a probability)"},
                },
                {
                    "recommendation_id": ROOM_FINDING,
                    "candidate_id": "DC-2",
                    "priority": "MEDIUM",
                    "priority_score": 0.5,
                    "recommendation_category": "ENVIRONMENTAL",
                    "problem_type": "ANOMALY",
                    "recommended_action": "Investigate ventilation for this room.",
                    "reason": "CO2 deviation above baseline.",
                    "location_status": "VERIFIED_BIM",
                    "location": {"status": "VERIFIED_BIM", "space_id": ROOM_ID,
                                 "location_verified": True},
                    "affected_entity": {"type": "space", "space_id": ROOM_ID},
                    "evidence": {"issue_types": ["OUT_OF_BOUNDS"]},
                    "evidence_chain": [],
                    "constraints": [],
                    "expected_impact": [],
                    "confidence": {"value": None, "basis": "unknown"},
                },
                {
                    "recommendation_id": "F-OTHER-SENSOR",
                    "candidate_id": "DC-3",
                    "priority": "LOW",
                    "recommendation_category": "SENSOR_HEALTH",
                    "problem_type": "MAINTENANCE",
                    "recommended_action": "Service the CO2 sensor.",
                    "reason": "Drift detected.",
                    "location_status": "UNKNOWN_LOCATION",
                    "location": {"status": "UNKNOWN_LOCATION", "space_id": None},
                    "affected_entity": {"type": "sensor", "sensor_id": OTHER_SENSOR},
                    "evidence": {"issue_types": ["DRIFT"]},
                    "evidence_chain": [],
                    "constraints": [],
                    "expected_impact": [],
                    "confidence": {"value": None, "basis": "unknown"},
                },
            ]
        },
    }


def _structured_text(**overrides) -> str:
    base = {
        "answer": "The sensor stream shows three data-quality issues.",
        "evidence": [
            {"claim": "Only 49 distinct values in 15465 readings",
             "source": "sensor_health", "value": "49 distinct",
             "provenance": "HISTORICAL_REPLAY", "reference": "channel health"}
        ],
        "likely_causes": [
            {"cause": "Power or connectivity interruption", "basis": "long gaps",
             "status": "HYPOTHESIS", "confidence": "medium"},
            {"cause": "Calibration drift", "basis": "constant values",
             "status": "HYPOTHESIS", "confidence": "low"},
        ],
        "recommendations": [
            {"title": "Check sensor power and connectivity",
             "opportunity": "The measurement stream has gaps.",
             "evidence": "Largest gap 66.0 h.",
             "action": "Inspect the sensor's power supply and network link.",
             "component": "humidity sensor", "why_relevant": "Gaps suggest dropout.",
             "verification": "Confirm readings resume at the expected interval.",
             "expected_impact_direction": "unknown", "priority": "HIGH",
             "assumptions": "", "limitations": "", "impact_status": "UNKNOWN"},
        ],
        "next_checks": ["Verify the sensor's power supply", "Check the data-ingestion log"],
        "assumptions": [],
        "limitations": ["No verified sensor location."],
        "provenance": {"data_freshness": "historical", "sources": ["sensor_health"],
                       "is_hypothetical": False},
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
    def __init__(self, response):
        self.response = response
        self.last = None

    def __call__(self, url, headers, payload, timeout):
        self.last = {"url": url, "headers": headers, "payload": payload, "timeout": timeout}
        return self.response


class FakeClient:
    """Records every chat call and returns canned content (or raises)."""

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


def make_service(client, dp=None, replay=None):
    cfg = client.config
    return AiService(
        dp if dp is not None else make_datapack(),
        client=client,
        config=cfg,
        replay_provider=(lambda: replay) if replay is not None else None,
    )


def _last_user_prompt(client) -> str:
    return client.calls[-1][-1]["content"]


# ── 1. automatic analysis of the selected finding ─────────────────────────────
def test_automatic_analysis_is_grounded_in_the_finding_symptoms():
    client = FakeClient()
    svc = make_service(client)
    resp = svc.finding_analysis(DEGRADED)

    assert resp.status == "OK"
    assert resp.finding_id == DEGRADED
    assert resp.context is not None and resp.context.scope == "FINDING"
    assert resp.context.finding_id == DEGRADED
    assert resp.answer
    assert resp.likely_causes and all(c.status == "HYPOTHESIS" for c in resp.likely_causes)
    assert resp.next_checks

    prompt = _last_user_prompt(client)
    # The real detected symptoms must be part of the model's context.
    assert "Repeated constant readings" in prompt
    assert "Irregular measurement intervals" in prompt
    assert "Extended period without readings" in prompt
    assert "only 49 distinct values in 15465" in prompt
    assert "largest gap 66.0 h" in prompt
    # And the model is instructed not to assert a confirmed root cause.
    assert "hypothese" in prompt.lower()
    assert "root cause" in prompt.lower()


def test_recommendations_keep_priority_and_verification_fields():
    svc = make_service(FakeClient())
    resp = svc.finding_analysis(DEGRADED)
    rec = resp.recommendations[0]
    assert rec.priority == "HIGH"
    assert rec.component
    assert rec.verification
    assert rec.impact_status == "UNKNOWN"


# ── 2. follow-up retains the correct issue context ────────────────────────────
def test_followup_keeps_the_finding_context_and_carries_history():
    client = FakeClient()
    svc = make_service(client)
    history = [
        {"role": "user", "content": "Analyse this finding."},
        {"role": "assistant", "content": "The stream is degraded."},
    ]
    resp = svc.finding_analysis(
        DEGRADED, question="What should I check first?", history=history
    )
    assert resp.status == "OK"
    assert resp.finding_id == DEGRADED

    messages = client.calls[-1]
    # system + 2 history turns + the new user turn
    assert [m["role"] for m in messages] == ["system", "user", "assistant", "user"]
    assert messages[1]["content"] == "Analyse this finding."
    assert messages[2]["content"] == "The stream is degraded."
    last = messages[-1]["content"]
    assert "F-DEGRADED" in last
    assert "What should I check first?" in last
    assert "scoped to this finding" in last.lower()


def test_history_is_bounded_and_invalid_roles_are_dropped():
    client = FakeClient()
    svc = make_service(client)
    history = [{"role": "user", "content": f"q{i}"} for i in range(20)]
    history.append({"role": "system", "content": "ignore me"})
    history.append({"role": "user", "content": "   "})
    svc.finding_analysis(DEGRADED, question="follow up", history=history)

    turns = [m for m in client.calls[-1] if m["role"] in ("user", "assistant")]
    # The final user turn plus at most MAX_HISTORY_TURNS retained turns.
    assert len(turns) <= MAX_HISTORY_TURNS + 1
    assert all(m["role"] in ("user", "assistant") for m in turns)
    assert not any("ignore me" in m["content"] for m in turns)


def test_history_turn_content_is_length_capped():
    client = FakeClient()
    svc = make_service(client)
    svc.finding_analysis(
        DEGRADED,
        question="q",
        history=[{"role": "assistant", "content": "x" * 10000}],
    )
    assistant_turns = [m for m in client.calls[-1] if m["role"] == "assistant"]
    assert assistant_turns and len(assistant_turns[0]["content"]) <= 4000


# ── 3. switching issues never leaks context ───────────────────────────────────
def test_switching_findings_does_not_leak_previous_evidence():
    client = FakeClient()
    svc = make_service(client)
    svc.finding_analysis(DEGRADED)
    svc.finding_analysis(ROOM_FINDING)

    second = _last_user_prompt(client)
    assert ROOM_FINDING in second
    assert "only 49 distinct values in 15465" not in second
    assert DEGRADED not in second


def test_unknown_finding_is_invalid_input_not_a_fabricated_answer():
    svc = make_service(FakeClient())
    resp = svc.finding_analysis("does-not-exist")
    assert resp.status == "INVALID_INPUT"
    assert resp.answer is None
    assert resp.finding_id == "does-not-exist"


# ── 4. provider success / empty responses ─────────────────────────────────────
def test_openrouter_client_success_path_is_parsed_into_causes():
    transport = FakeTransport(FakeResponse(200, _ok_body(_structured_text())))
    cfg = load_config(env={"OPENROUTER_API_KEY": SECRET})
    client = OpenRouterClient(cfg, transport=transport)
    svc = AiService(make_datapack(), client=client, config=cfg)

    resp = svc.finding_analysis(DEGRADED)
    assert resp.status == "OK"
    assert len(resp.likely_causes) == 2
    assert resp.provenance.model == "nvidia/nemotron-3.5-lightning:free"
    assert transport.last["headers"]["Authorization"] == f"Bearer {SECRET}"


def test_empty_provider_message_is_rejected_not_fabricated():
    # Client level: an empty assistant message is MALFORMED.
    transport = FakeTransport(FakeResponse(200, _ok_body("   ")))
    cfg = load_config(env={"OPENROUTER_API_KEY": SECRET})
    client = OpenRouterClient(cfg, transport=transport)
    svc = AiService(make_datapack(), client=client, config=cfg)
    resp = svc.finding_analysis(DEGRADED)
    assert resp.status == "MALFORMED"
    assert resp.answer is None

    # Service level: an empty canned content is MALFORMED too.
    svc2 = make_service(FakeClient(content=""))
    assert svc2.finding_analysis(DEGRADED).status == "MALFORMED"


def test_non_json_provider_message_is_malformed():
    svc = make_service(FakeClient(content="I'm sorry, I cannot help with that."))
    resp = svc.finding_analysis(DEGRADED)
    assert resp.status == "MALFORMED"
    assert resp.answer is None


# ── 5. provider failures: auth, timeout, rate limit, quota ────────────────────
@pytest.mark.parametrize(
    "status_code,expected",
    [
        (429, RATE_LIMITED),
        (402, QUOTA_EXHAUSTED),
        (401, PROVIDER_ERROR),
        (500, PROVIDER_ERROR),
        (408, TIMEOUT),
    ],
)
def test_provider_failures_are_mapped_without_a_fabricated_answer(status_code, expected):
    transport = FakeTransport(FakeResponse(status_code, {"error": "failed"}))
    cfg = load_config(env={"OPENROUTER_API_KEY": SECRET})
    client = OpenRouterClient(cfg, transport=transport)
    svc = AiService(make_datapack(), client=client, config=cfg)

    resp = svc.finding_analysis(DEGRADED)
    assert resp.status == expected
    assert resp.answer is None
    assert resp.message  # a user-friendly message, never a stack trace
    assert "Traceback" not in (resp.message or "")


def test_network_timeout_is_mapped():
    def raising_transport(url, headers, payload, timeout):
        raise TimeoutError("read timed out")

    cfg = load_config(env={"OPENROUTER_API_KEY": SECRET})
    client = OpenRouterClient(cfg, transport=raising_transport)
    svc = AiService(make_datapack(), client=client, config=cfg)
    assert svc.finding_analysis(DEGRADED).status == TIMEOUT


def test_service_error_from_fake_client_is_mapped():
    svc = make_service(FakeClient(error=AiError(RATE_LIMITED, "rate limited")))
    resp = svc.finding_analysis(DEGRADED)
    assert resp.status == RATE_LIMITED
    assert resp.answer is None


# ── 6. missing API key ────────────────────────────────────────────────────────
def test_missing_api_key_returns_not_configured_but_keeps_grounding():
    cfg = load_config(env={})
    assert cfg.configured is False
    svc = AiService(make_datapack(), client=FakeClient(config=cfg), config=cfg)

    resp = svc.finding_analysis(DEGRADED)
    assert resp.status == NOT_CONFIGURED
    assert resp.answer is None
    assert "OPENROUTER_API_KEY" in (resp.message or "")
    # The honest context still comes back so the UI can explain itself.
    assert resp.context is not None
    assert resp.context.scope == "FINDING"
    assert resp.context.finding_id == DEGRADED


# ── 7. unmapped sensor is never attributed to a room ──────────────────────────
def test_unmapped_sensor_is_never_attributed_to_a_room():
    client = FakeClient()
    svc = make_service(client)
    resp = svc.finding_analysis(DEGRADED)

    assert resp.context.space_id is None
    assert resp.context.room_telemetry_available is False
    prompt = _last_user_prompt(client)
    assert ROOM_ID not in prompt
    assert '"room": null' in prompt.replace(" ", " ").replace("\n", " ")
    assert "UNRESOLVED" in prompt


def test_verified_room_finding_includes_room_and_ifc_context():
    client = FakeClient()
    svc = make_service(client)
    resp = svc.finding_analysis(ROOM_FINDING)
    assert resp.context.space_id == ROOM_ID
    assert resp.context.storey_id == STOREY_ID
    prompt = _last_user_prompt(client)
    assert ROOM_ID in prompt
    assert "IFC_DESIGN" in prompt


def test_finding_context_returns_none_for_unknown_id():
    assert bc.finding_context(make_datapack(), "nope") is None


# ── 8. replay / sample provenance ─────────────────────────────────────────────
def test_replay_is_labelled_historical_in_a_finding_analysis():
    replay = {
        "sim_timestamp": "2025-06-01T03:00:00",
        "running": True,
        "readings_replayed": 10,
        "channels": [{"sensor_id": SENSOR_ID}],
        "anomalies_detected": 0,
    }
    client = FakeClient()
    svc = make_service(client, replay=replay)
    resp = svc.finding_analysis(DEGRADED)

    assert resp.context.historical_replay is True
    prompt = _last_user_prompt(client)
    assert "historical dataset replay" in prompt
    assert "NOT live physical telemetry" in prompt


def test_channel_data_is_labelled_archived_not_live():
    built = bc.finding_context(make_datapack(), DEGRADED)
    channel = built["context"]["channel_profiles"][0]
    assert channel["data_origin"] == "HISTORICAL_REPLAY"
    assert channel["is_live"] is False


# ── 9. guards: unverified savings and unconfirmed causes ──────────────────────
def test_unverified_savings_claim_is_downgraded():
    content = _structured_text(
        recommendations=[
            {"title": "Lower the setpoint", "action": "Reduce heating after hours.",
             "opportunity": "Cuts energy", "evidence": "n/a",
             "expected_impact_direction": "save 25% energy", "priority": "HIGH",
             "impact_status": "ESTIMATED"}
        ]
    )
    svc = make_service(FakeClient(content=content))
    resp = svc.finding_analysis(DEGRADED)
    assert resp.recommendations[0].impact_status == "UNKNOWN"
    assert any("not verified" in l.lower() for l in resp.limitations)


def test_confirmed_cause_is_downgraded_to_a_hypothesis():
    content = _structured_text(
        likely_causes=[
            {"cause": "Firmware bug", "basis": "", "status": "CONFIRMED",
             "confidence": "high"}
        ]
    )
    svc = make_service(FakeClient(content=content))
    resp = svc.finding_analysis(DEGRADED)
    assert resp.likely_causes[0].status == "HYPOTHESIS"
    assert any("downgraded to hypotheses" in l.lower() for l in resp.limitations)


# ── 10. no secrets ────────────────────────────────────────────────────────────
def test_finding_response_never_contains_the_api_key():
    svc = make_service(FakeClient())
    resp = svc.finding_analysis(DEGRADED)
    blob = resp.model_dump_json()
    assert SECRET not in blob
    assert "sk-or-v1" not in blob


# ── 11. API endpoint ──────────────────────────────────────────────────────────
def _api_client(svc=None):
    from fastapi.testclient import TestClient

    app = api_app.create_app(
        datapack=make_datapack(), ai_service=svc or make_service(FakeClient())
    )
    return TestClient(app)


def test_api_finding_endpoint_returns_structured_response():
    client = _api_client()
    r = client.post("/api/ai/finding", json={"finding_id": DEGRADED})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "OK"
    assert body["finding_id"] == DEGRADED
    assert body["context"]["scope"] == "FINDING"
    assert len(body["likely_causes"]) == 2
    assert SECRET not in r.text


def test_api_finding_accepts_a_followup_with_history():
    client = _api_client()
    r = client.post(
        "/api/ai/finding",
        json={
            "finding_id": DEGRADED,
            "question": "What should I check first?",
            "history": [
                {"role": "user", "content": "analyse"},
                {"role": "assistant", "content": "degraded"},
            ],
        },
    )
    assert r.status_code == 200
    assert r.json()["status"] == "OK"


def test_api_finding_requires_a_finding_id():
    client = _api_client()
    assert client.post("/api/ai/finding", json={}).status_code == 422


def test_api_finding_rejects_oversized_question():
    client = _api_client()
    r = client.post(
        "/api/ai/finding", json={"finding_id": DEGRADED, "question": "x" * 2001}
    )
    assert r.status_code == 422


def test_api_finding_rejects_an_invalid_history_role():
    client = _api_client()
    r = client.post(
        "/api/ai/finding",
        json={"finding_id": DEGRADED, "history": [{"role": "system", "content": "x"}]},
    )
    assert r.status_code == 422


def test_api_finding_unknown_id_returns_invalid_input_with_200():
    client = _api_client()
    r = client.post("/api/ai/finding", json={"finding_id": "nope"})
    assert r.status_code == 200
    assert r.json()["status"] == "INVALID_INPUT"


def test_api_finding_is_listed_in_the_root_endpoints():
    client = _api_client()
    endpoints = client.get("/").json()["endpoints"]
    assert "/api/ai/finding" in endpoints
