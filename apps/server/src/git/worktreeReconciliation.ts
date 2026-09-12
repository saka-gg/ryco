import { realpathSync } from "node:fs";
import path from "node:path";

import type { ProjectId, ThreadId, WorktreeId } from "@ryco/contracts";
import {
  isManagedWorktreeBranch,
  isTemporaryWorktreeBranch,
  sanitizeBranchFragment,
  WORKTREE_BRANCH_PREFIX,
} from "@ryco/shared/git";

/**
 * Reconciles what git reports on disk with what the orchestration projection
 * believes about a project's worktrees.
 *
 * Threads record the directory they run in (`worktreePath`) independently of
 * the worktree rows in the projection. The two drift apart whenever a worktree
 * is removed outside Ryco, or when a directory is reached through a different
 * spelling of the same path (a symlinked home, a case-different mount). A
 * thread left pointing at a directory with no worktree row renders in the
 * sidebar as a phantom worktree node named after the thread's branch — a second
 * "main" under the project, holding real sessions but backed by nothing.
 */

export interface ReconcilableProject {
  readonly id: ProjectId;
  readonly workspaceRoot: string;
}

export interface ReconcilableProjectRoots {
  /** Projects whose roots can safely be inspected by git. */
  readonly available: ReadonlyArray<ReconcilableProject>;
  /** Projects retained in history whose roots are currently absent. */
  readonly missing: ReadonlyArray<ReconcilableProject>;
}

/**
 * Missing roots are an availability condition, not permission to delete the
 * project or its thread history. Partition them before invoking git so a
 * removed managed worktree cannot turn every reconnect into a failed sweep.
 */
export function partitionReconcilableProjectRoots(
  projects: ReadonlyArray<ReconcilableProject>,
  pathExists: (workspaceRoot: string) => boolean,
): ReconcilableProjectRoots {
  const available: ReconcilableProject[] = [];
  const missing: ReconcilableProject[] = [];
  for (const project of projects) {
    (pathExists(project.workspaceRoot) ? available : missing).push(project);
  }
  return { available, missing };
}

export interface ReconcilableWorktree {
  readonly worktreeId: WorktreeId;
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
}

export interface ReconcilableThread {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly worktreeId?: WorktreeId | null | undefined;
}

/** A live git worktree holding sessions that Ryco has no row for. */
export interface WorktreeAdoption {
  readonly branch: string;
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly title: string;
  readonly worktreePath: string;
}

export interface WorktreeAttachment {
  readonly threadId: ThreadId;
  readonly worktreeId: WorktreeId;
}

export interface WorktreeReconciliationPlan {
  /** Live git worktrees with sessions but no worktree row; register them. */
  readonly adopt: ReadonlyArray<WorktreeAdoption>;
  /** Threads whose directory has a worktree row they are not linked to. */
  readonly attach: ReadonlyArray<WorktreeAttachment>;
  /**
   * Threads pointing at a directory that is no longer a worktree of this
   * project (removed, or the project root under another spelling). Clearing
   * `worktreePath` returns them to the project root node.
   */
  readonly detach: ReadonlyArray<ThreadId>;
}

export interface PlanWorktreeReconciliationInput {
  readonly worktreeBranchPrefix?: string | undefined;
  /**
   * Resolves a path to its canonical on-disk form (symlinks followed). Injected
   * so the planner stays pure and testable.
   */
  readonly canonicalizePath: (value: string) => string;
  /** True when the filesystem distinguishes `/Foo` from `/foo`. */
  readonly caseSensitiveFileSystem: boolean;
  /** Paths reported by `git worktree list` for this project. */
  readonly gitWorktreePaths: ReadonlyArray<string>;
  readonly project: ReconcilableProject;
  readonly threads: ReadonlyArray<ReconcilableThread>;
  readonly worktrees: ReadonlyArray<ReconcilableWorktree>;
}

/** Only replace a generated directory label; user-chosen titles remain authoritative. */
export function generatedWorktreeTitle(input: {
  readonly worktreeBranchPrefix?: string | undefined;
  readonly branch: string;
  readonly worktreePath: string | null;
  readonly title?: string | null | undefined;
}): string | null {
  if (input.worktreePath === null) return null;
  const directoryName = path.basename(input.worktreePath);
  const prefix = input.worktreeBranchPrefix ?? WORKTREE_BRANCH_PREFIX;
  const isGeneratedDirectory = [prefix, WORKTREE_BRANCH_PREFIX].some((candidate) => {
    const exampleDirectory = sanitizeBranchFragment(
      candidate === "" ? "00000000" : `${candidate}/00000000`,
    ).replaceAll("/", "-");
    // A long namespace can consume the checkout path's 64-character budget.
    // Without the complete random token there is insufficient evidence to retitle it.
    if (!exampleDirectory.endsWith("00000000")) return false;
    const directoryPrefix = exampleDirectory.slice(0, -8);
    return (
      directoryName.startsWith(directoryPrefix) &&
      /^[0-9a-f]{8}(?:__[a-z]{5})?$/.test(directoryName.slice(directoryPrefix.length))
    );
  });
  if (
    !isGeneratedDirectory ||
    (prefix !== "" && !isManagedWorktreeBranch(input.branch, prefix)) ||
    isTemporaryWorktreeBranch(input.branch, prefix) ||
    (input.title != null && input.title !== directoryName)
  )
    return null;
  return input.branch;
}

export function planWorktreeReconciliation(
  input: PlanWorktreeReconciliationInput,
): WorktreeReconciliationPlan {
  // A git repository always lists at least its own root, so an empty listing
  // means git could not answer — not that every worktree disappeared. Detaching
  // on that reading would scatter sessions out of their worktrees.
  if (input.gitWorktreePaths.length === 0) {
    return { adopt: [], attach: [], detach: [] };
  }

  const canonicalCache = new Map<string, string>();
  const canonicalize = (value: string): string => {
    const cached = canonicalCache.get(value);
    if (cached !== undefined) {
      return cached;
    }
    const canonical = input.canonicalizePath(value);
    canonicalCache.set(value, canonical);
    return canonical;
  };
  const pathKey = (value: string): string => {
    const canonical = canonicalize(value);
    return input.caseSensitiveFileSystem ? canonical : canonical.toLowerCase();
  };

  const projectRootKey = pathKey(input.project.workspaceRoot);
  const livePathByKey = new Map<string, string>();
  for (const gitWorktreePath of input.gitWorktreePaths) {
    livePathByKey.set(pathKey(gitWorktreePath), canonicalize(gitWorktreePath));
  }

  const worktreeIdByKey = new Map<string, WorktreeId>();
  for (const worktree of input.worktrees) {
    if (worktree.projectId !== input.project.id || worktree.worktreePath === null) {
      continue;
    }
    worktreeIdByKey.set(pathKey(worktree.worktreePath), worktree.worktreeId);
  }

  const attach: WorktreeAttachment[] = [];
  const detach: ThreadId[] = [];
  const orphanThreadsByKey = new Map<string, ReconcilableThread[]>();

  for (const thread of input.threads) {
    if (thread.projectId !== input.project.id || thread.worktreePath === null) {
      continue;
    }
    const key = pathKey(thread.worktreePath);

    // The thread runs in the project root, just spelled differently. Clearing
    // the path folds it back into the project root node instead of splitting
    // off a duplicate one.
    if (key === projectRootKey) {
      detach.push(thread.id);
      continue;
    }

    const worktreeId = worktreeIdByKey.get(key);
    if (worktreeId !== undefined) {
      if (thread.worktreeId !== worktreeId) {
        attach.push({ threadId: thread.id, worktreeId });
      }
      continue;
    }

    if (!livePathByKey.has(key)) {
      detach.push(thread.id);
      continue;
    }

    const orphans = orphanThreadsByKey.get(key);
    if (orphans) {
      orphans.push(thread);
    } else {
      orphanThreadsByKey.set(key, [thread]);
    }
  }

  const adopt: WorktreeAdoption[] = [];
  for (const [key, threads] of orphanThreadsByKey) {
    const worktreePath = livePathByKey.get(key);
    if (worktreePath === undefined) {
      continue;
    }
    const directoryName = path.basename(worktreePath);
    const branch = threads.find((thread) => thread.branch !== null)?.branch ?? directoryName;
    // Older New Thread worktrees were not registered until reconciliation. Their
    // generated directory is stable, while the branch receives the useful name.
    const title =
      generatedWorktreeTitle({
        branch,
        worktreePath,
        worktreeBranchPrefix: input.worktreeBranchPrefix,
      }) ?? directoryName;
    adopt.push({
      // Only threads know which ref the directory was checked out on when they
      // ran; `refreshWorktreeSourceControlState` corrects it afterwards.
      branch,
      threadIds: threads.map((thread) => thread.id),
      title,
      worktreePath,
    });
  }

  return { adopt, attach, detach };
}

/**
 * Resolves symlinks so the same directory reached two ways compares equal.
 * Falls back to `path.resolve` when the path no longer exists — a missing
 * directory is exactly the case the planner needs to detach.
 */
export function canonicalizeFilesystemPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export const isCaseSensitiveFileSystem = (platform: NodeJS.Platform = process.platform): boolean =>
  platform !== "darwin" && platform !== "win32";
