"""Green Twin — validated AI response schema.

The model is instructed to return JSON in this exact shape, and every field is
validated before anything reaches the frontend. Validation is deliberately
strict and *non-fabricating*: unknown provenance/impact labels are downgraded to
the safe "UNKNOWN" value rather than trusted, and any numeric savings claim found
in free text is flagged as unverified.

Nothing produced here can mutate room status, occupancy, IFC geometry, telemetry
records or operational systems — the response is a read-only explanation.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator

# Provenance categories the model must use. These mirror the product's honest
# data categories; the model may not invent new ones.
ProvenanceKind = Literal[
    "VERIFIED_SENSOR",
    "WEBCAM_ESTIMATE",
    "SAMPLE_SIMULATION",
    "HISTORICAL_REPLAY",
    "IFC_DESIGN",
    "PREDICTION",
    "RULE_BASED",
    "UNAVAILABLE",
]

ImpactStatus = Literal["MEASURED", "CALCULATED", "ESTIMATED", "QUALITATIVE", "UNKNOWN"]

# A likely cause is only ever a hypothesis unless a diagnostic test or verified
# measurement confirms it. "CONFIRMED" is accepted from the model but guarded
# below, because the available data rarely confirms a single root cause.
CauseStatus = Literal["CONFIRMED", "HYPOTHESIS", "UNKNOWN"]
_CAUSE_STATUS = {"CONFIRMED", "HYPOTHESIS", "UNKNOWN"}

# Ordered priority used to sort recommended actions. An unknown value is kept
# as an empty string rather than invented.
_PRIORITY = {"HIGH", "MEDIUM", "LOW"}

# Self-reported confidence for a recommended action; normalized to UNKNOWN when
# the model does not give a recognised value.
_CONFIDENCE = {"HIGH", "MEDIUM", "LOW", "UNKNOWN"}

_PROVENANCE = {
    "VERIFIED_SENSOR",
    "WEBCAM_ESTIMATE",
    "SAMPLE_SIMULATION",
    "HISTORICAL_REPLAY",
    "IFC_DESIGN",
    "PREDICTION",
    "RULE_BASED",
    "UNAVAILABLE",
}
_IMPACT = {"MEASURED", "CALCULATED", "ESTIMATED", "QUALITATIVE", "UNKNOWN"}

# Patterns that indicate a numeric savings/impact claim which the model is not
# allowed to assert without a verified intervention model.
_UNVERIFIED_CLAIM_MARKERS = (
    "%",
    "percent",
    "kwh",
    "kwh/",
    "co2",
    "co₂",
    "kg co",
    "tonnes",
    "tonnes of",
    "carbon savings",
    "energy savings",
    "save ",
    "savings of",
    "€",
    "$",
)


def _clean_str_list(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        if isinstance(item, str) and item.strip():
            out.append(item.strip())
        elif item is not None:
            out.append(str(item))
    return out


class AiEvidence(BaseModel):
    claim: str = ""
    source: str = ""
    value: str | None = None
    provenance: ProvenanceKind = "UNAVAILABLE"
    reference: str | None = None

    @field_validator("provenance", mode="before")
    @classmethod
    def _norm_provenance(cls, v):
        if isinstance(v, str):
            up = v.strip().upper().replace(" ", "_")
            if up in _PROVENANCE:
                return up
        return "UNAVAILABLE"


class AiRecommendation(BaseModel):
    title: str = ""
    opportunity: str = ""
    evidence: str = ""
    action: str = ""
    expected_impact_direction: str = ""
    assumptions: str = ""
    limitations: str = ""
    impact_status: ImpactStatus = "UNKNOWN"
    # Added for the integrated diagnostic workflow.
    priority: str = ""  # HIGH | MEDIUM | LOW (ordering hint); "" when unknown
    component: str = ""  # the affected component / space the action targets
    why_relevant: str = ""  # concise reason this action relates to the finding
    verification: str = ""  # how the operator can verify the issue is resolved
    # How confident the model is in THIS action (self-reported, normalized).
    confidence: str = "UNKNOWN"  # HIGH | MEDIUM | LOW | UNKNOWN

    @field_validator("impact_status", mode="before")
    @classmethod
    def _norm_impact(cls, v):
        if isinstance(v, str):
            up = v.strip().upper()
            if up in _IMPACT:
                return up
        return "UNKNOWN"

    @field_validator("priority", mode="before")
    @classmethod
    def _norm_priority(cls, v):
        if isinstance(v, str):
            up = v.strip().upper()
            if up in _PRIORITY:
                return up
        return ""

    @field_validator("confidence", mode="before")
    @classmethod
    def _norm_confidence(cls, v):
        if isinstance(v, str):
            up = v.strip().upper()
            if up in _CONFIDENCE:
                return up
        return "UNKNOWN"

    @field_validator("title", "opportunity", "evidence", "action", "component", "why_relevant", "verification", mode="before")
    @classmethod
    def _norm_text(cls, v):
        return v if isinstance(v, str) else ("" if v is None else str(v))


class AiLikelyCause(BaseModel):
    """A plausible root cause — explicitly a hypothesis unless confirmed."""

    cause: str = ""
    basis: str = ""  # the observation/evidence that makes it plausible
    status: CauseStatus = "HYPOTHESIS"
    confidence: str | None = None

    @field_validator("status", mode="before")
    @classmethod
    def _norm_status(cls, v):
        if isinstance(v, str):
            up = v.strip().upper()
            if up in _CAUSE_STATUS:
                return up
        return "HYPOTHESIS"

    @field_validator("cause", "basis", mode="before")
    @classmethod
    def _norm_text(cls, v):
        return v if isinstance(v, str) else ("" if v is None else str(v))


class AiProvenance(BaseModel):
    data_freshness: str = "unknown"
    sources: list[str] = Field(default_factory=list)
    is_hypothetical: bool = False
    model: str | None = None

    @field_validator("sources", mode="before")
    @classmethod
    def _norm_sources(cls, v):
        return _clean_str_list(v)


class AiStructured(BaseModel):
    """The validated body of a model response."""

    answer: str = ""
    evidence: list[AiEvidence] = Field(default_factory=list)
    likely_causes: list[AiLikelyCause] = Field(default_factory=list)
    recommendations: list[AiRecommendation] = Field(default_factory=list)
    next_checks: list[str] = Field(default_factory=list)
    assumptions: list[str] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)
    provenance: AiProvenance = Field(default_factory=AiProvenance)

    @field_validator("assumptions", "limitations", "next_checks", mode="before")
    @classmethod
    def _norm_lists(cls, v):
        return _clean_str_list(v)

    @field_validator("answer", mode="before")
    @classmethod
    def _norm_answer(cls, v):
        return v if isinstance(v, str) else ("" if v is None else str(v))


class RoomStatusOut(BaseModel):
    """Deterministic room status computed by the application (not the model)."""

    space_id: str
    level: Literal["UNKNOWN", "NORMAL", "WARNING", "OVER_CAPACITY", "CRITICAL"]
    occupancy_level: str | None = None
    occupancy_count: float | None = None
    capacity: float | None = None
    capacity_source: str | None = None
    occupancy_source: str | None = None
    occupancy_is_demo: bool = False
    occupancy_stale: bool = False
    issue_present: bool = False
    issue_severity: str | None = None
    issue_count: int = 0
    note: str = ""


class ContextSummary(BaseModel):
    """A small, non-secret summary of the grounding data sent to the model."""

    scope: Literal["BUILDING", "ROOM", "FINDING"] = "BUILDING"
    space_id: str | None = None
    storey_id: str | None = None
    finding_id: str | None = None
    sensor_location_mapping: str = "UNRESOLVED"
    mapped_sensors: int = 0
    total_sensors: int = 0
    measured_energy_available: bool = False
    historical_replay: bool = False
    has_webcam_occupancy: bool = False
    room_telemetry_available: bool = False
    data_sources: list[str] = Field(default_factory=list)


class AiBasedOn(BaseModel):
    """The room-state version an analysis was computed from.

    Echoes the client-supplied ``state_version`` and records the authoritative
    occupancy/status values the backend actually used, so the UI can tell whether
    a shown analysis still matches the current room state and can label a stale
    analysis honestly. Never contains a secret.
    """

    space_id: str | None = None
    state_version: str | None = None
    trigger: str | None = None
    occupancy_count: float | None = None
    occupancy_timestamp: str | None = None
    occupancy_source: str | None = None
    occupancy_is_demo: bool = False
    occupancy_stale: bool = False
    status_level: str | None = None
    generated_at: str = ""


class AiResponse(BaseModel):
    """The single response envelope returned by every AI endpoint."""

    status: Literal[
        "OK",
        "NOT_CONFIGURED",
        "RATE_LIMITED",
        "QUOTA_EXHAUSTED",
        "TIMEOUT",
        "PROVIDER_ERROR",
        "MALFORMED",
        "INVALID_INPUT",
    ]
    provider: str = "openrouter"
    model: str | None = None
    message: str | None = None
    answer: str | None = None
    evidence: list[AiEvidence] = Field(default_factory=list)
    likely_causes: list[AiLikelyCause] = Field(default_factory=list)
    recommendations: list[AiRecommendation] = Field(default_factory=list)
    next_checks: list[str] = Field(default_factory=list)
    assumptions: list[str] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)
    provenance: AiProvenance = Field(default_factory=AiProvenance)
    deterministic_status: RoomStatusOut | None = None
    context: ContextSummary | None = None
    finding_id: str | None = None
    # The room-state version this analysis was computed from, so the UI can tell
    # whether the shown analysis still matches the current room state.
    based_on: AiBasedOn | None = None
    generated_at: str = ""


def parse_structured(text: str) -> AiStructured:
    """Parse + validate model JSON into an AiStructured.

    Accepts either a bare JSON object or a JSON object embedded in prose
    (extracts the first balanced ``{...}`` block). Raises ValueError when no
    valid object can be recovered, so the caller can surface MALFORMED rather
    than trusting unvalidated text.
    """
    import json

    if not isinstance(text, str) or not text.strip():
        raise ValueError("empty model output")

    candidate = text.strip()
    try:
        data = json.loads(candidate)
    except json.JSONDecodeError:
        data = _extract_json_object(candidate)
    if not isinstance(data, dict):
        raise ValueError("model output was not a JSON object")
    return AiStructured.model_validate(data)


def _extract_json_object(text: str):
    import json

    start = text.find("{")
    if start == -1:
        return None
    depth = 0
    in_str = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                snippet = text[start : i + 1]
                try:
                    return json.loads(snippet)
                except json.JSONDecodeError:
                    return None
    return None


def guard_unverified_claims(structured: AiStructured) -> AiStructured:
    """Downgrade numeric savings/impact claims that the model cannot support.

    Scans recommendation text for savings-like numeric claims. Any recommendation
    carrying such a claim is forced to ``impact_status = UNKNOWN`` and an explicit
    limitation is appended so the UI never presents a fabricated saving.
    """
    flagged = False
    for rec in structured.recommendations:
        blob = " ".join(
            [
                rec.expected_impact_direction or "",
                rec.evidence or "",
                rec.opportunity or "",
                rec.action or "",
                rec.assumptions or "",
            ]
        ).lower()
        if any(marker in blob for marker in _UNVERIFIED_CLAIM_MARKERS):
            if rec.impact_status in ("MEASURED", "CALCULATED", "ESTIMATED"):
                rec.impact_status = "UNKNOWN"
            flagged = True

    if flagged and not any("not verified" in x.lower() for x in structured.limitations):
        structured.limitations.append(
            "Numeric savings or impact figures mentioned by the model are NOT "
            "verified: no intervention model or measured outcome exists, so they "
            "are presented as UNKNOWN."
        )
    return structured


def guard_unconfirmed_causes(structured: AiStructured) -> AiStructured:
    """Never present a root cause as CONFIRMED without a diagnostic test.

    The available data describes *symptoms* (constant readings, irregular
    intervals, long gaps); it does not confirm which physical cause produced
    them. Any cause the model marks CONFIRMED is downgraded to HYPOTHESIS and an
    explicit limitation is appended, so the UI always distinguishes a confirmed
    fact from a hypothesis to investigate.
    """
    downgraded = False
    for cause in structured.likely_causes:
        if cause.status == "CONFIRMED":
            cause.status = "HYPOTHESIS"
            downgraded = True
    if downgraded and not any(
        "downgraded to hypotheses" in x.lower() for x in structured.limitations
    ):
        structured.limitations.append(
            "Root causes the model marked as confirmed were downgraded to "
            "hypotheses: no diagnostic test or verified measurement in the "
            "available data confirms any single cause."
        )
    return structured
