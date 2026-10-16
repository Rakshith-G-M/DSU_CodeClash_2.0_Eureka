// Green Twin product API response types.
// These mirror the actual FastAPI response shapes (scripts/api_app.py). Do
// not invent fields; "unknown" states come back as null/missing from the API.

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

// GET /api/campus
export interface CampusSummary {
  campus: { campus_id: string | null; name: string | null };
  buildings: Array<{
    building_id: string;
    name: string;
    space_count: number;
    storey_ids: string[];
  }>;
  storeys: Array<{ storey_id: string; name: string | null; space_count: number }>;
  building_count: number;
  storey_count: number;
}

// GET /api/spaces
export interface SpaceListItem {
  space_id: string;
  ifc_global_id?: string | null;
  ifc_name?: string | null;
  ifc_long_name?: string | null;
  storey_name?: string | null;
  building_id: string | null;
  storey_id: string | null;
  area_m2: number | null;
  volume_m3: number | null;
  capacity_occupants: number | null;
  occupiable: boolean;
  conditioning: string | null;
}

// GET /api/resources
export interface ResourceSummary {
  building_count: number;
  space_count: number;
  storey_count: number;
  storey_count_registry: number;
  occupiable_count: number;
  total_area_m2: number;
  total_volume_m3: number;
  total_capacity_occupants: number;
  [key: string]: unknown;
}

export interface ResourceStateResponse {
  summary: ResourceSummary;
  availability?: {
    present: boolean;
    [key: string]: unknown;
  };
  design_metrics?: { metric_origin: string } | null;
  storeys?: Array<Record<string, unknown>>;
  items: Array<{
    space_id: string;
    area_m2: number | null;
    capacity_occupants: number | null;
    metric_origin: string | null;
  }>;
  total: number;
  limit: number;
  offset: number;
}

// GET /api/telemetry/summary
export interface TelemetrySummary {
  dataset: {
    devices: number;
    channels: number;
    total_readings: number;
    channels_by_type: Record<string, number>;
    time_span: { first: string; last: string } | null;
    [key: string]: unknown;
  };
  intelligence: {
    anomalies: {
      total_candidates: number;
      recorded_detail: number;
      channels_with_anomalies: number;
      by_severity: Record<string, number>;
      by_measurement_type: Record<string, number>;
      [key: string]: unknown;
    };
  };
  sensor_count: number;
  generated_at: string;
}

// GET /api/anomalies (slim projection)
export interface AnomalyItem {
  sensor_id: string;
  timestamp: string;
  measurement_type: string;
  unit: string | null;
  value: number | null;
  expected: number | null;
  deviation: number | null;
  score: number | null;
  severity: string | null;
  category: string | null;
  method: string | null;
  persistence: number | null;
  location_status: string | null;
}

// GET /api/forecasts
export interface ForecastItem {
  sensor_id: string;
  measurement_type: string;
  unit: string | null;
  as_of_timestamp: string;
  forecast_timestamp: string;
  horizon_hours: number;
  predicted_value: number | null;
  baseline_value: number | null;
  prediction_method: string;
  location_status: string | null;
  confidence_interval_95: unknown;
  coverage?: {
    confidence_intervals_calculated: boolean;
    recent_sample_count: number;
    seasonal_bucket_sample_count: number;
    seasonal_spread_estimate: number | null;
    total_history_samples: number;
  } | null;
}

// GET /api/decision-candidates
export interface DecisionCandidate {
  candidate_id: string;
  candidate_type: string;
  problem_type: string;
  source: string;
  severity: string;
  affected_entity: { type: string; sensor_id?: string; space_id?: string };
  proposed_action: string;
  reason: string;
  evidence: Record<string, unknown>;
  constraints: string[];
  location_status: string;
  location: { status: string; space_id: string | null };
  confidence: number | null;
}

// GET /api/recommendations and /api/recommendations/{id}
export interface Recommendation {
  recommendation_id: string;
  candidate_id: string;
  priority: string;
  priority_score: number;
  priority_factors: Record<string, number>;
  ranking: {
    priority_score: number;
    weights: Record<string, number>;
    factors: Record<string, number>;
    factor_basis: Record<string, string>;
    formula_version: string;
    explanation: string;
  };
  recommendation_category: string;
  problem_type: string;
  source: string;
  affected_entity: { type: string; sensor_id?: string; space_id?: string };
  location_status: string;
  location: { status: string; space_id: string | null };
  recommended_action: string;
  reason: string;
  evidence: Record<string, unknown>;
  evidence_chain: Array<{
    step: string;
    entity: string | null;
    value: unknown;
    note: string;
  }>;
  constraints: string[];
  expected_impact: Array<{
    type: string;
    value: number | null;
    unit: string | null;
    status: string;
    method: string | null;
    reason: string;
  }>;
  confidence: { value: number | null; basis: string };
  data_quality: Record<string, unknown>;
}

export interface RecommendationsResponse extends Page<Recommendation> {
  generated_at: string;
  data_status: { sensor_location_mapping: string };
}

// GET /api/health
export interface HealthItem {
  sensor_id: string;
  health_status: string;
  coverage_fraction: number | null;
  missing_ratio: number | null;
  valid_readings: number | null;
  missing_readings: number | null;
  issues: Array<{ type: string; max_severity?: string }>;
}

export interface HealthResponse extends Page<HealthItem> {
  summary?: {
    devices?: number;
    healthy?: number;
    degraded?: number;
    overall?: string;
    [key: string]: unknown;
  };
}

// GET /api/spaces/{space_id}/bim-design
export interface BimDesignResponse {
  space_id: string;
  origin: "IFC_DESIGN";
  measured: false;
  note: string;
  space: {
    ifc_name: string | null;
    storey_id: string | null;
    area_m2: number | null;
    volume_m3: number | null;
    height_m: number | null;
    capacity_occupants: number | null;
    occupiable: boolean | null;
  };
  design: Record<string, number>;
  conditioning: string | null;
}

// GET /api/dashboard/summary
export interface DashboardSummary {
  campus: {
    campus_id: string | null;
    campus_name?: string | null;
    building_count: number;
    storey_count: number | null;
    space_count: number | null;
  };
  telemetry: {
    sensor_count: number | null;
    channel_count: number | null;
    total_readings: number | null;
    channels_by_type: Record<string, number> | null;
    time_span: { first: string; last: string } | null;
  };
  anomalies: {
    channels_with_anomalies: number | null;
    by_severity: Record<string, number>;
    high_critical_total: number;
  };
  decision_candidates: {
    total: number | null;
    by_severity: Record<string, number>;
    high_critical_total: number;
  };
  sensor_health: {
    devices: number | null;
    healthy: number | null;
    degraded: number | null;
    status: string | null;
  };
  forecasts: {
    channels_forecasted: number | null;
    channels_total: number | null;
    available: boolean;
  };
  recommendations: {
    total: number | null;
    by_priority: Record<string, number>;
  };
  mapping: {
    total: number | null;
    resolved: number | null;
    confirmed: number | null;
    provisional: number | null;
    unresolved: number | null;
    verified_locations: number | null;
    status: string;
  };
  data_status: {
    sensor_location_mapping: string;
    availability_present: boolean;
    measured_energy_available: boolean;
    recommendation_records: number | null;
  };
  generated_at: string;
}

// ── Replay / Simulation Types ──────────────────────────────────────────────────

export interface ReplayStatus {
  running: boolean;
  speed: number;
  sim_timestamp: string;
  readings_replayed: number;
  anomalies_detected: number;
  channels_active: number;
}

export interface ReplayChannel {
  sensor_id: string;
  measurement_type: string;
  unit: string;
  value: number;
  timestamp: string;
  baseline_mean?: number | null;
  baseline_std?: number | null;
  z_score?: number | null;
  severity?: "WARN" | "HIGH" | "CRITICAL" | null;
  location_status: string;
}

export interface ReplayState {
  sim_timestamp: string;
  running: boolean;
  speed: number;
  readings_replayed: number;
  anomalies_detected: number;
  channels: ReplayChannel[];
  summaries: Record<string, { count: number; mean: number; min: number; max: number }>;
  active_anomalies: ReplayChannel[];
  location_note: string;
}

export interface ReplayHistoryItem {
  ts: string;
  value: number;
}

export interface ReplayHistoryResponse {
  sensor_id: string;
  measurement_type: string;
  count: number;
  history: ReplayHistoryItem[];
}

// ── Generative AI (OpenRouter) Types ───────────────────────────────────────────
// Mirror the backend AiResponse envelope (scripts/ai_schemas.py). The backend
// never returns the API key; these shapes contain only validated model content.

export type AiStatus =
  | "OK"
  | "NOT_CONFIGURED"
  | "RATE_LIMITED"
  | "QUOTA_EXHAUSTED"
  | "TIMEOUT"
  | "PROVIDER_ERROR"
  | "MALFORMED"
  | "INVALID_INPUT";

export type AiProvenanceKind =
  | "VERIFIED_SENSOR"
  | "WEBCAM_ESTIMATE"
  | "SAMPLE_SIMULATION"
  | "HISTORICAL_REPLAY"
  | "IFC_DESIGN"
  | "PREDICTION"
  | "RULE_BASED"
  | "UNAVAILABLE";

export type AiImpactStatus =
  | "MEASURED"
  | "CALCULATED"
  | "ESTIMATED"
  | "QUALITATIVE"
  | "UNKNOWN";

export interface AiEvidence {
  claim: string;
  source: string;
  value: string | null;
  provenance: AiProvenanceKind;
  reference: string | null;
}

// A likely cause is explicitly a hypothesis unless a diagnostic test confirms
// it. The backend downgrades any unverified "CONFIRMED" cause, so the UI can
// present these without ever implying a proven root cause.
export type AiCauseStatus = "CONFIRMED" | "HYPOTHESIS" | "UNKNOWN";

export interface AiLikelyCause {
  cause: string;
  basis: string;
  status: AiCauseStatus;
  confidence: string | null;
}

export interface AiRecommendation {
  title: string;
  opportunity: string;
  evidence: string;
  action: string;
  expected_impact_direction: string;
  assumptions: string;
  limitations: string;
  impact_status: AiImpactStatus;
  /** Ordering hint: HIGH | MEDIUM | LOW, or "" when unknown. */
  priority?: string;
  /** The affected component / space the action targets. */
  component?: string;
  /** Concise reason this action relates to the finding. */
  why_relevant?: string;
  /** How the operator can verify the issue is resolved. */
  verification?: string;
  /** Self-reported confidence in this action: HIGH | MEDIUM | LOW | UNKNOWN. */
  confidence?: string;
}

export interface AiProvenance {
  data_freshness: string;
  sources: string[];
  is_hypothetical: boolean;
  model: string | null;
}

export interface AiRoomStatus {
  space_id: string;
  level: "UNKNOWN" | "NORMAL" | "WARNING" | "OVER_CAPACITY" | "CRITICAL";
  occupancy_level: string | null;
  occupancy_count: number | null;
  capacity: number | null;
  capacity_source: string | null;
  occupancy_source: string | null;
  occupancy_is_demo: boolean;
  occupancy_stale: boolean;
  issue_present: boolean;
  issue_severity: string | null;
  issue_count: number;
  note: string;
}

// The room-state version an analysis was computed from (backend `AiBasedOn`).
// `state_version` echoes the client fingerprint so the UI can mark an analysis
// stale when the room state has since changed.
export interface AiBasedOn {
  space_id: string | null;
  state_version: string | null;
  trigger: string | null;
  occupancy_count: number | null;
  occupancy_timestamp: string | null;
  occupancy_source: string | null;
  occupancy_is_demo: boolean;
  occupancy_stale: boolean;
  status_level: string | null;
  generated_at: string;
}

export interface AiContextSummary {
  scope: "BUILDING" | "ROOM" | "FINDING";
  space_id: string | null;
  storey_id: string | null;
  finding_id?: string | null;
  sensor_location_mapping: string;
  mapped_sensors: number;
  total_sensors: number;
  measured_energy_available: boolean;
  historical_replay: boolean;
  has_webcam_occupancy: boolean;
  room_telemetry_available: boolean;
  data_sources: string[];
}

export interface AiResponse {
  status: AiStatus;
  provider: string;
  model: string | null;
  message: string | null;
  answer: string | null;
  evidence: AiEvidence[];
  likely_causes?: AiLikelyCause[];
  recommendations: AiRecommendation[];
  next_checks?: string[];
  assumptions: string[];
  limitations: string[];
  provenance: AiProvenance;
  deterministic_status: AiRoomStatus | null;
  context: AiContextSummary | null;
  finding_id?: string | null;
  /** The room-state version the analysis was computed from (room analysis). */
  based_on?: AiBasedOn | null;
  generated_at: string;
}

// Minimal camera-observation payload sent with a room analysis. A camera is
// only ever attached to the room it is explicitly associated with.
export interface AiObservationInput {
  count: number | null;
  source: string | null;
  timestamp: string | null;
  space_id: string | null;
  mapping_kind: string | null;
}

// One turn of the issue-scoped follow-up conversation. Answers stay bound to
// the finding they were asked about; the backend bounds and sanitises the list.
export interface AiConversationTurn {
  role: "user" | "assistant";
  content: string;
}