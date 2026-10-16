// Guard: the OpenRouter API key must never exist in frontend code.
//
// The key is backend-only (scripts/ai_config.py). This test scans the entire
// frontend source tree for anything that could smuggle a secret into the
// browser bundle: env reads for provider credentials, hardcoded key literals,
// or Authorization headers pointing at the provider.
//
// Sources are loaded through Vite's `?raw` glob so the test itself never needs
// filesystem or Node types.

import { describe, expect, it } from "vitest";

const RAW_SOURCES = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Relative paths of production source files (tests themselves excluded). */
const FILES = Object.entries(RAW_SOURCES)
  .filter(([path]) => !path.includes(".test.") && !path.endsWith(".d.ts"))
  .map(([path, contents]) => ({ path, contents }));

describe("no secrets reach the browser bundle", () => {
  it("scans the whole source tree, including the API client and AI modules", () => {
    expect(FILES.length).toBeGreaterThan(40);
    const paths = FILES.map((f) => f.path);
    expect(paths.some((p) => p.endsWith("api/client.ts"))).toBe(true);
    expect(paths.some((p) => p.endsWith("FindingAnalysis.tsx"))).toBe(true);
  });

  it("never reads a provider credential from the environment", () => {
    const offenders = FILES.filter(({ contents }) =>
      /import\.meta\.env\.[A-Z0-9_]*(KEY|SECRET|TOKEN)/.test(contents) ||
      /process\.env\.[A-Z0-9_]*(KEY|SECRET|TOKEN)/.test(contents),
    ).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("contains no hardcoded OpenRouter key material", () => {
    const offenders = FILES.filter(({ contents }) =>
      /sk-or-[A-Za-z0-9_-]{8,}/.test(contents) ||
      /Bearer\s+[A-Za-z0-9._-]{20,}/.test(contents),
    ).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("never attaches an Authorization header in the API client", () => {
    const client = FILES.find((f) => f.path.endsWith("api/client.ts"));
    expect(client).toBeDefined();
    expect(client?.contents ?? "").not.toMatch(/Authorization/i);
    expect(client?.contents ?? "").not.toMatch(/api[_-]?key/i);
  });

  it("only mentions OPENROUTER_API_KEY as user-facing configuration help", () => {
    const hits = FILES.filter(({ contents }) =>
      /OPENROUTER_API_KEY\s*[:=]/.test(contents),
    ).map((f) => f.path);
    expect(hits).toEqual([]);
    // The instruction itself must still be present for a missing-key state.
    const helper = FILES.find((f) =>
      f.contents.includes("Set OPENROUTER_API_KEY on the backend"),
    );
    expect(helper).toBeDefined();
  });
});
