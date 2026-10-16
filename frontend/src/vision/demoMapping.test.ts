import { describe, expect, it } from "vitest";
import {
  DEMO_MAPPING_KIND,
  DEMO_MAPPING_STORAGE_KEY,
  clearDemoMapping,
  loadDemoMapping,
  parseDemoMapping,
  saveDemoMapping,
} from "./demoMapping";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe("demo camera mapping store", () => {
  it("round-trips using the canonical space identifier", () => {
    const s = memoryStorage();
    const saved = saveDemoMapping(
      {
        space_id: "space_3U1W8Xs6L9pRXU5Afk5MW1",
        ifc_global_id: "3U1W8Xs6L9pRXU5Afk5MW1",
        space_name: "114",
        storey_id: "storey_1mnZnZ29v9QRze4pjg0g3S",
        storey_name: "3. korrus",
      },
      s,
    );

    expect(saved?.kind).toBe(DEMO_MAPPING_KIND);
    expect(saved?.space_id).toBe("space_3U1W8Xs6L9pRXU5Afk5MW1");
    expect(saved?.note).toMatch(/NOT a verified physical camera installation/i);

    const loaded = loadDemoMapping(s);
    expect(loaded?.space_id).toBe("space_3U1W8Xs6L9pRXU5Afk5MW1");
    expect(loaded?.storey_id).toBe("storey_1mnZnZ29v9QRze4pjg0g3S");
    expect(loaded?.ifc_global_id).toBe("3U1W8Xs6L9pRXU5Afk5MW1");
  });

  it("accepts a minimal input and fills nulls for absent fields", () => {
    const s = memoryStorage();
    const saved = saveDemoMapping({ space_id: "space_x" }, s);
    expect(saved?.ifc_global_id).toBeNull();
    expect(saved?.space_name).toBeNull();
    expect(saved?.storey_id).toBeNull();
    expect(saved?.schema_version).toBe("campusiq.demo_camera_mapping/v1");
  });

  it("clears the association", () => {
    const s = memoryStorage();
    saveDemoMapping({ space_id: "space_x" }, s);
    expect(loadDemoMapping(s)).not.toBeNull();
    clearDemoMapping(s);
    expect(loadDemoMapping(s)).toBeNull();
    expect(s.getItem(DEMO_MAPPING_STORAGE_KEY)).toBeNull();
  });

  it("rejects malformed or legacy stored values", () => {
    expect(parseDemoMapping(null)).toBeNull();
    expect(parseDemoMapping("nope")).toBeNull();
    expect(parseDemoMapping({ space_id: "space_x" })).toBeNull(); // no kind
    expect(parseDemoMapping({ kind: "OTHER", space_id: "space_x" })).toBeNull();
    expect(parseDemoMapping({ kind: DEMO_MAPPING_KIND, space_id: "" })).toBeNull();

    const s = memoryStorage();
    s.setItem(DEMO_MAPPING_STORAGE_KEY, "{not json");
    expect(loadDemoMapping(s)).toBeNull();
  });

  it("never throws when storage is unavailable", () => {
    expect(loadDemoMapping(null)).toBeNull();
    expect(clearDemoMapping(null)).toBeUndefined();
    // save still returns the object so the in-memory state can update.
    const saved = saveDemoMapping({ space_id: "space_x" }, null);
    expect(saved?.space_id).toBe("space_x");
  });

  it("rejects an empty space_id", () => {
    const s = memoryStorage();
    expect(saveDemoMapping({ space_id: "" }, s)).toBeNull();
    expect(loadDemoMapping(s)).toBeNull();
  });
});
