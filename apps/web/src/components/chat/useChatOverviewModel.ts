import type {
  ChangeRequest,
  ChangeRequestState,
  EnvironmentId,
  SourceControlWorkflowRunListResult,
  VcsStatusResult,
} from "@ryco/contracts";
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";

import { useSettings } from "~/hooks/useSettings";
import { invalidateSourceControl } from "~/rpc/useSourceControl";
import {
  useOverviewPullRequestDetail,
  useOverviewWorkflowRunJobs,
  useOverviewWorkflowRuns,
} from "~/rpc/useOverview";
import type { ActivePlanState, LatestProposedPlanState } from "../../session-logic";
import type { ThreadSubagentView } from "../../threadWorkspaceViewModel";
import type { TurnDiffSummary } from "../../types";
import { buildOverviewChangedFiles } from "../overviewChanges.logic";
import { classifyOverviewError } from "../overview/overviewErrors.logic";
import type {
  OverviewChanges,
  OverviewDataReadiness,
  OverviewLayoutProps,
  OverviewPanelItem,
  OverviewPullRequestState,
} from "../overview/overviewTypes";
import type { PostPushWorkflowDiscoveryWatch } from "../postPushWorkflowDiscovery.logic";
import { toastManager, stackedThreadToast } from "../ui/toast";
import {
  areOverviewWorkflowRunsSupported,
  buildOverviewCheckRollupRows,
  buildOverviewItems,
  buildOverviewWorkflowCheckRows,
  getPrCheckStatusForQuery,
  getPrCheckStatusFromChangeRequest,
  getPrCheckStatusFromWorkflowRuns,
  hasDiscoveredPostPushWorkflowRun,
  isOverviewActiveCheckKind,
  isOverviewActiveWorkflowRun,
  resolveWorkflowDetailRunIds,
  resolveWorkflowRunsRefetchInterval,
  selectActivePostPushWorkflowDiscoveryWatch,
  selectOverviewChecksError,
  shouldRefreshPrCheckStatus,
  sourceControlOptionValue,
  summarizeActiveWorkflowJob,
} from "./ChatOverviewPanel.logic";
import { useThreadChangeRequest } from "./useThreadChangeRequest";

/** The thread state and callbacks the overview is computed from. */
export interface ChatOverviewModelInput {
  environmentId: EnvironmentId;
  gitCwd: string | null;
  activeWorktreeBranch: string | null;
  activeThreadBranch: string | null;
  activeWorktreePrNumber: number | null;
  activeWorktreePrState: ChangeRequestState | null | undefined;
  activeWorktreePrIsDraft: boolean | null | undefined;
  activeWorktreeTitle: string | null | undefined;
  activeThreadKey: string | null;
  activePlan: ActivePlanState | null;
  sidebarProposedPlan: LatestProposedPlanState | null;
  threadSubagents: ReadonlyArray<ThreadSubagentView>;
  changedFileSummaries?: ReadonlyArray<TurnDiffSummary> | undefined;
  sourceControlActions: (detectedChangeRequest: ChangeRequest | null) => ReactNode;
  branchControl: ReactNode;
  markdownCwd: string | undefined;
  workspaceRoot: string | undefined;
  onOpenFiles: () => void;
  onOpenReview: () => void;
  onOpenSubagent: (subagent: ThreadSubagentView) => void;
  /**
   * Opens the thread's change request in the workspace panel's pull request
   * tab (desktop). A number pins one the panel cannot resolve on its own yet.
   */
  onOpenPullRequestInApp?: ((pinnedNumber?: number) => void) | undefined;
  postPushWorkflowWatch: PostPushWorkflowDiscoveryWatch | null;
  onPostPushDiscoveryComplete: () => void;
}

/**
 * The resolved overview. Stage 1's presenters render `layoutProps` (and the
 * crown its `readiness`); `detectedChangeRequest` and `gitStatus` are the raw
 * inputs the planned model exposes for presenters that need them.
 */
export interface ChatOverviewModel {
  /** Everything an overview presenter renders, with the git controls already rendered. */
  layoutProps: OverviewLayoutProps;
  /** The thread's change request, as handed to the git controls. */
  detectedChangeRequest: ChangeRequest | null;
  /** The checkout's git status, or null while it is unknown. */
  gitStatus: VcsStatusResult | null;
  /** Which of that data has answered, so presenters can tell placeholders from values. */
  readiness: OverviewDataReadiness;
}

/**
 * Resolves the overview of a thread: its change request and CI checks
 * (polled through the post-push workflow watch), its changed files and its
 * git status, and surfaces source-control fetch failures as toasts. Every
 * overview presenter renders from this one model.
 */
export function useChatOverviewModel(input: ChatOverviewModelInput): ChatOverviewModel {
  const {
    environmentId,
    gitCwd,
    activeWorktreeBranch,
    activeThreadBranch,
    activeWorktreePrNumber,
    activeWorktreePrState,
    activeWorktreePrIsDraft,
    activeWorktreeTitle,
    postPushWorkflowWatch,
    activeThreadKey,
    activePlan,
    sidebarProposedPlan,
    threadSubagents,
    changedFileSummaries,
    sourceControlActions,
    branchControl,
    markdownCwd,
    workspaceRoot,
    onOpenFiles,
    onOpenReview,
    onOpenSubagent,
    onOpenPullRequestInApp,
    onPostPushDiscoveryComplete,
  } = input;

  const sourceControlRefreshMode = useSettings((settings) => settings.sourceControlRefreshMode);
  const postPushWorkflowWatchForContext = selectActivePostPushWorkflowDiscoveryWatch({
    watch: postPushWorkflowWatch,
    environmentId,
    threadKey: activeThreadKey,
    cwd: gitCwd,
    pullRequestNumber: null,
    nowMs: Date.now(),
  });

  const {
    gitStatusQuery,
    branchChangeRequest: overviewBranchPullRequest,
    number: overviewPullRequestNumber,
    fromPush: overviewPullRequestFromPush,
    resolving: overviewPullRequestResolving,
  } = useThreadChangeRequest({
    environmentId,
    gitCwd,
    worktreeBranch: activeWorktreeBranch,
    threadBranch: activeThreadBranch,
    worktreePrNumber: activeWorktreePrNumber,
    pushedPullRequestNumber: postPushWorkflowWatchForContext?.pullRequestNumber ?? null,
  });

  const activePostPushWorkflowWatch = selectActivePostPushWorkflowDiscoveryWatch({
    watch: postPushWorkflowWatchForContext,
    environmentId,
    threadKey: activeThreadKey,
    cwd: gitCwd,
    pullRequestNumber: overviewPullRequestNumber,
    nowMs: Date.now(),
  });

  const overviewPullRequestReference =
    overviewPullRequestNumber !== null ? String(overviewPullRequestNumber) : null;
  const overviewGitProvider = gitStatusQuery.data?.sourceControlProvider?.kind ?? null;

  const overviewPullRequestDetail = useOverviewPullRequestDetail({
    environmentId,
    cwd: gitCwd,
    reference: overviewPullRequestReference,
    enabled: overviewPullRequestNumber !== null,
  });

  const overviewPullRequestProvider =
    overviewPullRequestDetail.data?.provider ??
    overviewBranchPullRequest?.provider ??
    overviewGitProvider;

  const overviewWorkflowRunsSupported = areOverviewWorkflowRunsSupported(
    overviewPullRequestProvider,
  );

  // On the default branch there is no pull request, but CI still runs on pushes.
  // Fetch workflow runs scoped to the branch so the panel surfaces the latest
  // push's checks. Requires a remote — there are no runs to show without one.
  const overviewDefaultBranchChecksEnabled =
    overviewWorkflowRunsSupported &&
    overviewPullRequestNumber === null &&
    gitStatusQuery.data?.isDefaultRef === true &&
    gitStatusQuery.data?.hasPrimaryRemote === true;

  const overviewChecksBranchName = overviewDefaultBranchChecksEnabled
    ? (gitStatusQuery.data?.refName ?? null)
    : null;

  const overviewWorkflowRunsEnabled =
    overviewWorkflowRunsSupported &&
    (overviewPullRequestNumber !== null || overviewChecksBranchName !== null);

  const resolveWorkflowRunsIntervalMs = useCallback(
    (data: SourceControlWorkflowRunListResult | null): number | false => {
      const status = data
        ? getPrCheckStatusFromWorkflowRuns({
            runs: data.runs,
            headSha: sourceControlOptionValue(data.headSha),
          })
        : null;
      return resolveWorkflowRunsRefetchInterval({
        mode: sourceControlRefreshMode,
        activeWatch: activePostPushWorkflowWatch,
        nowMs: Date.now(),
        discoveredPostPushRun: hasDiscoveredPostPushWorkflowRun({
          watch: activePostPushWorkflowWatch,
          runs: data?.runs,
        }),
        statusRefreshable: status ? shouldRefreshPrCheckStatus(status) : false,
      });
    },
    [activePostPushWorkflowWatch, sourceControlRefreshMode],
  );

  const overviewWorkflowRuns = useOverviewWorkflowRuns({
    environmentId,
    cwd: gitCwd,
    pullRequestNumber: overviewPullRequestNumber,
    branch: overviewChecksBranchName,
    commitSha: activePostPushWorkflowWatch?.commitSha ?? null,
    enabled: overviewWorkflowRunsEnabled,
    resolveIntervalMs: resolveWorkflowRunsIntervalMs,
  });

  useEffect(() => {
    if (!activePostPushWorkflowWatch) return;
    if (
      !hasDiscoveredPostPushWorkflowRun({
        watch: activePostPushWorkflowWatch,
        runs: overviewWorkflowRuns.data?.runs,
      })
    ) {
      return;
    }
    onPostPushDiscoveryComplete();
  }, [activePostPushWorkflowWatch, overviewWorkflowRuns.data?.runs, onPostPushDiscoveryComplete]);

  const overviewActiveWorkflowRunId = useMemo(() => {
    const runs = overviewWorkflowRuns.data?.runs ?? [];
    return runs.find(isOverviewActiveWorkflowRun)?.runId ?? null;
  }, [overviewWorkflowRuns.data]);

  const overviewWorkflowDetailRunIds = useMemo(
    () =>
      resolveWorkflowDetailRunIds({
        workflowRunsSupported: overviewWorkflowRunsSupported,
        pullRequestNumber: overviewPullRequestNumber,
        branchName: overviewChecksBranchName,
        runs: overviewWorkflowRuns.data?.runs,
        activeWorkflowRunId: overviewActiveWorkflowRunId,
      }),
    [
      overviewActiveWorkflowRunId,
      overviewChecksBranchName,
      overviewPullRequestNumber,
      overviewWorkflowRuns.data?.runs,
      overviewWorkflowRunsSupported,
    ],
  );

  const { jobsByRunId: overviewWorkflowJobsByRunId, isLoading: overviewWorkflowRunJobsLoading } =
    useOverviewWorkflowRunJobs({
      environmentId,
      cwd: gitCwd,
      runIds: overviewWorkflowDetailRunIds,
      activeRunId: overviewActiveWorkflowRunId,
      enabled:
        overviewWorkflowRunsSupported &&
        (overviewPullRequestNumber !== null || overviewChecksBranchName !== null),
    });

  // Classify the source-control fetch error once (transient vs terminal, short
  // copy). Memoized on the underlying query errors so it only changes when a
  // fetch actually fails/recovers — which the toast effect below dedupes on.
  const checksErrorInfo = useMemo(
    () =>
      classifyOverviewError(
        selectOverviewChecksError({
          workflowRunsSupported: overviewWorkflowRunsSupported,
          workflowError: overviewWorkflowRuns.error,
          detailError: overviewPullRequestDetail.error,
        }),
      ),
    [overviewWorkflowRunsSupported, overviewWorkflowRuns.error, overviewPullRequestDetail.error],
  );

  const overviewPullRequest = useMemo<OverviewPullRequestState | null>(() => {
    const isRealPullRequest = overviewPullRequestNumber !== null;
    if (!isRealPullRequest && !overviewDefaultBranchChecksEnabled) {
      return null;
    }
    // PR metadata only applies to a real pull request; the default-branch path
    // carries CI checks alone (no title / reviews / merge state).
    const gitPr = isRealPullRequest ? (gitStatusQuery.data?.pr ?? null) : null;
    const branchPr = isRealPullRequest ? overviewBranchPullRequest : null;
    const detail = isRealPullRequest ? (overviewPullRequestDetail.data ?? null) : null;
    const workflowData = overviewWorkflowRunsSupported ? (overviewWorkflowRuns.data ?? null) : null;
    const checksQueryError = selectOverviewChecksError({
      workflowRunsSupported: overviewWorkflowRunsSupported,
      workflowError: overviewWorkflowRuns.error,
      detailError: overviewPullRequestDetail.error,
    });
    const activeWorkflowJobDetail =
      overviewActiveWorkflowRunId === null
        ? undefined
        : summarizeActiveWorkflowJob(overviewWorkflowJobsByRunId.get(overviewActiveWorkflowRunId));
    const checkStatus =
      workflowData && overviewWorkflowRunsSupported
        ? getPrCheckStatusForQuery({
            isLoading: overviewWorkflowRuns.isLoading,
            error: overviewWorkflowRuns.error,
            status: getPrCheckStatusFromWorkflowRuns({
              runs: workflowData.runs,
              headSha: sourceControlOptionValue(workflowData.headSha),
            }),
          })
        : detail
          ? getPrCheckStatusFromChangeRequest(detail)
          : branchPr
            ? getPrCheckStatusFromChangeRequest(branchPr)
            : getPrCheckStatusForQuery({
                isLoading:
                  (overviewWorkflowRunsSupported && overviewWorkflowRuns.isLoading) ||
                  overviewPullRequestDetail.isLoading,
                error: checksQueryError,
                status: null,
              });
    const workflowRows = workflowData
      ? buildOverviewWorkflowCheckRows({
          runs: workflowData.runs,
          jobsByRunId: overviewWorkflowJobsByRunId,
        })
      : [];
    const rollupRows = buildOverviewCheckRollupRows({
      rollup: detail?.checkRollup ?? branchPr?.checkRollup,
    });
    const hasWorkflowJobRows = Array.from(overviewWorkflowJobsByRunId.values()).some(
      (jobs) => jobs.length > 0,
    );
    const latestRuns = hasWorkflowJobRows
      ? workflowRows
      : rollupRows.length > 0
        ? rollupRows
        : workflowRows;
    if (activeWorkflowJobDetail) {
      for (const run of latestRuns) {
        if (
          isOverviewActiveCheckKind(run.statusKind) &&
          overviewActiveWorkflowRunId !== null &&
          run.id.startsWith(`run:${overviewActiveWorkflowRunId}`)
        ) {
          run.activeDetail = activeWorkflowJobDetail;
        }
      }
    }
    const runs = latestRuns.filter((run) => isOverviewActiveCheckKind(run.statusKind));
    const checksError = checksErrorInfo;
    const checksLoading =
      (overviewWorkflowRunsSupported && overviewWorkflowRuns.isLoading) ||
      (isRealPullRequest && overviewPullRequestDetail.isLoading) ||
      overviewWorkflowRunJobsLoading;
    const activeCheckCount =
      runs.length > 0
        ? runs.length
        : checkStatus && isOverviewActiveCheckKind(checkStatus.kind)
          ? 1
          : 0;

    if (overviewPullRequestNumber === null) {
      // Default branch (no PR): don't render an empty Checks section, so repos
      // without CI stay clean. Only surface it once there are runs, an error
      // worth showing, or a load in flight.
      if (!checksLoading && latestRuns.length === 0 && !checksError) {
        return null;
      }
      return {
        checkStatus,
        checksLoading,
        ...(checksError ? { checksError } : {}),
        hasMergeConflicts: false,
        activeCheckCount,
        runs,
        latestRuns,
      };
    }

    const pullRequestUrl = detail?.url ?? gitPr?.url ?? branchPr?.url ?? null;
    const pullRequestState =
      detail?.state ?? activeWorktreePrState ?? gitPr?.state ?? branchPr?.state ?? null;
    const pullRequestIsDraft = detail?.isDraft ?? activeWorktreePrIsDraft ?? branchPr?.isDraft;
    const reviewsApproved = detail?.participants
      ? detail.participants.filter((participant) => participant.approved === true).length
      : undefined;
    const reviewsRequested = detail?.reviewers ? detail.reviewers.length : undefined;

    return {
      number: overviewPullRequestNumber,
      title:
        detail?.title ??
        gitPr?.title ??
        branchPr?.title ??
        activeWorktreeTitle ??
        `Pull request #${overviewPullRequestNumber}`,
      ...(pullRequestUrl ? { url: pullRequestUrl } : {}),
      ...(pullRequestState ? { state: pullRequestState } : {}),
      ...(typeof pullRequestIsDraft === "boolean" ? { isDraft: pullRequestIsDraft } : {}),
      ...(typeof detail?.commentsCount === "number"
        ? { commentsCount: detail.commentsCount }
        : detail
          ? { commentsCount: detail.comments.length }
          : typeof branchPr?.commentsCount === "number"
            ? { commentsCount: branchPr.commentsCount }
            : {}),
      ...(typeof reviewsApproved === "number" ? { reviewsApproved } : {}),
      ...(typeof reviewsRequested === "number" ? { reviewsRequested } : {}),
      checkStatus,
      checksLoading,
      ...(checksError ? { checksError } : {}),
      ...(detail?.mergeability ? { mergeability: detail.mergeability } : {}),
      hasMergeConflicts: detail?.mergeability === "conflicting",
      activeCheckCount,
      runs,
      latestRuns,
    };
  }, [
    activeWorktreePrState,
    activeWorktreePrIsDraft,
    activeWorktreeTitle,
    checksErrorInfo,
    gitStatusQuery.data?.pr,
    overviewActiveWorkflowRunId,
    overviewBranchPullRequest,
    overviewDefaultBranchChecksEnabled,
    overviewWorkflowJobsByRunId,
    overviewWorkflowRunJobsLoading,
    overviewPullRequestDetail.data,
    overviewPullRequestDetail.error,
    overviewPullRequestDetail.isLoading,
    overviewPullRequestNumber,
    overviewWorkflowRunsSupported,
    overviewWorkflowRuns.data,
    overviewWorkflowRuns.error,
    overviewWorkflowRuns.isLoading,
  ]);

  // Surface a source-control fetch failure as a single toast per error episode
  // rather than a persistent banner in the panel. The dedupe signature keys off
  // the PR + kind + message, so the 30s polling loop won't re-toast the same
  // failure; it resets when the error clears, so a later recurrence notifies
  // again. The raw command dump stays out of the UI and only goes to the log.
  const lastToastedErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!checksErrorInfo) {
      lastToastedErrorRef.current = null;
      return;
    }
    const signature = `${overviewPullRequestNumber ?? "?"}|${checksErrorInfo.kind}|${checksErrorInfo.message}`;
    if (lastToastedErrorRef.current === signature) return;
    lastToastedErrorRef.current = signature;
    if (checksErrorInfo.raw) {
      console.debug("[overview] source control fetch failed:", checksErrorInfo.raw);
    }
    // On the default branch there is no pull request behind the checks, so keep
    // the copy about "checks" rather than mislabeling it as a pull request.
    const isBranchChecks = overviewPullRequestNumber === null;
    toastManager.add(
      stackedThreadToast({
        type: checksErrorInfo.kind === "terminal" ? "error" : "warning",
        title:
          checksErrorInfo.kind === "terminal"
            ? isBranchChecks
              ? "Checks unavailable"
              : "Pull request unavailable"
            : isBranchChecks
              ? "Couldn't refresh checks"
              : "Couldn't refresh pull request",
        description: checksErrorInfo.message,
      }),
    );
  }, [checksErrorInfo, overviewPullRequestNumber]);

  // The working tree only lists *uncommitted* files, so once the session's
  // changes are committed the overview would go blank while the Review panel
  // still shows everything. Merge the session's turn diff summaries (the same
  // per-file source the Review view uses — path + kind + additions/deletions)
  // with the working tree so committed and uncommitted changes both appear.
  // `kind` also yields the real M/A/D status. Staged / conflict flags are still
  // unavailable (would need `git status --porcelain=2` through the contract).
  // This one list feeds both the collapsed summary item and the expanded file
  // list, so the +/- totals and the buckets can never disagree.
  const changedFiles = useMemo(
    () =>
      buildOverviewChangedFiles(
        changedFileSummaries ?? [],
        gitStatusQuery.data?.workingTree.files ?? [],
        gitStatusQuery.data?.committed?.files ?? [],
      ),
    [changedFileSummaries, gitStatusQuery.data],
  );

  const overviewItems = useMemo<OverviewPanelItem[]>(
    () =>
      buildOverviewItems({
        gitStatusData: gitStatusQuery.data,
        changedFiles,
        overviewPullRequestNumber,
      }),
    [gitStatusQuery.data, changedFiles, overviewPullRequestNumber],
  );

  const overviewChanges = useMemo<OverviewChanges | undefined>(() => {
    const data = gitStatusQuery.data;
    // Don't gate on git status: turn diff summaries alone should keep the
    // Changes section populated while `useGitStatus()` is still loading.
    if (!data && changedFiles.length === 0) return undefined;
    const insertions = changedFiles.reduce((total, file) => total + file.insertions, 0);
    const deletions = changedFiles.reduce((total, file) => total + file.deletions, 0);
    return {
      files: changedFiles,
      insertions,
      deletions,
      refName: data?.refName ?? null,
      aheadCount: data?.aheadCount ?? 0,
      behindCount: data?.behindCount ?? 0,
      hasUpstream: data?.hasUpstream,
      aheadOfDefaultCount: data?.aheadOfDefaultCount,
    };
  }, [gitStatusQuery.data, changedFiles]);

  const handleRefreshPullRequest = useCallback(() => {
    invalidateSourceControl({ environmentId, cwd: gitCwd });
  }, [environmentId, gitCwd]);

  const isRefreshingPullRequest =
    overviewPullRequestDetail.isFetching ||
    (overviewWorkflowRunsSupported && overviewWorkflowRuns.isFetching);

  const detectedChangeRequest = overviewPullRequestDetail.data ?? overviewBranchPullRequest ?? null;

  // Git status streams its local half first; a resubscribe marks it pending.
  const remoteStatusKnown =
    gitStatusQuery.data !== null && !gitStatusQuery.isPending && !gitStatusQuery.remotePending;
  const readiness = useMemo<OverviewDataReadiness>(
    () => ({
      remoteStatus: remoteStatusKnown,
      pullRequestLookup: remoteStatusKnown && !overviewPullRequestResolving,
    }),
    [overviewPullRequestResolving, remoteStatusKnown],
  );

  return {
    layoutProps: {
      activePlan,
      activeProposedPlan: sidebarProposedPlan,
      changes: overviewChanges,
      overviewItems,
      pullRequest: overviewPullRequest,
      onRefreshPullRequest: handleRefreshPullRequest,
      isRefreshingPullRequest,
      subagents: threadSubagents,
      sourceControlActions: sourceControlActions(detectedChangeRequest),
      branchControl,
      environmentId,
      markdownCwd,
      workspaceRoot,
      onOpenFiles,
      onOpenReview,
      onOpenSubagent,
      onOpenPullRequestInApp:
        onOpenPullRequestInApp && overviewPullRequest?.number != null
          ? () =>
              // The panel resolves the thread's change request itself; only a
              // number the push watch alone knows has to travel in the URL.
              onOpenPullRequestInApp(
                overviewPullRequestFromPush ? (overviewPullRequest.number as number) : undefined,
              )
          : undefined,
    },
    detectedChangeRequest,
    gitStatus: gitStatusQuery.data ?? null,
    readiness,
  };
}
