import type {
  ChangeRequest,
  ChangeRequestState,
  EnvironmentId,
  ScopedThreadRef,
  SourceControlWorkflowRunListResult,
  ThreadId,
} from "@ryco/contracts";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useGitStatus } from "~/lib/gitStatusState";
import { useSettings } from "~/hooks/useSettings";
import { invalidateSourceControl } from "~/rpc/useSourceControl";
import {
  useOverviewChangeRequestList,
  useOverviewPullRequestDetail,
  useOverviewWorkflowRunJobs,
  useOverviewWorkflowRuns,
} from "~/rpc/useOverview";
import { cn } from "~/lib/utils";
import PlanSidebar, {
  type OverviewChanges,
  type OverviewPanelItem,
  type OverviewPullRequestState,
} from "../PlanSidebar";
import type { ActivePlanState, LatestProposedPlanState } from "../../session-logic";
import type { ThreadSubagentView } from "../../threadWorkspaceViewModel";
import type { TurnDiffSummary } from "../../types";
import type { DraftId } from "../../composerDraftStore";
import { BranchToolbarBranchSelector } from "../BranchToolbarBranchSelector";
import { buildOverviewChangedFiles } from "../overviewChanges.logic";
import { classifyOverviewError } from "../overview/overviewErrors.logic";
import { toastManager, stackedThreadToast } from "../ui/toast";
import GitActionsControl, { type GitActionPostPushEvent } from "../GitActionsControl";
import {
  createPostPushWorkflowDiscoveryWatch,
  type PostPushWorkflowDiscoveryWatch,
} from "../postPushWorkflowDiscovery.logic";
import {
  areOverviewWorkflowRunsSupported,
  buildOverviewCheckRollupRows,
  buildOverviewItems,
  buildOverviewWorkflowCheckRows,
  findChangeRequestForBranch,
  getPrCheckStatusForQuery,
  getPrCheckStatusFromChangeRequest,
  getPrCheckStatusFromWorkflowRuns,
  hasDiscoveredPostPushWorkflowRun,
  isOverviewActiveCheckKind,
  isOverviewActiveWorkflowRun,
  resolveOverviewPullRequestNumber,
  resolveWorkflowDetailRunIds,
  resolveWorkflowRunsRefetchInterval,
  selectActivePostPushWorkflowDiscoveryWatch,
  selectOverviewChecksError,
  shouldRefreshPrCheckStatus,
  sourceControlOptionValue,
  summarizeActiveWorkflowJob,
} from "./ChatOverviewPanel.logic";

export const OVERVIEW_FLOATING_EXIT_DURATION_MS = 260;
export const OVERVIEW_SIDEBAR_EXIT_DURATION_MS = 320;
export const OVERVIEW_SIDEBAR_FRAME_WIDTH = "calc(340px + 0.75rem)";

export function OverviewSidebarMotionFrame(props: {
  animate: boolean;
  children: ReactNode;
  open: boolean;
}) {
  const [entered, setEntered] = useState(!props.animate && props.open);

  useEffect(() => {
    if (!props.animate) {
      setEntered(props.open);
      return;
    }

    if (!props.open) {
      setEntered(false);
      return;
    }

    const frameId = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(frameId);
  }, [props.animate, props.open]);

  const active = props.animate ? props.open && entered : props.open;

  return (
    <div
      aria-hidden={props.open ? undefined : true}
      inert={props.open ? undefined : true}
      className={cn(
        // Clears the floating chat header (the transcript scrolls beneath it,
        // this docked panel must not — its own header row carries the branch
        // control). Unset on tiers without the overlay, resolving to 0.
        "h-full min-h-0 shrink-0 overflow-hidden pt-[var(--chat-header-clearance,0px)] transition-[width,opacity] duration-[320ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
        active ? "w-(--overview-sidebar-frame-width) opacity-100" : "w-0 opacity-0",
      )}
      style={
        {
          "--overview-sidebar-frame-width": OVERVIEW_SIDEBAR_FRAME_WIDTH,
        } as CSSProperties
      }
    >
      <div
        className={cn(
          "h-full min-h-0 w-(--overview-sidebar-frame-width) transition-[translate,opacity] duration-[320ms] ease-[cubic-bezier(0.16,1,0.3,1)] will-change-transform motion-reduce:transition-none",
          active ? "translate-x-0 opacity-100" : "translate-x-5 opacity-0",
        )}
      >
        {props.children}
      </div>
    </div>
  );
}

export function FloatingOverviewMotionFrame(props: {
  animate: boolean;
  children: ReactNode;
  open: boolean;
}) {
  const [entered, setEntered] = useState(!props.animate && props.open);

  useEffect(() => {
    if (!props.animate) {
      setEntered(props.open);
      return;
    }

    if (!props.open) {
      setEntered(false);
      return;
    }

    const frameId = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(frameId);
  }, [props.animate, props.open]);

  const active = props.animate ? props.open && entered : props.open;

  return (
    <div className="pointer-events-none absolute top-[calc(var(--chat-header-clearance,0px)+0.75rem)] right-3 z-40">
      <div
        aria-hidden={props.open ? undefined : true}
        inert={props.open ? undefined : true}
        className={cn(
          "origin-top-right transition-[translate,opacity] duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] will-change-transform motion-reduce:transition-none",
          active ? "translate-x-0 opacity-100" : "translate-x-3 opacity-0",
        )}
      >
        {props.children}
      </div>
    </div>
  );
}

export interface ChatOverviewPanelProps {
  environmentId: EnvironmentId;
  gitCwd: string | null;
  activeWorktreeBranch: string | null;
  activeThreadBranch: string | null;
  activeWorktreePrNumber: number | null;
  activeWorktreePrState: ChangeRequestState | null | undefined;
  activeWorktreePrIsDraft: boolean | null | undefined;
  activeWorktreeTitle: string | null | undefined;
  activeThreadKey: string | null;
  activeEnvironmentUnavailableState: {
    label: string;
    connectionState: string;
  } | null;
  activePlan: ActivePlanState | null;
  sidebarProposedPlan: LatestProposedPlanState | null;
  threadSubagents: ReadonlyArray<ThreadSubagentView>;
  changedFileSummaries?: ReadonlyArray<TurnDiffSummary> | undefined;
  sourceControlActions: (detectedChangeRequest: ChangeRequest | null) => ReactNode;
  branchControl: ReactNode;
  markdownCwd: string | undefined;
  workspaceRoot: string | undefined;
  mode: "floating" | "sheet" | "sidebar";
  /** Visible close affordance for overlay presentations (see PlanSidebar). */
  onClose?: (() => void) | undefined;
  onOpenFiles: () => void;
  onOpenReview: () => void;
  onOpenSubagent: (subagent: ThreadSubagentView) => void;
  /** Opens a change request on the pull requests page (desktop). */
  onOpenPullRequestInApp?: ((number: number) => void) | undefined;
}

export function usePostPushWorkflowWatch() {
  const [postPushWorkflowWatch, setPostPushWorkflowWatch] =
    useState<PostPushWorkflowDiscoveryWatch | null>(null);

  const handlePostPush = useCallback((event: GitActionPostPushEvent) => {
    setPostPushWorkflowWatch(
      createPostPushWorkflowDiscoveryWatch({
        environmentId: event.environmentId,
        threadKey: event.threadKey,
        cwd: event.cwd,
        pullRequestNumber: event.pullRequestNumber,
        commitSha: event.commitSha,
        nowMs: Date.now(),
      }),
    );
    invalidateSourceControl({ environmentId: event.environmentId, cwd: event.cwd });
  }, []);

  useEffect(() => {
    if (!postPushWorkflowWatch) return;
    const timeoutId = window.setTimeout(
      () =>
        setPostPushWorkflowWatch((current) => (current === postPushWorkflowWatch ? null : current)),
      Math.max(0, postPushWorkflowWatch.expiresAtMs - Date.now()),
    );
    return () => window.clearTimeout(timeoutId);
  }, [postPushWorkflowWatch]);

  const clearWatch = useCallback(() => {
    setPostPushWorkflowWatch(null);
  }, []);

  return { postPushWorkflowWatch, handlePostPush, clearWatch } as const;
}

export interface OverviewPanelControlsInput {
  gitCwd: string | null;
  activeThreadRef: ScopedThreadRef | null;
  routeKind: "server" | "draft";
  draftId: DraftId | null;
  onPostPush: (event: GitActionPostPushEvent) => void;
  branchControlThread: { environmentId: EnvironmentId; id: ThreadId } | null;
  isGitRepo: boolean;
  canOverrideServerThreadBranch: boolean;
  activeThreadBranch: string | null;
  onActiveThreadBranchOverrideChange: (refName: string | null) => void;
  envLocked: boolean;
  onComposerFocusRequest: () => void;
  canCheckoutPullRequestIntoThread: boolean;
  onCheckoutPullRequestRequest: (reference: string) => void;
}

export interface OverviewPanelControls {
  sourceControlActions: (detectedChangeRequest: ChangeRequest | null) => ReactNode;
  branchControl: ReactNode;
}

export function useOverviewPanelControls(input: OverviewPanelControlsInput): OverviewPanelControls {
  const {
    gitCwd,
    activeThreadRef,
    routeKind,
    draftId,
    onPostPush,
    branchControlThread,
    isGitRepo,
    canOverrideServerThreadBranch,
    activeThreadBranch,
    onActiveThreadBranchOverrideChange,
    envLocked,
    onComposerFocusRequest,
    canCheckoutPullRequestIntoThread,
    onCheckoutPullRequestRequest,
  } = input;

  const sourceControlActions = useCallback(
    (detectedChangeRequest: ChangeRequest | null) =>
      gitCwd && activeThreadRef ? (
        <GitActionsControl
          gitCwd={gitCwd}
          activeThreadRef={activeThreadRef}
          detectedChangeRequest={detectedChangeRequest}
          {...(routeKind === "draft" && draftId ? { draftId } : {})}
          onPostPush={onPostPush}
          showLabels
          block
        />
      ) : null,
    [gitCwd, activeThreadRef, routeKind, draftId, onPostPush],
  );

  const branchControl = useMemo<ReactNode>(
    () =>
      branchControlThread && isGitRepo ? (
        <BranchToolbarBranchSelector
          appearance="panelRow"
          className="w-full"
          environmentId={branchControlThread.environmentId}
          threadId={branchControlThread.id}
          {...(routeKind === "draft" && draftId ? { draftId } : {})}
          {...(canOverrideServerThreadBranch
            ? {
                activeThreadBranchOverride: activeThreadBranch,
                onActiveThreadBranchOverrideChange,
              }
            : {})}
          envLocked={envLocked}
          onComposerFocusRequest={onComposerFocusRequest}
          {...(canCheckoutPullRequestIntoThread ? { onCheckoutPullRequestRequest } : {})}
        />
      ) : null,
    [
      branchControlThread,
      isGitRepo,
      routeKind,
      draftId,
      canOverrideServerThreadBranch,
      activeThreadBranch,
      onActiveThreadBranchOverrideChange,
      envLocked,
      onComposerFocusRequest,
      canCheckoutPullRequestIntoThread,
      onCheckoutPullRequestRequest,
    ],
  );

  return { sourceControlActions, branchControl };
}

export function ChatOverviewPanel(
  props: ChatOverviewPanelProps & {
    postPushWorkflowWatch: PostPushWorkflowDiscoveryWatch | null;
    onPostPushDiscoveryComplete: () => void;
  },
) {
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
    activeEnvironmentUnavailableState,
    activePlan,
    sidebarProposedPlan,
    threadSubagents,
    changedFileSummaries,
    sourceControlActions,
    branchControl,
    markdownCwd,
    workspaceRoot,
    mode,
    onClose,
    onOpenFiles,
    onOpenReview,
    onOpenSubagent,
    onPostPushDiscoveryComplete,
  } = props;

  const sourceControlRefreshMode = useSettings((settings) => settings.sourceControlRefreshMode);
  const gitStatusQuery = useGitStatus({ environmentId, cwd: gitCwd });
  const overviewBranchName =
    activeWorktreeBranch ?? activeThreadBranch ?? gitStatusQuery.data?.refName ?? null;

  const overviewBranchPullRequestList = useOverviewChangeRequestList({
    environmentId,
    cwd: gitCwd,
    enabled:
      overviewBranchName !== null &&
      activeWorktreePrNumber == null &&
      gitStatusQuery.data?.pr == null,
  });

  const overviewBranchPullRequest = useMemo(
    () => findChangeRequestForBranch(overviewBranchPullRequestList.data, overviewBranchName),
    [overviewBranchName, overviewBranchPullRequestList.data],
  );

  const postPushWorkflowWatchForContext = selectActivePostPushWorkflowDiscoveryWatch({
    watch: postPushWorkflowWatch,
    environmentId,
    threadKey: activeThreadKey,
    cwd: gitCwd,
    pullRequestNumber: null,
    nowMs: Date.now(),
  });

  const overviewPullRequestNumber = resolveOverviewPullRequestNumber({
    activeWorktreePrNumber,
    gitStatusPrNumber: gitStatusQuery.data?.pr?.number ?? null,
    overviewBranchPullRequestNumber: overviewBranchPullRequest?.number ?? null,
    postPushWatchPullRequestNumber: postPushWorkflowWatchForContext?.pullRequestNumber ?? null,
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
        activeEnvironmentUnavailableState,
      }),
    [
      activeEnvironmentUnavailableState,
      gitStatusQuery.data,
      changedFiles,
      overviewPullRequestNumber,
    ],
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
    };
  }, [gitStatusQuery.data, changedFiles]);

  const handleRefreshPullRequest = useCallback(() => {
    invalidateSourceControl({ environmentId, cwd: gitCwd });
  }, [environmentId, gitCwd]);

  const isRefreshingPullRequest =
    overviewPullRequestDetail.isFetching ||
    (overviewWorkflowRunsSupported && overviewWorkflowRuns.isFetching);

  const detectedChangeRequest = overviewPullRequestDetail.data ?? overviewBranchPullRequest ?? null;

  return (
    <PlanSidebar
      activePlan={activePlan}
      activeProposedPlan={sidebarProposedPlan}
      changes={overviewChanges}
      overviewItems={overviewItems}
      pullRequest={overviewPullRequest}
      onRefreshPullRequest={handleRefreshPullRequest}
      isRefreshingPullRequest={isRefreshingPullRequest}
      subagents={threadSubagents}
      sourceControlActions={sourceControlActions(detectedChangeRequest)}
      branchControl={branchControl}
      environmentId={environmentId}
      markdownCwd={markdownCwd}
      workspaceRoot={workspaceRoot}
      mode={mode}
      onClose={onClose}
      onOpenFiles={onOpenFiles}
      onOpenReview={onOpenReview}
      onOpenSubagent={onOpenSubagent}
      onOpenPullRequestInApp={
        props.onOpenPullRequestInApp && overviewPullRequest?.number != null
          ? () => props.onOpenPullRequestInApp?.(overviewPullRequest.number as number)
          : undefined
      }
    />
  );
}

export default ChatOverviewPanel;
