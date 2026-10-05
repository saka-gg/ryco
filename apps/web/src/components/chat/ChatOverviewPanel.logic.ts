import type { ChangeRequest } from "@ryco/contracts";
import type { OverviewPanelItem } from "../PlanSidebar";
import { OVERVIEW_CHECK_DETAIL_RUN_LIMIT } from "../overviewPullRequestChecks.logic";
import { buildOverviewChangesItem, partitionOverviewChangedFiles } from "../overviewChanges.logic";
import type { OverviewChangedFile } from "../overview/overviewTypes";
import type { useGitStatus } from "~/lib/gitStatusState";

export type GitStatusData = NonNullable<ReturnType<typeof useGitStatus>["data"]>;

export function compactQueryErrorMessage(error: unknown): string | undefined {
  if (!error) return undefined;
  const message = error instanceof Error ? error.message : "Failed to load.";
  const providerMatch = /^Source control provider [^ ]+ failed in [^:]+:\s*(.*)$/u.exec(message);
  return providerMatch?.[1] ?? message;
}

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

export function resolveOverviewPullRequestNumber(input: {
  activeWorktreePrNumber: number | null;
  gitStatusPrNumber: number | null;
  overviewBranchPullRequestNumber: number | null;
  postPushWatchPullRequestNumber: number | null;
}): number | null {
  return (
    input.activeWorktreePrNumber ??
    input.gitStatusPrNumber ??
    input.overviewBranchPullRequestNumber ??
    input.postPushWatchPullRequestNumber ??
    null
  );
}

export function resolveWorkflowDetailRunIds(input: {
  workflowRunsSupported: boolean;
  pullRequestNumber: number | null;
  /** Branch scope when there is no pull request (default branch). */
  branchName?: string | null;
  runs: ReadonlyArray<{ runId: string }> | undefined;
  activeWorkflowRunId: string | null;
}): string[] {
  if (
    !input.workflowRunsSupported ||
    (input.pullRequestNumber === null && (input.branchName ?? null) === null)
  ) {
    return [];
  }
  const runs = input.runs ?? [];
  const runIds = runs.slice(0, OVERVIEW_CHECK_DETAIL_RUN_LIMIT).map((run) => run.runId);
  if (input.activeWorkflowRunId && !runIds.includes(input.activeWorkflowRunId)) {
    return [input.activeWorkflowRunId, ...runIds].slice(0, OVERVIEW_CHECK_DETAIL_RUN_LIMIT);
  }
  return runIds;
}

export interface BuildOverviewItemsInput {
  gitStatusData: GitStatusData | null | undefined;
  /**
   * The unified changed-file list (turn summaries ∪ working tree) that also
   * drives the expanded Changes view, so the collapsed summary and the file
   * list always agree. See {@link buildOverviewChangedFiles}.
   */
  changedFiles: ReadonlyArray<OverviewChangedFile>;
  overviewPullRequestNumber: number | null;
}

export function buildOverviewItems(input: BuildOverviewItemsInput): OverviewPanelItem[] {
  const items: OverviewPanelItem[] = [];
  // Show the Changes item whenever the repo status has loaded or the session
  // already has tracked changes (turn summaries can populate the list before
  // `useGitStatus()` resolves).
  if (input.gitStatusData || input.changedFiles.length > 0) {
    const { committed, local } = partitionOverviewChangedFiles(input.changedFiles);
    const changesItem = buildOverviewChangesItem({
      committed,
      local,
      pullRequestNumber: input.overviewPullRequestNumber,
    });
    items.push({ ...changesItem, action: "review", icon: "changes" });
  }

  return items;
}

export {
  areOverviewWorkflowRunsSupported,
  buildOverviewCheckRollupRows,
  buildOverviewWorkflowCheckRows,
  isOverviewActiveCheckKind,
  isOverviewActiveWorkflowRun,
  OVERVIEW_CHECK_DETAIL_RUN_LIMIT,
  selectOverviewChecksError,
  summarizeActiveWorkflowJob,
} from "../overviewPullRequestChecks.logic";
export {
  selectActivePostPushWorkflowDiscoveryWatch,
  hasDiscoveredPostPushWorkflowRun,
  resolveWorkflowRunsRefetchInterval,
} from "../postPushWorkflowDiscovery.logic";
export type { PostPushWorkflowDiscoveryWatch } from "../postPushWorkflowDiscovery.logic";
export {
  getPrCheckStatusForQuery,
  getPrCheckStatusFromChangeRequest,
  getPrCheckStatusFromWorkflowRuns,
  shouldRefreshPrCheckStatus,
  sourceControlOptionValue,
} from "../projectExplorer/prCheckStatus";
