/**
 * Server-side turn finalization: decides which turn a `thread.session-set` releases and
 * how it ended. The decider calls `resolveReleasedTurn` once per session-set and writes
 * the result into the event as `payload.releasedTurn`; every reducer then applies that
 * explicit data instead of inferring a turn state from the session status.
 *
 * @module turnFinalization
 */
import type {
  OrchestrationReleasedTurn,
  OrchestrationSession,
  OrchestrationTerminalTurnState,
  OrchestrationThread,
  OrchestrationTurnOutcome,
  ProviderRuntimeEvent,
} from "@ryco/contracts";
import { latestIsoTimestamp } from "@ryco/shared/turnFinalization";

/** Open diagnostic reasons carried on `releasedTurn.reason`. Never a closed literal set. */
export const TURN_FINALIZATION_REASON = {
  providerTurnCompleted: "provider-turn-completed",
  providerTurnAborted: "provider-turn-aborted",
  providerSessionIdle: "provider-session-idle",
  providerSessionExited: "provider-session-exited",
  providerRuntimeError: "provider-runtime-error",
  providerHistory: "provider-history",
  turnStartFailed: "turn-start-failed",
  sessionReplaced: "session-replaced",
  sessionStopped: "session-stopped",
  interruptFailed: "interrupt-failed",
  startupOrphanedSession: "startup-orphaned-session",
  startupStaleTurn: "startup-stale-turn",
  /** Fallback when a release carries no matching hint. */
  sessionReleased: "session-released",
} as const;

/**
 * One mapping from a provider terminal event to the turn's terminal state, used by both
 * the release hint and the completion-return observation.
 */
export function runtimeTerminalTurnState(
  event: Extract<ProviderRuntimeEvent, { type: "turn.completed" | "turn.aborted" }>,
): OrchestrationTerminalTurnState {
  if (event.type === "turn.aborted") {
    return "interrupted";
  }
  switch (event.payload.state) {
    case "interrupted":
    case "cancelled":
      return "interrupted";
    case "failed":
      return "error";
    default:
      return "completed";
  }
}

/**
 * State for a release that carries no matching hint. Fails closed: only a provider can
 * report `completed`, so the fallback is never `completed`.
 */
export function fallbackReleasedTurnState(
  session: Pick<OrchestrationSession, "status">,
): OrchestrationTerminalTurnState {
  return session.status === "error" ? "error" : "interrupted";
}

/**
 * Decide which turn a session-set releases and how it ended.
 *
 * - The candidate is the previous `session.activeTurnId`, even when the in-memory latest
 *   turn already says `completed` (a failure can correct a premature `completed`). Without
 *   an active turn, a `running` latest turn is the candidate (legacy or race leftovers).
 * - A session-set that keeps the same active turn releases nothing.
 * - A hint naming a different turn is ignored, so late or duplicate completions cannot
 *   label, move or create turns.
 * - `completedAt` is clamped to never precede the turn's start or request.
 */
export function resolveReleasedTurn(input: {
  readonly thread: Pick<OrchestrationThread, "session" | "latestTurn">;
  readonly nextSession: OrchestrationSession;
  readonly outcome: OrchestrationTurnOutcome | undefined;
}): OrchestrationReleasedTurn | undefined {
  const latest = input.thread.latestTurn;
  const candidate =
    input.thread.session?.activeTurnId ?? (latest?.state === "running" ? latest.turnId : null);
  if (candidate === null || input.nextSession.activeTurnId === candidate) {
    return undefined;
  }
  const hint =
    input.outcome !== undefined &&
    (input.outcome.turnId === undefined || input.outcome.turnId === candidate)
      ? input.outcome
      : undefined;
  const same = latest?.turnId === candidate ? latest : null;
  return {
    turnId: candidate,
    state: hint?.state ?? fallbackReleasedTurnState(input.nextSession),
    reason: hint?.reason ?? TURN_FINALIZATION_REASON.sessionReleased,
    completedAt: latestIsoTimestamp(
      hint?.completedAt ?? input.nextSession.updatedAt,
      same?.startedAt,
      same?.requestedAt,
    ),
  };
}
