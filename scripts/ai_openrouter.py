"""Green Twin — OpenRouter inference client.

A small, dependency-light client for the OpenAI-compatible Chat Completions
interface exposed by OpenRouter. Two design goals:

1. The API key lives ONLY here (backend). It is never logged and never leaves a
   request header.
2. Every failure mode is mapped to an explicit, user-friendly error code so the
   product can degrade gracefully and never fabricate a model response.

Tests inject a fake transport (a callable returning a response-like object), so
automated tests never hit the network and never need a real API key.
"""

from __future__ import annotations

import json
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeoutError
from typing import Any, Callable, Sequence

from ai_config import AiConfig

# Error codes surfaced to the frontend (never contain a secret).
NOT_CONFIGURED = "NOT_CONFIGURED"
RATE_LIMITED = "RATE_LIMITED"
QUOTA_EXHAUSTED = "QUOTA_EXHAUSTED"
TIMEOUT = "TIMEOUT"
PROVIDER_ERROR = "PROVIDER_ERROR"
MALFORMED = "MALFORMED"
INVALID_INPUT = "INVALID_INPUT"

# Transport signature: (url, headers, payload, timeout) -> response-like.
# The response-like object must expose .status_code and .text, and ideally
# .json(). httpx.Response satisfies this.
Transport = Callable[[str, dict, dict, float], Any]


class AiError(Exception):
    """A mapped inference failure with a user-friendly message."""

    def __init__(
        self,
        code: str,
        message: str,
        status_code: int | None = None,
        diagnostic: dict | None = None,
    ):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        # Non-secret diagnostic payload for server-side logging only.
        # Never exposed to the client; never contains the API key.
        self.diagnostic: dict = diagnostic or {}


USER_MESSAGES: dict[str, str] = {
    NOT_CONFIGURED: (
        "The AI assistant is not configured. Set OPENROUTER_API_KEY on the "
        "backend to enable it."
    ),
    RATE_LIMITED: (
        "The AI model is rate-limited right now. Please try again in a moment."
    ),
    QUOTA_EXHAUSTED: (
        "The AI model's free quota is exhausted. It may recover later, or a "
        "different model can be configured."
    ),
    TIMEOUT: "The AI model took too long to respond. Please try again.",
    PROVIDER_ERROR: (
        "The AI provider is temporarily unavailable. The rest of the "
        "application keeps working."
    ),
    MALFORMED: (
        "The AI model returned a response that could not be validated. No "
        "unverified content was used."
    ),
    INVALID_INPUT: "The request was rejected before contacting the model.",
}


def user_message(code: str) -> str:
    return USER_MESSAGES.get(code, "The AI service is unavailable.")


def _default_transport(url: str, headers: dict, payload: dict, timeout: float):
    import httpx

    with httpx.Client(timeout=httpx.Timeout(timeout)) as client:
        return client.post(url, headers=headers, json=payload)


def _extract_content(body: Any) -> str:
    """Pull the assistant text out of an OpenAI-compatible response body.

    Raises AiError with a precise diagnostic message that names the actual
    failure mode — in particular the reasoning-token-exhaustion pattern where
    a hidden-reasoning model spends its entire token budget on internal
    reasoning and returns content=null with finish_reason='length'.
    """
    if not isinstance(body, dict):
        raise AiError(MALFORMED, "Non-object response body from provider.")
    choices = body.get("choices")
    if not isinstance(choices, list) or not choices:
        raise AiError(MALFORMED, "Provider response contained no choices.")
    first = choices[0]
    if not isinstance(first, dict):
        raise AiError(MALFORMED, "Provider choice was not an object.")

    finish_reason = first.get("finish_reason")
    message = first.get("message")
    if not isinstance(message, dict):
        raise AiError(MALFORMED, "Provider choice had no message.")

    content = message.get("content")
    if isinstance(content, list):
        # Some providers return content as a list of parts.
        parts = [
            p.get("text", "")
            for p in content
            if isinstance(p, dict)
        ]
        content = "".join(parts)

    # Collect safe diagnostic metadata (never the API key or full prompt).
    usage = body.get("usage") or {}
    cd = usage.get("completion_tokens_details") or {}
    reasoning_tokens = cd.get("reasoning_tokens") or 0
    completion_tokens = usage.get("completion_tokens") or 0
    model_id = body.get("model", "")
    diag = {
        "finish_reason": finish_reason,
        "content_type": type(content).__name__,
        "content_length": len(content) if isinstance(content, str) else 0,
        "reasoning_tokens": reasoning_tokens,
        "completion_tokens": completion_tokens,
        "model": model_id,
        "has_reasoning_field": "reasoning" in message,
        "has_tool_calls": "tool_calls" in message,
    }

    if not isinstance(content, str) or not content.strip():
        # Distinguish reasoning-budget-exhaustion from other empty-content cases.
        if finish_reason == "length" and reasoning_tokens > 0:
            pct = int(100 * reasoning_tokens / completion_tokens) if completion_tokens else 0
            raise AiError(
                MALFORMED,
                (
                    f"The model used its entire token budget ({completion_tokens} tokens) "
                    f"on internal reasoning ({reasoning_tokens} reasoning tokens, {pct}% of budget) "
                    "and returned no answer. "
                    "Disable model reasoning (OPENROUTER_REASONING=0) or increase "
                    "OPENROUTER_MAX_TOKENS to give the model room to answer."
                ),
                diagnostic=diag,
            )
        raise AiError(
            MALFORMED,
            (
                f"The model returned an empty answer (finish_reason={finish_reason!r}, "
                f"reasoning_tokens={reasoning_tokens}). "
                "The model may require reasoning to be disabled or a different model."
            ),
            diagnostic=diag,
        )
    return content


class OpenRouterClient:
    """Thin wrapper over OpenRouter Chat Completions."""

    def __init__(self, config: AiConfig, transport: Transport | None = None):
        self._config = config
        self._transport: Transport = transport or _default_transport

    @property
    def config(self) -> AiConfig:
        return self._config

    def _call_transport(
        self, url: str, headers: dict, payload: dict, *, deadline_at: float
    ):
        """Invoke the transport under a hard total deadline.

        ``deadline_at`` is a ``time.monotonic()`` instant. The per-phase network
        timeout passed to the transport is clamped to the time left, and the call
        is run on a worker so a trickling response can be abandoned at the total
        deadline instead of hanging (httpx's read timeout resets on every byte).
        Raises AiError(TIMEOUT) when the deadline is exceeded.
        """
        remaining = max(0.1, deadline_at - time.monotonic())
        per_phase = min(self._config.timeout_seconds, remaining)
        executor = ThreadPoolExecutor(max_workers=1)
        try:
            future = executor.submit(self._transport, url, headers, payload, per_phase)
            try:
                return future.result(timeout=remaining)
            except FutureTimeoutError as exc:
                future.cancel()
                raise AiError(TIMEOUT, user_message(TIMEOUT)) from exc
        finally:
            # Never block on the abandoned worker: the socket will be closed by
            # its own per-phase timeout, so the thread exits promptly.
            executor.shutdown(wait=False)

    def _headers(self) -> dict:
        headers = {
            "Authorization": f"Bearer {self._config.api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            # OpenRouter attribution headers (optional, non-secret).
            "X-Title": self._config.title,
        }
        if self._config.referer:
            headers["HTTP-Referer"] = self._config.referer
        return headers

    def _classify_status(self, status_code: int, text: str) -> AiError:
        snippet = (text or "").strip()[:200]
        if status_code == 429:
            return AiError(RATE_LIMITED, user_message(RATE_LIMITED), status_code)
        if status_code == 402:
            return AiError(QUOTA_EXHAUSTED, user_message(QUOTA_EXHAUSTED), status_code)
        if status_code in (401, 403):
            return AiError(
                PROVIDER_ERROR,
                "The AI provider rejected the configured credentials. Check the "
                "backend API key.",
                status_code,
            )
        if status_code == 408:
            return AiError(TIMEOUT, user_message(TIMEOUT), status_code)
        if status_code >= 500:
            return AiError(PROVIDER_ERROR, user_message(PROVIDER_ERROR), status_code)
        return AiError(
            PROVIDER_ERROR,
            f"The AI provider returned an error (HTTP {status_code}). {snippet}".strip(),
            status_code,
        )

    def chat(
        self,
        messages: Sequence[dict],
        *,
        temperature: float = 0.2,
        max_tokens: int | None = None,
        json_mode: bool = False,
        reasoning_enabled: bool | None = None,
    ) -> str:
        """Run one chat completion and return the assistant text.

        Raises AiError(code, message) on any failure.
        """
        if not self._config.configured:
            raise AiError(NOT_CONFIGURED, user_message(NOT_CONFIGURED))

        effective_max_tokens = (
            max_tokens if max_tokens is not None else self._config.max_tokens
        )
        payload: dict[str, Any] = {
            "model": self._config.model,
            "messages": list(messages),
            "temperature": temperature,
            "max_tokens": effective_max_tokens,
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}

        # OpenRouter reasoning control:
        # In OpenRouter's API, `exclude: true` only strips thinking tokens from the
        # output text, but the model still spends output tokens on reasoning.
        # To actually disable reasoning and free the full token budget for the
        # visible response, OpenRouter uses `reasoning: {"enabled": False, "effort": "none"}`.
        effective_reasoning = (
            reasoning_enabled
            if reasoning_enabled is not None
            else self._config.reasoning_enabled
        )
        if not effective_reasoning:
            payload["reasoning"] = {"enabled": False, "effort": "none"}
        else:
            payload["reasoning"] = {"enabled": True}

        url = self._config.chat_completions_url
        headers = self._headers()
        # One total wall-clock budget shared by the (at most two) transport
        # attempts, so a retry can never double the operator's wait.
        deadline_at = time.monotonic() + self._config.deadline_seconds

        try:
            response = self._call_transport(url, headers, payload, deadline_at=deadline_at)
        except AiError:
            raise
        except Exception as exc:  # network / timeout / dns
            name = type(exc).__name__.lower()
            if "timeout" in name:
                raise AiError(TIMEOUT, user_message(TIMEOUT)) from exc
            raise AiError(PROVIDER_ERROR, user_message(PROVIDER_ERROR)) from exc

        status_code = getattr(response, "status_code", None)
        text = getattr(response, "text", "") or ""

        # Some free endpoints reject response_format or reasoning; retry once without them.
        needs_retry = False
        if json_mode and status_code == 400 and "response_format" in text:
            payload.pop("response_format", None)
            needs_retry = True
        if status_code == 400 and "reasoning" in text.lower():
            payload.pop("reasoning", None)
            needs_retry = True

        if needs_retry:
            try:
                response = self._call_transport(
                    url, headers, payload, deadline_at=deadline_at
                )
            except AiError:
                raise
            except Exception as exc:
                name = type(exc).__name__.lower()
                if "timeout" in name:
                    raise AiError(TIMEOUT, user_message(TIMEOUT)) from exc
                raise AiError(PROVIDER_ERROR, user_message(PROVIDER_ERROR)) from exc
            status_code = getattr(response, "status_code", None)
            text = getattr(response, "text", "") or ""

        if status_code != 200:
            raise self._classify_status(int(status_code or 0), text)

        try:
            body = response.json()
        except Exception:
            try:
                body = json.loads(text)
            except Exception as exc:
                raise AiError(MALFORMED, "Provider returned non-JSON content.") from exc

        return _extract_content(body)
