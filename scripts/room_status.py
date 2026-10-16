"""Green Twin — deterministic room-status resolver (backend mirror).

The 3D room colouring and status precedence are owned by the frontend
(`frontend/src/lib/roomStatus.ts`). The AI must never decide or override a room
status, so the backend needs its own authoritative copy of the *deterministic*
rules to ground the "explain this status" capability.

This module mirrors the frontend contract exactly:

    precedence: NORMAL < UNKNOWN < WARNING < OVER_CAPACITY < CRITICAL

Two independent signals are combined:
  * camera occupancy — only from an explicit camera->room association, and
    always labelled as a (DEMO) estimate, never verified physical occupancy;
  * rule-based issues — only from a VERIFIED_BIM recommendation that names the
    room (sensor-derived UNKNOWN_LOCATION candidates are ignored).

Capacity is the IFC *design* occupancy from the resource state: it is a declared
model value, never a confirmed legal/operational maximum.
"""

from __future__ import annotations

DEFAULT_WARNING_RATIO = 0.8
DEFAULT_MAX_OBSERVATION_AGE_MS = 20_000

LEVEL_RANK = {
    "NORMAL": 0,
    "UNKNOWN": 1,
    "WARNING": 2,
    "OVER_CAPACITY": 3,
    "CRITICAL": 4,
}

SEVERITY_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO", "UNKNOWN"]


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


def capacity_from_space(value) -> float | None:
    """Valid positive finite capacity, else None (never assume a value)."""
    f = _num(value)
    if f is None or f <= 0:
        return None
    return f


def _verified_space_id(rec: dict) -> str | None:
    location = rec.get("location") or {}
    status = location.get("status") or rec.get("location_status")
    if status != "VERIFIED_BIM":
        return None
    return location.get("space_id") or (rec.get("affected_entity") or {}).get("space_id")


def _severity_rank(severity) -> int:
    s = (severity or "UNKNOWN").upper()
    try:
        return SEVERITY_ORDER.index(s)
    except ValueError:
        return len(SEVERITY_ORDER)


def _parse_ts(value) -> float | None:
    if not value or not isinstance(value, str):
        return None
    from datetime import datetime, timezone

    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def occupancy_status(
    space_id: str,
    observation: dict | None,
    capacity: float | None,
    *,
    now_ms: float,
    warning_ratio: float = DEFAULT_WARNING_RATIO,
    max_observation_age_ms: float = DEFAULT_MAX_OBSERVATION_AGE_MS,
) -> dict | None:
    """Resolve occupancy for a room, or None when there is no explicit
    camera->room association (an unassociated count is never attributed)."""
    if not observation or observation.get("space_id") != space_id:
        return None
    if observation.get("mapping_kind") in (None, "", "UNASSIGNED"):
        return None

    cap = capacity_from_space(capacity)
    count = _num(observation.get("count"))

    ts = _parse_ts(observation.get("timestamp"))
    stale = True if ts is None else (now_ms / 1000.0 - ts) > (max_observation_age_ms / 1000.0)

    level = "UNKNOWN"
    if not stale and cap is not None and count is not None:
        if count > cap:
            level = "OVER_CAPACITY"
        elif count >= cap * warning_ratio:
            level = "WARNING"
        else:
            level = "NORMAL"

    return {
        "level": level,
        "count": count,
        "capacity": cap,
        "capacity_source": "DESIGN" if cap is not None else None,
        "demo": observation.get("mapping_kind") == "DEMO_MAPPING",
        "source": observation.get("source"),
        "stale": stale,
    }


def issue_status(recommendations: list[dict] | None, space_id: str) -> dict | None:
    matches = [r for r in (recommendations or []) if _verified_space_id(r) == space_id]
    if not matches:
        return None
    highest = matches[0]
    for r in matches[1:]:
        if _severity_rank(r.get("priority")) < _severity_rank(highest.get("priority")):
            highest = r
    severity = (highest.get("priority") or "UNKNOWN").upper()
    return {
        "level": "CRITICAL" if severity == "CRITICAL" else "WARNING",
        "severity": severity,
        "count": len(matches),
        "recommendation_id": highest.get("recommendation_id"),
        "action": highest.get("recommended_action"),
    }


def combine_level(occupancy: dict | None, issue: dict | None) -> str:
    candidates: list[str] = []
    if occupancy:
        candidates.append(occupancy["level"])
    if issue:
        candidates.append(issue["level"])
    if not candidates:
        return "UNKNOWN"
    return max(candidates, key=lambda level: LEVEL_RANK.get(level, 0))


def resolve_room_status(
    space_id: str,
    *,
    capacity,
    recommendations: list[dict] | None = None,
    observation: dict | None = None,
    now_ms: float | None = None,
    warning_ratio: float = DEFAULT_WARNING_RATIO,
    max_observation_age_ms: float = DEFAULT_MAX_OBSERVATION_AGE_MS,
) -> dict:
    """Resolve one room's combined, deterministic status."""
    if now_ms is None:
        import time

        now_ms = time.time() * 1000.0
    occ = occupancy_status(
        space_id,
        observation,
        capacity,
        now_ms=now_ms,
        warning_ratio=warning_ratio,
        max_observation_age_ms=max_observation_age_ms,
    )
    issue = issue_status(recommendations, space_id)
    return {
        "space_id": space_id,
        "level": combine_level(occ, issue),
        "occupancy": occ,
        "issue": issue,
    }


def to_output(status: dict) -> dict:
    """Flatten a resolved status into the AI `RoomStatusOut` shape."""
    occ = status.get("occupancy") or {}
    issue = status.get("issue") or {}
    return {
        "space_id": status["space_id"],
        "level": status["level"],
        "occupancy_level": occ.get("level"),
        "occupancy_count": occ.get("count"),
        "capacity": occ.get("capacity"),
        "capacity_source": occ.get("capacity_source"),
        "occupancy_source": occ.get("source"),
        "occupancy_is_demo": bool(occ.get("demo")),
        "occupancy_stale": bool(occ.get("stale")),
        "issue_present": bool(issue),
        "issue_severity": issue.get("severity"),
        "issue_count": int(issue.get("count") or 0),
        "note": (
            "Deterministic status produced by the Green Twin application "
            "(occupancy + verified rule-based issues). The AI only explains it."
        ),
    }
