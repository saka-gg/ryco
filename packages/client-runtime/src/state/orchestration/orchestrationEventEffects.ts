import type { OrchestrationEvent, ThreadId } from "@ryco/contracts";
import { CHECKPOINT_REVERT_ACTIVITY_KIND } from "@ryco/contracts/orchestration";

/**
 * Checkpoint diffs of one thread that may answer differently now. A diff
 * between two turn counts reads two checkpoint commits, so it changes only
 * when one of them does: every range of a reverted thread (its turn counts
 * are reused), or a range that reads the checkpoint a completed turn just
 * captured (`fromTurnCount`: ranges that reach that turn, and ones that never
 * resolved). Every other cached diff stays exactly as it is.
 */
export interface CheckpointDiffChange {
  readonly threadId: ThreadId;
  /** Null: every range of the thread. */
  readonly fromTurnCount: number | null;
}

export interface OrchestrationBatchEffects {
  promoteDraftThreadIds: ThreadId[];
  clearDeletedThreadIds: ThreadId[];
  removeTerminalStateThreadIds: ThreadId[];
  /** Files changed in some thread's checkout: the node-owned file caches are stale. */
  needsProviderInvalidation: boolean;
  /** Threads whose checkout files changed (turn diffs, reverts, files-only reverts). */
  changedFileThreadIds: ThreadId[];
  checkpointDiffChanges: CheckpointDiffChange[];
}

/**
 * A files-only revert (`thread.files.revert`) changes files without
 * `thread.reverted`: its journal row reaching an end says so. Checkpoints stay.
 */
function isFinishedFilesRevert(event: OrchestrationEvent): boolean {
  if (event.type !== "thread.activity-appended") return false;
  const { activity } = event.payload;
  if (activity.kind !== CHECKPOINT_REVERT_ACTIVITY_KIND) return false;
  const payload = activity.payload as {
    readonly status?: unknown;
    readonly rollbackConversation?: unknown;
  } | null;
  return (
    payload?.rollbackConversation === false &&
    payload.status !== "requested" &&
    payload.status !== "restoring-files"
  );
}

function noteCheckpointDiffChange(
  changes: Map<ThreadId, number | null>,
  threadId: ThreadId,
  fromTurnCount: number | null,
): void {
  if (!changes.has(threadId)) {
    changes.set(threadId, fromTurnCount);
    return;
  }
  const current = changes.get(threadId) ?? null;
  if (current === null) return;
  changes.set(threadId, fromTurnCount === null ? null : Math.min(current, fromTurnCount));
}

export function deriveOrchestrationBatchEffects(
  events: readonly OrchestrationEvent[],
): OrchestrationBatchEffects {
  const threadLifecycleEffects = new Map<
    ThreadId,
    {
      clearPromotedDraft: boolean;
      clearDeletedThread: boolean;
      removeTerminalState: boolean;
    }
  >();
  const changedFileThreadIds = new Set<ThreadId>();
  const checkpointDiffChanges = new Map<ThreadId, number | null>();

  for (const event of events) {
    switch (event.type) {
      case "thread.turn-diff-completed": {
        changedFileThreadIds.add(event.payload.threadId);
        noteCheckpointDiffChange(
          checkpointDiffChanges,
          event.payload.threadId,
          event.payload.checkpointTurnCount,
        );
        break;
      }

      case "thread.reverted": {
        changedFileThreadIds.add(event.payload.threadId);
        noteCheckpointDiffChange(checkpointDiffChanges, event.payload.threadId, null);
        break;
      }

      case "thread.activity-appended": {
        if (isFinishedFilesRevert(event)) changedFileThreadIds.add(event.payload.threadId);
        break;
      }

      case "thread.created": {
        threadLifecycleEffects.set(event.payload.threadId, {
          clearPromotedDraft: true,
          clearDeletedThread: false,
          removeTerminalState: false,
        });
        break;
      }

      case "thread.deleted": {
        threadLifecycleEffects.set(event.payload.threadId, {
          clearPromotedDraft: false,
          clearDeletedThread: true,
          removeTerminalState: true,
        });
        break;
      }

      // Trash keeps the unsent draft: restoring the conversation brings it back intact.
      case "thread.trashed":
      case "thread.archived": {
        threadLifecycleEffects.set(event.payload.threadId, {
          clearPromotedDraft: false,
          clearDeletedThread: false,
          removeTerminalState: true,
        });
        break;
      }

      case "thread.unarchived": {
        threadLifecycleEffects.set(event.payload.threadId, {
          clearPromotedDraft: false,
          clearDeletedThread: false,
          removeTerminalState: false,
        });
        break;
      }

      default: {
        break;
      }
    }
  }

  const promoteDraftThreadIds: ThreadId[] = [];
  const clearDeletedThreadIds: ThreadId[] = [];
  const removeTerminalStateThreadIds: ThreadId[] = [];
  for (const [threadId, effect] of threadLifecycleEffects) {
    if (effect.clearPromotedDraft) {
      promoteDraftThreadIds.push(threadId);
    }
    if (effect.clearDeletedThread) {
      clearDeletedThreadIds.push(threadId);
    }
    if (effect.removeTerminalState) {
      removeTerminalStateThreadIds.push(threadId);
    }
  }

  return {
    promoteDraftThreadIds,
    clearDeletedThreadIds,
    removeTerminalStateThreadIds,
    needsProviderInvalidation: changedFileThreadIds.size > 0,
    changedFileThreadIds: [...changedFileThreadIds],
    checkpointDiffChanges: Array.from(checkpointDiffChanges, ([threadId, fromTurnCount]) => ({
      threadId,
      fromTurnCount,
    })),
  };
}
