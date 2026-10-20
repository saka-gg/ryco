import type {
  Thread,
  ThreadSession,
  ThreadShell,
  ThreadShellOrStub,
  ThreadTurnState,
} from "./types.ts";

/**
 * The composed thread for each shell, with the records it was composed from,
 * so composing an unchanged thread again returns the same object. The memo
 * holds the composed body (messages, activities, proposed plans, turn diffs):
 * a thread whose body is evicted must not keep it reachable through its shell,
 * which the store keeps.
 */
export const threadCache = new WeakMap<
  ThreadShell,
  {
    session: ThreadSession | null;
    turnState: ThreadTurnState | undefined;
    messages: Thread["messages"];
    activities: Thread["activities"];
    proposedPlans: Thread["proposedPlans"];
    turnDiffSummaries: Thread["turnDiffSummaries"];
    thread: Thread;
  }
>();

/** Drops the composed thread memoized for a shell; a stub is never composed and has none. */
export function forgetDerivedThread(shell: ThreadShellOrStub): void {
  threadCache.delete(shell as ThreadShell);
}
