/**
 * Turn liveness: decides whether a projected running turn is still backed by
 * a provider runtime, using signals other than wall time.
 *
 * - **lost**: the projection says `running` with an active turn on runtime R,
 *   there is no exact live adapter session for R, there were no runtime events
 *   within one sweep interval, and this was seen on two consecutive sweeps for
 *   the same R and turn. The turn is settled as an error.
 * - **unresponsive**: the live session matches, nothing is waiting on the
 *   user, there is no background work, and the provider has been silent for at
 *   least `unresponsiveAfterMs`. Reported once per turn, never acted on: long
 *   silent work (shell commands, ACP tools) looks exactly like this.
 *
 * Pure module: no services, no I/O.
 *
 * @module providerTurnLiveness
 */
import type { OrchestrationSession, RuntimeSessionId, TurnId } from "@ryco/contracts";

import type { ProviderRuntimeActivity } from "../provider/Services/ProviderService.ts";

export type TurnLivenessVerdict =
  | { readonly kind: "not-applicable" }
  | { readonly kind: "healthy" }
  | {
      readonly kind: "suspect-lost";
      readonly runtimeSessionId: RuntimeSessionId;
      readonly turnId: TurnId;
    }
  | { readonly kind: "lost"; readonly runtimeSessionId: RuntimeSessionId; readonly turnId: TurnId }
  | {
      readonly kind: "unresponsive";
      readonly runtimeSessionId: RuntimeSessionId;
      readonly turnId: TurnId;
      readonly silentForMs: number;
      readonly lastActivityAtMs: number;
    };

const NOT_APPLICABLE: TurnLivenessVerdict = { kind: "not-applicable" };
const HEALTHY: TurnLivenessVerdict = { kind: "healthy" };

export function classifyTurnLiveness(input: {
  readonly session: OrchestrationSession | null;
  readonly hasPendingRequest: boolean;
  readonly backgroundLiveness: "working" | "monitoring" | null | undefined;
  /** The exact live adapter session for the bound runtime, if any. */
  readonly liveRuntimeSessionId: RuntimeSessionId | null;
  readonly activity: ProviderRuntimeActivity | null;
  readonly previous: TurnLivenessVerdict | null;
  readonly alreadyWarned: boolean;
  readonly nowMs: number;
  readonly sweepIntervalMs: number;
  readonly unresponsiveAfterMs: number;
}): TurnLivenessVerdict {
  const session = input.session;
  // 1. Only a running turn on a known runtime can be lost or stuck.
  if (
    session === null ||
    session.status !== "running" ||
    session.activeTurnId === null ||
    session.runtimeSessionId === undefined
  ) {
    return NOT_APPLICABLE;
  }
  const runtimeSessionId = session.runtimeSessionId;
  const turnId = session.activeTurnId;
  // 2. No activity record for this runtime: nothing to measure against.
  if (input.activity === null || input.activity.runtimeSessionId !== runtimeSessionId) {
    return NOT_APPLICABLE;
  }
  const silentForMs = Math.max(0, input.nowMs - input.activity.lastActivityAtMs);
  // 3. No live runtime.
  if (input.liveRuntimeSessionId === null) {
    if (silentForMs < input.sweepIntervalMs) return HEALTHY;
    const previous = input.previous;
    if (
      (previous?.kind === "suspect-lost" || previous?.kind === "lost") &&
      previous.runtimeSessionId === runtimeSessionId &&
      previous.turnId === turnId
    ) {
      return { kind: "lost", runtimeSessionId, turnId };
    }
    return { kind: "suspect-lost", runtimeSessionId, turnId };
  }
  // 4. A different runtime is live: a replacement is in progress elsewhere.
  if (input.liveRuntimeSessionId !== runtimeSessionId) return NOT_APPLICABLE;
  // 5. Waiting on the user, or on background work, is not silence.
  if (input.hasPendingRequest || input.backgroundLiveness != null) return HEALTHY;
  // 6. Silent long enough, and not reported for this turn yet.
  if (silentForMs >= input.unresponsiveAfterMs && !input.alreadyWarned) {
    return {
      kind: "unresponsive",
      runtimeSessionId,
      turnId,
      silentForMs,
      lastActivityAtMs: input.activity.lastActivityAtMs,
    };
  }
  // 7.
  return HEALTHY;
}

export const TURN_LOST_DETAIL = "The provider session ended without finishing the turn.";

export function unresponsiveTurnDetail(silentForMs: number): string {
  const minutes = Math.max(1, Math.round(silentForMs / 60_000));
  return `No provider activity for ${minutes} minute${minutes === 1 ? "" : "s"}. It may be running a long silent command, or it may be stuck. Stop the turn if it does not recover.`;
}
