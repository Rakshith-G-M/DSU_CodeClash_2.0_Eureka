# Green Twin — Generative AI Integration

Milestone scope: introduce a **grounded generative-AI layer** (OpenRouter →
NVIDIA Nemotron 3.5 Lightning, `nvidia/nemotron-3.5-lightning:free`) that is
embedded directly in the diagnostic workflow. Opening a finding in
**Sustainability Insights** automatically produces an *AI Analysis & Recommended
Actions* section for that finding, with issue-scoped follow-up questions —
without ever letting the model invent data or change building state.

There is **no floating chatbot**. The GenAI surface lives inside the existing
finding detail page (`RecDetail`), so the operator never re-states the problem in
a separate window and there is only ever one assistant interface.

Owner: The Commit Crew · Status: implemented, unit-tested with a mocked provider
· **not yet exercised against the live OpenRouter API** (a `.env` may exist, but
this tooling never reads or prints it — see [Verifying a live call](#verifying-a-live-call)).

---

## 1. What was added

| Area | Files |
| --- | --- |
| Config | `scripts/ai_config.py`, `.env.example` |
| Provider client | `scripts/ai_openrouter.py` |
| Response schema + guards | `scripts/ai_schemas.py` |
| Grounding context | `scripts/building_context.py`, `scripts/room_status.py` |
| Orchestration + prompt | `scripts/ai_service.py` |
| API | `scripts/api_app.py` (`/api/ai/*`) |
| Tests | `tests/test_ai_service.py` (32 mocked tests), `tests/test_ai_finding.py` (33 mocked tests) |
| UI | `frontend/src/ai/FindingAnalysis.tsx`, `frontend/src/ai/presentation.ts`, `pages/RecDetail.tsx`, `pages/intelligenceTabs.tsx`, `pages/Intelligence.tsx` |

**No existing functionality was replaced or deleted.** The rule-based
recommendation engine remains the deterministic fallback and audit trail.

---

## 2. Configuration

The key lives **only on the backend**. It is never bundled into the frontend,
never returned by an endpoint, and never logged.

```bash
cp .env.example .env          # placeholders only — fill in the real key
# .env is git-ignored; an existing .env is never overwritten by the app
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | *(empty)* | Enables the assistant. Empty ⇒ `NOT_CONFIGURED`. |
| `OPENROUTER_MODEL` | `nvidia/nemotron-3.5-lightning:free` | Model id. Configurable, never silently swapped for another provider. |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenAI-compatible Chat Completions base. |
| `OPENROUTER_REFERER` | *(empty)* | Optional OpenRouter attribution header. |
| `OPENROUTER_TITLE` | `Green Twin` | Optional OpenRouter attribution header. |
| `OPENROUTER_TIMEOUT` | `30` | Per-phase (connect/read/write) network timeout in seconds. |
| `OPENROUTER_DEADLINE` | `90` | Total wall-clock deadline in seconds for one request, across all transport attempts. Bounds the worst case even when a slow endpoint trickles bytes. Clamped up to `OPENROUTER_TIMEOUT` when set lower. |

`ai_config.load_env_files()` is a dependency-free `.env` reader: it **only fills
variables that are not already set**, never writes to disk, and therefore can
never clobber a real `.env` or a real environment.

No credit purchase, paid tier or billing change is required or performed by the
codebase.

---

## 3. Architecture

```
browser (React)                       backend (FastAPI)
────────────────                      ─────────────────
RecDetail — "AI Analysis &            AiService
  Recommended Actions"  ──POST──▶      1. resolve the finding from the datapack
  (one finding, auto-analysis)         2. build_finding_context() ← real artefacts
  + issue-scoped follow-up             3. determinism: symptoms, intervals, gaps
     POST /api/ai/finding       ◀──    4. prompt + Chat Completions
                              AiResponse 5. parse + guard + validate (Pydantic)
                                         6. strip anything unsafe
```

* `ai_openrouter.py` uses `httpx` directly with an **injectable transport
  callable** `(url, headers, payload, timeout) -> response-like`. Tests pass a
  fake transport, so the suite never opens a network connection.
* `building_context.py` is pure: `build_finding_context()` summarises one
  diagnostic finding — its detected symptoms, per-channel interval statistics,
  related findings and the sensor→room mapping status. It sends a **compact
  summary, never a raw telemetry dump or CSV**.
* `room_status.py` is the backend mirror of the frontend
  `lib/roomStatus.ts` precedence (`NORMAL < UNKNOWN < WARNING < OVER_CAPACITY <
  CRITICAL`). The model is *told* the status; it can never compute or override
  it.

### Response envelope (`AiResponse`)

`status` · `provider` · `model` · `message` · `answer` · `evidence[]` ·
`recommendations[]` · `assumptions[]` · `limitations[]` · `provenance` ·
`deterministic_status` · `context` · `generated_at`.

Separating these fields is the honesty contract: evidence, assumptions,
limitations and data freshness are never blended into prose.

---

## 4. Capabilities

| # | Capability | Endpoint |
| --- | --- | --- |
| ★ | **Issue-scoped analysis + follow-ups** (the UI's entry point) | `POST /api/ai/finding` |
| A | Natural-language building assistant (capability retained) | `POST /api/ai/assistant` |
| B | Evidence-grounded sustainability recommendations | `POST /api/ai/recommendations` |
| C | Explain the *actual* deterministic room status | `POST /api/ai/explain-status` |
| D | Finding / room vs building-overview context | all of the above |
| E | Conversational what-if with explicit assumptions | `POST /api/ai/assistant` (`provenance.is_hypothetical`) |
| — | Non-secret configuration status | `GET /api/ai/status` |

### `POST /api/ai/finding` — the integrated entry point

```jsonc
{ "finding_id": "R-0001",       // required — the ONLY id the client sends
  "question": "…",              // optional: absent ⇒ full analysis, present ⇒ follow-up
  "history": [ {"role": "...", "content": "..."} ] }   // capped at 8 turns / 4000 chars
```

The finding is **resolved server-side from the datapack** (recommendation record,
sensor-health channel profile, interval statistics), so the client never ships
measurements and the model can only reason over evidence the backend already
holds. The response adds `likely_causes[]` (each with `status`:
`CONFIRMED` / `HYPOTHESIS` / `UNKNOWN`, plus `confidence` and `basis`),
`next_checks[]`, and per-recommendation `priority` / `component` /
`why_relevant` / `verification`.

### Data-integrity categories

Every evidence item carries one of:
`VERIFIED_SENSOR`, `WEBCAM_ESTIMATE`, `SAMPLE_SIMULATION`, `HISTORICAL_REPLAY`,
`IFC_DESIGN`, `PREDICTION`, `RULE_BASED`, `UNAVAILABLE`. The UI renders the
label next to every claim, so a replay is never read as live and an IFC design
value is never read as a measurement.

### Hard rules enforced in code (not just in the prompt)

* `guard_unverified_claims()` downgrades any numeric savings/euro/kWh claim to
  `impact_status = UNKNOWN` and appends an explicit limitation.
* `guard_unconfirmed_causes()` downgrades any cause the model labels `CONFIRMED`
  to `HYPOTHESIS` unless the backend's own determinism checks confirm it — the
  model can never declare a root cause as fact. Likely causes are rendered
  distinctly from confirmed findings.
* `parse_structured()` extracts the JSON object with balanced-brace scanning and
  Pydantic-validates it; unparseable output becomes `MALFORMED`, never rendered.
* `ai_openrouter.py` retries once without `response_format` if the provider
  rejects structured output (HTTP 400) on the free tier.
* Missing key, rate limit, quota exhaustion, timeout, provider 5xx and malformed
  content all map to distinct `status` codes with user-friendly text.
* An unmapped sensor or observation is **never attributed to a room**: the
  context carries `sensor_location_mapping` and the UI shows a
  "Sensor-to-room mapping unresolved" chip rather than guessing a space.

### The model can never change building state

The AI layer is read-only. It cannot modify room status, occupancy, IFC
geometry, telemetry, the replay clock or any operational system. There is no
HVAC / lighting / access-control actuation path anywhere in the integration.

---

## 5. Deterministic components that must remain

The GenAI layer is an *addition* on the diagnostic page; it does not remove the
deterministic engine. Consumer analysis before/after:

| Deterministic component | Consumers | Status |
| --- | --- | --- |
| `lib/roomStatus.ts` (status precedence, mesh colour, staleness, capacity = IFC design) | `TwinViewer`, `DigitalTwin`, `BimSpacePanel`, `Vision` | **Unchanged — source of truth.** |
| `scripts/room_status.py` (backend mirror) | `ai_service.explain_status`, context | New, mirrors the above; does not replace it. |
| `recommendation_engine.build_dashboard_summary` | `GET /api/dashboard/summary` (Overview) | **Kept** — imported by `api_app.py`. |
| `recommendation_engine` recommendation records | `GET /api/recommendations` → Intelligence **Recommendations** list, `DigitalTwin` (room issue association), `BimSpacePanel`, `Overview` featured actions, `RecDetail` | **Kept** — still the data behind room-status issue association, the list view and the `?rec=` deep link. |
| `decision_engine`, `decision_intelligence` | `GET /api/decision-candidates` (Decision Log), `recommendation_engine` | **Kept** (also the previous allocation-removal scope). |
| Telemetry validation / baseline / anomaly / health / forecast | Intelligence tabs, dashboard, AI grounding | **Kept**. |
| Shared data validation + `output/*.json` artifacts | everything | **Kept**. |

Why nothing was deleted: every rule-based module still has at least one live
dependent. `recommendation_engine.build_dashboard_summary` powers the Overview;
the `/api/recommendations` list still supplies the room-issue inputs that decide
the 3D room colours and still backs the `?rec=` deep link. Deleting it would
remove working functionality, which the milestone forbids. The rule-based path is
therefore retained as the deterministic source of truth; the AI layer only
*interprets* a single finding on top of it and can never replace or mutate it.

### Transition: what actually changed in the UI

* **The floating chatbot was removed.** `Assistant.tsx`, `AiProvider.tsx`,
  `aiContext.ts`, `observation.ts` and `AiResponseView.tsx` are gone, along with
  the header "AI Assistant" button, the floating launcher, the slide-over panel,
  the Digital Twin assistant wiring and the per-room "Explain this room's status"
  button. The now-dead client wrappers (`aiStatus`, `aiAssistant`,
  `aiRecommendations`, `aiExplainStatus`) were removed after confirming no other
  consumers.
* **Intelligence → Recommendations** (tab key `recommendations`, unchanged so
  deep links keep working) renders the **deterministic rule-based list only** —
  the same audit trail as before. It is *not* an AI surface, so there is exactly
  one GenAI interface in the product.
* **`?rec=<id>`** still opens `RecDetail` exactly as before.
* **The GenAI surface now lives on `RecDetail`**: `<FindingAnalysis
  key={finding_id} />` is rendered between the diagnostic content and the
  collapsed "Evidence Traceability Chain" / "Technical Diagnostic Details"
  sections. It auto-analyses the opened finding.
* Everything else — 3D rendering, floor navigation, room selection/status,
  telemetry replay, occupancy, Vision — was left untouched.

---

## 6. Frontend integration

`frontend/src/ai/FindingAnalysis.tsx` is the only GenAI surface. It uses the
existing Green Twin design tokens and sits inline in the diagnostic page — it is
**not** an embedded third-party chatbot.

* **Automatic analysis.** Opening a finding POSTs `{finding_id}` once; the
  operator never re-types the problem. The section renders, in order:
  * a **plain-language diagnosis** (`answer`),
  * **supporting evidence** with a provenance chip on every row
    (`Verified sensor`, `Webcam estimate`, `Historical replay`, `IFC design spec`,
    `Sample / simulated`, `Rule-based`, `Not available`),
  * **likely causes**, each badged `Hypothesis — to verify` (or `Confirmed by
    data`) with its `basis` — hypotheses are visually and textually distinct from
    confirmed facts,
  * **recommended actions ordered by priority**, each with the affected
    component, the action, *Why:* (`why_relevant`) and *Verify:*
    (`verification`), plus an impact badge (`Measured outcome` … `Unknown — not
    verified`),
  * **what to inspect or measure next** (`next_checks`),
  * **expected impact** — only when a recommendation's `impact_status` is data
    supported; otherwise it states plainly that the available data does not
    support a quantified impact,
  * **limitations & missing evidence** and explicit assumptions,
  * a context chip row (scope + sensor-to-room mapping status).
* **Issue-scoped follow-ups.** A compact textarea plus five suggested questions
  sit at the bottom. Enter submits (Shift+Enter inserts a newline), the send
  button is disabled while empty or in flight, and the conversation is sent with
  `history` so answers stay bound to *this* finding.
* **No cross-issue leakage.** The parent mounts it with
  `key={finding_id}`, so switching findings remounts the section: analysis,
  thread, draft and pending state all reset.
* **States are explicit:** `finding-analysis-loading`,
  `finding-analysis-error` + `finding-retry`, `finding-analysis-unavailable`
  (missing key / rate limit / timeout / quota / provider / malformed, naming
  `OPENROUTER_API_KEY` as the fix and never echoing a secret),
  `finding-analysis-empty` (an empty model response is refused, never
  fabricated), and per-question `finding-followup-error` with its own retry. The
  rest of the app stays usable when AI is down.
* **Advisory only.** No control in the section can change occupancy, room
  status, IFC geometry, sensor mappings or measured values — there is no
  execution path behind it.

---

## 7. Failure handling

| Situation | Behaviour |
| --- | --- |
| No key | `status = NOT_CONFIGURED`, HTTP 200, UI banner explains how to configure. |
| Rate limit (429) | `RATE_LIMITED` + retry copy. |
| Quota exhausted (402) | `QUOTA_EXHAUSTED`. |
| Timeout | `TIMEOUT` — a stalled transfer is abandoned at the per-phase `OPENROUTER_TIMEOUT`, and the whole request is abandoned at the total `OPENROUTER_DEADLINE`. |
| Provider 5xx / network | `PROVIDER_ERROR`. |
| Unparseable / invalid model output | `MALFORMED` — nothing shown. |
| Oversized input | `422` from FastAPI (`max_length` guards). |

Non-OK failures return **HTTP 200 with a `status` field** so the UI can branch
cleanly; only genuine request-validation errors use 4xx. Error text never
contains secrets, and stack traces are never surfaced.

---

## 8. Testing

```bash
# backend — includes 32 + 33 AI tests, all mocked (no network, no charges)
python3 -m pytest tests/ -q          # 186 passed

# frontend
cd frontend
npx vitest run                       # 150 passed, 20 files
npx tsc --noEmit                     # 0 errors
npm run lint                         # 0 errors (6 pre-existing warnings)
npm run build                        # succeeds
```

Frontend AI coverage: `src/ai/FindingAnalysis.test.tsx`,
`src/ai/presentation.test.ts`, `src/ai/noSecrets.test.ts`,
`src/pages/IntelligenceRecommendations.test.tsx`.

`FindingAnalysis.test.tsx` asserts, against a fully mocked provider: the
automatic analysis of a selected finding (one POST carrying only `finding_id`),
follow-ups retaining the issue context via `history`, switching findings
resetting the conversation with no leakage of the previous issue's text,
provider success, an empty model response refused rather than fabricated,
authentication failure, missing key (message names `OPENROUTER_API_KEY`, never
echoes `sk-or-v1`/`Bearer`), timeout + retry that actually re-requests, rate
limiting, network failure, unverified sensor→room mapping shown as unresolved
(no room claim), replay provenance chips, unsupported savings claims presented
as `Unknown — not verified`, duplicate submissions disabled while in flight,
and the five suggested follow-up questions. `IntelligenceRecommendations.test.tsx`
asserts the deterministic list is restored, that the old advisor surfaces
(`ai-advisor`, `advisor-*`) are gone, that `?rec=` still opens the detail page,
and that no floating chatbot entry points remain.

**Mocked vs live.** The entire suite runs against fake transports; it never
calls OpenRouter and therefore verifies integration, validation, refusal
behaviour and the honesty guards — but *not* the live model's answer quality.

### Verifying a live call

A live call was not performed in this environment (a `.env` exists but was never
read or printed by the tooling). To confirm the live path:

```bash
export OPENROUTER_API_KEY=sk-or-...        # your own free key
cd scripts && uvicorn api_app:app --port 8000   # restart after editing .env —
                                                # AiService reads config once
curl -s localhost:8000/api/ai/status
curl -s -X POST localhost:8000/api/ai/finding \
  -H 'Content-Type: application/json' \
  -d '{"finding_id":"R-0001"}' | head -c 800
```

Expected: `configured: true` and a JSON envelope whose `provenance.sources`
cite `output/*` artefacts. A live run is a manual, un-billed-by-us action using
the operator's own free key.

---

## 9. Known limitations

* The live provider call is unverified in this environment (see above).
* `sensor_location_mapping` is `UNRESOLVED` (0 of 36 sensors resolve to rooms),
  so the assistant correctly reports room-level telemetry as unavailable rather
  than guessing an attribution.
* `measured_energy_available` is `false` in the current dataset, so no energy or
  carbon savings can be claimed — recommendations carry
  `impact_status = UNKNOWN` with stated limitations.
* Demo webcam occupancy is an **estimate with a demo association**, consistently
  labelled as such; it is never presented as verified CCTV.
* Every one of the 36 sensors is currently `DEGRADED` with
  `UNKNOWN_LOCATION`, so the example finding (`R-0001`) yields hypotheses
  (power/connectivity, comms failure, calibration, data-ingestion health) that
  are explicitly marked `Hypothesis — to verify` — the data supports no confirmed
  root cause.
* Visual inspection of the rendered page was not possible in this session (no
  desktop browser attached), so layout/responsive behaviour is covered only by
  DOM-level tests and design-token usage, not by a pixel review.
