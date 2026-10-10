import type { ChangeRequest, EnvironmentId } from "@ryco/contracts";
import type { WorktreePullRequestLink } from "@ryco/shared/worktreePullRequests";
import { useMemo } from "react";

import { useGitStatus } from "~/lib/gitStatusState";
import { useOverviewChangeRequestList } from "~/rpc/useOverview";
import { findChangeRequestForBranch, resolveThreadPullRequests } from "./ChatOverviewPanel.logic";

/**
 * The change requests a thread works on. The workspace's links (a shipped
 * pull request and its follow-up, stack layers, manual links) plus whatever
 * git status reports for the checkout, current first; with none of those, an
 * open change request whose head is the thread's branch, else (overview only)
 * the one a push just opened. The overview and the workspace panel's pull
 * request tab both read it, so they agree on which change request is current;
 * the push watch lives in the chat, so the overview hands a pushed number to
 * the panel explicitly (`fromPush`). The branch list is only read when no
 * cheaper source knows.
 */
export function useThreadChangeRequest(input: {
  readonly environmentId: EnvironmentId | null;
  readonly gitCwd: string | null;
  readonly worktreeBranch: string | null;
  readonly threadBranch: string | null;
  /** The workspace's links (`readWorktreePullRequestLinks`); empty without a workspace. */
  readonly worktreePullRequests: ReadonlyArray<WorktreePullRequestLink>;
  /** `workspaceDiscoversPullRequests(worktree)`: the server links the branch's pull requests. */
  readonly discoversPullRequests: boolean;
  /** A push that just opened a change request names it before git status does. */
  readonly pushedPullRequestNumber?: number | null | undefined;
  /** Off where the result is unused (the frozen phone tier's workspace). */
  readonly enabled?: boolean | undefined;
}) {
  const enabled = input.enabled ?? true;
  const gitStatusQuery = useGitStatus(
    { environmentId: input.environmentId, cwd: input.gitCwd },
    { enabled },
  );
  const branchName =
    input.worktreeBranch ?? input.threadBranch ?? gitStatusQuery.data?.refName ?? null;
  const live = gitStatusQuery.data?.pr ?? null;
  const links = useMemo(
    () =>
      resolveThreadPullRequests({
        links: input.worktreePullRequests,
        live,
        discoversPullRequests: input.discoversPullRequests,
      }),
    [input.discoversPullRequests, input.worktreePullRequests, live],
  );
  const branchListEnabled = enabled && branchName !== null && links.length === 0;
  const branchListQuery = useOverviewChangeRequestList({
    environmentId: input.environmentId,
    cwd: input.gitCwd,
    enabled: branchListEnabled,
  });
  const branchChangeRequest = useMemo<ChangeRequest | null>(() => {
    const found = findChangeRequestForBranch(branchListQuery.data, branchName);
    // The list only runs with no visible link: a stored number here was dismissed.
    return found && !input.worktreePullRequests.some((link) => link.number === found.number)
      ? found
      : null;
  }, [branchListQuery.data, branchName, input.worktreePullRequests]);
  const current = links[0] ?? null;
  const resolvedNumber = current?.number ?? branchChangeRequest?.number ?? null;
  const number = resolvedNumber ?? input.pushedPullRequestNumber ?? null;
  return {
    gitStatusQuery,
    branchName,
    branchChangeRequest,
    /** Every pull request the thread's workspace carries, current first. */
    links,
    /** The current link, when the current pull request is a link (not a branch-list find). */
    current,
    number,
    /** Only the push watch knows this change request (git status has not caught up). */
    fromPush: resolvedNumber === null && number !== null,
    /** No source has answered yet (git status, or the branch list it fell back to). */
    resolving:
      enabled &&
      number === null &&
      input.gitCwd !== null &&
      ((gitStatusQuery.data === null && gitStatusQuery.error === null) ||
        (branchListEnabled && branchListQuery.isLoading)),
  };
}
