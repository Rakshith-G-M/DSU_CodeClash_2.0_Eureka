import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useApi } from "../hooks/useApi";
import { api } from "../api";
import type { Recommendation, SpaceListItem } from "../api/types";
import { ErrorState, LoadingState } from "../components/common";
import { TwinViewer } from "../components/TwinViewer";
import { BimSpacePanel } from "../components/BimSpacePanel";
import {
  fmtArea,
  formatStoreyName,
  formatSpaceRoomName,
  resolveSpaceDisplayName,
  type TwinManifest,
} from "../lib/format";
import {
  buildRoomStatusMap,
  resolveSpaceStorey,
  roomStatusLabel,
  ROOM_STATUS_COLOR_HEX,
} from "../lib/roomStatus";
import { useVision } from "../vision/visionContext";
import { IconBuilding } from "../components/icons";

// Stable empty references so derived-state memos do not recompute needlessly.
const EMPTY_SPACES: SpaceListItem[] = [];
const EMPTY_RECOMMENDATIONS: Recommendation[] = [];

type Loadable<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: T };

function useJson(url: string): Loadable<TwinManifest> {
  const [state, setState] = useState<Loadable<TwinManifest>>({ status: "loading" });
  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: TwinManifest) => alive && setState({ status: "ready", data }))
      .catch((e: unknown) =>
        alive && setState({ status: "error", message: String((e as Error).message ?? e) })
      );
    return () => {
      alive = false;
    };
  }, [url]);
  return state;
}

export function DigitalTwinPage() {
  const manifest = useJson("/models/twin_manifest.json");
  const { state: campusState } = useApi(() => api.campus(), []);
  const { state: spacesState } = useApi(() => api.spaces({ limit: 500 }), []);
  const { state: recsState } = useApi(() => api.recommendations({ limit: 500 }), []);
  const { demoMapping, observation } = useVision();

  const [searchParams, setSearchParams] = useSearchParams();
  const spaceParam = searchParams.get("space");

  const [currentStorey, setCurrentStorey] = useState<string | null>(null);
  const [selectedSpace, setSelectedSpace] = useState<string | null>(null);
  const [hoveredSpace, setHoveredSpace] = useState<string | null>(null);
  const [spaceSearch, setSpaceSearch] = useState("");
  const [spaceNotFoundError, setSpaceNotFoundError] = useState<string | null>(null);

  const [showLeftPanel, setShowLeftPanel] = useState(true);
  const [showRightPanel, setShowRightPanel] = useState(true);

  const [resetTrigger, setResetTrigger] = useState(0);
  const [fitTrigger, setFitTrigger] = useState(0);

  /**
   * Single canonical room-selection routine used by every selection entry
   * point (room list, search result, 3D mesh, deep link, demo reveal). It
   * resolves the room's canonical storey from the IFC manifest — never from a
   * name, index or label — and activates that floor so the room geometry is
   * visible, then opens the inspector. The viewer focuses the camera from the
   * real mesh bounds once the geometry is available.
   */
  const selectSpace = useCallback(
    (spaceId: string | null) => {
      if (!spaceId) {
        setSelectedSpace(null);
        setSpaceNotFoundError(null);
        return;
      }
      const storeyId =
        manifest.status === "ready"
          ? resolveSpaceStorey(manifest.data.spaces, spaceId)
          : null;
      setSelectedSpace(spaceId);
      if (storeyId) setCurrentStorey(storeyId);
      setSpaceNotFoundError(null);
      setShowRightPanel(true);
    },
    [manifest],
  );

  // Reveal the explicitly configured demo camera room in the existing model.
  // Purely presentational: it only sets the current selection/storey (which the
  // viewer already highlights) and the existing ?space= deep link. No geometry,
  // no IFC data and no highlight materials are changed.
  function revealDemoRoom() {
    if (!demoMapping) return;
    selectSpace(demoMapping.space_id);
    // Fall back to the association's own canonical storey if the manifest has
    // no matching space record.
    if (demoMapping.storey_id) setCurrentStorey(demoMapping.storey_id);
    if (spaceParam !== demoMapping.space_id) {
      setSearchParams({ space: demoMapping.space_id }, { replace: false });
    }
  }

  // Handle deep-linked room selection via URL parameter: /twin?space=<id>
  useEffect(() => {
    if (manifest.status === "ready" && spaceParam) {
      const q = spaceParam.trim().toLowerCase();
      const found = manifest.data.spaces.find(
        (s) =>
          s.space_id.toLowerCase() === q ||
          (s.ifc_global_id && s.ifc_global_id.toLowerCase() === q) ||
          (s.ifc_name && s.ifc_name.toLowerCase() === q)
      );

      if (found) {
        selectSpace(found.space_id);
      } else {
        setSpaceNotFoundError(spaceParam);
      }
    }
  }, [manifest, spaceParam, selectSpace]);

  const spaces = spacesState.status === "READY" ? spacesState.data.items : EMPTY_SPACES;
  const campus = campusState.status === "READY" ? campusState.data : null;
  const recommendations =
    recsState.status === "READY" ? recsState.data.items : EMPTY_RECOMMENDATIONS;

  // Re-evaluate room status on a slow heartbeat while a camera reading is live,
  // so a stalled detector ages out to an honest UNKNOWN instead of leaving a
  // stale colour behind.
  const hasObservation = observation !== null;
  const [statusTick, setStatusTick] = useState(0);
  useEffect(() => {
    if (!hasObservation) return;
    const id = window.setInterval(() => setStatusTick((t) => t + 1), 5000);
    return () => window.clearInterval(id);
  }, [hasObservation]);

  const roomStatus = useMemo(
    () =>
      buildRoomStatusMap({
        spaces,
        observation,
        recommendations,
        now: Date.now(),
      }),
    // statusTick is an intentional trigger for staleness re-evaluation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spaces, observation, recommendations, statusTick],
  );

  // The assistant context and room-scoping wiring has been removed. The
  // integrated analysis lives on the Sustainability Insights finding detail
  // page.
  const storeyName = useMemo(() => {
    const m = new Map<string, string | null>(
      (campus?.storeys ?? []).map((s) => [s.storey_id, s.name])
    );
    if (manifest.status === "ready") {
      for (const s of manifest.data.storeys)
        if (!m.has(s.storey_id)) m.set(s.storey_id, s.name);
    }
    return m;
  }, [campus, manifest]);

  const selected = useMemo(() => {
    if (!selectedSpace) return null;
    const space = spaces.find((s) => s.space_id === selectedSpace) ?? null;
    const ref =
      manifest.status === "ready"
        ? manifest.data.spaces.find((s) => s.space_id === selectedSpace) ?? null
        : null;
    return { space, ref };
  }, [selectedSpace, spaces, manifest]);

  const filteredSpaces = useMemo(() => {
    if (manifest.status !== "ready") return [];
    let list = manifest.data.spaces;
    if (currentStorey) {
      list = list.filter((s) => s.storey_id === currentStorey);
    }
    if (spaceSearch.trim()) {
      const q = spaceSearch.toLowerCase();
      list = list.filter((s) => {
        const roomName = formatSpaceRoomName(s.ifc_name, s.space_id).toLowerCase();
        const rawStorey = storeyName.get(s.storey_id ?? "") ?? "";
        const floorName = formatStoreyName(rawStorey).toLowerCase();
        return (
          (s.ifc_name ?? "").toLowerCase().includes(q) ||
          roomName.includes(q) ||
          floorName.includes(q) ||
          rawStorey.toLowerCase().includes(q) ||
          s.space_id.toLowerCase().includes(q)
        );
      });
    }
    return list;
  }, [manifest, currentStorey, spaceSearch, storeyName]);

  const handleStoreyChange = useCallback(
    (targetStoreyId: string | null) => {
      setCurrentStorey(targetStoreyId);
      // If a room is currently selected but belongs to a different floor,
      // deselect it so the inspector doesn't show a misleading out-of-floor room.
      if (selectedSpace && targetStoreyId !== null && manifest.status === "ready") {
        const roomStorey = resolveSpaceStorey(manifest.data.spaces, selectedSpace);
        if (roomStorey && roomStorey !== targetStoreyId) {
          setSelectedSpace(null);
          setSearchParams({}, { replace: true });
        }
      }
      setTimeout(() => window.dispatchEvent(new Event("resize")), 50);
    },
    [selectedSpace, manifest, setSearchParams],
  );

  const toggleLeftPanel = useCallback(() => {
    setShowLeftPanel((v) => !v);
    setTimeout(() => window.dispatchEvent(new Event("resize")), 50);
  }, []);

  const toggleRightPanel = useCallback(() => {
    setShowRightPanel((v) => !v);
    setTimeout(() => window.dispatchEvent(new Event("resize")), 50);
  }, []);

  if (manifest.status === "loading")
    return <LoadingState label="Loading TalTech IFC 3D Building Geometry..." />;
  if (manifest.status === "error")
    return (
      <ErrorState
        error={{
          status: 0,
          name: "Error",
          message: `Twin manifest unavailable: ${manifest.message}`,
        }}
      />
    );

  const { data: mf } = manifest;

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "calc(100vh - 65px)",
        background: "var(--bg-dark)",
        overflow: "hidden",
      }}
    >
      {/* ── 100% FULL-CANVAS 3D VIEWPORT (VISUAL HERO) ── */}
      <div style={{ position: "absolute", inset: 0, zIndex: 1 }}>
        <TwinViewer
          manifest={mf}
          currentStorey={currentStorey}
          selectedSpace={selectedSpace}
          hoveredSpace={hoveredSpace}
          roomStatus={roomStatus}
          onSelect={(id) => selectSpace(id)}
          onHover={setHoveredSpace}
          externalResetTrigger={resetTrigger}
          externalFitTrigger={fitTrigger}
        />
      </div>

      {/* ── SPACE NOT FOUND BANNER ── */}
      {spaceNotFoundError && (
        <div
          style={{
            position: "absolute",
            top: "1.25rem",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 35,
            padding: "0.55rem 1.25rem",
            background: "rgba(248, 113, 113, 0.9)",
            backdropFilter: "blur(16px)",
            border: "1px solid rgba(248, 113, 113, 0.5)",
            borderRadius: "9999px",
            display: "flex",
            alignItems: "center",
            gap: "1rem",
            color: "#ffffff",
            fontSize: "0.85rem",
            fontWeight: 700,
            boxShadow: "0 10px 30px rgba(0,0,0,0.6)",
          }}
        >
          <span>Space not found ("{spaceNotFoundError}")</span>
          <button
            onClick={() => {
              setSpaceNotFoundError(null);
              setSearchParams({});
            }}
            style={{
              background: "#ffffff",
              border: "none",
              color: "#07120d",
              padding: "0.25rem 0.75rem",
              borderRadius: "9999px",
              cursor: "pointer",
              fontSize: "0.78rem",
              fontWeight: 800,
            }}
          >
            Show all spaces
          </button>
        </div>
      )}

      {/* ── FLOATING TOP-CENTER FLOOR NAVIGATION TOOLBAR ── */}
      <div
        style={{
          position: "absolute",
          top: "1.25rem",
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 20,
          display: "flex",
          alignItems: "center",
          gap: "0.35rem",
          padding: "0.4rem 0.65rem",
          background: "rgba(9, 22, 17, 0.85)",
          backdropFilter: "blur(16px)",
          border: "1px solid var(--color-line-bright)",
          borderRadius: "9999px",
          boxShadow: "0 10px 30px rgba(0, 0, 0, 0.6)",
        }}
      >
        <button
          onClick={() => handleStoreyChange(null)}
          style={{
            padding: "0.35rem 0.85rem",
            borderRadius: "9999px",
            fontSize: "0.75rem",
            fontWeight: 700,
            cursor: "pointer",
            border: "none",
            background: currentStorey === null ? "var(--accent-cyan)" : "transparent",
            color: currentStorey === null ? "#07120d" : "var(--color-ink-muted)",
            transition: "all 0.15s ease",
          }}
        >
          ALL FLOORS
        </button>
        {mf.storeys.map((s) => {
          const isSelected = currentStorey === s.storey_id;
          return (
            <button
              key={s.storey_id}
              onClick={() => handleStoreyChange(isSelected ? null : s.storey_id)}
              style={{
                padding: "0.35rem 0.85rem",
                borderRadius: "9999px",
                fontSize: "0.75rem",
                fontWeight: 700,
                cursor: "pointer",
                border: "none",
                background: isSelected ? "var(--accent-cyan)" : "transparent",
                color: isSelected ? "#07120d" : "var(--color-ink-muted)",
                transition: "all 0.15s ease",
              }}
            >
              {formatStoreyName(s.name).toUpperCase()}
            </button>
          );
        })}
      </div>

      {/* ── FLOATING TOP-RIGHT VIEW CONTROLS (RESET VIEW / TOP VIEW / INSPECTOR) ── */}
      <div
        style={{
          position: "absolute",
          top: "1.25rem",
          right: "1.25rem",
          zIndex: 20,
          display: "flex",
          gap: "0.5rem",
          alignItems: "center",
        }}
      >
        <button
          id="twin-reset-view-header"
          onClick={() => setResetTrigger((v) => v + 1)}
          style={{
            padding: "0.45rem 0.85rem",
            borderRadius: "8px",
            border: "1px solid var(--color-line-bright)",
            background: "rgba(9, 22, 17, 0.88)",
            backdropFilter: "blur(12px)",
            color: "var(--color-ink-2)",
            fontSize: "0.8rem",
            fontWeight: 600,
            cursor: "pointer",
            transition: "all 0.15s ease",
            boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--accent-cyan)";
            (e.currentTarget as HTMLButtonElement).style.color = "#ffffff";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--color-line-bright)";
            (e.currentTarget as HTMLButtonElement).style.color = "var(--color-ink-2)";
          }}
        >
          ⊡ Reset View
        </button>
        <button
          id="twin-top-view-header"
          onClick={() => setFitTrigger((v) => v + 1)}
          style={{
            padding: "0.45rem 0.85rem",
            borderRadius: "8px",
            border: "1px solid var(--color-line-bright)",
            background: "rgba(9, 22, 17, 0.88)",
            backdropFilter: "blur(12px)",
            color: "var(--color-ink-2)",
            fontSize: "0.8rem",
            fontWeight: 600,
            cursor: "pointer",
            transition: "all 0.15s ease",
            boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--accent-cyan)";
            (e.currentTarget as HTMLButtonElement).style.color = "#ffffff";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--color-line-bright)";
            (e.currentTarget as HTMLButtonElement).style.color = "var(--color-ink-2)";
          }}
        >
          ↑ Top View
        </button>
        <button
          onClick={toggleRightPanel}
          aria-label="Toggle Space Inspector Panel"
          style={{
            padding: "0.45rem 0.65rem",
            borderRadius: "8px",
            border: "1px solid var(--color-line)",
            background: showRightPanel ? "rgba(63, 174, 131, 0.18)" : "rgba(9, 22, 17, 0.88)",
            color: showRightPanel ? "var(--accent-cyan)" : "var(--color-ink-dim)",
            fontSize: "0.8rem",
            fontWeight: 700,
            cursor: "pointer",
          }}
          title="Toggle Space Inspector Panel"
        >
          Inspector {showRightPanel ? "▲" : "▼"}
        </button>
      </div>

      {/* ── FLOATING LEFT PANEL — BUILDING SPACES DIRECTORY OVERLAY ── */}
      {showLeftPanel ? (
        <div
          style={{
            position: "absolute",
            top: "1.25rem",
            left: "1.25rem",
            width: "240px",
            maxHeight: "calc(100vh - 105px)",
            zIndex: 20,
            display: "flex",
            flexDirection: "column",
            background: "rgba(9, 22, 17, 0.88)",
            backdropFilter: "blur(16px)",
            border: "1px solid var(--color-line)",
            borderRadius: "14px",
            padding: "0.75rem",
            boxShadow: "0 20px 40px rgba(0, 0, 0, 0.6)",
            overflow: "hidden",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.45rem" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.1rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                <span style={{ fontSize: "0.74rem", fontWeight: 800, color: "var(--accent-cyan)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
                  SPACES
                </span>
                <span
                  style={{
                    fontSize: "0.7rem",
                    color: "var(--color-ink-dim)",
                    fontFamily: "var(--font-mono)",
                    fontWeight: 700,
                    background: "rgba(255, 255, 255, 0.06)",
                    padding: "0.05rem 0.35rem",
                    borderRadius: "4px",
                  }}
                >
                  {filteredSpaces.length}
                </span>
              </div>
              <div style={{ fontSize: "0.68rem", color: "var(--color-ink-muted)" }}>
                {currentStorey ? (
                  <span>
                    Floor: <strong style={{ color: "#ffffff" }}>{formatStoreyName(storeyName.get(currentStorey))}</strong>{" "}
                    <button
                      onClick={() => handleStoreyChange(null)}
                      style={{
                        background: "none",
                        border: "none",
                        padding: 0,
                        color: "var(--accent-cyan)",
                        fontSize: "0.68rem",
                        cursor: "pointer",
                        textDecoration: "underline",
                      }}
                    >
                      All
                    </button>
                  </span>
                ) : (
                  "All Floors visible"
                )}
              </div>
            </div>
            <button
              onClick={toggleLeftPanel}
              aria-label="Collapse building spaces list"
              style={{
                background: "transparent",
                border: "none",
                color: "var(--color-ink-dim)",
                cursor: "pointer",
                padding: "0.2rem 0.35rem",
                borderRadius: "4px",
                fontSize: "0.75rem",
              }}
              title="Hide panel"
            >
              ◀
            </button>
          </div>

          <input
            type="text"
            placeholder="Search room..."
            value={spaceSearch}
            onChange={(e) => setSpaceSearch(e.target.value)}
            style={{
              background: "rgba(5, 7, 17, 0.8)",
              border: "1px solid var(--color-line)",
              borderRadius: "6px",
              padding: "0.38rem 0.6rem",
              fontSize: "0.78rem",
              color: "#ffffff",
              outline: "none",
              marginBottom: "0.5rem",
            }}
          />

          <div className="scroll-thin" style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            {filteredSpaces.map((s) => {
              const isSelected = selectedSpace === s.space_id;
              const roomName = formatSpaceRoomName(s.ifc_name, s.space_id);
              const rawSt = storeyName.get(s.storey_id ?? "");
              const status = roomStatus[s.space_id];
              return (
                <div
                  key={s.space_id}
                  onClick={() => selectSpace(isSelected ? null : s.space_id)}
                  onMouseEnter={() => setHoveredSpace(s.space_id)}
                  onMouseLeave={() => setHoveredSpace(null)}
                  style={{
                    padding: "0.4rem 0.55rem",
                    borderRadius: "6px",
                    background: isSelected ? "rgba(63, 174, 131, 0.22)" : "rgba(14, 32, 24, 0.45)",
                    border: `1px solid ${isSelected ? "var(--accent-cyan)" : "transparent"}`,
                    borderLeft: isSelected ? "3px solid var(--accent-cyan)" : "3px solid transparent",
                    cursor: "pointer",
                    transition: "all 0.12s ease",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
                    {status && (
                      <span
                        data-testid={`room-status-dot-${s.space_id}`}
                        title={roomStatusLabel(status.level)}
                        style={{
                          width: "6px",
                          height: "6px",
                          borderRadius: "50%",
                          flexShrink: 0,
                          background: ROOM_STATUS_COLOR_HEX[status.level],
                          boxShadow: `0 0 5px ${ROOM_STATUS_COLOR_HEX[status.level]}99`,
                        }}
                      />
                    )}
                    <div style={{ fontSize: "0.82rem", fontWeight: isSelected ? 800 : 500, color: isSelected ? "var(--accent-cyan)" : "#ffffff" }}>
                      {roomName}
                    </div>
                  </div>
                  <div style={{ fontSize: "0.68rem", color: "var(--color-ink-dim)", marginTop: "0.1rem" }}>
                    {formatStoreyName(rawSt)} · {fmtArea(s.area_m2)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <button
          onClick={toggleLeftPanel}
          aria-label="Expand building spaces list"
          style={{
            position: "absolute",
            top: "1.25rem",
            left: "1.25rem",
            zIndex: 20,
            padding: "0.45rem 0.75rem",
            borderRadius: "8px",
            border: "1px solid var(--color-line-bright)",
            background: "rgba(9, 22, 17, 0.9)",
            backdropFilter: "blur(12px)",
            color: "var(--accent-cyan)",
            fontSize: "0.76rem",
            fontWeight: 700,
            cursor: "pointer",
            boxShadow: "0 10px 25px rgba(0,0,0,0.5)",
          }}
        >
          ▶ Spaces ({filteredSpaces.length})
        </button>
      )}

      {/* ── FLOATING RIGHT PANEL — SPACE INSPECTOR OVERLAY ── */}
      {showRightPanel && (
        <div
          className="scroll-thin"
          style={{
            position: "absolute",
            top: "4.5rem",
            right: "1.25rem",
            width: "310px",
            maxHeight: "calc(100vh - 120px)",
            zIndex: 20,
            overflowY: "auto",
            background: "rgba(9, 22, 17, 0.88)",
            backdropFilter: "blur(16px)",
            border: "1px solid var(--color-line)",
            borderRadius: "14px",
            boxShadow: "0 20px 40px rgba(0, 0, 0, 0.6)",
          }}
        >
          {/* Explicit Camera Association Banner */}
          {demoMapping ? (
            <div
              data-testid="demo-mapping-strip"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.25rem",
                padding: "0.45rem 0.75rem",
                borderBottom: "1px solid var(--color-line)",
                background: demoMapping.space_id === selectedSpace
                  ? "rgba(63, 174, 131, 0.12)"
                  : "rgba(251, 191, 36, 0.08)",
                position: "sticky",
                top: 0,
                zIndex: 2,
                backdropFilter: "blur(12px)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.4rem" }}>
                <span
                  style={{
                    fontSize: "0.64rem",
                    fontWeight: 800,
                    color: demoMapping.space_id === selectedSpace ? "var(--accent-cyan)" : "#fbbf24",
                    letterSpacing: "0.05em",
                    textTransform: "uppercase",
                  }}
                >
                  {demoMapping.space_id === selectedSpace
                    ? "Demo Camera · This Room"
                    : "Demo Camera · Different Room"}
                </span>
                {demoMapping.space_id !== selectedSpace && (
                  <button
                    type="button"
                    onClick={revealDemoRoom}
                    data-testid="demo-mapping-reveal"
                    style={{
                      flexShrink: 0,
                      background: "rgba(251, 191, 36, 0.16)",
                      border: "1px solid rgba(251, 191, 36, 0.5)",
                      color: "#fbbf24",
                      borderRadius: "4px",
                      padding: "0.15rem 0.45rem",
                      fontSize: "0.66rem",
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    View Room
                  </button>
                )}
              </div>
              <div
                style={{
                  fontSize: "0.7rem",
                  color: "var(--color-ink-dim)",
                  lineHeight: 1.3,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {demoMapping.space_id === selectedSpace
                  ? "Webcam occupancy monitoring configured for this space."
                  : `Camera associated with: ${resolveSpaceDisplayName(demoMapping.space_id)}`}
              </div>
            </div>
          ) : (
            <div
              data-testid="demo-mapping-strip"
              style={{
                padding: "0.4rem 0.75rem",
                borderBottom: "1px solid var(--color-line)",
                background: "rgba(255, 255, 255, 0.02)",
                fontSize: "0.68rem",
                color: "var(--color-ink-dim)",
              }}
            >
              No room associated with demo camera
            </div>
          )}

          {selected ? (
            <BimSpacePanel
              spaceId={selectedSpace ?? ""}
              spaceName={selected.ref?.ifc_name ?? null}
              storey={storeyName.get(selected.ref?.storey_id ?? "") ?? null}
              storeyId={selected.ref?.storey_id ?? null}
              area={selected.space?.area_m2 ?? selected.ref?.area_m2 ?? null}
              volume={selected.space?.volume_m3 ?? selected.ref?.volume_m3 ?? null}
              height={selected.ref?.height_m ?? null}
              capacity={selected.space?.capacity_occupants ?? null}
              occupiable={selected.space?.occupiable ?? true}
              conditioning={selected.space?.conditioning ?? null}
              ifcGlobalId={selected.ref?.ifc_global_id ?? null}
              rawStorey={selected.ref?.storey_id ? storeyName.get(selected.ref.storey_id) : null}
              status={selectedSpace ? roomStatus[selectedSpace] ?? null : null}
            />
          ) : (
            <div
              style={{
                padding: "1.75rem 1.25rem",
                textAlign: "center",
                color: "var(--color-ink-muted)",
              }}
            >
              <IconBuilding size={32} color="var(--accent-cyan)" style={{ marginBottom: "0.75rem", opacity: 0.85 }} />
              <div style={{ fontSize: "0.9rem", fontWeight: 800, color: "#ffffff", marginBottom: "0.35rem" }}>
                SPACE INSPECTOR
              </div>
              <p style={{ fontSize: "0.78rem", color: "var(--color-ink-2)", margin: 0, lineHeight: 1.5 }}>
                Select a room from the 3D model or spaces directory to inspect its BIM properties and occupancy.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
