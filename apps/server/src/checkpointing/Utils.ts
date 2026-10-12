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
