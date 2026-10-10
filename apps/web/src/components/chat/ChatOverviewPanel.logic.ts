import type { ChangeRequest } from "@ryco/contracts";
import {
  visiblePullRequestLinks,
  type WorktreePullRequestLink,
} from "@ryco/shared/worktreePullRequests";
import type { OverviewPanelItem } from "../PlanSidebar";
import { OVERVIEW_CHECK_DETAIL_RUN_LIMIT } from "../overviewPullRequestChecks.logic";
import { buildOverviewChangesItem, partitionOverviewChangedFiles } from "../overviewChanges.logic";
import type { OverviewChangedFile, OverviewPullRequestCheckRun } from "../overview/overviewTypes";
import type { useGitStatus } from "~/lib/gitStatusState";
import {
  formatWorkspacePullRequestReveal,
  parseWorkspacePullRequestReveal,
  type WorkspacePullRequestReveal,
} from "~/workspaceRouteSearch";

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

/**
 * Where a check row lands in the pull request reader: its job when the row
 * names one the route can carry, otherwise the Checks tab.
 */
export function overviewCheckReveal(
  check: Pick<OverviewPullRequestCheckRun, "jobParam">,
): WorkspacePullRequestReveal {
  if (check.jobParam === undefined) return { kind: "checks" };
  // Round-trip through the route parser so a value the URL would drop (empty,
  // over-long) still lands on the Checks tab.
  return (
    parseWorkspacePullRequestReveal(
      formatWorkspacePullRequestReveal({ kind: "job", job: check.jobParam }),
    ) ?? { kind: "checks" }
  );
}

export type OpenPullRequestInApp = (
  pinnedNumber?: number,
  reveal?: WorkspacePullRequestReveal,
) => void;

export interface OverviewPullRequestOpeners {
  /** The shown pull request without a number, another of the workspace's pinned. */
  onOpenPullRequestInApp?: (number?: number) => void;
  onOpenPullRequestCheck?: (check: OverviewPullRequestCheckRun) => void;
}

/**
 * The overview's in-app pull request openers, or none without an opener or a
 * pull request to open (default-branch CI keeps its host links).
 */
export function buildOverviewPullRequestOpeners(input: {
  readonly open: OpenPullRequestInApp | null | undefined;
  readonly pullRequestNumber: number | null | undefined;
  /**
   * Only the post-push watch knows this number: it has to travel in the URL.
   * Otherwise the panel resolves the thread's change request itself.
   */
  readonly pinFromPush: boolean;
}): OverviewPullRequestOpeners {
  const { open, pullRequestNumber } = input;
  if (!open || pullRequestNumber == null) return {};
  const pinned = input.pinFromPush ? pullRequestNumber : undefined;
  return {
    // Only another of the workspace's pull requests, or a number the push watch
    // alone knows, has to travel in the URL.
    onOpenPullRequestInApp: (number) =>
      open(number !== undefined && number !== pullRequestNumber ? number : pinned),
    onOpenPullRequestCheck: (check) => open(pinned, overviewCheckReveal(check)),
  };
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
