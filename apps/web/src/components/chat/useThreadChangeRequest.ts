import type { ChangeRequest, EnvironmentId } from "@ryco/contracts";
import { useMemo } from "react";

import { useGitStatus } from "~/lib/gitStatusState";
import { useOverviewChangeRequestList } from "~/rpc/useOverview";
import {
  findChangeRequestForBranch,
  resolveOverviewPullRequestNumber,
} from "./ChatOverviewPanel.logic";

/**
 * The change request a thread works on: its worktree's linked change request,
 * else the one git status reports for the checkout, else an open change
 * request whose head is the thread's branch, else (overview only) the one a
 * push just opened. The overview and the workspace panel's pull request tab
 * both read it, so they agree on which change request is "this thread's";
 * the push watch lives in the chat, so the overview hands a pushed number to
 * the panel explicitly (`fromPush`). The branch list is only read when
 * neither of the cheaper sources knows.
 */
export function useThreadChangeRequest(input: {
  readonly environmentId: EnvironmentId | null;
  readonly gitCwd: string | null;
  readonly worktreeBranch: string | null;
  readonly threadBranch: string | null;
  readonly worktreePrNumber: number | null;
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
  const gitStatusPrNumber = gitStatusQuery.data?.pr?.number ?? null;
  const branchListEnabled =
    enabled && branchName !== null && input.worktreePrNumber == null && gitStatusPrNumber == null;
  const branchListQuery = useOverviewChangeRequestList({
    environmentId: input.environmentId,
    cwd: input.gitCwd,
    enabled: branchListEnabled,
  });
  const branchChangeRequest = useMemo<ChangeRequest | null>(
    () => findChangeRequestForBranch(branchListQuery.data, branchName),
    [branchListQuery.data, branchName],
  );
  const resolvedNumber = resolveOverviewPullRequestNumber({
    activeWorktreePrNumber: input.worktreePrNumber,
    gitStatusPrNumber,
    overviewBranchPullRequestNumber: branchChangeRequest?.number ?? null,
    postPushWatchPullRequestNumber: null,
  });
  const number = resolvedNumber ?? input.pushedPullRequestNumber ?? null;
  return {
    gitStatusQuery,
    branchName,
    branchChangeRequest,
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
