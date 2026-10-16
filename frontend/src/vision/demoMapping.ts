// CV-2 — operator-configured demo camera→room association.
//
// This is a purely client-side, per-browser operator configuration. It is
// deliberately NOT written into any generated artefact under output/ (those are
// produced by the offline scripts) and NOT into the canonical
// output/sensor_space_mapping.json. It never claims to be a verified physical
// camera installation.
//
// Storage is keyed by the project's canonical space identifier:
//   space_id === "space_" + <IfcGlobalId>   (e.g. "space_3U1W8Xs6L9pRXU5Afk5MW1")
//
// The module is dependency-free and takes an injectable `Storage` so the
// honesty rules are unit-testable in isolation.

export const DEMO_MAPPING_STORAGE_KEY = "campusiq.demoCameraMapping/v1";
export const DEMO_MAPPING_SCHEMA_VERSION = "campusiq.demo_camera_mapping/v1";
export const DEMO_MAPPING_KIND = "DEMO_MAPPING";
export const DEMO_MAPPING_NOTE =
  "Operator-configured demo association only. NOT a verified physical camera " +
  "installation, and NOT evidence that any telemetry belongs to this room.";

export interface DemoCameraMapping {
  schema_version: string;
  kind: "DEMO_MAPPING";
  space_id: string;
  ifc_global_id: string | null;
  space_name: string | null;
  storey_id: string | null;
  storey_name: string | null;
  created_at: string;
  note: string;
}

/** What the picker supplies; the canonical fields are filled in here. */
export interface DemoSpaceInput {
  space_id: string;
  ifc_global_id?: string | null;
  space_name?: string | null;
  storey_id?: string | null;
  storey_name?: string | null;
}

function defaultStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Defensive parse: any malformed/legacy value resolves to `null`. */
export function parseDemoMapping(raw: unknown): DemoCameraMapping | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.kind !== DEMO_MAPPING_KIND) return null;
  if (typeof o.space_id !== "string" || o.space_id.length === 0) return null;
  return {
    schema_version:
      typeof o.schema_version === "string"
        ? o.schema_version
        : DEMO_MAPPING_SCHEMA_VERSION,
    kind: DEMO_MAPPING_KIND,
    space_id: o.space_id,
    ifc_global_id: typeof o.ifc_global_id === "string" ? o.ifc_global_id : null,
    space_name: typeof o.space_name === "string" ? o.space_name : null,
    storey_id: typeof o.storey_id === "string" ? o.storey_id : null,
    storey_name: typeof o.storey_name === "string" ? o.storey_name : null,
    created_at: typeof o.created_at === "string" ? o.created_at : "",
    note: DEMO_MAPPING_NOTE,
  };
}

export function loadDemoMapping(storage: Storage | null = defaultStorage()): DemoCameraMapping | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(DEMO_MAPPING_STORAGE_KEY);
    if (!raw) return null;
    return parseDemoMapping(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Persist an association. Returns the stored object, or null if unusable. */
export function saveDemoMapping(
  input: DemoSpaceInput,
  storage: Storage | null = defaultStorage(),
): DemoCameraMapping | null {
  if (!input || typeof input.space_id !== "string" || input.space_id.length === 0) {
    return null;
  }
  const mapping: DemoCameraMapping = {
    schema_version: DEMO_MAPPING_SCHEMA_VERSION,
    kind: DEMO_MAPPING_KIND,
    space_id: input.space_id,
    ifc_global_id: input.ifc_global_id ?? null,
    space_name: input.space_name ?? null,
    storey_id: input.storey_id ?? null,
    storey_name: input.storey_name ?? null,
    created_at: new Date().toISOString(),
    note: DEMO_MAPPING_NOTE,
  };
  if (storage) {
    try {
      storage.setItem(DEMO_MAPPING_STORAGE_KEY, JSON.stringify(mapping));
    } catch {
      // Quota/privacy failures must not break the UI.
    }
  }
  return mapping;
}

export function clearDemoMapping(storage: Storage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(DEMO_MAPPING_STORAGE_KEY);
  } catch {
    // ignore
  }
}
