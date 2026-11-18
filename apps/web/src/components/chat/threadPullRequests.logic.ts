import type { ChangeRequest } from "@ryco/contracts";
import {
  visiblePullRequestLinks,
  type WorktreePullRequestLink,
} from "@ryco/shared/worktreePullRequests";
import type { useGitStatus } from "~/lib/gitStatusState";

/*
 * A thread's pull requests, apart from the overview panel's logic: the chat
 * view resolves them on every thread, the overview panel loads lazily.
 */

export type GitStatusData = NonNullable<ReturnType<typeof useGitStatus>["data"]>;

export function branchNameCandidates(branchName: string | null | undefined): ReadonlySet<string> {
  const candidates = new Set<string>();
  const trimmed = branchName?.trim() ?? "";
  if (trimmed.length === 0) {
    return candidates;
  }
  candidates.add(trimmed);

  const firstSlashIndex = trimmed.indexOf("/");
  if (firstSlashIndex > 0 && firstSlashIndex < trimmed.length - 1) {
    const prefix = trimmed.slice(0, firstSlashIndex);
    if (prefix === "origin" || prefix === "upstream") {
      candidates.add(trimmed.slice(firstSlashIndex + 1));
    }
  }

  return candidates;
}

export function findChangeRequestForBranch(
  changeRequests: ReadonlyArray<ChangeRequest> | null | undefined,
  branchName: string | null | undefined,
): ChangeRequest | null {
  const candidates = branchNameCandidates(branchName);
  if (candidates.size === 0) {
    return null;
  }
  return changeRequests?.find((request) => candidates.has(request.headRefName)) ?? null;
}

/** The pull request git status reports for the checkout's branch. */
export type LiveBranchPullRequest = NonNullable<NonNullable<GitStatusData["pr"]>>;

/**
 * A thread's pull requests: the workspace's links plus the pull request git
 * status reports for the checkout's branch (it sees a follow-up before the
 * server links it), current first. Where the server discovers the workspace's
 * pull requests, a finished one it never linked is stale (a reused branch
 * name's old pull request) and stays out; elsewhere (no workspace record, the
 * main checkout, an older server) git status is all there is. The current one
 * is the newest open pull request, else the most recently finished — never a
 * stale merged link hiding a newer open one.
 */
export function resolveThreadPullRequests(input: {
  readonly links: ReadonlyArray<WorktreePullRequestLink>;
  readonly live: LiveBranchPullRequest | null;
  /** `workspaceDiscoversPullRequests(worktree)`. */
  readonly discoversPullRequests: boolean;
}): WorktreePullRequestLink[] {
  const live = input.live;
  // A dismissed number stays dismissed even while git status reports it.
  const known = live !== null && input.links.some((link) => link.number === live.number);
  const candidates =
    live === null || known || (input.discoversPullRequests && live.state !== "open")
      ? input.links
      : [
          ...input.links,
          {
            number: live.number,
            title: live.title,
            url: live.url,
            state: live.state,
            isDraft: null,
            terminalAt: null,
            headRefName: live.headRef,
            baseRefName: live.baseRef,
            source: "discovered" as const,
            linkedAt: null,
            dismissedAt: null,
          },
        ];
  return visiblePullRequestLinks(candidates);
}
