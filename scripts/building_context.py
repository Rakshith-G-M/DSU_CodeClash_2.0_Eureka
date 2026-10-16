"""Green Twin — building-context service for AI grounding.

Assembles the *minimum* relevant, authoritative context for an AI request from
the already-loaded application data (the FastAPI datapack). It never dumps raw
telemetry: anomaly/telemetry figures come from the pre-aggregated intelligence
summary, and channel statistics from the telemetry profile summary.

Honesty rules enforced here:
  * sensor->room mapping is UNRESOLVED in this dataset, so sensor readings are
    reported at building/channel level only and never attributed to a room;
  * IFC values are design/specification values, never measurements;
  * replay data is labelled historical, never live;
  * an operator camera association is labelled a DEMO estimate.

Every function is pure and returns JSON-serializable dicts, so the resulting
payload is fully unit-testable.
"""

from __future__ import annotations

from ai_config import MAX_CONTEXT_SPACES

# Subset of IFC design fields (mirrors scripts/api_app.py `_DESIGN_FIELDS`).
_DESIGN_FIELDS = [
    ("lighting_design_load_w", "Energy Analysis.Specified Lighting Load"),
    ("power_design_load_w", "Energy Analysis.Specified Power Load"),
    ("design_cooling_load_w", "Energy Analysis.Design Cooling Load"),
    ("design_heating_load_w", "Energy Analysis.Design Heating Load"),
    ("air_changes_per_hour", "Energy Analysis.Air Changes per Hour"),
    ("design_occupancy_people", "Energy Analysis.Number of People"),
    ("area_per_person_m2", "Energy Analysis.Area per Person"),
]


def _num(value) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if f != f or f in (float("inf"), float("-inf")):
        return None
    return f


def mapping_summary(dp: dict) -> dict:
    summary = (dp.get("sensor_space_mapping") or {}).get("summary") or {}
    total = int(summary.get("total") or 0)
    resolved = int(summary.get("resolved") or 0)
    return {
        "total_sensors": total,
        "resolved": resolved,
        "unresolved": int(summary.get("unresolved") or 0),
        "verified_locations": int(summary.get("verified_locations") or 0),
        "status": "RESOLVED" if total and resolved >= total else "UNRESOLVED",
    }


def _storeys(dp: dict) -> list[dict]:
    reg = dp.get("campus_registry") or {}
    out = []
    for s in reg.get("storeys") or []:
        out.append(
            {
                "storey_id": s.get("id") or s.get("storey_id"),
                "name": s.get("name") or s.get("long_name"),
                "space_count": s.get("space_count"),
                "elevation_m": _num(s.get("elevation")),
            }
        )
    return out


def _building(dp: dict) -> dict:
    reg = dp.get("campus_registry") or {}
    campus = reg.get("campus") or {}
    buildings = reg.get("buildings") or []
    b0 = buildings[0] if buildings else {}
    return {
        "campus_name": campus.get("name"),
        "building_name": b0.get("name"),
        "building_id": b0.get("id"),
        "space_count": b0.get("space_count") or campus.get("space_count"),
        "storey_count": campus.get("storey_count"),
    }


def _resource_space(dp: dict, space_id: str) -> dict | None:
    for s in (dp.get("resource_state") or {}).get("spaces", []):
        if s.get("space_id") == space_id:
            return s
    return None


def _bim_space(dp: dict, space_id: str) -> dict | None:
    for s in (dp.get("spaces_bim") or {}).get("spaces", []):
        if s.get("space_id") == space_id:
            return s
    return None


def space_context(dp: dict, space_id: str) -> dict | None:
    """Canonical IFC context for one space (design values only)."""
    rs = _resource_space(dp, space_id)
    bim = _bim_space(dp, space_id)
    if rs is None and bim is None:
        return None

    src = rs or {}
    geometry = src.get("geometry") or {}
    occupancy = src.get("occupancy") or {}
    capacity = _num(src.get("capacity_occupants"))
    if capacity is None:
        capacity = _num(occupancy.get("capacity_occupants"))
    if capacity is None and bim is not None:
        capacity = _num(bim.get("capacity"))

    design: dict = {}
    if bim is not None:
        props = bim.get("bim_properties") or {}
        for key, prop in _DESIGN_FIELDS:
            val = props.get(prop)
            if val is not None and not isinstance(val, bool):
                design[key] = _num(val)

    storey_name = src.get("storey_name")
    storey_id = src.get("storey_id") or (bim or {}).get("storey_id")
    if not storey_name and storey_id:
        for st in _storeys(dp):
            if st["storey_id"] == storey_id:
                storey_name = st["name"]
                break

    return {
        "space_id": space_id,
        "ifc_name": src.get("ifc_name") or (bim or {}).get("ifc_name"),
        "storey_id": storey_id,
        "storey_name": storey_name,
        "area_m2": _num(geometry.get("area_m2")) or _num((bim or {}).get("area_m2")),
        "volume_m3": _num(geometry.get("volume_m3")) or _num((bim or {}).get("volume_m3")),
        "height_m": _num(geometry.get("height_m")) or _num((bim or {}).get("height_m")),
        # Declared IFC DESIGN occupancy — not a confirmed legal/operational max.
        "design_capacity_occupants": capacity,
        "capacity_origin": "IFC_DESIGN" if capacity is not None else None,
        "occupiable": src.get("occupiable", occupancy.get("occupiable")),
        "conditioning": (src.get("conditioning") or {}).get("condition_type"),
        "design_values": design,
        "data_origin": "IFC_DESIGN",
        "measured": False,
    }


def telemetry_context(dp: dict) -> dict:
    """Building-level telemetry summary (aggregated; never per-room)."""
    intel = dp.get("telemetry_intelligence_summary") or {}
    dataset = intel.get("dataset") or {}
    intelligence = (intel.get("intelligence") or {}).get("anomalies") or {}
    profile = (dp.get("telemetry_profile") or {}).get("summary") or {}
    sensors = dp.get("sensors") or {}
    health = (dp.get("sensor_health") or {}).get("summary") or {}
    return {
        "scope": "BUILDING",
        "devices": dataset.get("devices") or sensors.get("count"),
        "channels": dataset.get("channels") or profile.get("channels"),
        "total_readings": dataset.get("total_readings") or profile.get("total_readings"),
        "channels_by_type": dataset.get("channels_by_type") or profile.get("channels_by_type"),
        "time_span": dataset.get("time_span"),
        "anomalies_by_severity": intelligence.get("by_severity"),
        "anomalies_by_measurement_type": intelligence.get("by_measurement_type"),
        "sensor_health": {
            "devices": health.get("devices"),
            "healthy": health.get("healthy"),
            "degraded": health.get("degraded"),
            "overall": health.get("overall"),
        },
        # Sensor locations are unresolved: nothing here may be attributed to a room.
        "location_note": (
            "Sensor locations are UNRESOLVED. These readings are building/channel "
            "level only and are never attributed to a specific room."
        ),
        "is_historical": True,
    }


def environmental_availability(dp: dict, space_id: str | None) -> dict:
    """Whether room-level environmental telemetry is available (it is not)."""
    mapping = mapping_summary(dp)
    return {
        "room_id": space_id,
        "room_level_readings_available": False if space_id else None,
        "reason": (
            "No sensor has a verified location in this room in the current data "
            "release (sensor->space mapping is UNRESOLVED)."
            if space_id
            else "Environmental channels exist at building level only."
        ),
        "verified_locations": mapping["verified_locations"],
        "mapping_status": mapping["status"],
    }


def replay_context(replay_state: dict | None) -> dict:
    if not replay_state:
        return {"available": False}
    return {
        "available": True,
        "is_historical": True,
        "sim_timestamp": replay_state.get("sim_timestamp"),
        "running": replay_state.get("running"),
        "readings_replayed": replay_state.get("readings_replayed"),
        "channels_active": len(replay_state.get("channels") or []),
        "anomalies_detected": replay_state.get("anomalies_detected"),
        "note": (
            "This is a historical dataset replay, NOT live physical telemetry. "
            "Never present it as a live reading."
        ),
    }


def relevant_recommendations(dp: dict, space_id: str | None, limit: int = 6) -> list[dict]:
    """A few deterministic recommendations for grounding.

    Room-scoped, VERIFIED_BIM recommendations come first when a room is in focus;
    otherwise a severity-ordered sample of the highest-priority candidates.
    """
    records = (dp.get("recommendations") or {}).get("records") or []
    severity_rank = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}
    ordered = sorted(records, key=lambda r: severity_rank.get(r.get("priority"), 9))
    if space_id:
        scoped = [
            r
            for r in ordered
            if (r.get("location") or {}).get("space_id") == space_id
            or (r.get("affected_entity") or {}).get("space_id") == space_id
        ]
        if scoped:
            ordered = scoped
    out = []
    for r in ordered[:limit]:
        out.append(
            {
                "recommendation_id": r.get("recommendation_id"),
                "priority": r.get("priority"),
                "category": r.get("recommendation_category"),
                "problem_type": r.get("problem_type"),
                "action": r.get("recommended_action"),
                "reason": r.get("reason"),
                "location_status": r.get("location_status"),
                "impact": r.get("expected_impact"),
            }
        )
    return out


# Issue code -> product-approved human label. Mirrors
# frontend/src/lib/recPresentation.ts so the model reuses the same language the
# operator already sees, rather than inventing its own.
_ISSUE_LABELS = {
    "CONSTANT_VALUE": "Repeated constant readings",
    "IRREGULAR_SAMPLING": "Irregular measurement intervals",
    "LONG_GAP": "Extended period without readings",
    "LONG_DATA_GAP": "Extended period without readings",
    "EXCESSIVE_MISSING": "High rate of missing readings",
    "OUT_OF_BOUNDS": "Out-of-range readings detected",
    "NOISE": "Noisy or unstable readings",
    "SPIKE": "Sudden measurement spikes",
    "DRIFT": "Gradual sensor drift detected",
}


def _issue_label(code: str) -> str:
    up = (code or "").upper().strip()
    return _ISSUE_LABELS.get(up, up.replace("_", " ").title())


def finding_record(dp: dict, finding_id: str) -> dict | None:
    """Look up one deterministic diagnostic finding by id."""
    if not finding_id:
        return None
    for r in (dp.get("recommendations") or {}).get("records") or []:
        if r.get("recommendation_id") == finding_id:
            return r
    return None


def _sensor_health_device(dp: dict, sensor_id: str) -> dict | None:
    if not sensor_id:
        return None
    for d in (dp.get("sensor_health") or {}).get("devices") or []:
        if d.get("sensor_id") == sensor_id:
            return d
    return None


def _sensor_meta(dp: dict, sensor_id: str) -> dict | None:
    if not sensor_id:
        return None
    for s in (dp.get("sensors") or {}).get("sensors") or []:
        if s.get("sensor_id") == sensor_id:
            return s
    return None


def _channel_profile(channel: dict) -> dict:
    """A compact, per-channel summary (never the raw series)."""
    health = channel.get("health") or {}
    gaps = channel.get("gaps") or {}
    interval = channel.get("interval_stats") or {}
    anomaly = channel.get("anomaly_summary") or {}
    issues = [
        {
            "type": i.get("type"),
            "label": _issue_label(i.get("type")),
            "severity": i.get("severity"),
            "detail": i.get("detail"),
        }
        for i in (health.get("issues") or [])
        if isinstance(i, dict)
    ]
    return {
        "measurement_type": channel.get("measurement_type"),
        "unit": channel.get("unit"),
        "record_count": channel.get("record_count"),
        "duration_hours": _num(channel.get("duration_hours")),
        "value_stats": {
            "min": _num(channel.get("min")),
            "max": _num(channel.get("max")),
            "mean": _num(channel.get("mean")),
            "median": _num(channel.get("median")),
            "std": _num(channel.get("std")),
        },
        "quality": channel.get("quality"),
        "sampling": {
            "expected_interval_seconds": _num(channel.get("expected_interval_seconds")),
            "interval_median_seconds": _num(interval.get("median")),
            "interval_mean_seconds": _num(interval.get("mean")),
            "interval_std_seconds": _num(interval.get("std")),
            "interval_cv": (
                round(float(interval.get("std")) / float(interval.get("mean")), 3)
                if interval.get("std") is not None
                and interval.get("mean") not in (None, 0)
                else None
            ),
        },
        "gaps": {
            "count": gaps.get("count"),
            "largest_hours": (
                round(_num(gaps.get("largest_seconds")) / 3600.0, 1)
                if _num(gaps.get("largest_seconds")) is not None
                else None
            ),
        },
        "health": {
            "distinct_values": health.get("distinct_values"),
            "longest_identical_run": health.get("longest_identical_run"),
            "issues": issues,
        },
        "anomaly_candidates": anomaly.get("candidates_surviving"),
        # Archived historical telemetry — never a live physical reading.
        "data_origin": "HISTORICAL_REPLAY",
        "is_live": False,
        "note": "Archived historical telemetry, not a live physical reading.",
    }


def _channel_profiles(dp: dict, sensor_id: str, limit: int = 3) -> list[dict]:
    if not sensor_id:
        return []
    out = []
    for c in (dp.get("telemetry_profile") or {}).get("channels") or []:
        if c.get("sensor_id") == sensor_id:
            out.append(_channel_profile(c))
            if len(out) >= limit:
                break
    return out


def _detected_symptoms(rec: dict, device: dict | None) -> list[dict]:
    """Merge the finding's issue codes with the device/channel issue details."""
    details: dict[str, dict] = {}
    for issue in (device or {}).get("issues") or []:
        if isinstance(issue, dict) and issue.get("type"):
            details[str(issue["type"]).upper()] = {
                "severity": issue.get("max_severity"),
                "detail": (issue.get("example") or {}).get("detail"),
                "affected_channels": issue.get("affected_channels"),
            }

    codes: list[str] = []
    evidence = rec.get("evidence") or {}
    for code in evidence.get("issue_types") or []:
        codes.append(str(code))
    for step in rec.get("evidence_chain") or []:
        if step.get("step") == "HEALTH_ISSUE" and isinstance(step.get("value"), list):
            codes.extend(str(v) for v in step["value"])
    for code in (rec.get("data_quality") or {}).get("issue_types") or []:
        codes.append(str(code))

    out: list[dict] = []
    seen: set[str] = set()
    for code in codes:
        up = code.upper()
        if up in seen:
            continue
        seen.add(up)
        detail = details.get(up, {})
        out.append(
            {
                "code": up,
                "label": _issue_label(up),
                "severity": detail.get("severity"),
                "detail": detail.get("detail"),
                "affected_channels": detail.get("affected_channels"),
            }
        )
    return out


def _related_findings(dp: dict, rec: dict, sensor_id: str, limit: int = 4) -> list[dict]:
    """Other findings for the same sensor — prior/remediation context."""
    if not sensor_id:
        return []
    out = []
    for r in (dp.get("recommendations") or {}).get("records") or []:
        if r.get("recommendation_id") == rec.get("recommendation_id"):
            continue
        if (r.get("affected_entity") or {}).get("sensor_id") != sensor_id:
            continue
        out.append(
            {
                "finding_id": r.get("recommendation_id"),
                "problem_type": r.get("problem_type"),
                "priority": r.get("priority"),
                "action": r.get("recommended_action"),
                "status": (r.get("data_quality") or {}).get("health_status"),
            }
        )
        if len(out) >= limit:
            break
    return out


def finding_context(
    dp: dict,
    finding_id: str,
    *,
    observation: dict | None = None,
    replay_state: dict | None = None,
) -> dict | None:
    """Assemble the grounding payload for one diagnostic finding.

    Returns ``None`` when the finding is unknown. The sensor's measurements are
    reported at *device/channel* level only; a room context is attached solely
    when the finding carries a VERIFIED_BIM location — an unresolved mapping is
    never attributed to a room.
    """
    rec = finding_record(dp, finding_id)
    if rec is None:
        return None

    mapping = mapping_summary(dp)
    telemetry = telemetry_context(dp)
    replay = replay_context(replay_state)
    occ = occupancy_context(observation)

    affected = rec.get("affected_entity") or {}
    sensor_id = affected.get("sensor_id") or (rec.get("data_quality") or {}).get("sensor_id")
    location = rec.get("location") or {}
    location_status = rec.get("location_status") or location.get("status") or "UNKNOWN_LOCATION"
    verified_room = (
        location_status == "VERIFIED_BIM" and bool(location.get("space_id"))
    )
    space_id = location.get("space_id") if verified_room else None

    device = _sensor_health_device(dp, sensor_id)
    meta = _sensor_meta(dp, sensor_id)

    payload: dict = {
        "finding": {
            "finding_id": rec.get("recommendation_id"),
            "problem_type": rec.get("problem_type"),
            "category": rec.get("recommendation_category"),
            "priority": rec.get("priority"),
            "recommended_action": rec.get("recommended_action"),
            "reason": rec.get("reason"),
            "detected_symptoms": _detected_symptoms(rec, device),
            "evidence_chain": rec.get("evidence_chain"),
            "constraints": rec.get("constraints"),
            "expected_impact": rec.get("expected_impact"),
            "confidence": rec.get("confidence"),
            "data_quality": rec.get("data_quality"),
            "origin": "RULE_BASED_DIAGNOSTIC",
        },
        "location": {
            "status": location_status,
            "verified": verified_room,
            "space_id": space_id,
            "note": (
                "Location verified to a building space via the BIM model."
                if verified_room
                else "Sensor-to-space mapping is UNRESOLVED: the physical room "
                "is unknown and must not be asserted."
            ),
        },
        "affected_sensor": (
            {
                "sensor_id": sensor_id,
                "type": (meta or {}).get("type"),
                "unit": (meta or {}).get("unit"),
                "mapping_status": (meta or {}).get("status"),
                "health_status": (device or {}).get("health_status"),
                "channels": [(meta or {}).get("type")],
            }
            if sensor_id
            else None
        ),
        "sensor_health": (
            {
                "health_status": device.get("health_status"),
                "valid_readings": device.get("valid_readings"),
                "missing_readings": device.get("missing_readings"),
                "time_gaps": device.get("time_gaps"),
                "suspect_readings": device.get("suspect_readings"),
                "anomaly_candidates": device.get("anomaly_candidates"),
                "coverage_fraction": _num(device.get("coverage_fraction")),
                "first_report": device.get("first_report"),
                "last_report": device.get("last_report"),
                "issues": [
                    {
                        "type": i.get("type"),
                        "label": _issue_label(i.get("type")),
                        "max_severity": i.get("max_severity"),
                        "detail": (i.get("example") or {}).get("detail"),
                    }
                    for i in device.get("issues") or []
                    if isinstance(i, dict)
                ],
                "note": "Device-level observability quality, not measurement accuracy.",
            }
            if device
            else None
        ),
        "channel_profiles": _channel_profiles(dp, sensor_id),
        "sensor_location_mapping": mapping,
        "related_findings": _related_findings(dp, rec, sensor_id),
        "building_telemetry": telemetry,
        "replay": replay,
        "webcam_occupancy": occ,
        "room": None,
        "room_level_telemetry_available": False,
    }

    storey_id = None
    if space_id:
        space = space_context(dp, space_id)
        if space is not None:
            payload["room"] = space
            storey_id = space.get("storey_id")

    summary = {
        "scope": "FINDING",
        "space_id": space_id,
        "storey_id": storey_id,
        "finding_id": rec.get("recommendation_id"),
        "sensor_location_mapping": mapping["status"],
        "mapped_sensors": mapping["resolved"],
        "total_sensors": mapping["total_sensors"],
        "measured_energy_available": bool(
            (_data_status(dp).get("measured_energy_available"))
        ),
        "historical_replay": bool(replay.get("available")),
        "has_webcam_occupancy": occ is not None,
        "room_telemetry_available": False,
        "data_sources": _data_sources("FINDING"),
    }
    return {"context": payload, "summary": summary}


def occupancy_context(observation: dict | None) -> dict | None:
    """Sanitised camera-occupancy observation (always an estimate)."""
    if not observation:
        return None
    kind = observation.get("mapping_kind")
    return {
        "count": _num(observation.get("count")),
        "source": observation.get("source"),
        "timestamp": observation.get("timestamp"),
        "space_id": observation.get("space_id"),
        "mapping_kind": kind,
        "is_demo_association": kind == "DEMO_MAPPING",
        "note": (
            "Browser webcam occupancy estimate"
            + (" from an operator DEMO association" if kind == "DEMO_MAPPING" else "")
            + ". This is an estimate, not verified physical occupancy or a CCTV "
            "installation."
        ),
    }


def build_context(
    dp: dict,
    *,
    space_id: str | None = None,
    replay_state: dict | None = None,
    observation: dict | None = None,
) -> dict:
    """Assemble the grounding payload plus a small context summary."""
    mapping = mapping_summary(dp)
    telemetry = telemetry_context(dp)
    replay = replay_context(replay_state)
    occ = occupancy_context(observation)
    data_status = _data_status(dp)

    payload: dict = {
        "building": _building(dp),
        "storeys": _storeys(dp),
        "sensor_location_mapping": mapping,
        "building_telemetry": telemetry,
        "replay": replay,
        "webcam_occupancy": occ,
        "energy_and_resources": data_status,
        "rule_based_recommendations": relevant_recommendations(dp, space_id),
    }

    scope = "BUILDING"
    room_telemetry_available = False
    if space_id:
        space = space_context(dp, space_id)
        if space is not None:
            scope = "ROOM"
            payload["room"] = space
            payload["room_environmental"] = environmental_availability(dp, space_id)
            room_telemetry_available = False

    summary = {
        "scope": scope,
        "space_id": space_id if scope == "ROOM" else None,
        "storey_id": (payload.get("room") or {}).get("storey_id") if scope == "ROOM" else None,
        "sensor_location_mapping": mapping["status"],
        "mapped_sensors": mapping["resolved"],
        "total_sensors": mapping["total_sensors"],
        "measured_energy_available": bool(data_status.get("measured_energy_available")),
        "historical_replay": bool(replay.get("available")),
        "has_webcam_occupancy": occ is not None,
        "room_telemetry_available": room_telemetry_available,
        "data_sources": _data_sources(scope),
    }
    return {"context": payload, "summary": summary}


def _data_status(dp: dict) -> dict:
    rs = dp.get("resource_state") or {}
    availability = rs.get("availability") or {}
    summary = rs.get("summary") or {}
    return {
        "measured_energy_available": bool(availability.get("present")),
        "metric_origin_note": summary.get("metric_origin_note"),
        "total_area_m2": _num(summary.get("total_area_m2")),
        "total_capacity_occupants": _num(summary.get("total_capacity_occupants")),
        "note": (
            "Area/volume/capacity/lighting/power/HVAC values are BIM DESIGN or "
            "derived design metrics; none are measured consumption."
        ),
    }


def _data_sources(scope: str) -> list[str]:
    sources = ["IFC_DESIGN", "TELEMETRY_AGGREGATE", "RULE_BASED_RECOMMENDATIONS"]
    if scope == "ROOM":
        sources.append("ROOM_IFC_CONTEXT")
    if scope == "FINDING":
        sources.extend(["DIAGNOSTIC_FINDING", "SENSOR_HEALTH"])
    return sources
