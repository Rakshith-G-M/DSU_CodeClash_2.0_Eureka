// useRoomIntelligence — one authoritative, reactive room-intelligence state.
//
// Wires the live camera observation + deterministic room status into the
// controlled AI trigger policy (roomIntelligence.ts) and the room analysis
// endpoint. Reactivity is one-directional and never blocks the UI:
//
//   observation → (existing) room status → material version
//     → debounce → throttle → POST /api/ai/room → validated response
//
// Guarantees:
//   * The model is advisory: it cannot change occupancy, capacity, geometry,
//     mappings or the resolved status.
//   * Every request carries a monotonic id; a late/out-of-order response is
//     discarded, so a superseded room can never surface under a new selection.
//   * Switching rooms (or unmounting) invalidates in-flight requests and resets
//     the conversation, so a stale room's answers never leak.
//   * Real-time occupancy/colouring are never blocked: the request is fired from
//     a timer, never from the render path.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { AiConversationTurn, AiResponse } from "../api/types";
import type { OccupancyObservation } from "../components/vision/visionTypes";
import { aiStatusMessage } from "./presentation";
import type { RoomStatus } from "../lib/roomStatus";
import {
  DEFAULT_TRIGGER_POLICY,
  buildMaterialState,
  derivePhase,
  materialStateVersion,
  observationPayloadFor,
  responseIsStale,
  scheduleDecision,
  type AiAnalysisPhase,
  type RoomMaterialState,
  type TriggerPolicy,
} from "./roomIntelligence";

export interface RoomTurn {
  id: string;
  question: string;
  answer: AiResponse | null;
  error: string | null;
}

export interface RoomIntelligenceState {
  phase: AiAnalysisPhase;
  response: AiResponse | null;
  error: string | null;
  turns: RoomTurn[];
  sending: boolean;
  isStale: boolean;
  /** Explicit retry/refresh of the current room state. */
  retry: () => void;
  /** Room-scoped follow-up question. */
  ask: (question: string) => Promise<void>;
}

export interface UseRoomIntelligenceParams {
  spaceId: string | null;
  status: RoomStatus | null;
  observation: OccupancyObservation | null;
  /** When false, nothing is requested (e.g. no room selected). */
  enabled?: boolean;
  policy?: TriggerPolicy;
}

function buildHistory(
  base: AiResponse | null,
  turns: RoomTurn[],
): AiConversationTurn[] {
  const out: AiConversationTurn[] = [
    { role: "user", content: "Analyse this room's current situation." },
  ];
  if (base?.answer) out.push({ role: "assistant", content: base.answer });
  for (const t of turns) {
    out.push({ role: "user", content: t.question });
    if (t.answer?.answer) out.push({ role: "assistant", content: t.answer.answer });
  }
  return out;
}

export function useRoomIntelligence({
  spaceId,
  status,
  observation,
  enabled = true,
  policy = DEFAULT_TRIGGER_POLICY,
}: UseRoomIntelligenceParams): RoomIntelligenceState {
  const material = useMemo(
    () => buildMaterialState(spaceId, status),
    [spaceId, status],
  );
  const materialVersion = materialStateVersion(material);
  const observationPayload = useMemo(
    () => observationPayloadFor(spaceId, observation),
    [spaceId, observation],
  );

  const [stableVersion, setStableVersion] = useState<string | null>(null);
  const [response, setResponse] = useState<AiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [turns, setTurns] = useState<RoomTurn[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [scheduled, setScheduled] = useState(false);
  const [sending, setSending] = useState(false);

  // Mutable bookkeeping that must NOT re-run effects when it changes.
  const lastAttemptedVersion = useRef<string | null>(null);
  const lastAttemptedAt = useRef<number | null>(null);
  const requestSeq = useRef(0);

  // Latest inputs for timer callbacks, kept current without re-arming timers.
  const inputsRef = useRef<{
    spaceId: string | null;
    material: RoomMaterialState | null;
    observationPayload: ReturnType<typeof observationPayloadFor>;
  }>({ spaceId, material, observationPayload });
  useEffect(() => {
    inputsRef.current = { spaceId, material, observationPayload };
  }, [spaceId, material, observationPayload]);

  // Reset everything when the room selection changes and invalidate in-flight
  // requests so a superseded room's response can never be applied.
  useEffect(() => {
    requestSeq.current += 1;
    lastAttemptedVersion.current = null;
    lastAttemptedAt.current = null;
    setStableVersion(null);
    setResponse(null);
    setError(null);
    setTurns([]);
    setAnalyzing(false);
    setScheduled(false);
    setSending(false);
  }, [spaceId]);

  // Dwell: adopt a new material version only after it has stayed stable for
  // `debounceMs`, so flicker / repeated identical detections do not trigger.
  useEffect(() => {
    if (materialVersion === null) {
      setStableVersion(null);
      return;
    }
    if (stableVersion === null) {
      // First material state for this room: adopt immediately.
      setStableVersion(materialVersion);
      return;
    }
    if (stableVersion === materialVersion) return;
    const id = window.setTimeout(
      () => setStableVersion(materialVersion),
      policy.debounceMs,
    );
    return () => window.clearTimeout(id);
  }, [materialVersion, stableVersion, policy.debounceMs]);

  /** Fire one request for the given state version. Idempotent per request id. */
  const perform = useCallback(
    async (
      version: string | null,
      trigger: string,
      question?: string,
      history?: AiConversationTurn[],
    ) => {
      const inputs = inputsRef.current;
      const room = inputs.spaceId;
      if (!room || !inputs.material) return;

      const myId = ++requestSeq.current;
      lastAttemptedVersion.current = version;
      lastAttemptedAt.current = Date.now();
      setError(null);
      setAnalyzing(true);
      setScheduled(false);

      try {
        const res = await api.aiRoom({
          space_id: room,
          question: question ?? null,
          history: history ?? null,
          observation: inputs.observationPayload,
          state_version: version,
          trigger,
        });
        if (myId !== requestSeq.current) return; // superseded / unmounted

        const message =
          res.status !== "OK"
            ? aiStatusMessage(res.status, res.message)
            : !res.answer?.trim()
              ? "The model returned an empty response, so it was not shown."
              : null;

        setResponse(res);
        setError(message);
      } catch (err) {
        if (myId !== requestSeq.current) return;
        setError(
          err instanceof Error
            ? err.message
            : "The AI service could not be reached.",
        );
      } finally {
        if (myId === requestSeq.current) setAnalyzing(false);
      }
    },
    [],
  );

  // Schedule a (re)analysis from the current stable state, honouring the
  // trigger policy. The timer is cleared on unmount or when the room changes.
  useEffect(() => {
    if (!enabled || !spaceId || stableVersion === null) return;
    if (analyzing) return; // already in flight

    const decision = scheduleDecision({
      targetVersion: stableVersion,
      lastAttemptedVersion: lastAttemptedVersion.current,
      lastAttemptedAt: lastAttemptedAt.current,
      failed: error !== null,
      manual: false,
      now: Date.now(),
      policy,
    });
    if (!decision.schedule) return;

    setScheduled(true);
    const id = window.setTimeout(() => {
      void perform(stableVersion, decision.reason);
    }, decision.delayMs);
    return () => {
      window.clearTimeout(id);
      // The timer was cancelled (dependency change or unmount), so no request
      // is pending. Clearing here prevents the UI ever sticking on "scheduling".
      setScheduled(false);
    };
  }, [enabled, spaceId, stableVersion, analyzing, error, policy, perform]);

  const retry = useCallback(() => {
    const version = inputsRef.current
      ? materialStateVersion(inputsRef.current.material)
      : null;
    // Force an immediate attempt for the current version.
    lastAttemptedVersion.current = null;
    lastAttemptedAt.current = null;
    void perform(version, "manual");
  }, [perform]);

  const ask = useCallback(
    async (raw: string) => {
      const question = raw.trim();
      if (!question || sending) return;
      const room = inputsRef.current.spaceId;
      if (!room || !inputsRef.current.material) return;
      setSending(true);
      const history = buildHistory(response, turns);
      try {
        const res = await api.aiRoom({
          space_id: room,
          question,
          history,
          observation: inputsRef.current.observationPayload,
          state_version: materialStateVersion(inputsRef.current.material),
          trigger: "follow_up",
        });
        // Drop the answer if the operator switched rooms meanwhile.
        if (inputsRef.current.spaceId !== room) return;
        const err =
          res.status !== "OK"
            ? aiStatusMessage(res.status, res.message)
            : !res.answer?.trim()
              ? "The model returned an empty response, so it was not shown."
              : null;
        setTurns((prev) => [
          ...prev,
          { id: `${prev.length + 1}-${Date.now()}`, question, answer: res, error: err },
        ]);
      } catch (err) {
        if (inputsRef.current.spaceId !== room) return;
        setTurns((prev) => [
          ...prev,
          {
            id: `${prev.length + 1}-${Date.now()}`,
            question,
            answer: null,
            error:
              err instanceof Error
                ? err.message
                : "The follow-up could not be sent. Please try again.",
          },
        ]);
      } finally {
        setSending(false);
      }
    },
    [response, turns, sending],
  );

  const isStale = responseIsStale(response?.based_on?.state_version, materialVersion);
  const phase = derivePhase({
    analyzing,
    scheduled,
    hasResponse: response !== null,
    failed: error !== null,
    responseIsStale: isStale,
  });

  return {
    phase,
    response,
    error,
    turns,
    sending,
    isStale,
    retry,
    ask,
  };
}
