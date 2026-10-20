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
 * which the store keeps. A shell that leaves the store (replaced or removed)
 * forgets its entry too, so no earlier shell still held elsewhere keeps a body
 * reachable.
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

/**
 * The arrays collected from a thread's id list and record (messages,
 * activities, proposed plans, turn diffs), per id list then per record. An
 * entry lives while both keys are reachable, and an older state held elsewhere
 * may still hold them, so a dropped body's arrays are forgotten explicitly.
 */
export const collectedByIdsCache = new WeakMap<
  readonly string[],
  WeakMap<object, readonly unknown[]>
>();

/** Drops the composed thread memoized for a shell; a stub is never composed and has none. */
export function forgetDerivedThread(shell: ThreadShellOrStub): void {
  threadCache.delete(shell as ThreadShell);
}

/**
 * Forgets the thread composed under a shell the store replaced or removed.
 *
 * A cache-only side effect of the reducer that decides the replacement, like
 * forgetting on eviction: only a reader of an older state still reaches the
 * replaced shell, and it composes the thread once more, so readers of the
 * current state see no change. When a reducer's result is discarded instead of
 * committed (an event that throws, which a batch then skips), the store keeps
 * the shell that event replaced and composes its thread once more.
 */
export function retireDerivedThread(
  previous: ThreadShellOrStub | undefined,
  next: ThreadShellOrStub | undefined,
): void {
  if (previous !== undefined && previous !== next) forgetDerivedThread(previous);
}

/** Forgets the arrays collected from a thread body's id lists. */
export function forgetCollectedRows(
  ...idLists: ReadonlyArray<readonly string[] | undefined>
): void {
  for (const ids of idLists) if (ids !== undefined) collectedByIdsCache.delete(ids);
}
