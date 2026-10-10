import type { OrchestrationLatestTurnState } from "@ryco/contracts";

/** One look at a thread's latest turn. */
export interface TurnCompletionObservation {
  readonly turnId: string | null;
  /** The session is running (its phase is `"running"`). */
  readonly running: boolean;
  /** The latest turn has settled (`isLatestTurnSettled`). */
  readonly settled: boolean;
  readonly completedAt: string | null;
  /** The latest turn's state; decides how a completed turn ended. */
  readonly state: OrchestrationLatestTurnState | null;
}

/** How a watched turn ended. */
export type TurnCompletionOutcome = "completed" | "failed" | "interrupted";

export interface TurnCompletionTracker {
  /**
   * Records the observation and reports how it ends a turn: an outcome exactly
   * once per turn id, and only for a turn that was observed running before it
   * settled with a completion time; null otherwise.
   */
  observe(input: TurnCompletionObservation): TurnCompletionOutcome | null;
  /** Forgets every turn seen so far. */
  reset(): void;
}

function turnOutcome(state: OrchestrationLatestTurnState | null): TurnCompletionOutcome {
  if (state === "error") return "failed";
  if (state === "interrupted") return "interrupted";
  return "completed";
}

/**
 * Detects "a turn the user watched has just finished", the single rule behind
 * the desktop notification and the overview's turn alerts. Turns that were
 * never observed running (history loaded on mount, a thread opened after its
 * turn ended) never complete, and each turn completes at most once, so
 * re-renders and re-subscriptions after a settle stay quiet. Each consumer
 * owns a tracker, so the notification and the alert fire independently.
 */
export function createTurnCompletionTracker(): TurnCompletionTracker {
  const seenRunningTurnIds = new Set<string>();
  const completedTurnIds = new Set<string>();
  return {
    observe({ turnId, running, settled, completedAt, state }) {
      if (!turnId) return null;
      if (running) {
        seenRunningTurnIds.add(turnId);
        return null;
      }
      if (!settled || !completedAt) return null;
      if (!seenRunningTurnIds.has(turnId)) return null;
      if (completedTurnIds.has(turnId)) return null;
      completedTurnIds.add(turnId);
      return turnOutcome(state);
    },
    reset() {
      seenRunningTurnIds.clear();
      completedTurnIds.clear();
    },
  };
}
