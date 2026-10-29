import { useAtomValue } from "@effect/atom-react";
import { appAtomRegistry } from "@ryco/client-runtime/rpc";
import {
  pullRequestWatchControlKey,
  pullRequestWatchControlState,
  pullRequestWatchErrorMessage,
  pullRequestWatchFailureTitle,
  pullRequestWatchInput,
  pullRequestWatchSwitchRequest,
  type PullRequestWatchAction,
  type PullRequestWatchSwitchRequest,
  type PullRequestWatchTarget,
  type PullRequestWatchView,
} from "@ryco/client-runtime/state/threads";
import { WS_METHODS } from "@ryco/contracts";
import type {
  ChangeRequest,
  ChangeRequestActivity,
  ChangeRequestCreateInput,
  ChangeRequestUpdateAction,
  DismissWorktreePullRequestInput,
  EnvironmentId,
  LinkWorktreePullRequestInput,
  SourceControlAssigneeCandidate,
  SourceControlChangeRequestDetail,
  SourceControlChangeRequestMergeMethod,
  SourceControlCreateIssueInput,
  SourceControlIssueDetail,
  SourceControlIssueSummary,
  SourceControlLabel,
  SourceControlRepositorySearchResult,
  SourceControlWorkflowJobLogResult,
  SourceControlWorkflowRunJobsResult,
  SourceControlWorkflowRunListResult,
  ServerConfig,
  ThreadId,
  ThreadPullRequestWatchShell,
} from "@ryco/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { readEnvironmentApi } from "~/environmentApi";
import { requireEnvironmentConnection } from "~/environments/runtime";
import { useHostedRpcCapability } from "~/hostedHub/capabilities";
import { useEnvironmentServerConfigSelector } from "~/hooks/useChatsAvailability";
import { usePresentationTier } from "~/hooks/usePresentationTier";
import { useSettings } from "~/hooks/useSettings";
import { useWsConnectionStatusForEnvironment } from "./wsConnectionState";
import {
  changeRequestActivityBinding,
  changeRequestDetailBinding,
  changeRequestDiffBinding,
  changeRequestListBinding,
  changeRequestSearchBinding,
  issueAssigneesBinding,
  issueDetailBinding,
  issueLabelsBinding,
  issueListBinding,
  issueSearchBinding,
  addChangeRequestComment,
  addIssueComment,
  createChangeRequest,
  invalidateSourceControlAfterWorkflowRerun,
  invalidateSourceControlIssueLists,
  mergeSourceControlChangeRequest,
  replyToReviewThread,
  repositorySearchBinding,
  setReviewThreadResolved,
  submitChangeRequestReview,
  toggleChangeRequestCommentReaction,
  toggleIssueCommentReaction,
  updateChangeRequest,
  updateChangeRequestComment,
  workflowJobLogBinding,
  workflowRunJobsBinding,
  workflowRunsBinding,
  type AddCommentPayload,
  type ChangeRequestMutationTarget,
  type CommentReactionPayload,
  type QueryBinding,
  type ReplyToReviewThreadPayload,
  type SetReviewThreadResolvedPayload,
  type SourceControlChangeRequestActivityInput,
  type SourceControlChangeRequestDetailInput,
  type SubmitChangeRequestReviewPayload,
  type UpdateChangeRequestCommentPayload,
  type SourceControlChangeRequestDiffInput,
  type SourceControlChangeRequestListInput,
  type SourceControlChangeRequestSearchInput,
  type SourceControlIssueDetailInput,
  type SourceControlIssueListInput,
  type SourceControlIssueMetaInput,
  type SourceControlIssueSearchInput,
  type SourceControlQueryState,
  type SourceControlRepositorySearchInput,
  type SourceControlWorkflowJobLogInput,
  type SourceControlWorkflowRunJobsInput,
  type SourceControlWorkflowRunsInput,
} from "./sourceControlAtoms";
import {
  resolveSourceControlRefreshDelay,
  resolveWorkflowRunJobsPhase,
  shouldRefreshSourceControlOnLifecycle,
  workflowRunJobsContradictRun,
  type SourceControlRefreshPhase,
} from "./sourceControlRefreshPolicy";

export {
  fetchSourceControlChangeRequestDetail,
  fetchSourceControlIssueDetail,
  invalidateSourceControl,
  invalidateSourceControlWorkflowRuns,
  loadChangeRequestFileContents,
  retrySourceControlWorkflowJobLog,
  writeChangeRequestDetail,
  type ChangeRequestMutationTarget,
  type ReplyToReviewThreadPayload,
  type SetReviewThreadResolvedPayload,
  type SourceControlChangeRequestActivityInput,
  type SourceControlChangeRequestFileContentsInput,
  type SourceControlRepositorySearchInput,
  type SourceControlQueryState,
  type SubmitChangeRequestReviewPayload,
  type UpdateChangeRequestCommentPayload,
} from "./sourceControlAtoms";
export {
  ChangeRequestFileContentsUnavailableError,
  createChangeRequestDiffFilesLoader,
  type ChangeRequestDiffFilesTarget,
} from "./changeRequestDiffFiles";

type SourceControlWorkflowRerunPayload =
  | { readonly target: "failed-jobs" }
  | { readonly target: "job"; readonly jobId: string };

// ---------------------------------------------------------------------------
// Reactive read hooks (atom-backed replacements for the former
// `useQuery(*QueryOptions(...))` source-control reads).
// ---------------------------------------------------------------------------

function useWatchedQuery<TInput, TData>(
  binding: QueryBinding<TInput, TData>,
  input: TInput,
  resolveIntervalMs?: (data: TData | null) => number | false,
  /**
   * Re-subscribes when it changes, so a cadence that depends on caller state
   * (not on the fetched data) takes effect immediately instead of after the
   * next fetch.
   */
  cadenceKey?: string | number | boolean | null,
): SourceControlQueryState<TData> {
  const targetKey = binding.targetKey(input);
  const refreshMode = useSettings((settings) => settings.sourceControlRefreshMode);
  const inputRef = useRef(input);
  inputRef.current = input;
  const resolveIntervalRef = useRef(resolveIntervalMs);
  resolveIntervalRef.current = resolveIntervalMs;
  const refreshModeRef = useRef(refreshMode);
  refreshModeRef.current = refreshMode;

  useEffect(() => {
    return binding.watch(inputRef.current, {
      resolveIntervalMs: (data) =>
        refreshModeRef.current === "manual"
          ? false
          : (resolveIntervalRef.current?.(data as TData | null) ?? false),
      shouldRefreshOnLifecycle: ({ hasData, lastFetchedAt, staleTime }) =>
        shouldRefreshSourceControlOnLifecycle({
          mode: refreshModeRef.current,
          hasData,
          invalidated: false,
          lastFetchedAtMs: lastFetchedAt,
          staleTimeMs: staleTime,
        }),
    });
  }, [binding, refreshMode, targetKey, cadenceKey]);

  return useAtomValue(binding.atomFor(input));
}

export function useSourceControlIssueList(
  input: SourceControlIssueListInput,
): SourceControlQueryState<ReadonlyArray<SourceControlIssueSummary>> {
  return useWatchedQuery(issueListBinding, input);
}

export function useSourceControlChangeRequestList(
  input: SourceControlChangeRequestListInput,
  resolveIntervalMs?: (data: ReadonlyArray<ChangeRequest> | null) => number | false,
): SourceControlQueryState<ReadonlyArray<ChangeRequest>> {
  return useWatchedQuery(changeRequestListBinding, input, resolveIntervalMs);
}

export function useSourceControlIssueSearch(
  input: SourceControlIssueSearchInput,
): SourceControlQueryState<ReadonlyArray<SourceControlIssueSummary>> {
  return useWatchedQuery(issueSearchBinding, input);
}

export function useSourceControlChangeRequestSearch(
  input: SourceControlChangeRequestSearchInput,
): SourceControlQueryState<ReadonlyArray<ChangeRequest>> {
  return useWatchedQuery(changeRequestSearchBinding, input);
}

export function useSourceControlRepositorySearch(
  input: SourceControlRepositorySearchInput,
): SourceControlQueryState<SourceControlRepositorySearchResult> {
  return useWatchedQuery(repositorySearchBinding, input);
}

export function useSourceControlIssueLabels(
  input: SourceControlIssueMetaInput,
): SourceControlQueryState<ReadonlyArray<SourceControlLabel>> {
  return useWatchedQuery(issueLabelsBinding, input);
}

export function useSourceControlIssueAssignees(
  input: SourceControlIssueMetaInput,
): SourceControlQueryState<ReadonlyArray<SourceControlAssigneeCandidate>> {
  return useWatchedQuery(issueAssigneesBinding, input);
}

export function useSourceControlIssueDetail(
  input: SourceControlIssueDetailInput,
): SourceControlQueryState<SourceControlIssueDetail> {
  return useWatchedQuery(issueDetailBinding, input);
}

export function useSourceControlChangeRequestDetail(
  input: SourceControlChangeRequestDetailInput,
  resolveIntervalMs?: (data: SourceControlChangeRequestDetail | null) => number | false,
): SourceControlQueryState<SourceControlChangeRequestDetail> {
  return useWatchedQuery(changeRequestDetailBinding, input, resolveIntervalMs);
}

export function useSourceControlChangeRequestDiff(
  input: SourceControlChangeRequestDiffInput,
): SourceControlQueryState<string> {
  return useWatchedQuery(changeRequestDiffBinding, input);
}

/**
 * Timeline, review threads, and viewer capabilities for one change request.
 * Polls at the "active" cadence while `active` (pass `detail.state === "open"`),
 * otherwise only refreshes on demand, lifecycle recovery, or invalidation.
 */
export function useSourceControlChangeRequestActivity(
  input: SourceControlChangeRequestActivityInput & {
    /** Poll cadence (default `settled`: lifecycle refreshes and mutations only). */
    readonly phase?: Exclude<SourceControlRefreshPhase, "discovery">;
  },
): SourceControlQueryState<ChangeRequestActivity> {
  const refreshMode = useSettings((settings) => settings.sourceControlRefreshMode);
  const phase = input.phase ?? "settled";
  return useWatchedQuery(
    changeRequestActivityBinding,
    input,
    () => resolveSourceControlRefreshDelay({ mode: refreshMode, phase }),
    phase,
  );
}

export function useSourceControlWorkflowRuns(
  input: SourceControlWorkflowRunsInput,
  resolveIntervalMs?: (data: SourceControlWorkflowRunListResult | null) => number | false,
): SourceControlQueryState<SourceControlWorkflowRunListResult> {
  return useWatchedQuery(workflowRunsBinding, input, resolveIntervalMs);
}

export function useSourceControlWorkflowRunJobs(
  input: SourceControlWorkflowRunJobsInput,
  resolveIntervalMs?: (data: SourceControlWorkflowRunJobsResult | null) => number | false,
): SourceControlQueryState<SourceControlWorkflowRunJobsResult> {
  return useWatchedQuery(workflowRunJobsBinding, input, resolveIntervalMs);
}

function sourceControlQueryStatesEqual<TData>(
  left: SourceControlQueryState<TData>,
  right: SourceControlQueryState<TData>,
): boolean {
  return (
    left.data === right.data &&
    left.isLoading === right.isLoading &&
    left.isFetching === right.isFetching &&
    left.error === right.error
  );
}

export interface SourceControlWorkflowRunJobsBatchResult {
  readonly jobsByRunId: Map<string, SourceControlWorkflowRunJobsResult["jobs"]>;
  readonly isLoading: boolean;
}

/**
 * Jobs of several workflow runs. Each run's jobs poll at the active cadence
 * while the runs list reports the run incomplete or its cached jobs still show
 * unfinished work, so every running workflow is followed. The cadence is read
 * per poll from a ref: status changes never re-subscribe (which would refetch
 * every stale settled run). When a run's status flips and its cached jobs
 * contradict it, that run alone is read once (the final read of a finished
 * run, or the first read of a re-run).
 */
export function useSourceControlWorkflowRunJobsBatch(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly runIds: ReadonlyArray<string>;
  /** Runs the runs list reports as not completed (queued, waiting, in progress). */
  readonly incompleteRunIds: ReadonlyArray<string>;
  readonly enabled: boolean;
}): SourceControlWorkflowRunJobsBatchResult {
  const refreshMode = useSettings((settings) => settings.sourceControlRefreshMode);
  const queryInputs = useMemo(
    () =>
      input.runIds.map((runId): SourceControlWorkflowRunJobsInput => ({
        environmentId: input.environmentId,
        cwd: input.cwd,
        runId,
        enabled: input.enabled,
      })),
    [input.cwd, input.enabled, input.environmentId, input.runIds],
  );
  const targetKeys = useMemo(
    () => queryInputs.map((queryInput) => workflowRunJobsBinding.targetKey(queryInput)),
    [queryInputs],
  );
  const batchSignature = useMemo(() => targetKeys.join("\u0001"), [targetKeys]);
  const queryInputsRef = useRef(queryInputs);
  queryInputsRef.current = queryInputs;
  const snapshotRef = useRef<
    ReadonlyArray<SourceControlQueryState<SourceControlWorkflowRunJobsResult>>
  >([]);
  const incompleteSignature = input.incompleteRunIds.toSorted().join("\u0001");
  const incompleteRunIds = useMemo(
    () => new Set(incompleteSignature ? incompleteSignature.split("\u0001") : []),
    [incompleteSignature],
  );
  const incompleteRunIdsRef = useRef(incompleteRunIds);
  incompleteRunIdsRef.current = incompleteRunIds;

  useEffect(() => {
    const releases = queryInputsRef.current.map((queryInput) =>
      workflowRunJobsBinding.watch(queryInput, {
        resolveIntervalMs: (data) =>
          resolveSourceControlRefreshDelay({
            mode: refreshMode,
            phase: resolveWorkflowRunJobsPhase({
              runIncomplete: incompleteRunIdsRef.current.has(queryInput.runId ?? ""),
              jobs: data?.jobs ?? null,
            }),
          }),
        shouldRefreshOnLifecycle: ({ hasData, lastFetchedAt, staleTime }) =>
          shouldRefreshSourceControlOnLifecycle({
            mode: refreshMode,
            hasData,
            invalidated: false,
            lastFetchedAtMs: lastFetchedAt,
            staleTimeMs: staleTime,
          }),
      }),
    );
    return () => {
      for (const release of releases) release();
    };
  }, [batchSignature, refreshMode]);

  // A run's status flipped: read it once if its cached jobs contradict the
  // new status. Never-read runs are left to their watch.
  const previousIncompleteRef = useRef<ReadonlySet<string> | null>(null);
  useEffect(() => {
    const previous = previousIncompleteRef.current;
    previousIncompleteRef.current = incompleteRunIds;
    if (previous === null) return;
    for (const queryInput of queryInputsRef.current) {
      const runId = queryInput.runId ?? "";
      const runIncomplete = incompleteRunIds.has(runId);
      if (previous.has(runId) === runIncomplete) continue;
      const jobs = workflowRunJobsBinding.snapshotFor(queryInput).data?.jobs;
      if (jobs && workflowRunJobsContradictRun({ runIncomplete, jobs })) {
        workflowRunJobsBinding.refresh(queryInput);
      }
    }
  }, [incompleteRunIds]);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      // The signature intentionally rotates this subscription when the batch
      // membership changes, while the current inputs themselves live in a ref.
      void batchSignature;
      const releases = queryInputsRef.current.map((queryInput) =>
        appAtomRegistry.subscribe(workflowRunJobsBinding.atomFor(queryInput), onStoreChange),
      );
      return () => {
        for (const release of releases) release();
      };
    },
    [batchSignature],
  );

  const getSnapshot = useCallback(() => {
    const next = queryInputsRef.current.map((queryInput) =>
      workflowRunJobsBinding.snapshotFor(queryInput),
    );
    const previous = snapshotRef.current;
    if (
      previous.length === next.length &&
      previous.every((state, index) => sourceControlQueryStatesEqual(state, next[index]!))
    ) {
      return previous;
    }
    snapshotRef.current = next;
    return next;
  }, []);

  const states = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(() => {
    const jobsByRunId = new Map<string, SourceControlWorkflowRunJobsResult["jobs"]>();
    let isLoading = false;
    input.runIds.forEach((runId, index) => {
      const state = states[index];
      if (!state || state.isLoading || state.data === null) {
        isLoading = input.enabled;
        return;
      }
      jobsByRunId.set(runId, state.data.jobs);
    });
    return { jobsByRunId, isLoading };
  }, [input.enabled, input.runIds, states]);
}

export function useSourceControlWorkflowJobLog(
  input: SourceControlWorkflowJobLogInput,
): SourceControlQueryState<SourceControlWorkflowJobLogResult> {
  return useWatchedQuery(workflowJobLogBinding, input);
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface SourceControlMutationResult<TArgs, TResult> {
  readonly mutateAsync: (args: TArgs) => Promise<TResult>;
  readonly isPending: boolean;
  readonly error: Error | null;
  readonly reset: () => void;
}

function useSourceControlMutation<TArgs, TResult>(
  mutationFn: (args: TArgs) => Promise<TResult>,
  options?: { readonly onSuccess?: (result: TResult, args: TArgs) => void },
): SourceControlMutationResult<TArgs, TResult> {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const mountedRef = useRef(true);
  const fnRef = useRef(mutationFn);
  fnRef.current = mutationFn;
  const onSuccessRef = useRef(options?.onSuccess);
  onSuccessRef.current = options?.onSuccess;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const mutateAsync = useCallback(async (args: TArgs): Promise<TResult> => {
    setIsPending(true);
    setError(null);
    try {
      const result = await fnRef.current(args);
      onSuccessRef.current?.(result, args);
      if (mountedRef.current) {
        setIsPending(false);
      }
      return result;
    } catch (rawError) {
      const normalized = rawError instanceof Error ? rawError : new Error("Mutation failed.");
      if (mountedRef.current) {
        setIsPending(false);
        setError(normalized);
      }
      throw normalized;
    }
  }, []);

  const reset = useCallback(() => {
    setIsPending(false);
    setError(null);
  }, []);

  return { mutateAsync, isPending, error, reset };
}

export function useCreateIssueMutation(input: { environmentId: EnvironmentId }) {
  const { environmentId } = input;
  return useSourceControlMutation(
    (payload: SourceControlCreateIssueInput) =>
      requireEnvironmentConnection(environmentId).client.sourceControl.createIssue(payload),
    {
      onSuccess: (_result, payload) => {
        invalidateSourceControlIssueLists({ environmentId, cwd: payload.cwd });
      },
    },
  );
}

/**
 * Links a pull request to a workspace by number or URL. The workspace's links
 * arrive back through orchestration events, so nothing is written here.
 */
export function useLinkWorktreePullRequestMutation(input: {
  readonly environmentId: EnvironmentId | null;
}) {
  const { environmentId } = input;
  return useSourceControlMutation((payload: LinkWorktreePullRequestInput) => {
    if (environmentId === null) {
      return Promise.reject(new Error("This workspace's environment is not connected."));
    }
    return requireEnvironmentConnection(environmentId).client.sourceControl.linkWorktreePullRequest(
      payload,
    );
  });
}

/** Hides a linked pull request from a workspace (discovery never brings it back). */
export function useDismissWorktreePullRequestMutation(input: {
  readonly environmentId: EnvironmentId | null;
}) {
  const { environmentId } = input;
  return useSourceControlMutation((payload: DismissWorktreePullRequestInput) => {
    if (environmentId === null) {
      return Promise.reject(new Error("This workspace's environment is not connected."));
    }
    return requireEnvironmentConnection(
      environmentId,
    ).client.sourceControl.dismissWorktreePullRequest(payload);
  });
}

export interface SetPullRequestWatchPayload extends PullRequestWatchTarget {
  readonly threadId: ThreadId;
  readonly action: PullRequestWatchAction;
}

/**
 * Turns Auto-fix CI on or off for a thread's pull request, or stops watching
 * it. The watch's state arrives back in the thread's shell, so nothing is
 * written here.
 */
export function useSetPullRequestWatchMutation(input: {
  readonly environmentId: EnvironmentId | null;
}) {
  const { environmentId } = input;
  return useSourceControlMutation(({ action, ...target }: SetPullRequestWatchPayload) => {
    const send =
      environmentId === null
        ? undefined
        : readEnvironmentApi(environmentId)?.sourceControl.setPullRequestWatch;
    if (send === undefined) {
      return Promise.reject(new Error("This thread's environment is not connected."));
    }
    return send(pullRequestWatchInput(target, action));
  });
}

export interface PullRequestWatchControl {
  /**
   * The node watches pull requests and this surface offers the control: a
   * thread and a pull request to watch, and not the frozen phone tier.
   */
  readonly supported: boolean;
  /** …and a change goes through right now (the environment accepts mutations). */
  readonly ready: boolean;
  /**
   * The Auto-fix CI switch is shown: a watch is on, or the pull request may
   * still be watched (a merged or closed one cannot start a watch).
   */
  readonly switchOffered: boolean;
  /** The pull request's active watch on the thread, null when there is none. */
  readonly view: PullRequestWatchView | null;
  /** Why its latest watch ended (shells keep that for a day), when none is active. */
  readonly endedLabel: string | null;
  /** The Auto-fix CI switch: the request in flight, else the watch's own state. */
  readonly autoFixChecked: boolean;
  readonly pending: boolean;
  readonly run: (action: PullRequestWatchAction) => void;
}

const selectPullRequestWatchAvailable = (config: ServerConfig | null): boolean =>
  config?.pullRequestWatch?.available === true;

/**
 * One thread's server-side watch of one pull request, for the pull request
 * page's rail and the Crown: what to show, the Auto-fix CI switch and Stop.
 * Here, beside its RPC, because both surfaces load this module already (a
 * module of their own would be a chunk of its own). Unsupported on nodes
 * without watches (older nodes send no `pullRequestWatch`) and inert until the
 * environment accepts mutations, the same readiness as linking.
 */
export function usePullRequestWatchControl(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly target: PullRequestWatchTarget | null;
  readonly watches: ThreadPullRequestWatchShell | null | undefined;
  /** The pull request is known to be merged or closed. */
  readonly closed: boolean;
}): PullRequestWatchControl {
  const { environmentId, threadId, target, watches, closed } = input;
  const presentationTier = usePresentationTier();
  const available = useEnvironmentServerConfigSelector(
    environmentId,
    selectPullRequestWatchAvailable,
  );
  const connection = useWsConnectionStatusForEnvironment(environmentId);
  const capability = useHostedRpcCapability(
    WS_METHODS.sourceControlSetPullRequestWatch,
    environmentId,
  );
  const mutation = useSetPullRequestWatchMutation({ environmentId });
  // The switch follows a request at once; the server's answer arrives in the shell.
  const [requested, setRequested] = useState<PullRequestWatchSwitchRequest | null>(null);

  const supported =
    available &&
    presentationTier !== "phone" &&
    environmentId !== null &&
    threadId !== null &&
    target !== null;
  const ready = supported && connection.phase === "connected" && capability.allowed;
  const key = pullRequestWatchControlKey({
    environmentId,
    threadId,
    number: target?.number ?? null,
  });
  const state = pullRequestWatchControlState({
    watches,
    target,
    startable: !closed,
    key,
    request: requested,
  });
  if (state.requestDone) setRequested(null);

  const run = (action: PullRequestWatchAction) => {
    if (!ready || mutation.isPending || threadId === null || target === null) return;
    const number = target.number;
    const request = pullRequestWatchSwitchRequest(action, key, watches);
    if (request !== null) setRequested(request);
    mutation.mutateAsync({ threadId, ...target, action }).then(
      () => setRequested((current) => (current === null ? null : { ...current, settled: true })),
      (error: unknown) => {
        setRequested(null);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: pullRequestWatchFailureTitle(action, number),
            description: pullRequestWatchErrorMessage(error) ?? undefined,
          }),
        );
      },
    );
  };

  return {
    supported,
    ready,
    switchOffered: state.switchOffered,
    view: state.view,
    endedLabel: state.endedLabel,
    autoFixChecked: state.autoFixChecked,
    pending: mutation.isPending,
    run,
  };
}

interface CommentMutationInput {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly reference: string;
}

/** Adds an issue comment; writes the returned detail and refreshes the issue lists. */
export function useAddIssueCommentMutation(input: CommentMutationInput) {
  return useSourceControlMutation((payload: AddCommentPayload) => addIssueComment(input, payload));
}

/** Toggles a reaction on an issue comment, optimistically, with exact rollback. */
export function useAddIssueCommentReactionMutation(input: CommentMutationInput) {
  return useSourceControlMutation((payload: CommentReactionPayload) =>
    toggleIssueCommentReaction(input, payload),
  );
}

/** Adds a conversation comment; writes the returned detail and refreshes the timeline only. */
export function useAddChangeRequestCommentMutation(input: CommentMutationInput) {
  return useSourceControlMutation((payload: AddCommentPayload) =>
    addChangeRequestComment(input, payload),
  );
}

/**
 * Toggles a reaction on a change-request comment, optimistically, with exact
 * rollback; refreshes the timeline only (never the diff, checks, or lists).
 */
export function useAddChangeRequestCommentReactionMutation(input: CommentMutationInput) {
  return useSourceControlMutation((payload: CommentReactionPayload) =>
    toggleChangeRequestCommentReaction(input, payload),
  );
}

export interface MergeChangeRequestPayload {
  readonly mergeMethod: SourceControlChangeRequestMergeMethod;
  /** Delete the head branch after a successful (non-queued) merge. */
  readonly deleteBranch?: boolean;
  /** Refuse to merge when the head moved since the user looked. */
  readonly expectedHeadSha?: string | null;
}

export function useMergeChangeRequestMutation(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  reference: string;
}) {
  return useSourceControlMutation((payload: MergeChangeRequestPayload) =>
    mergeSourceControlChangeRequest({
      environmentId: input.environmentId,
      cwd: input.cwd,
      reference: input.reference,
      mergeMethod: payload.mergeMethod,
      ...(payload.deleteBranch !== undefined ? { deleteBranch: payload.deleteBranch } : {}),
      ...(payload.expectedHeadSha ? { expectedHeadSha: payload.expectedHeadSha } : {}),
    }),
  );
}

/** Submits a whole review (verdict + line comments); refreshes detail, timeline, and lists. */
export function useSubmitChangeRequestReviewMutation(target: ChangeRequestMutationTarget) {
  return useSourceControlMutation((payload: SubmitChangeRequestReviewPayload) =>
    submitChangeRequestReview(target, payload),
  );
}

/** Replies to a review thread; writes the returned thread, then refreshes the activity. */
export function useReplyToReviewThreadMutation(target: ChangeRequestMutationTarget) {
  return useSourceControlMutation((payload: ReplyToReviewThreadPayload) =>
    replyToReviewThread(target, payload),
  );
}

/** Optimistically resolves/unresolves a thread with exact per-thread rollback. */
export function useSetReviewThreadResolvedMutation(target: ChangeRequestMutationTarget) {
  return useSourceControlMutation((payload: SetReviewThreadResolvedPayload) =>
    setReviewThreadResolved(target, payload),
  );
}

/** Edits or deletes a conversation comment, review body, or review comment. */
export function useUpdateChangeRequestCommentMutation(target: ChangeRequestMutationTarget) {
  return useSourceControlMutation((payload: UpdateChangeRequestCommentPayload) =>
    updateChangeRequestComment(target, payload),
  );
}

/**
 * Lifecycle actions (edit, draft/ready, close/reopen, reviewers, labels,
 * assignees, update branch, auto-merge, delete branch). Predictable actions
 * apply optimistically to both detail cache variants and roll back on failure.
 */
export function useUpdateChangeRequestMutation(target: ChangeRequestMutationTarget) {
  return useSourceControlMutation((action: ChangeRequestUpdateAction) =>
    updateChangeRequest(target, action),
  );
}

export function useCreateChangeRequestMutation(input: { environmentId: EnvironmentId | null }) {
  const { environmentId } = input;
  return useSourceControlMutation((payload: ChangeRequestCreateInput) =>
    createChangeRequest(environmentId, payload),
  );
}

export function useRerunWorkflowMutation(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  runId: string;
}) {
  return useSourceControlMutation(
    (payload: SourceControlWorkflowRerunPayload) => {
      if (!input.environmentId || !input.cwd) {
        throw new Error("Workflow reruns are unavailable.");
      }
      return requireEnvironmentConnection(input.environmentId).client.sourceControl.rerunWorkflow({
        cwd: input.cwd,
        runId: input.runId,
        ...payload,
      });
    },
    {
      onSuccess: () => {
        invalidateSourceControlAfterWorkflowRerun({
          environmentId: input.environmentId,
          cwd: input.cwd,
        });
      },
    },
  );
}

export interface GenerateIssueContentPayload {
  readonly cwd: string;
  readonly mode: "polish" | "title";
  readonly rough?: string;
  readonly body?: string;
  readonly currentTitle?: string;
  readonly customInstructions?: string;
}

export function useGenerateIssueContentMutation(input: { environmentId: EnvironmentId }) {
  const { environmentId } = input;
  return useSourceControlMutation((payload: GenerateIssueContentPayload) =>
    requireEnvironmentConnection(environmentId).client.textGeneration.generateIssueContent(payload),
  );
}

export function useGenerateBranchNameMutation(input: { environmentId: EnvironmentId }) {
  const { environmentId } = input;
  return useSourceControlMutation((payload: { cwd: string; message: string }) =>
    requireEnvironmentConnection(environmentId).client.textGeneration.generateBranchName(payload),
  );
}
