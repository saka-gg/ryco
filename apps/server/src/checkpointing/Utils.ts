import { Base64Url } from "effect/encoding";
import { CheckpointRef, ProjectId, type ThreadId } from "@ryco/contracts";

/** Every hidden ref Ryco writes lives under this namespace. */
export const RYCO_REFS_PREFIX = "refs/ryco";
export const CHECKPOINT_REFS_PREFIX = `${RYCO_REFS_PREFIX}/checkpoints`;
export const FORK_PIN_REFS_PREFIX = `${RYCO_REFS_PREFIX}/forks`;

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Base64Url.encode(threadId)}/turn/${turnCount}`,
  );
}

/**
 * The snapshot of the checkout a revert takes right before it restores a checkpoint's
 * files, so a restore that fails part way can be put back. Named after the revert, so
 * startup recovery finds the snapshot of a revert that stopped while restoring; the
 * recovery saves the checkout as it found it under the `"recovery"` sibling (a ref of
 * its own name, since git cannot nest a ref under another). Deleted once the files are
 * restored or put back; kept, and named to the user, when neither worked.
 */
export function checkpointRefForThreadRevertRescue(
  threadId: ThreadId,
  revertRequestId: string,
  snapshot: "revert" | "recovery" = "revert",
): CheckpointRef {
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Base64Url.encode(threadId)}/revert-rescue/${Base64Url.encode(revertRequestId)}${snapshot === "recovery" ? ".recovery" : ""}`,
  );
}

/**
 * Refs a fork owns while it prepares a new worktree. They pin the commits resolved at
 * acceptance, so a later source revert (which deletes and reuses checkpoint refs) or garbage
 * collection cannot take them away. Deleted once the fork completes.
 */
export function forkPinRefs(forkThreadId: ThreadId): {
  /** The new branch's start commit. */
  readonly base: CheckpointRef;
  /** The checkpoint snapshot overlaid on it. */
  readonly checkpoint: CheckpointRef;
} {
  const root = `${FORK_PIN_REFS_PREFIX}/${Base64Url.encode(forkThreadId)}`;
  return {
    base: CheckpointRef.make(`${root}/base`),
    checkpoint: CheckpointRef.make(`${root}/checkpoint`),
  };
}

export function resolveThreadWorkspaceCwd(input: {
  readonly thread: {
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  };
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
}): string | undefined {
  const worktreeCwd = input.thread.worktreePath ?? undefined;
  if (worktreeCwd) {
    return worktreeCwd;
  }

  return input.projects.find((project) => project.id === input.thread.projectId)?.workspaceRoot;
}
