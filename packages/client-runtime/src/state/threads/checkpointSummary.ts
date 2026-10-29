import type { TurnId } from "@ryco/contracts";

import type { TurnDiffSummary } from "./types.ts";

/**
 * `ProviderRuntimeIngestion` records a provider-reported diff under this fake ref (status
 * `missing`) on a turn's first `turn.diff.updated`, before `CheckpointReactor` captures the
 * real checkpoint. It names no commit.
 */
export const PROVIDER_DIFF_CHECKPOINT_REF_PREFIX = "provider-diff:";

/**
 * Whether a turn's checkpoint names a captured snapshot that can be restored or checked out:
 * a missing or errored summary has nothing behind it, and a `provider-diff:` ref is a reported
 * diff rather than a checkpoint Ryco captured. The one client rule for undo and for starting a
 * fork's worktree from a turn; the server re-checks before it acts.
 */
export function isMaterializableCheckpointSummary(
  summary: Pick<TurnDiffSummary, "status" | "checkpointRef"> | null | undefined,
): boolean {
  if (!summary || summary.status === "missing" || summary.status === "error") return false;
  return (
    summary.checkpointRef !== undefined &&
    !summary.checkpointRef.startsWith(PROVIDER_DIFF_CHECKPOINT_REF_PREFIX)
  );
}

/**
 * Rollback target for each turn whose edits can still be undone, keyed by turn.
 *
 * A turn is undoable only when its checkpoint is real and reachable — the
 * shared `isMaterializableCheckpointSummary` rule, which also decides whether a
 * fork's worktree can start from the turn's checkpoint. The stored count is the
 * turn *before* this one — undoing means returning the tree to how it looked
 * when the turn started.
 */
export function deriveUndoTurnCountByTurnId(input: {
  readonly turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  readonly inferredCheckpointTurnCountByTurnId: Readonly<
    Partial<Record<TurnDiffSummary["turnId"], number>>
  >;
}): Map<TurnId, number> {
  const byTurnId = new Map<TurnId, number>();
  for (const summary of input.turnDiffSummaries) {
    if (!isMaterializableCheckpointSummary(summary) || summary.files.length === 0) continue;
    const turnCount =
      summary.checkpointTurnCount ?? input.inferredCheckpointTurnCountByTurnId[summary.turnId];
    if (typeof turnCount === "number") {
      byTurnId.set(summary.turnId, Math.max(0, turnCount - 1));
    }
  }
  return byTurnId;
}
