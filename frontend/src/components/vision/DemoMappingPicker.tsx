// CV-2 — operator control to associate the demo webcam with a real IFC space.
//
// The picker only ever offers spaces that actually exist in the running app
// (fetched from /api/spaces). It stores a canonical `space_id` and never
// guesses a room from camera observations. The association is labelled
// DEMO MAPPING everywhere it appears.

import { useMemo } from "react";
import { api } from "../../api";
import { useApi } from "../../hooks/useApi";
import { Badge } from "../common";
import { formatStoreyName, formatSpaceRoomName } from "../../lib/format";
import { DEMO_MAPPING_LABEL, DEMO_MAPPING_DISCLAIMER } from "./provenance";
import type { DemoCameraMapping } from "../../vision/demoMapping";

export function DemoMappingPicker({
  current,
  onSelect,
  onClear,
}: {
  current: DemoCameraMapping | null;
  onSelect: (space: {
    space_id: string;
    ifc_global_id?: string | null;
    space_name?: string | null;
    storey_id?: string | null;
    storey_name?: string | null;
  }) => void;
  onClear: () => void;
}) {
  const { state } = useApi(() => api.spaces({ limit: 500 }), []);

  const spaces = useMemo(
    () =>
      state.status === "READY"
        ? [...state.data.items].sort((a, b) => {
            const sa = a.storey_name ?? "";
            const sb = b.storey_name ?? "";
            if (sa !== sb) return sa.localeCompare(sb);
            return a.space_id.localeCompare(b.space_id);
          })
        : [],
    [state],
  );

  return (
    <div
      data-testid="demo-mapping-picker"
      style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
        <span style={{ fontSize: "0.72rem", fontWeight: 800, letterSpacing: "0.05em", color: "var(--color-ink-dim)" }}>
          DEMO CAMERA → ROOM
        </span>
        <Badge label={DEMO_MAPPING_LABEL} tone="warn" mono />
      </div>

      <select
        data-testid="demo-mapping-select"
        value={current?.space_id ?? ""}
        disabled={state.status === "LOADING" || spaces.length === 0}
        onChange={(e) => {
          const space = spaces.find((s) => s.space_id === e.target.value);
          if (!space) return;
          onSelect({
            space_id: space.space_id,
            ifc_global_id: space.ifc_global_id ?? null,
            space_name: space.ifc_name ?? null,
            storey_id: space.storey_id ?? null,
            storey_name: space.storey_name ?? null,
          });
        }}
        style={{
          width: "100%",
          background: "rgba(5, 7, 17, 0.8)",
          border: "1px solid var(--color-line)",
          borderRadius: "8px",
          padding: "0.5rem 0.6rem",
          fontSize: "0.82rem",
          color: "#ffffff",
          outline: "none",
        }}
      >
        <option value="">
          {state.status === "LOADING"
            ? "Loading IFC spaces…"
            : spaces.length === 0
              ? "No IFC spaces available"
              : "Select an IFC space…"}
        </option>
        {spaces.map((s) => {
          const room = formatSpaceRoomName(s.ifc_name, s.space_id);
          const floor = formatStoreyName(s.storey_name);
          return (
            <option key={s.space_id} value={s.space_id}>
              {room} · {floor}
            </option>
          );
        })}
      </select>

      {current && (
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.78rem", color: "var(--color-ink-muted)" }}>
            Associated with{" "}
            <strong style={{ color: "var(--color-ink)" }}>
              {formatSpaceRoomName(current.space_name, current.space_id)}
            </strong>
            {current.storey_name ? ` · ${formatStoreyName(current.storey_name)}` : ""}
          </span>
          <button
            type="button"
            onClick={onClear}
            data-testid="demo-mapping-clear"
            style={{
              background: "transparent",
              border: "1px solid var(--color-line)",
              color: "var(--color-ink-dim)",
              borderRadius: "6px",
              padding: "0.2rem 0.5rem",
              fontSize: "0.72rem",
              cursor: "pointer",
            }}
          >
            Clear
          </button>
        </div>
      )}

      <p style={{ margin: 0, fontSize: "0.72rem", color: "var(--color-ink-dim)", lineHeight: 1.5 }}>
        {DEMO_MAPPING_DISCLAIMER}
      </p>
    </div>
  );
}
