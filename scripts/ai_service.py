"""Green Twin — Generative AI service.

Orchestrates the AI capabilities on top of the OpenRouter client and the
building-context service:

  * assistant              — natural-language Q&A grounded in app data;
  * sustainability         — evidence-grounded recommendations;
  * explain-status         — explain the *deterministic* room status;
  * room-analysis          — analyse one room's live situation, with follow-ups;
  * finding-analysis       — analyse one diagnostic finding, with follow-ups.

The service owns prompt construction, output validation, and failure mapping.
It never lets model output mutate application state, and it never logs or
returns the API key.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from typing import Callable

from ai_config import AiConfig, MAX_FOCUS_CHARS, MAX_QUESTION_CHARS, load_config
from ai_openrouter import (
    INVALID_INPUT,
    MALFORMED,
    AiError,
    OpenRouterClient,
    user_message,
)
from ai_schemas import (
    AiResponse,
    guard_unconfirmed_causes,
    guard_unverified_claims,
    parse_structured,
)
import building_context as bc
import room_status

# Conversation bounds for the issue-scoped follow-up (defensive, applied before
# any model call).
MAX_HISTORY_TURNS = 8
MAX_HISTORY_CHARS = 4000

_SYSTEM_PROMPT = """You are the Green Twin assistant for a sustainable-building \
digital twin (TalTech DS3 building, Estonia). Explain building data honestly and \
concisely for facility operators.

The JSON in the user message is the ONLY source of truth. Never invent facts, \
values, sensors, rooms, savings or installation details.

Data-integrity rules (single source of truth; follow all of them):
- Label every figure's origin: verified live sensor; webcam occupancy estimate; \
sample/simulated; historical replay; IFC design spec; prediction/hypothesis. \
Never present replay as live, an IFC design value as a measurement, or a DEMO \
webcam association as a verified CCTV installation.
- If a sensor's room mapping is UNRESOLVED, room-level telemetry is unavailable: \
say so and never attribute an unmapped reading to a room.
- A camera occupancy count alone never proves ventilation, air quality or thermal \
comfort is inadequate. If verified room-level CO2 / airflow / temperature is \
unavailable, state that ventilation adequacy cannot be determined from the camera \
count, and at most recommend measuring CO2 or inspecting the HVAC system. Flag \
overcrowding only when a valid capacity is supplied (a count alone is not a breach).
- Never select, redirect or move people between rooms.
- Never invent temperatures, occupancy, energy, carbon or monetary savings; a \
missing/zero BIM property means "not specified", not that it does not exist.
- Never claim an intervention succeeded without evidence. Treat hypothetical/what-if \
outcomes as SIMULATED, never measured.
- You may EXPLAIN a room status the application already computed; never decide, \
change or override it.
- For a diagnostic finding, the detected symptoms are OBSERVATIONS; the physical \
root cause is not confirmed. Present likely causes as HYPOTHESIS unless the supplied \
data confirms one.
- Never claim an energy, carbon or cost saving without a measured/calculated figure; \
otherwise state that the impact is not quantified.

Reply with ONE JSON object (no prose outside it):
{
  "answer": "<2-4 sentence summary of the current situation>",
  "evidence": [{"claim": "...", "source": "...", "value": "...", "provenance": \
"VERIFIED_SENSOR|WEBCAM_ESTIMATE|SAMPLE_SIMULATION|HISTORICAL_REPLAY|IFC_DESIGN|\
PREDICTION|RULE_BASED|UNAVAILABLE", "reference": "..."}],
  "likely_causes": [{"cause": "...", "basis": "...", \
"status": "HYPOTHESIS|CONFIRMED|UNKNOWN", "confidence": "high|medium|low"}],
  "recommendations": [{"title": "...", "action": "...", "component": "...", \
"why_relevant": "...", "verification": "...", "priority": "HIGH|MEDIUM|LOW", \
"confidence": "HIGH|MEDIUM|LOW|UNKNOWN", "impact_status": \
"MEASURED|CALCULATED|ESTIMATED|QUALITATIVE|UNKNOWN"}],
  "next_checks": ["..."],
  "assumptions": ["..."],
  "limitations": ["..."],
  "provenance": {"data_freshness": "...", "sources": ["..."], "is_hypothetical": false}
}

Response rules:
- recommendations[0] MUST be the single most important NEXT ACTION; then at most 3 \
more, ordered by priority. Each action states a concrete step, a one-line reason, \
and how the operator can verify it worked.
- Keep every field short and operational. Do not repeat the same limitation in more \
than one section. Use empty arrays for sections that do not apply.
- Only include a recommendation grounded in the supplied data. Never attach numeric \
savings; use impact_status "UNKNOWN" when impact is not measured/calculated."""


class AiService:
    def __init__(
        self,
        dp: dict,
        client: OpenRouterClient | None = None,
        config: AiConfig | None = None,
        replay_provider: Callable[[], dict] | None = None,
    ):
        self._dp = dp or {}
        self._config = config or load_config()
        self._client = client or OpenRouterClient(self._config)
        self._replay_provider = replay_provider

    # ── configuration ────────────────────────────────────────────
    @property
    def config(self) -> AiConfig:
        return self._config

    def status(self) -> dict:
        return self._config.public_status()

    # ── helpers ──────────────────────────────────────────────────
    def _now_ms(self) -> float:
        return time.time() * 1000.0

    def _generated_at(self) -> str:
        return datetime.now(timezone.utc).isoformat(timespec="seconds")

    def _replay_state(self) -> dict | None:
        if self._replay_provider is None:
            return None
        try:
            return self._replay_provider()
        except Exception:
            return None

    def _context(
        self, space_id: str | None, observation: dict | None
    ) -> tuple[dict, dict]:
        return_ = bc.build_context(
            self._dp,
            space_id=space_id,
            replay_state=self._replay_state(),
            observation=observation,
        )
        return return_["context"], return_["summary"]

    def _error_response(
        self,
        code: str,
        message: str | None = None,
        context: dict | None = None,
        deterministic_status: dict | None = None,
        finding_id: str | None = None,
        based_on: dict | None = None,
    ) -> AiResponse:
        return AiResponse(
            status=code,  # type: ignore[arg-type]
            model=self._config.model,
            message=message or user_message(code),
            context=context,
            finding_id=finding_id,
            # The deterministic status is computed by the backend, never by the
            # model, so it is returned even when the AI is unavailable. The UI
            # can still show an honest room status.
            deterministic_status=deterministic_status,  # type: ignore[arg-type]
            based_on=based_on,  # type: ignore[arg-type]
            generated_at=self._generated_at(),
        )

    def _run(
        self,
        user_prompt: str,
        context_payload: dict,
        summary: dict,
        *,
        deterministic_status: dict | None = None,
        extra_instructions: str | None = None,
        history: list[dict] | None = None,
        finding_id: str | None = None,
        based_on: dict | None = None,
    ) -> AiResponse:
        if not self._config.configured:
            return self._error_response(
                "NOT_CONFIGURED",
                context=summary,
                deterministic_status=deterministic_status,
                finding_id=finding_id,
                based_on=based_on,
            )

        user_content = (
            f"AUTHORITATIVE APPLICATION DATA (JSON):\n```json\n"
            f"{json.dumps(context_payload, default=str)}\n```\n\n"
            f"{user_prompt}"
        )
        if extra_instructions:
            user_content += f"\n\n{extra_instructions}"

        messages = [
            {"role": "system", "content": _SYSTEM_PROMPT},
        ]
        # Prior turns of the issue-scoped conversation, so a follow-up keeps the
        # finding's context. Sanitised + bounded by the caller.
        for turn in self._sanitise_history(history):
            messages.append(turn)
        messages.append({"role": "user", "content": user_content})

        try:
            raw = self._client.chat(messages, json_mode=True)
        except AiError as exc:
            return self._error_response(
                exc.code, exc.message, summary, deterministic_status, finding_id, based_on
            )
        except Exception:
            return self._error_response(
                "PROVIDER_ERROR",
                context=summary,
                deterministic_status=deterministic_status,
                finding_id=finding_id,
                based_on=based_on,
            )

        try:
            structured = parse_structured(raw)
        except Exception:
            return self._error_response(
                MALFORMED,
                context=summary,
                deterministic_status=deterministic_status,
                finding_id=finding_id,
                based_on=based_on,
            )

        structured = guard_unverified_claims(structured)
        structured = guard_unconfirmed_causes(structured)
        structured.provenance.model = self._config.model

        return AiResponse(
            status="OK",
            model=self._config.model,
            answer=structured.answer,
            evidence=structured.evidence,
            likely_causes=structured.likely_causes,
            recommendations=structured.recommendations,
            next_checks=structured.next_checks,
            assumptions=structured.assumptions,
            limitations=structured.limitations,
            provenance=structured.provenance,
            deterministic_status=deterministic_status,  # type: ignore[arg-type]
            context=summary,  # type: ignore[arg-type]
            finding_id=finding_id,
            based_on=based_on,  # type: ignore[arg-type]
            generated_at=self._generated_at(),
        )

    @staticmethod
    def _sanitise_history(history: list[dict] | None) -> list[dict]:
        """Keep only the last N user/assistant text turns, each length-capped."""
        if not history:
            return []
        out: list[dict] = []
        for turn in history[-MAX_HISTORY_TURNS:]:
            if not isinstance(turn, dict):
                continue
            role = turn.get("role")
            content = turn.get("content")
            if role not in ("user", "assistant") or not isinstance(content, str):
                continue
            content = content.strip()
            if not content:
                continue
            out.append({"role": role, "content": content[:MAX_HISTORY_CHARS]})
        return out

    # ── capabilities ─────────────────────────────────────────────
    def assistant(
        self,
        question: str,
        *,
        space_id: str | None = None,
        observation: dict | None = None,
        now_ms: float | None = None,
    ) -> AiResponse:
        question = (question or "").strip()
        if not question:
            return self._error_response(INVALID_INPUT, "Please enter a question.")
        if len(question) > MAX_QUESTION_CHARS:
            return self._error_response(
                INVALID_INPUT,
                f"Question is too long (max {MAX_QUESTION_CHARS} characters).",
            )

        context_payload, summary = self._context(space_id, observation)
        det_status = None
        if space_id and context_payload.get("room"):
            det_status = self._deterministic_status(space_id, observation, now_ms)

        focus = (
            f"The user is viewing room {space_id}."
            if space_id
            else "The user is viewing the building overview."
        )
        prompt = (
            f"{focus}\n\nUser question: {question}\n\n"
            "Answer using only the supplied data. Explain any room status using the "
            "deterministic status the application provided; do not change it."
        )
        if det_status:
            prompt += f"\n\nDeterministic room status (authoritative): {json.dumps(det_status)}"

        return self._run(
            prompt,
            context_payload,
            summary,
            deterministic_status=det_status,
        )

    def sustainability_recommendations(
        self,
        *,
        space_id: str | None = None,
        focus: str | None = None,
    ) -> AiResponse:
        focus = (focus or "").strip()
        if len(focus) > MAX_FOCUS_CHARS:
            return self._error_response(
                INVALID_INPUT, f"Focus is too long (max {MAX_FOCUS_CHARS} characters)."
            )
        context_payload, summary = self._context(space_id, None)
        scope_text = f"for room {space_id}" if space_id else "for the whole building"
        prompt = (
            f"Generate a short list of sustainability recommendations {scope_text}, "
            "grounded strictly in the supplied data (energy efficiency, lighting and "
            "equipment utilisation, occupancy-aware operation, indoor environmental "
            "quality, or water/resources where data exists). Return them in the "
            "'recommendations' array, most important first, each with a concrete "
            "action, a one-line reason, how to verify it, priority, confidence, and "
            "whether the impact is measured, calculated, estimated, qualitative or "
            "unknown. Do NOT invent percentage savings, kWh, carbon or monetary "
            "benefits."
        )
        if focus:
            prompt += f"\n\nOperator focus: {focus}"
        return self._run(prompt, context_payload, summary)

    def explain_status(
        self,
        space_id: str,
        *,
        observation: dict | None = None,
        now_ms: float | None = None,
    ) -> AiResponse:
        space_id = (space_id or "").strip()
        if not space_id:
            return self._error_response(INVALID_INPUT, "A room id is required.")

        context_payload, summary = self._context(space_id, observation)
        if not context_payload.get("room"):
            return self._error_response(
                INVALID_INPUT, f"Unknown room '{space_id}'.", summary
            )

        det_status = self._deterministic_status(space_id, observation, now_ms)
        prompt = (
            f"Explain why room {space_id} currently has status "
            f"'{det_status['level']}'. Base the explanation ONLY on the supplied "
            "deterministic status and its supporting observations. Do not decide or "
            "override the status. State clearly which signals are verified, which are "
            "webcam estimates, and what data is missing."
        )
        return self._run(
            prompt,
            context_payload,
            summary,
            deterministic_status=det_status,
        )

    def room_analysis(
        self,
        space_id: str,
        *,
        question: str | None = None,
        history: list[dict] | None = None,
        observation: dict | None = None,
        state_version: str | None = None,
        trigger: str | None = None,
        now_ms: float | None = None,
    ) -> AiResponse:
        """Analyse one room's current situation, or answer a follow-up.

        With no ``question`` this is the automatic analysis shown when a room's
        situation materially changes (occupancy/status). With a ``question`` it
        is a follow-up that stays scoped to the same room and carries the prior
        turns. The deterministic status is computed by the application, never by
        the model, and is always returned even when the AI is unavailable.
        """
        space_id = (space_id or "").strip()
        if not space_id:
            return self._error_response(INVALID_INPUT, "A room id is required.")
        if len(space_id) > 200:
            return self._error_response(INVALID_INPUT, "Room id is not valid.")

        question = (question or "").strip() or None
        if question and len(question) > MAX_QUESTION_CHARS:
            return self._error_response(
                INVALID_INPUT,
                f"Question is too long (max {MAX_QUESTION_CHARS} characters).",
            )

        context_payload, summary = self._context(space_id, observation)
        if not context_payload.get("room"):
            return self._error_response(
                INVALID_INPUT, f"Unknown room '{space_id}'.", summary
            )

        det_status = self._deterministic_status(space_id, observation, now_ms)
        based_on = self._based_on(
            space_id, det_status, observation, state_version, trigger
        )

        hint = (
            "\n\nThe supplied data also contains the previous questions and answers "
            "for this room. Keep the answer scoped to this room only; never mix in "
            "evidence from other rooms, sensors or findings."
            if question and history
            else ""
        )
        occ_rules = self._occupancy_instruction()

        if question:
            prompt = (
                f"The operator is inspecting room {space_id} and asks a follow-up "
                f"question about its current situation:\n\n{question}\n\n"
                "Answer using only the supplied data for THIS room. Explain which "
                "evidence you used and when it was collected, and distinguish "
                "confirmed observations from hypotheses. If the room state has "
                "changed since the last analysis, say so." + occ_rules + hint
            )
        else:
            prompt = (
                f"Analyse the current situation of room {space_id} for a facility "
                "operator and return the JSON. Keep it operational:\n"
                "- answer: 2-4 sentences on what is happening in THIS room now.\n"
                "- recommendations: the single most important NEXT ACTION first, "
                "then at most 3 more, ordered by priority — each with a concrete "
                "action, a one-line reason, and how to verify it worked.\n"
                "- evidence: only the figures supporting the assessment (occupancy "
                "estimate with its freshness, capacity and its provenance, "
                "environmental measurements with units/timestamps where available, "
                "diagnostic findings, data-quality problems), each labelled with "
                "whether it is live, sampled, simulated or replayed.\n"
                "- likely_causes: the plausible causes, each marked as a hypothesis "
                "unless the supplied data confirms it.\n"
                "- next_checks / limitations: what to measure or inspect next, and "
                "what evidence is missing.\n"
                "If no actionable issue is supported by the evidence, say so "
                "explicitly. Do not repeat the same limitation across sections."
                + occ_rules
            )

        return self._run(
            prompt,
            context_payload,
            summary,
            deterministic_status=det_status,
            history=history if question else None,
            based_on=based_on,
        )

    @staticmethod
    def _occupancy_instruction() -> str:
        """The occupancy/ventilation guardrail appended to room-analysis prompts."""
        return (
            "\n\nOccupancy decision rules:\n"
            "- A camera occupancy count is an ESTIMATE from a DEMO association, not "
            "verified physical occupancy and not a CCTV installation.\n"
            "- Ventilation adequacy cannot be determined from an occupancy count "
            "alone: if verified room-level CO2 / airflow / environmental "
            "measurements are unavailable, say so and only recommend measuring CO2 "
            "or inspecting the HVAC system as a next step. Flag overcrowding only "
            "when a valid capacity for this room is supplied.\n"
            "- Do not select, redirect or move people to another room."
        )

    def _based_on(
        self,
        space_id: str,
        det_status: dict,
        observation: dict | None,
        state_version: str | None,
        trigger: str | None,
    ) -> dict:
        """The room-state version + authoritative values the analysis used."""
        occ = observation or {}
        return {
            "space_id": space_id,
            "state_version": state_version,
            "trigger": trigger,
            "occupancy_count": det_status.get("occupancy_count"),
            "occupancy_timestamp": occ.get("timestamp"),
            "occupancy_source": det_status.get("occupancy_source"),
            "occupancy_is_demo": bool(det_status.get("occupancy_is_demo")),
            "occupancy_stale": bool(det_status.get("occupancy_stale")),
            "status_level": det_status.get("level"),
            "generated_at": self._generated_at(),
        }

    def finding_analysis(
        self,
        finding_id: str,
        *,
        question: str | None = None,
        history: list[dict] | None = None,
        observation: dict | None = None,
    ) -> AiResponse:
        """Analyse one diagnostic finding, optionally answering a follow-up.

        With no ``question`` this is the automatic analysis shown when the
        operator opens the finding. With a ``question`` it is a follow-up that
        stays scoped to the same finding and carries the prior turns.
        """
        finding_id = (finding_id or "").strip()
        if not finding_id:
            return self._error_response(INVALID_INPUT, "A finding id is required.")
        if len(finding_id) > 200:
            return self._error_response(INVALID_INPUT, "Finding id is not valid.")

        question = (question or "").strip() or None
        if question and len(question) > MAX_QUESTION_CHARS:
            return self._error_response(
                INVALID_INPUT,
                f"Question is too long (max {MAX_QUESTION_CHARS} characters).",
            )

        built = bc.finding_context(
            self._dp,
            finding_id,
            observation=observation,
            replay_state=self._replay_state(),
        )
        if built is None:
            return self._error_response(
                INVALID_INPUT, f"Unknown finding '{finding_id}'.", finding_id=finding_id
            )
        context_payload, summary = built["context"], built["summary"]

        hint = (
            "\n\nThe supplied data also contains the previous questions and answers "
            "for this finding. Keep the answer scoped to this finding only; never "
            "mix in evidence from other rooms, sensors or findings."
            if question and history
            else ""
        )

        if question:
            prompt = (
                f"The operator has opened diagnostic finding '{finding_id}' and asks "
                f"a follow-up question:\n\n{question}\n\n"
                "Answer using only the supplied data for THIS finding. Distinguish "
                "confirmed observations from hypotheses, and point out what must be "
                "measured or inspected to verify the answer." + hint
            )
        else:
            prompt = (
                f"Analyse diagnostic finding '{finding_id}' for a facility operator "
                "and return the JSON. Keep it operational:\n"
                "- answer: 2-4 sentences on what the data shows.\n"
                "- recommendations: the single most important NEXT ACTION first, "
                "then at most 3 more, ordered by priority — each with a concrete "
                "action, the affected component, a one-line reason, how to verify "
                "resolution, and a confidence.\n"
                "- likely_causes: the plausible root causes; present them as hypotheses "
                "to investigate, never as confirmed facts.\n"
                "- evidence: the figures supporting the diagnosis, each labelled "
                "with its provenance.\n"
                "- next_checks / limitations: what to inspect or measure next, and "
                "what evidence is missing.\n"
                "The detected symptoms are observations; do not assert a single "
                "physical root cause as confirmed. If the impact is not in the "
                "supplied data, state that it is not quantified. Do not repeat the "
                "same limitation across sections."
            )

        return self._run(
            prompt,
            context_payload,
            summary,
            deterministic_status=None,
            history=history if question else None,
            finding_id=finding_id,
        )

    def _deterministic_status(
        self, space_id: str, observation: dict | None, now_ms: float | None
    ) -> dict:
        space = bc.space_context(self._dp, space_id) or {}
        recs = (self._dp.get("recommendations") or {}).get("records") or []
        status = room_status.resolve_room_status(
            space_id,
            capacity=space.get("design_capacity_occupants"),
            recommendations=recs,
            observation=observation,
            now_ms=now_ms if now_ms is not None else self._now_ms(),
        )
        return room_status.to_output(status)
