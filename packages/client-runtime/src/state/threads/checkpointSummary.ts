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
