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
 * A running turn that is silent on its live runtime may also have finished
 * with a completion event that was lost on its way to the projection (the
 * runtime stays up, so nothing else settles it). `silentTurnHistoryCheckDue`
 * schedules a read of the provider's own history for it once the live adapter
 * session no longer runs the turn, which settles the turn only if the provider
 * says it ended: after one sweep interval of silence, then at doubling gaps.
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

/**
 * Rules 1 and 2 of `classifyTurnLiveness`: only a running turn on a known
 * runtime, with an activity record for that runtime, can be classified. Callers
 * check it first to skip the live-runtime lookup for every other thread.
 */
export function turnLivenessApplies(input: {
  readonly session: OrchestrationSession | null;
  readonly activity: ProviderRuntimeActivity | null;
}): boolean {
  const session = input.session;
  return (
    session !== null &&
    session.status === "running" &&
    session.activeTurnId !== null &&
    session.runtimeSessionId !== undefined &&
    input.activity !== null &&
    input.activity.runtimeSessionId === session.runtimeSessionId
  );
}

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
  const { session, activity } = input;
  // 1. Only a running turn on a known runtime can be lost or stuck.
  // 2. No activity record for this runtime: nothing to measure against.
  if (
    !turnLivenessApplies(input) ||
    session?.activeTurnId == null ||
    session.runtimeSessionId === undefined ||
    activity === null
  ) {
    return NOT_APPLICABLE;
  }
  const runtimeSessionId = session.runtimeSessionId;
  const turnId = session.activeTurnId;
  const silentForMs = Math.max(0, input.nowMs - activity.lastActivityAtMs);
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
      lastActivityAtMs: activity.lastActivityAtMs,
    };
  }
  // 7.
  return HEALTHY;
}

/** The history checks already made for a thread's silent running turn. */
export interface SilentTurnHistoryChecks {
  readonly turnId: TurnId;
  readonly count: number;
  readonly lastCheckAtMs: number;
}

/**
 * Whether a running turn on its live runtime has been silent long enough for a
 * provider history check. Only a turn the live adapter session no longer runs
 * qualifies: a genuinely long silent command or a pending approval is still
 * running there, and costs no reads. Background work is not silence. Waiting on
 * the user is checked too: a request whose turn ended keeps waiting until
 * history clears it. Per turn, checks are spaced by the sweep interval, doubling
 * after each one, so a lost completion costs a handful of reads at most.
 */
export function silentTurnHistoryCheckDue(input: {
  readonly session: OrchestrationSession | null;
  readonly backgroundLiveness: "working" | "monitoring" | null | undefined;
  readonly liveRuntimeSessionId: RuntimeSessionId | null;
  /** The live adapter session still reports the projected turn as running. */
  readonly liveTurnRunning: boolean;
  readonly activity: ProviderRuntimeActivity | null;
  readonly previous: SilentTurnHistoryChecks | null;
  readonly nowMs: number;
  readonly sweepIntervalMs: number;
}): boolean {
  const { session, activity, previous } = input;
  if (
    !turnLivenessApplies(input) ||
    session?.activeTurnId == null ||
    activity === null ||
    input.liveRuntimeSessionId === null ||
    input.liveRuntimeSessionId !== session.runtimeSessionId ||
    input.liveTurnRunning ||
    input.backgroundLiveness != null ||
    input.nowMs - activity.lastActivityAtMs < input.sweepIntervalMs
  ) {
    return false;
  }
  if (previous === null || previous.turnId !== session.activeTurnId) return true;
  return input.nowMs - previous.lastCheckAtMs >= input.sweepIntervalMs * 2 ** previous.count;
}

export const TURN_LOST_DETAIL = "The provider session ended without finishing the turn.";

export function unresponsiveTurnDetail(silentForMs: number): string {
  const minutes = Math.max(1, Math.round(silentForMs / 60_000));
  return `No provider activity for ${minutes} minute${minutes === 1 ? "" : "s"}. It may be running a long silent command, or it may be stuck. Stop the turn if it does not recover.`;
}
