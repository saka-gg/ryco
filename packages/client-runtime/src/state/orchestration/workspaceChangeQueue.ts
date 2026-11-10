import type { EnvironmentId, ThreadId } from "@ryco/contracts";

import type { CheckpointDiffChange, OrchestrationBatchEffects } from "./orchestrationEventEffects.ts";

/**
 * Turn diffs and reverts change files in one thread's checkout. The queue
 * collects those checkouts, and the checkpoint diff ranges they touched,
 * across a throttled batch so a flush drops only what changed: the file
 * caches (tree, reads, search) of those checkouts and the diffs of those
 * ranges, instead of every environment's files and every diff on screen.
 * A thread whose checkout is unknown invalidates its whole environment.
 */
export interface WorkspaceChangeQueue {
  readonly note: (
    environmentId: EnvironmentId,
    effects: Pick<OrchestrationBatchEffects, "changedFileThreadIds" | "checkpointDiffChanges">,
  ) => void;
  readonly flush: () => void;
  readonly reset: () => void;
}

export interface WorkspaceChangeQueueDependencies {
  /** The checkout a thread works in (its worktree, else its project root), or null. */
  readonly resolveThreadCwd: (environmentId: EnvironmentId, threadId: ThreadId) => string | null;
  /** `cwd` null: every checkout of the environment. */
  readonly invalidateCheckout: (environmentId: EnvironmentId, cwd: string | null) => void;
  readonly invalidateCheckpointDiffs: (changes: ReadonlyArray<CheckpointDiffChange>) => void;
}

export function createWorkspaceChangeQueue(
  dependencies: WorkspaceChangeQueueDependencies,
): WorkspaceChangeQueue {
  const pendingThreadsByEnvironment = new Map<EnvironmentId, Set<ThreadId>>();
  /** Per thread, the earliest turn count a change reached; null: every range. */
  const pendingDiffChanges = new Map<ThreadId, number | null>();

  return {
    note: (environmentId, effects) => {
      for (const threadId of effects.changedFileThreadIds) {
        let threads = pendingThreadsByEnvironment.get(environmentId);
        if (!threads) {
          threads = new Set();
          pendingThreadsByEnvironment.set(environmentId, threads);
        }
        threads.add(threadId);
      }
      for (const change of effects.checkpointDiffChanges) {
        if (!pendingDiffChanges.has(change.threadId)) {
          pendingDiffChanges.set(change.threadId, change.fromTurnCount);
          continue;
        }
        const current = pendingDiffChanges.get(change.threadId) ?? null;
        if (current === null) continue;
        pendingDiffChanges.set(
          change.threadId,
          change.fromTurnCount === null ? null : Math.min(current, change.fromTurnCount),
        );
      }
    },
    flush: () => {
      const pendingCheckouts = [...pendingThreadsByEnvironment];
      const diffChanges = Array.from(pendingDiffChanges, ([threadId, fromTurnCount]) => ({
        threadId,
        fromTurnCount,
      }));
      pendingThreadsByEnvironment.clear();
      pendingDiffChanges.clear();
      if (diffChanges.length > 0) dependencies.invalidateCheckpointDiffs(diffChanges);
      for (const [environmentId, threadIds] of pendingCheckouts) {
        const cwds = new Set<string>();
        let unresolved = false;
        for (const threadId of threadIds) {
          const cwd = dependencies.resolveThreadCwd(environmentId, threadId);
          if (cwd === null) {
            unresolved = true;
            break;
          }
          cwds.add(cwd);
        }
        if (unresolved) {
          dependencies.invalidateCheckout(environmentId, null);
          continue;
        }
        for (const cwd of cwds) dependencies.invalidateCheckout(environmentId, cwd);
      }
    },
    reset: () => {
      pendingThreadsByEnvironment.clear();
      pendingDiffChanges.clear();
    },
  };
}
