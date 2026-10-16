"""Green Twin — Generative AI configuration (OpenRouter).

Central place for reading the AI provider configuration from the environment.
No secret is ever logged, returned, or embedded in the frontend: the API key is
read here and used only by the backend inference client.

A minimal, dependency-free `.env` loader is included so the operator can drop
`.env.example` -> `.env` without installing python-dotenv. Real environment
variables always win over `.env` values, and an existing real `.env` is never
modified.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# OpenRouter defaults. The free NVIDIA Nemotron endpoint is the default model;
# it can be overridden but is never silently swapped for a different provider.
DEFAULT_MODEL = "nvidia/nemotron-3.5-lightning:free"
DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"
# Per-phase network timeout (connect / read / write / pool) passed to httpx.
DEFAULT_TIMEOUT_SECONDS = 30.0
# Total wall-clock budget for ONE inference request, across every transport
# attempt. A trickling response (or a queued free endpoint) can exceed the
# per-phase read timeout without ever going idle long enough to trip it, so a
# hard total deadline bounds the worst case the operator can be left waiting.
# 90 s sits above the slowest *successful* free-tier response we measured
# (~88 s) while still cutting the pathological trickle (~125 s) off.
DEFAULT_DEADLINE_SECONDS = 90.0
DEFAULT_TITLE = "Green Twin"

# Output-token budget for one completion. This covers BOTH the model's hidden
# reasoning and the visible JSON answer, so it must be large enough to hold the
# structured response after thinking.
DEFAULT_MAX_TOKENS = 2048
MIN_MAX_TOKENS = 64
MAX_MAX_TOKENS = 32000

# Hidden-reasoning models (e.g. the default Nemotron endpoint) will otherwise
# spend the WHOLE output budget "thinking" and return an empty message with
# finish_reason="length". Reasoning is therefore disabled by default so the
# answer budget is actually available to the answer. It can be re-enabled with
# OPENROUTER_REASONING=1 for models/operators that want it.
DEFAULT_REASONING_ENABLED = False

# Input-size guards (validated before any inference request is made).
MAX_QUESTION_CHARS = 2000
MAX_FOCUS_CHARS = 300
MAX_CONTEXT_SPACES = 8

_ENV_FILES = [
    os.path.join(BASE_DIR, ".env"),
    os.path.join(BASE_DIR, "scripts", ".env"),
]


def _parse_env_line(line: str) -> tuple[str, str] | None:
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        return None
    if line.startswith("export "):
        line = line[len("export ") :]
    key, _, value = line.partition("=")
    key = key.strip()
    value = value.strip().strip('"').strip("'")
    if not key:
        return None
    return key, value


def load_env_files(paths: list[str] | None = None) -> int:
    """Load simple KEY=VALUE pairs from `.env` files without overwriting real
    environment variables. Returns the number of values applied.

    Never writes to disk, so an existing `.env` is preserved untouched.
    """
    applied = 0
    for path in paths if paths is not None else _ENV_FILES:
        if not os.path.isfile(path):
            continue
        try:
            with open(path, encoding="utf-8") as fh:
                for line in fh:
                    parsed = _parse_env_line(line)
                    if parsed is None:
                        continue
                    key, value = parsed
                    if key not in os.environ and value:
                        os.environ[key] = value
                        applied += 1
        except OSError:
            continue
    return applied


@dataclass(frozen=True)
class AiConfig:
    """Resolved AI provider configuration (never serialized to clients)."""

    api_key: str | None = None
    model: str = DEFAULT_MODEL
    base_url: str = DEFAULT_BASE_URL
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS
    deadline_seconds: float = DEFAULT_DEADLINE_SECONDS
    referer: str | None = None
    title: str = DEFAULT_TITLE
    max_tokens: int = DEFAULT_MAX_TOKENS
    reasoning_enabled: bool = DEFAULT_REASONING_ENABLED
    extra: dict = field(default_factory=dict)

    @property
    def configured(self) -> bool:
        return bool(self.api_key and self.api_key.strip())

    @property
    def chat_completions_url(self) -> str:
        return f"{self.base_url.rstrip('/')}/chat/completions"

    @property
    def base_host(self) -> str:
        """Host only — safe to expose; never the key."""
        try:
            from urllib.parse import urlparse

            return urlparse(self.base_url).hostname or ""
        except Exception:  # pragma: no cover - defensive
            return ""

    def public_status(self) -> dict:
        """Non-secret configuration view for GET /api/ai/status."""
        return {
            "configured": self.configured,
            "provider": "openrouter",
            "model": self.model,
            "base_host": self.base_host,
        }


def _float_env(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def _float_from(env: dict, name: str, default: float) -> float:
    """Like ``_float_env`` but reads from the resolved env mapping (so tests can
    inject OPENROUTER_TIMEOUT / OPENROUTER_DEADLINE without touching os.environ)."""
    raw = env.get(name)
    if raw is None or not str(raw).strip():
        return default
    try:
        value = float(str(raw).strip())
    except ValueError:
        return default
    return value if value > 0 else default


def _int_env(name: str, default: int, lo: int, hi: int, env: dict | None = None) -> int:
    raw = (env if env is not None else os.environ).get(name)
    if raw is None or not str(raw).strip():
        return default
    try:
        value = int(float(str(raw).strip()))
    except ValueError:
        return default
    return max(lo, min(hi, value))


def _bool_env(name: str, default: bool, env: dict | None = None) -> bool:
    raw = (env if env is not None else os.environ).get(name)
    if raw is None or not str(raw).strip():
        return default
    return str(raw).strip().lower() in ("1", "true", "yes", "on")


def load_config(env: dict | None = None, *, load_files: bool = True) -> AiConfig:
    """Build the AI config from the environment.

    `env` allows tests to inject a mapping without touching os.environ.
    """
    if env is None:
        if load_files:
            load_env_files()
        env = os.environ

    key = (env.get("OPENROUTER_API_KEY") or "").strip() or None
    model = (env.get("OPENROUTER_MODEL") or "").strip() or DEFAULT_MODEL
    base_url = (env.get("OPENROUTER_BASE_URL") or "").strip() or DEFAULT_BASE_URL
    referer = (env.get("OPENROUTER_REFERER") or "").strip() or None
    title = (env.get("OPENROUTER_TITLE") or "").strip() or DEFAULT_TITLE
    timeout = _float_from(env, "OPENROUTER_TIMEOUT", DEFAULT_TIMEOUT_SECONDS)
    deadline = _float_from(env, "OPENROUTER_DEADLINE", DEFAULT_DEADLINE_SECONDS)
    # A total deadline below the per-phase timeout is pointless (the phase
    # timeout would fire first); keep it at least the per-phase value.
    if deadline < timeout:
        deadline = timeout

    # `env` may be an injected mapping (tests); read the token/reasoning knobs
    # from it when provided so tests never touch os.environ.
    if env is os.environ:
        max_tokens = _int_env(
            "OPENROUTER_MAX_TOKENS", DEFAULT_MAX_TOKENS, MIN_MAX_TOKENS, MAX_MAX_TOKENS
        )
        reasoning_enabled = _bool_env(
            "OPENROUTER_REASONING", DEFAULT_REASONING_ENABLED
        )
    else:
        raw_tokens = (env.get("OPENROUTER_MAX_TOKENS") or "").strip()
        try:
            max_tokens = int(float(raw_tokens)) if raw_tokens else DEFAULT_MAX_TOKENS
        except ValueError:
            max_tokens = DEFAULT_MAX_TOKENS
        max_tokens = max(MIN_MAX_TOKENS, min(MAX_MAX_TOKENS, max_tokens))
        raw_reasoning = (env.get("OPENROUTER_REASONING") or "").strip().lower()
        reasoning_enabled = (
            raw_reasoning in ("1", "true", "yes", "on")
            if raw_reasoning
            else DEFAULT_REASONING_ENABLED
        )

    return AiConfig(
        api_key=key,
        model=model,
        base_url=base_url,
        timeout_seconds=timeout,
        deadline_seconds=deadline,
        referer=referer,
        title=title,
        max_tokens=max_tokens,
        reasoning_enabled=reasoning_enabled,
    )
