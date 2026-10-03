import type {
  SidebarThreadSummary,
  SidebarWorktreeSummary,
} from "@ryco/client-runtime/state/threads";

/**
 * Which agent threads belong to a pull request, and where a new hand-off
 * thread should run. Both read the sidebar's thread and worktree summaries
 * for the pull request's project; nothing here touches the network.
 */

export interface PullRequestThreadLink {
  readonly number: number;
  readonly headRefName: string | null;
  /**
   * The head lives in another repository (a fork). Its branch name says
   * nothing about local branches then: a contributor's `main` is not ours.
   */
  readonly isCrossRepository?: boolean | undefined;
}

/**
 * The head branch as a local branch name, or null when a branch of that name
 * cannot be this pull request's head. Fork heads are checked out under their
 * own name (`pr-<n>/<branch>`), so they link by pull request number only.
 */
export function localHeadBranch(link: PullRequestThreadLink): string | null {
  return link.isCrossRepository === true ? null : link.headRefName;
}

type WorktreeLike = Pick<
  SidebarWorktreeSummary,
  "id" | "branch" | "worktreePath" | "prNumber" | "archivedAt" | "updatedAt"
>;
type ThreadLike = Pick<
  SidebarThreadSummary,
  | "id"
  | "branch"
  | "worktreePath"
  | "worktreeId"
  | "archivedAt"
  | "updatedAt"
  | "createdAt"
  | "latestUserMessageAt"
>;

/**
 * A live worktree checked out for this pull request: linked by number, else
 * (same-repository heads only) by head branch.
 */
export function findPullRequestWorktree<T extends WorktreeLike>(
  worktrees: ReadonlyArray<T>,
  link: PullRequestThreadLink,
): T | null {
  const live = worktrees.filter(
    (worktree) => worktree.archivedAt === null && worktree.worktreePath !== null,
  );
  const byRecency = (left: T, right: T) => right.updatedAt.localeCompare(left.updatedAt);
  const branch = localHeadBranch(link);
  return (
    live.filter((worktree) => worktree.prNumber === link.number).toSorted(byRecency)[0] ??
    (branch
      ? live.filter((worktree) => worktree.branch === branch).toSorted(byRecency)[0]
      : undefined) ??
    null
  );
}

function threadRecency(thread: ThreadLike): string {
  return thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt;
}

/**
 * Agent threads working on this pull request: threads in a worktree linked to
 * it, or (same-repository heads only) on its head branch. Archived threads are
 * left out; newest first.
 */
export function linkedAgentThreads<T extends ThreadLike>(input: {
  readonly threads: ReadonlyArray<T>;
  readonly worktrees: ReadonlyArray<WorktreeLike>;
  readonly link: PullRequestThreadLink;
  readonly limit?: number;
}): ReadonlyArray<T> {
  const branch = localHeadBranch(input.link);
  const linkedWorktrees = input.worktrees.filter(
    (worktree) =>
      worktree.prNumber === input.link.number || (branch !== null && worktree.branch === branch),
  );
  const worktreeIds = new Set(linkedWorktrees.map((worktree) => worktree.id as string));
  const worktreePaths = new Set(
    linkedWorktrees.flatMap((worktree) => (worktree.worktreePath ? [worktree.worktreePath] : [])),
  );
  return input.threads
    .filter(
      (thread) =>
        thread.archivedAt === null &&
        ((thread.worktreeId != null && worktreeIds.has(thread.worktreeId)) ||
          (thread.worktreePath !== null && worktreePaths.has(thread.worktreePath)) ||
          (branch !== null && thread.branch === branch)),
    )
    .toSorted((left, right) => threadRecency(right).localeCompare(threadRecency(left)))
    .slice(0, input.limit ?? 4);
}

/** When the thread last moved, for its row's relative time. */
export function agentThreadActivityAt(thread: ThreadLike): string {
  return threadRecency(thread);
}

// ── Hand-off prompt ──────────────────────────────────────────────────

/**
 * The first message of a hand-off thread: the prompt as the user would write
 * it, then the quoted material (thread excerpt, log tail, selected lines) in a
 * fence long enough that backticks inside it cannot close it early.
 */
export function composeHandoffPrompt(prompt: string, context?: string): string {
  const text = prompt.trimEnd();
  const material = context?.replace(/\s+$/u, "");
  if (!material) return text;
  const longestRun = Math.max(2, ...[...material.matchAll(/`+/gu)].map((run) => run[0].length));
  const fence = "`".repeat(longestRun + 1);
  return `${text}${text ? "\n\n" : ""}${fence}\n${material}\n${fence}\n`;
}

export type HandoffWorkLocation =
  /** Reuse a live worktree already checked out for the pull request. */
  | { readonly kind: "existing-worktree"; readonly worktreePath: string; readonly branch: string }
  /** The project checkout is already on the head branch. */
  | { readonly kind: "project-root"; readonly branch: string }
  /** Check the pull request out into its own worktree first (`createWorktreeForProject`). */
  | { readonly kind: "new-worktree" };

/**
 * Where a hand-off runs: a live worktree for the pull request, else the
 * project checkout when it is already on a same-repository head, else a fresh
 * pull request worktree. A fork's head never matches the project checkout by
 * name; it always gets the host's own checkout of the pull request.
 */
export function resolveHandoffWorkLocation(input: {
  readonly worktree: Pick<WorktreeLike, "worktreePath" | "branch"> | null;
  readonly projectBranch: string | null;
  readonly link: PullRequestThreadLink;
}): HandoffWorkLocation {
  if (input.worktree?.worktreePath) {
    return {
      kind: "existing-worktree",
      worktreePath: input.worktree.worktreePath,
      branch: input.worktree.branch,
    };
  }
  const branch = localHeadBranch(input.link);
  if (branch && input.projectBranch === branch) {
    return { kind: "project-root", branch };
  }
  return { kind: "new-worktree" };
}
