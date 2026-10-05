import type {
  ChangeRequest,
  ChangeRequestActivity,
  ChangeRequestCreateInput,
  ChangeRequestFileContents,
  ChangeRequestInvolvement,
  ChangeRequestReplyToThreadInput,
  ChangeRequestReplyToThreadResult,
  ChangeRequestSetThreadResolvedResult,
  ChangeRequestSubmitReviewInput,
  ChangeRequestSubmitReviewResult,
  ChangeRequestUpdateAction,
  ChangeRequestUpdateCommentInput,
  ChangeRequestUpdateCommentResult,
  ChangeRequestUpdateResult,
  EnvironmentId,
  SourceControlAddChangeRequestCommentInput,
  SourceControlAddChangeRequestCommentResult,
  SourceControlAddChangeRequestCommentReactionResult,
  SourceControlAddCommentReactionInput,
  SourceControlAddIssueCommentReactionResult,
  SourceControlAddIssueCommentResult,
  SourceControlAssigneeCandidate,
  SourceControlChangeRequestDetail,
  SourceControlChangeRequestMergeMethod,
  SourceControlCommentReaction,
  SourceControlCommentReactionContent,
  SourceControlIssueComment,
  SourceControlIssueDetail,
  SourceControlIssueSummary,
  SourceControlLabel,
  SourceControlProviderKind,
  SourceControlRepositorySearchResult,
  SourceControlWorkflowJobLogResult,
  SourceControlWorkflowRunJobsResult,
  SourceControlWorkflowRunListResult,
  SourceControlMergeChangeRequestResult,
} from "@ryco/contracts";
import { requireEnvironmentConnection } from "~/environments/runtime";
import {
  createKeyedQueryRegistry,
  defineKeyedQueryByInput,
  KEY_SEP,
  type KeyedQueryControllerBase,
} from "@ryco/client-runtime/rpc";
import {
  applyCommentUpdateToActivity,
  applyCommentUpdateToDetail,
  applyOptimisticChangeRequestUpdate,
  readReviewThreadResolution,
  replaceReviewThreadInActivity,
  resolveChangeRequestRefreshScope,
  rollbackOptimisticChangeRequestUpdate,
  rollbackReviewThreadResolved,
  setReviewThreadResolvedInActivity,
  type ChangeRequestMutation,
} from "@ryco/client-runtime/state/pull-request-review";
import {
  sourceControlReadAdmission,
  subscribeSourceControlReadAdmission,
} from "./sourceControlReadAdmission";
import { webAppLifecycle } from "~/platform/appLifecycle";
import {
  AUTOMATIC_ACTIVE_REFRESH_MS,
  resolveSourceControlFailureDelay,
} from "./sourceControlRefreshPolicy";

// ---------------------------------------------------------------------------
// Atom-backed source-control context reads.
//
// Replaces the React Query `*QueryOptions` helpers in
// `~/lib/sourceControlContextRpc` (issue/PR lists + searches) plus the former
// issue-creation label/assignee lookups and mutations. List/search reads are
// reactive (`watch*` + state atoms); issue/PR detail lookups are imperative
// cached fetches (the former `queryClient.fetchQuery` calls).
// ---------------------------------------------------------------------------

// Query families (binding labels); scoped invalidations select by them.
const ISSUE_LIST_FAMILY = "issues:list";
const ISSUE_SEARCH_FAMILY = "issues:search";
const ISSUE_DETAIL_FAMILY = "issues:detail";
const CHANGE_REQUEST_LIST_FAMILY = "changeRequests:list";
const CHANGE_REQUEST_SEARCH_FAMILY = "changeRequests:search";
const CHANGE_REQUEST_DETAIL_FAMILY = "changeRequests:detail";
const WORKFLOW_RUNS_FAMILY = "workflows:runs";
const WORKFLOW_JOBS_FAMILY = "workflows:jobs";

const ISSUE_LIST_STALE_TIME_MS = 60_000;
const CHANGE_REQUEST_LIST_STALE_TIME_MS = 60_000;
const SEARCH_STALE_TIME_MS = 30_000;
const LABELS_STALE_TIME_MS = 5 * 60_000;
const ASSIGNEES_STALE_TIME_MS = 5 * 60_000;
const DETAIL_STALE_TIME_MS = 5 * 60_000;
const ISSUE_DETAIL_STALE_TIME_MS = 300_000;
const CHANGE_REQUEST_DETAIL_STALE_TIME_MS = 300_000;
const CHANGE_REQUEST_DIFF_STALE_TIME_MS = 300_000;
const CHANGE_REQUEST_ACTIVITY_STALE_TIME_MS = 60_000;
const WORKFLOW_RUNS_STALE_TIME_MS = 60_000;
const WORKFLOW_RUN_JOBS_STALE_TIME_MS = 60_000;
const WORKFLOW_JOB_LOG_STALE_TIME_MS = 300_000;
const DEFAULT_QUERY_GC_TIME_MS = 5 * 60_000;
const SEARCH_QUERY_GC_TIME_MS = 60_000;
const LARGE_QUERY_GC_TIME_MS = 90_000;
const DETAIL_CACHE_GC_TIME_MS = 2 * 60_000;
const DETAIL_CACHE_MAX_ENTRIES = 48;
const DETAIL_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const FILE_CONTENTS_CACHE_GC_TIME_MS = 5 * 60_000;
const FILE_CONTENTS_CACHE_MAX_ENTRIES = 64;
const FILE_CONTENTS_CACHE_MAX_BYTES = 24 * 1024 * 1024;

export interface SourceControlQueryState<T> {
  readonly data: T | null;
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly error: Error | null;
}

const INITIAL_QUERY_STATE: SourceControlQueryState<never> = Object.freeze({
  data: null,
  isLoading: false,
  isFetching: false,
  error: null,
});

const sourceControlRegistry = createKeyedQueryRegistry<SourceControlQueryState<unknown>>({
  labelPrefix: "source-control",
  initialState: INITIAL_QUERY_STATE,
  gcTime: DEFAULT_QUERY_GC_TIME_MS,
  maxEntries: 192,
  lifecycle: webAppLifecycle,
  admission: {
    readState: (controller) => sourceControlReadAdmission(controller.environmentId),
    subscribe: (listener) =>
      subscribeSourceControlReadAdmission(() => {
        detailCache.reconcileAuthority();
        fileContentsCache.reconcileAuthority();
        listener();
      }),
    buildPausedState: (current, controller, retainData) => {
      controller.fetching = false;
      controller.consecutiveFailures = 0;
      if (!retainData) {
        for (const [key, entry] of sharedChangeRequestDetails) {
          if (
            sourceControlRegistry.controllers.get(entry.sourceKey)?.environmentId ===
            controller.environmentId
          )
            sharedChangeRequestDetails.delete(key);
        }
      }
      return {
        data: retainData ? current.data : null,
        error: null,
        isLoading: false,
        isFetching: false,
      };
    },
  },
  pollJitterRatio: 0.08,
  buildFetchingState: (current) => ({
    data: current.data,
    isLoading: current.data === null,
    isFetching: true,
    error: null,
  }),
  buildSuccessState: (data) => ({
    data,
    isLoading: false,
    isFetching: false,
    error: null,
  }),
  buildErrorState: (current, error) => ({
    data: current.data,
    isLoading: false,
    isFetching: false,
    error,
  }),
  isErrorState: (state) => state.error !== null,
  selectPollData: (state) => state.data,
  onRunStart: (controller) => {
    controller.fetching = true;
  },
  onRunEnd: (controller, outcome) => {
    controller.fetching = false;
    controller.consecutiveFailures =
      outcome === "success" ? 0 : (controller.consecutiveFailures as number) + 1;
  },
  adjustPollDelay: (baseDelayMs, controller) =>
    (controller.consecutiveFailures as number) > 0
      ? resolveSourceControlFailureDelay({
          baseDelayMs,
          consecutiveFailures: controller.consecutiveFailures as number,
        })
      : baseDelayMs,
  onPublish: (controller, data) => {
    if (controller.family === CHANGE_REQUEST_DETAIL_FAMILY) {
      shareFetchedChangeRequestDetail(controller, data as SourceControlChangeRequestDetail);
    }
  },
});

const { controllers, runController } = sourceControlRegistry;

export type QueryBinding<TInput, TData> = import("@ryco/client-runtime/rpc").KeyedQueryByInput<
  TInput,
  TData,
  SourceControlQueryState<TData>
>;

interface SourceControlQueryDefinition<TInput, TData> {
  readonly label: string;
  readonly staleTime: number;
  readonly gcTime?: number;
  readonly isEnabled: (input: TInput) => boolean;
  readonly buildKey: (input: TInput) => string;
  readonly resolveEnvironmentId: (input: TInput) => EnvironmentId;
  readonly resolveCwd: (input: TInput) => string;
  readonly run: (input: TInput) => Promise<TData>;
}

function defineQuery<TInput, TData>(
  definition: SourceControlQueryDefinition<TInput, TData>,
): QueryBinding<TInput, TData> {
  return defineKeyedQueryByInput(
    sourceControlRegistry,
    {
      ...definition,
      createControllerFields: (input) => ({
        cwd: definition.resolveCwd(input),
        fetching: false,
        consecutiveFailures: 0,
      }),
    },
    (controller) => {
      const isStale =
        controller.hasData && Date.now() - controller.lastFetchedAt >= controller.staleTime;
      return !controller.fetching && (!controller.hasData || isStale);
    },
  ) as QueryBinding<TInput, TData>;
}

function sourceControlClient(environmentId: EnvironmentId) {
  return requireEnvironmentConnection(environmentId).client.sourceControl;
}

// ---------------------------------------------------------------------------
// Issue list
// ---------------------------------------------------------------------------

export interface SourceControlIssueListInput {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly state: "open" | "closed" | "all";
  readonly limit?: number;
  readonly enabled?: boolean;
}

export const issueListBinding = defineQuery<
  SourceControlIssueListInput,
  ReadonlyArray<SourceControlIssueSummary>
>({
  label: ISSUE_LIST_FAMILY,
  staleTime: ISSUE_LIST_STALE_TIME_MS,
  isEnabled: (input) =>
    (input.enabled ?? true) && input.environmentId !== null && input.cwd !== null,
  buildKey: (input) =>
    `${input.environmentId}${KEY_SEP}${input.cwd}${KEY_SEP}${input.state}${KEY_SEP}${input.limit ?? ""}`,
  resolveEnvironmentId: (input) => input.environmentId as EnvironmentId,
  resolveCwd: (input) => input.cwd as string,
  run: (input) =>
    sourceControlClient(input.environmentId as EnvironmentId).listIssues({
      cwd: input.cwd as string,
      state: input.state,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    }),
});

// ---------------------------------------------------------------------------
// Change request (PR) list
// ---------------------------------------------------------------------------

export interface SourceControlChangeRequestListInput {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly state: "open" | "closed" | "merged" | "all";
  readonly limit?: number;
  /** Server-side filter relative to the authenticated viewer. Part of the cache key. */
  readonly involvement?: ChangeRequestInvolvement;
  readonly enabled?: boolean;
}

export const changeRequestListBinding = defineQuery<
  SourceControlChangeRequestListInput,
  ReadonlyArray<ChangeRequest>
>({
  label: CHANGE_REQUEST_LIST_FAMILY,
  staleTime: CHANGE_REQUEST_LIST_STALE_TIME_MS,
  isEnabled: (input) =>
    (input.enabled ?? true) && input.environmentId !== null && input.cwd !== null,
  buildKey: (input) =>
    `${input.environmentId}${KEY_SEP}${input.cwd}${KEY_SEP}${input.state}${KEY_SEP}${input.limit ?? ""}${KEY_SEP}${input.involvement ?? ""}`,
  resolveEnvironmentId: (input) => input.environmentId as EnvironmentId,
  resolveCwd: (input) => input.cwd as string,
  run: (input) =>
    sourceControlClient(input.environmentId as EnvironmentId).listChangeRequests({
      cwd: input.cwd as string,
      state: input.state,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.involvement !== undefined ? { involvement: input.involvement } : {}),
    }),
});

// ---------------------------------------------------------------------------
// Issue search
// ---------------------------------------------------------------------------

export interface SourceControlIssueSearchInput {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly query: string;
  readonly limit?: number;
  readonly enabled?: boolean;
}

export const issueSearchBinding = defineQuery<
  SourceControlIssueSearchInput,
  ReadonlyArray<SourceControlIssueSummary>
>({
  label: ISSUE_SEARCH_FAMILY,
  staleTime: SEARCH_STALE_TIME_MS,
  gcTime: SEARCH_QUERY_GC_TIME_MS,
  isEnabled: (input) =>
    (input.enabled ?? true) &&
    input.environmentId !== null &&
    input.cwd !== null &&
    input.query.length > 0,
  buildKey: (input) =>
    `${input.environmentId}${KEY_SEP}${input.cwd}${KEY_SEP}${input.query}${KEY_SEP}${input.limit ?? ""}`,
  resolveEnvironmentId: (input) => input.environmentId as EnvironmentId,
  resolveCwd: (input) => input.cwd as string,
  run: (input) =>
    sourceControlClient(input.environmentId as EnvironmentId).searchIssues({
      cwd: input.cwd as string,
      query: input.query,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    }),
});

// ---------------------------------------------------------------------------
// Change request (PR) search
// ---------------------------------------------------------------------------

export interface SourceControlChangeRequestSearchInput {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly query: string;
  readonly limit?: number;
  readonly enabled?: boolean;
}

export const changeRequestSearchBinding = defineQuery<
  SourceControlChangeRequestSearchInput,
  ReadonlyArray<ChangeRequest>
>({
  label: CHANGE_REQUEST_SEARCH_FAMILY,
  staleTime: SEARCH_STALE_TIME_MS,
  gcTime: SEARCH_QUERY_GC_TIME_MS,
  isEnabled: (input) =>
    (input.enabled ?? true) &&
    input.environmentId !== null &&
    input.cwd !== null &&
    input.query.length > 0,
  buildKey: (input) =>
    `${input.environmentId}${KEY_SEP}${input.cwd}${KEY_SEP}${input.query}${KEY_SEP}${input.limit ?? ""}`,
  resolveEnvironmentId: (input) => input.environmentId as EnvironmentId,
  resolveCwd: (input) => input.cwd as string,
  run: (input) =>
    sourceControlClient(input.environmentId as EnvironmentId).searchChangeRequests({
      cwd: input.cwd as string,
      query: input.query,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    }),
});

// ---------------------------------------------------------------------------
// Remote repository search (command palette clone flow)
// ---------------------------------------------------------------------------

export interface SourceControlRepositorySearchInput {
  readonly environmentId: EnvironmentId | null;
  readonly provider: SourceControlProviderKind | null;
  readonly query: string;
  readonly limit?: number;
  readonly enabled?: boolean;
}

export const repositorySearchBinding = defineQuery<
  SourceControlRepositorySearchInput,
  SourceControlRepositorySearchResult
>({
  label: "repositories:search",
  staleTime: SEARCH_STALE_TIME_MS,
  gcTime: SEARCH_QUERY_GC_TIME_MS,
  isEnabled: (input) =>
    (input.enabled ?? true) && input.environmentId !== null && input.provider !== null,
  buildKey: (input) =>
    `${input.environmentId}${KEY_SEP}${input.provider}${KEY_SEP}${input.query}${KEY_SEP}${input.limit ?? 25}`,
  resolveEnvironmentId: (input) => input.environmentId as EnvironmentId,
  resolveCwd: () => "",
  run: (input) =>
    sourceControlClient(input.environmentId as EnvironmentId).searchRepositories({
      provider: input.provider as SourceControlProviderKind,
      ...(input.query.length > 0 ? { query: input.query } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    }),
});

// ---------------------------------------------------------------------------
// Issue creation: labels + assignees
// ---------------------------------------------------------------------------

export interface SourceControlIssueMetaInput {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly enabled?: boolean;
}

export const issueLabelsBinding = defineQuery<
  SourceControlIssueMetaInput,
  ReadonlyArray<SourceControlLabel>
>({
  label: "issues:labels",
  staleTime: LABELS_STALE_TIME_MS,
  isEnabled: (input) =>
    (input.enabled ?? true) && input.environmentId !== null && input.cwd !== null,
  buildKey: (input) => `${input.environmentId}${KEY_SEP}${input.cwd}`,
  resolveEnvironmentId: (input) => input.environmentId as EnvironmentId,
  resolveCwd: (input) => input.cwd as string,
  run: (input) =>
    sourceControlClient(input.environmentId as EnvironmentId).listIssueLabels({
      cwd: input.cwd as string,
    }),
});

export const issueAssigneesBinding = defineQuery<
  SourceControlIssueMetaInput,
  ReadonlyArray<SourceControlAssigneeCandidate>
>({
  label: "issues:assignees",
  staleTime: ASSIGNEES_STALE_TIME_MS,
  isEnabled: (input) =>
    (input.enabled ?? true) && input.environmentId !== null && input.cwd !== null,
  buildKey: (input) => `${input.environmentId}${KEY_SEP}${input.cwd}`,
  resolveEnvironmentId: (input) => input.environmentId as EnvironmentId,
  resolveCwd: (input) => input.cwd as string,
  run: (input) =>
    sourceControlClient(input.environmentId as EnvironmentId).listIssueAssignees({
      cwd: input.cwd as string,
    }),
});

// ---------------------------------------------------------------------------
// Issue detail
// ---------------------------------------------------------------------------

export interface SourceControlIssueDetailInput {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly reference: string | null;
  readonly fullContent?: boolean;
  readonly enabled?: boolean;
}

export const issueDetailBinding = defineQuery<
  SourceControlIssueDetailInput,
  SourceControlIssueDetail
>({
  label: ISSUE_DETAIL_FAMILY,
  staleTime: ISSUE_DETAIL_STALE_TIME_MS,
  isEnabled: (input) =>
    (input.enabled ?? true) &&
    input.environmentId !== null &&
    input.cwd !== null &&
    input.reference !== null,
  buildKey: (input) =>
    `${input.environmentId}${KEY_SEP}${input.cwd}${KEY_SEP}${input.reference}${KEY_SEP}${input.fullContent ?? false}`,
  resolveEnvironmentId: (input) => input.environmentId as EnvironmentId,
  resolveCwd: (input) => input.cwd as string,
  run: (input) =>
    sourceControlClient(input.environmentId as EnvironmentId).getIssue({
      cwd: input.cwd as string,
      reference: input.reference as string,
      ...(input.fullContent ? { fullContent: true } : {}),
    }),
});

// ---------------------------------------------------------------------------
// Change request detail + diff
// ---------------------------------------------------------------------------

export interface SourceControlChangeRequestDetailInput {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly reference: string | null;
  readonly fullContent?: boolean;
  readonly enabled?: boolean;
}

export const changeRequestDetailBinding = defineQuery<
  SourceControlChangeRequestDetailInput,
  SourceControlChangeRequestDetail
>({
  label: CHANGE_REQUEST_DETAIL_FAMILY,
  staleTime: CHANGE_REQUEST_DETAIL_STALE_TIME_MS,
  isEnabled: (input) =>
    (input.enabled ?? true) &&
    input.environmentId !== null &&
    input.cwd !== null &&
    input.reference !== null,
  buildKey: (input) =>
    `${input.environmentId}${KEY_SEP}${input.cwd}${KEY_SEP}${input.reference}${KEY_SEP}${input.fullContent ?? false}`,
  resolveEnvironmentId: (input) => input.environmentId as EnvironmentId,
  resolveCwd: (input) => input.cwd as string,
  run: (input) => readChangeRequestDetail(input),
});

// ---------------------------------------------------------------------------
// Change request detail sharing
//
// One pull request is read under several keys: the page reads the uncapped
// (`fullContent`) detail through the repository checkout, while inbox rows and
// the overview read the capped variant through the thread's checkout (often a
// worktree). Each key used to poll the host on its own. Now a full read that
// one key publishes lands in every other cached detail of the same request
// (environment + URL) and re-arms their poll timers, and when another key's
// own read comes due it is served from that full read while it is younger
// than the key's own poll interval. Explicit refreshes and invalidations
// always go to the host.
// ---------------------------------------------------------------------------

/** A full detail read from the host (or returned by a mutation) for one key. */
interface ChangeRequestDetailOrigin {
  readonly sourceKey: string;
  /** When the request was sent: local writes after this are not reflected. */
  readonly startedAt: number;
  readonly fetchedAt: number;
}

interface SharedChangeRequestDetail extends ChangeRequestDetailOrigin {
  readonly detail: SourceControlChangeRequestDetail;
}

const SHARED_CHANGE_REQUEST_DETAIL_MAX_ENTRIES = 32;
/**
 * A shared read serves another key while younger than that key's interval
 * times this slack, which covers the ±8% poll jitter of both readers: a full
 * reader polling at the same cadence then always answers the others.
 */
const SHARED_CHANGE_REQUEST_DETAIL_AGE_SLACK = 1.25;

const sharedChangeRequestDetails = new Map<string, SharedChangeRequestDetail>();
const changeRequestDetailOrigins = new WeakMap<
  SourceControlChangeRequestDetail,
  ChangeRequestDetailOrigin
>();

function sharedChangeRequestDetailKey(environmentId: EnvironmentId, url: string): string {
  return `${environmentId}${KEY_SEP}${url}`;
}

function changeRequestDetailState(
  compositeKey: string,
): SourceControlQueryState<SourceControlChangeRequestDetail> {
  return sourceControlRegistry.getQueryState(
    compositeKey,
  ) as SourceControlQueryState<SourceControlChangeRequestDetail>;
}

/**
 * The shared read for `compositeKey`'s request, while it is still exactly what
 * its source key holds: an invalidated, rewritten, or evicted source no longer
 * vouches for it.
 */
function currentSharedChangeRequestDetail(
  environmentId: EnvironmentId,
  url: string,
): SharedChangeRequestDetail | null {
  const key = sharedChangeRequestDetailKey(environmentId, url);
  const entry = sharedChangeRequestDetails.get(key);
  if (!entry) return null;
  const source = controllers.get(entry.sourceKey);
  if (
    !source ||
    !source.hasData ||
    changeRequestDetailState(entry.sourceKey).data !== entry.detail
  ) {
    sharedChangeRequestDetails.delete(key);
    return null;
  }
  return entry;
}

/** A shared full read that may answer `compositeKey`'s due read, or null. */
function reusableChangeRequestDetail(
  environmentId: EnvironmentId,
  compositeKey: string,
): SourceControlChangeRequestDetail | null {
  const controller = controllers.get(compositeKey);
  // `refresh` zeroes `lastFetchedAt` and invalidation clears `hasData`: both
  // ask for the host's current answer, never a shared one.
  if (!controller || !controller.hasData || controller.lastFetchedAt === 0) return null;
  const own = changeRequestDetailState(compositeKey).data;
  if (own === null) return null;
  const entry = currentSharedChangeRequestDetail(environmentId, own.url);
  if (!entry || entry.sourceKey === compositeKey) return null;
  // The shared read predates a local (optimistic) write here.
  if ((controller.lastLocalWriteAt ?? 0) > entry.startedAt) return null;
  const interval = sourceControlRegistry.pollInterval(controller) ?? AUTOMATIC_ACTIVE_REFRESH_MS;
  if (Date.now() - entry.fetchedAt >= interval * SHARED_CHANGE_REQUEST_DETAIL_AGE_SLACK) {
    return null;
  }
  return entry.detail;
}

function readChangeRequestDetail(
  input: SourceControlChangeRequestDetailInput,
): Promise<SourceControlChangeRequestDetail> {
  const environmentId = input.environmentId as EnvironmentId;
  const compositeKey = changeRequestDetailBinding.targetKey(input);
  if (compositeKey !== null) {
    const shared = reusableChangeRequestDetail(environmentId, compositeKey);
    if (shared !== null) return Promise.resolve(shared);
  }
  const startedAt = Date.now();
  return sourceControlClient(environmentId)
    .getChangeRequestDetail({
      cwd: input.cwd as string,
      reference: input.reference as string,
      ...(input.fullContent ? { fullContent: true } : {}),
    })
    .then((detail) => {
      // Only uncapped reads may stand in for other keys.
      if (input.fullContent && compositeKey !== null) {
        changeRequestDetailOrigins.set(detail, {
          sourceKey: compositeKey,
          startedAt,
          fetchedAt: Date.now(),
        });
      }
      return detail;
    });
}

/**
 * Records a full detail for its request and publishes it into every other
 * cached detail of that request in the environment (any checkout, any
 * variant), unless that key holds something newer.
 */
function shareChangeRequestDetail(
  environmentId: EnvironmentId,
  entry: SharedChangeRequestDetail,
  skipKeys: ReadonlySet<string>,
): void {
  const key = sharedChangeRequestDetailKey(environmentId, entry.detail.url);
  sharedChangeRequestDetails.delete(key);
  sharedChangeRequestDetails.set(key, entry);
  while (sharedChangeRequestDetails.size > SHARED_CHANGE_REQUEST_DETAIL_MAX_ENTRIES) {
    const oldest = sharedChangeRequestDetails.keys().next().value;
    if (oldest === undefined) break;
    sharedChangeRequestDetails.delete(oldest);
  }

  for (const compositeKey of sourceControlRegistry.controllerKeys({
    environmentId,
    family: CHANGE_REQUEST_DETAIL_FAMILY,
  })) {
    if (compositeKey === entry.sourceKey || skipKeys.has(compositeKey)) continue;
    const controller = controllers.get(compositeKey);
    const current = changeRequestDetailState(compositeKey).data;
    if (!controller || current === null || current === entry.detail) continue;
    if (current.url !== entry.detail.url) continue;
    // Its own read landed after this one, or a local write is not in it yet.
    if (controller.lastFetchedAt > entry.fetchedAt) continue;
    if ((controller.lastLocalWriteAt ?? 0) > entry.startedAt) continue;
    // Supersede its own older read in flight, publish, and restart its poll
    // clock: this read is as fresh as one of its own.
    sourceControlRegistry.markLocalWrite(controller);
    controller.hasData = true;
    controller.lastFetchedAt = Date.now();
    sourceControlRegistry.setQueryState(compositeKey, {
      data: entry.detail,
      isLoading: false,
      isFetching: false,
      error: null,
    });
    sourceControlRegistry.schedulePoll(controller);
  }
}

function shareFetchedChangeRequestDetail(
  controller: { readonly compositeKey: string; readonly environmentId: EnvironmentId },
  detail: SourceControlChangeRequestDetail,
): void {
  const origin = changeRequestDetailOrigins.get(detail);
  // Capped reads and shared reads re-published by another key are not sources.
  if (!origin || origin.sourceKey !== controller.compositeKey) return;
  shareChangeRequestDetail(controller.environmentId, { ...origin, detail }, new Set());
}

export interface SourceControlChangeRequestDiffInput {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly reference: string | null;
  readonly enabled?: boolean;
  readonly headSha?: string | null;
  /** Scope the diff to one commit of the change request. Part of the cache key. */
  readonly commitSha?: string | null;
}

export const changeRequestDiffBinding = defineQuery<SourceControlChangeRequestDiffInput, string>({
  label: "changeRequests:diff",
  staleTime: CHANGE_REQUEST_DIFF_STALE_TIME_MS,
  gcTime: LARGE_QUERY_GC_TIME_MS,
  isEnabled: (input) =>
    (input.enabled ?? true) &&
    input.environmentId !== null &&
    input.cwd !== null &&
    input.reference !== null,
  buildKey: (input) =>
    `${input.environmentId}${KEY_SEP}${input.cwd}${KEY_SEP}${input.reference}${KEY_SEP}${input.headSha ?? ""}${KEY_SEP}${input.commitSha ?? ""}`,
  resolveEnvironmentId: (input) => input.environmentId as EnvironmentId,
  resolveCwd: (input) => input.cwd as string,
  run: (input) =>
    sourceControlClient(input.environmentId as EnvironmentId).getChangeRequestDiff({
      cwd: input.cwd as string,
      reference: input.reference as string,
      ...(input.headSha ? { expectedHeadSha: input.headSha } : {}),
      ...(input.commitSha ? { commitSha: input.commitSha } : {}),
    }),
});

// ---------------------------------------------------------------------------
// Change request activity (timeline, review threads, viewer capabilities)
// ---------------------------------------------------------------------------

export interface SourceControlChangeRequestActivityInput {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  /** Use the same reference (the PR number as a string) everywhere so caches line up. */
  readonly reference: string | null;
  readonly enabled?: boolean;
}

export const changeRequestActivityBinding = defineQuery<
  SourceControlChangeRequestActivityInput,
  ChangeRequestActivity
>({
  label: "changeRequests:activity",
  staleTime: CHANGE_REQUEST_ACTIVITY_STALE_TIME_MS,
  gcTime: LARGE_QUERY_GC_TIME_MS,
  isEnabled: (input) =>
    (input.enabled ?? true) &&
    input.environmentId !== null &&
    input.cwd !== null &&
    input.reference !== null,
  buildKey: (input) => `${input.environmentId}${KEY_SEP}${input.cwd}${KEY_SEP}${input.reference}`,
  resolveEnvironmentId: (input) => input.environmentId as EnvironmentId,
  resolveCwd: (input) => input.cwd as string,
  run: (input) =>
    sourceControlClient(input.environmentId as EnvironmentId).getChangeRequestActivity({
      cwd: input.cwd as string,
      reference: input.reference as string,
    }),
});

// ---------------------------------------------------------------------------
// Workflow runs, jobs, and logs
// ---------------------------------------------------------------------------

export interface SourceControlWorkflowRunsInput {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly pullRequestNumber?: number | null;
  readonly commitSha?: string | null;
  readonly branch?: string | null;
  readonly limit?: number;
  readonly enabled?: boolean;
}

export const workflowRunsBinding = defineQuery<
  SourceControlWorkflowRunsInput,
  SourceControlWorkflowRunListResult
>({
  label: WORKFLOW_RUNS_FAMILY,
  staleTime: WORKFLOW_RUNS_STALE_TIME_MS,
  isEnabled: (input) =>
    (input.enabled ?? true) && input.environmentId !== null && input.cwd !== null,
  buildKey: (input) =>
    `${input.environmentId}${KEY_SEP}${input.cwd}${KEY_SEP}${input.pullRequestNumber ?? ""}${KEY_SEP}${input.commitSha ?? ""}${KEY_SEP}${input.branch ?? ""}${KEY_SEP}${input.limit ?? ""}`,
  resolveEnvironmentId: (input) => input.environmentId as EnvironmentId,
  resolveCwd: (input) => input.cwd as string,
  run: (input) =>
    sourceControlClient(input.environmentId as EnvironmentId).listWorkflowRuns({
      cwd: input.cwd as string,
      ...(input.pullRequestNumber !== undefined && input.pullRequestNumber !== null
        ? { pullRequestNumber: input.pullRequestNumber }
        : {}),
      ...(input.commitSha !== undefined && input.commitSha !== null
        ? { commitSha: input.commitSha }
        : {}),
      ...(input.branch !== undefined && input.branch !== null ? { branch: input.branch } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    }),
});

export interface SourceControlWorkflowRunJobsInput {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly runId: string | null;
  readonly enabled?: boolean;
}

export const workflowRunJobsBinding = defineQuery<
  SourceControlWorkflowRunJobsInput,
  SourceControlWorkflowRunJobsResult
>({
  label: WORKFLOW_JOBS_FAMILY,
  staleTime: WORKFLOW_RUN_JOBS_STALE_TIME_MS,
  isEnabled: (input) =>
    (input.enabled ?? true) &&
    input.environmentId !== null &&
    input.cwd !== null &&
    input.runId !== null,
  buildKey: (input) => `${input.environmentId}${KEY_SEP}${input.cwd}${KEY_SEP}${input.runId}`,
  resolveEnvironmentId: (input) => input.environmentId as EnvironmentId,
  resolveCwd: (input) => input.cwd as string,
  run: (input) =>
    sourceControlClient(input.environmentId as EnvironmentId).getWorkflowRunJobs({
      cwd: input.cwd as string,
      runId: input.runId as string,
    }),
});

export interface SourceControlWorkflowJobLogInput {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly runId: string | null;
  readonly jobId: string | null;
  readonly enabled?: boolean;
}

export const workflowJobLogBinding = defineQuery<
  SourceControlWorkflowJobLogInput,
  SourceControlWorkflowJobLogResult
>({
  label: "workflows:jobLog",
  staleTime: WORKFLOW_JOB_LOG_STALE_TIME_MS,
  gcTime: LARGE_QUERY_GC_TIME_MS,
  isEnabled: (input) =>
    (input.enabled ?? false) &&
    input.environmentId !== null &&
    input.cwd !== null &&
    input.runId !== null &&
    input.jobId !== null,
  buildKey: (input) =>
    `${input.environmentId}${KEY_SEP}${input.cwd}${KEY_SEP}${input.runId}${KEY_SEP}${input.jobId}`,
  resolveEnvironmentId: (input) => input.environmentId as EnvironmentId,
  resolveCwd: (input) => input.cwd as string,
  run: (input) =>
    sourceControlClient(input.environmentId as EnvironmentId).getWorkflowJobLog({
      cwd: input.cwd as string,
      runId: input.runId as string,
      jobId: input.jobId as string,
    }),
});

// ---------------------------------------------------------------------------
// Imperative detail fetches (cached, replacing queryClient.fetchQuery)
// ---------------------------------------------------------------------------

interface ImperativeCacheEntry<T> {
  readonly value: T;
  readonly fetchedAt: number;
}

interface ImperativeCacheSlot {
  readonly authorityScope: string | null;
  readonly authorityLease: { revoked: boolean };
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  promise?: Promise<unknown>;
  entry?: ImperativeCacheEntry<unknown>;
  bytes: number;
  lastAccessedAt: number;
  gcTimer: ReturnType<typeof setTimeout> | null;
}

function estimatePayloadBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return 0;
  }
}

/**
 * Bounded LRU for imperative (non-reactive) reads: dedupes in-flight requests,
 * serves fresh entries within `staleTime`, evicts least-recently-used entries
 * past the entry/byte budget, and drops idle entries after `gcTimeMs`.
 */
function createImperativeCache(config: {
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly gcTimeMs: number;
  readonly estimateBytes?: (value: unknown) => number;
}) {
  const slots = new Map<string, ImperativeCacheSlot>();
  const activeLeases = new Map<
    { revoked: boolean },
    { environmentId: EnvironmentId; scope: string | null }
  >();
  let totalBytes = 0;
  const estimateBytes = config.estimateBytes ?? estimatePayloadBytes;

  function remove(cacheKey: string): void {
    const slot = slots.get(cacheKey);
    if (!slot) return;
    if (slot.gcTimer !== null) clearTimeout(slot.gcTimer);
    slots.delete(cacheKey);
    totalBytes = Math.max(0, totalBytes - slot.bytes);
  }

  function scheduleGc(cacheKey: string, slot: ImperativeCacheSlot): void {
    if (slot.gcTimer !== null) clearTimeout(slot.gcTimer);
    slot.gcTimer = setTimeout(() => {
      const current = slots.get(cacheKey);
      if (current === slot && !current.promise) remove(cacheKey);
    }, config.gcTimeMs);
  }

  function evictToBudget(): void {
    if (slots.size <= config.maxEntries && totalBytes <= config.maxBytes) return;
    const candidates = [...slots.entries()]
      .filter(([, slot]) => !slot.promise)
      .toSorted(([, left], [, right]) => left.lastAccessedAt - right.lastAccessedAt);
    for (const [cacheKey] of candidates) {
      remove(cacheKey);
      if (slots.size <= config.maxEntries && totalBytes <= config.maxBytes) break;
    }
  }

  async function fetch<T>(params: {
    readonly cacheKey: string;
    readonly environmentId: EnvironmentId;
    readonly cwd: string;
    readonly staleTime: number;
    readonly run: () => Promise<T>;
  }): Promise<T> {
    reconcileAuthority();
    const authorityScope = sourceControlReadAdmission(params.environmentId).scope;
    const authorityLease = { revoked: false };
    const existing = slots.get(params.cacheKey);
    if (existing?.entry && Date.now() - existing.entry.fetchedAt < params.staleTime) {
      existing.lastAccessedAt = Date.now();
      scheduleGc(params.cacheKey, existing);
      return existing.entry.value as T;
    }
    if (existing?.promise) {
      return existing.promise as Promise<T>;
    }

    activeLeases.set(authorityLease, {
      environmentId: params.environmentId,
      scope: authorityScope,
    });
    let request: Promise<T>;
    try {
      request = params.run();
    } catch (error) {
      activeLeases.delete(authorityLease);
      throw error;
    }
    const promise: Promise<T> = request
      .then((value) => {
        if (
          authorityLease.revoked ||
          sourceControlReadAdmission(params.environmentId).scope !== authorityScope ||
          authorityScope === null
        ) {
          throw new DOMException("Source-control read authority changed.", "AbortError");
        }
        const current = slots.get(params.cacheKey);
        // Invalidated (or replaced) while in flight: hand the value to this
        // caller but do not resurrect a cache entry the invalidation dropped.
        if (current?.promise !== promise) return value;
        if (current.gcTimer !== null) clearTimeout(current.gcTimer);
        const bytes = estimateBytes(value);
        totalBytes = Math.max(0, totalBytes - current.bytes) + bytes;
        const slot: ImperativeCacheSlot = {
          authorityScope,
          authorityLease,
          environmentId: params.environmentId,
          cwd: params.cwd,
          entry: { value, fetchedAt: Date.now() },
          bytes,
          lastAccessedAt: Date.now(),
          gcTimer: null,
        };
        slots.set(params.cacheKey, slot);
        scheduleGc(params.cacheKey, slot);
        evictToBudget();
        return value;
      })
      .catch((error: unknown) => {
        if (slots.get(params.cacheKey)?.promise === promise) remove(params.cacheKey);
        throw error;
      })
      .finally(() => activeLeases.delete(authorityLease));

    slots.set(params.cacheKey, {
      authorityScope,
      authorityLease,
      environmentId: params.environmentId,
      cwd: params.cwd,
      promise,
      bytes: existing?.bytes ?? 0,
      lastAccessedAt: Date.now(),
      gcTimer: existing?.gcTimer ?? null,
    });
    return promise;
  }

  function invalidate(filter: {
    readonly environmentId: EnvironmentId | null;
    readonly cwd: string | null;
  }): void {
    for (const [cacheKey, slot] of slots) {
      if (filter.environmentId !== null && slot.environmentId !== filter.environmentId) continue;
      if (filter.cwd !== null && slot.cwd !== filter.cwd) continue;
      remove(cacheKey);
    }
  }

  function reset(): void {
    // Deleting the current entry while iterating a Map is safe.
    for (const cacheKey of slots.keys()) remove(cacheKey);
    for (const lease of activeLeases.keys()) lease.revoked = true;
    activeLeases.clear();
  }

  function reconcileAuthority(): void {
    // An ordinary invalidation may already have removed an in-flight slot.
    // Keep fencing its direct consumer until the promise itself has settled.
    for (const [lease, authority] of activeLeases) {
      const scope = sourceControlReadAdmission(authority.environmentId).scope;
      if (scope === null || scope !== authority.scope) lease.revoked = true;
    }
    for (const [key, slot] of slots) {
      const scope = sourceControlReadAdmission(slot.environmentId).scope;
      if (scope === null || scope !== slot.authorityScope) {
        slot.authorityLease.revoked = true;
        remove(key);
      }
    }
  }

  return { fetch, invalidate, invalidateKey: remove, reset, reconcileAuthority };
}

const detailCache = createImperativeCache({
  maxEntries: DETAIL_CACHE_MAX_ENTRIES,
  maxBytes: DETAIL_CACHE_MAX_BYTES,
  gcTimeMs: DETAIL_CACHE_GC_TIME_MS,
});

// Keyed by immutable revisions, so it is not dropped by `invalidateSourceControl`.
const fileContentsCache = createImperativeCache({
  maxEntries: FILE_CONTENTS_CACHE_MAX_ENTRIES,
  maxBytes: FILE_CONTENTS_CACHE_MAX_BYTES,
  gcTimeMs: FILE_CONTENTS_CACHE_GC_TIME_MS,
  // UTF-16 upper bound; avoids re-encoding up to 2 MB of text per entry.
  estimateBytes: (value) => {
    const contents = value as ChangeRequestFileContents;
    return 2 * ((contents.oldContents?.length ?? 0) + (contents.newContents?.length ?? 0));
  },
});

function imperativeDetailCacheKey(
  kind: "issueDetail" | "changeRequestDetail",
  input: {
    readonly environmentId: EnvironmentId;
    readonly cwd: string;
    readonly reference: string;
    readonly fullContent: boolean;
  },
): string {
  return [kind, input.environmentId, input.cwd, input.reference, input.fullContent].join(KEY_SEP);
}

/** Drops both cached variants of one issue or change request's imperative detail. */
function dropImperativeDetail(
  kind: "issueDetail" | "changeRequestDetail",
  target: ResolvedChangeRequestTarget,
): void {
  for (const fullContent of [true, false]) {
    detailCache.invalidateKey(imperativeDetailCacheKey(kind, { ...target, fullContent }));
  }
}

export function fetchSourceControlIssueDetail(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly reference: string;
  readonly fullContent?: boolean;
}): Promise<SourceControlIssueDetail> {
  if (!input.environmentId || !input.cwd) {
    return Promise.reject(new Error("Issue detail is unavailable."));
  }
  const environmentId = input.environmentId;
  const cwd = input.cwd;
  const fullContent = input.fullContent ?? false;
  const cacheKey = imperativeDetailCacheKey("issueDetail", {
    environmentId,
    cwd,
    reference: input.reference,
    fullContent,
  });
  return detailCache.fetch({
    cacheKey,
    environmentId,
    cwd,
    staleTime: DETAIL_STALE_TIME_MS,
    run: () =>
      sourceControlClient(environmentId).getIssue({
        cwd,
        reference: input.reference,
        ...(fullContent ? { fullContent: true } : {}),
      }),
  });
}

export function fetchSourceControlChangeRequestDetail(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly reference: string;
  readonly fullContent?: boolean;
  /** Ignore any cached copy (a read already in flight is still joined). */
  readonly fresh?: boolean;
}): Promise<SourceControlChangeRequestDetail> {
  if (!input.environmentId || !input.cwd) {
    return Promise.reject(new Error("Change request detail is unavailable."));
  }
  const environmentId = input.environmentId;
  const cwd = input.cwd;
  const fullContent = input.fullContent ?? false;
  const cacheKey = imperativeDetailCacheKey("changeRequestDetail", {
    environmentId,
    cwd,
    reference: input.reference,
    fullContent,
  });
  return detailCache.fetch({
    cacheKey,
    environmentId,
    cwd,
    staleTime: input.fresh ? 0 : DETAIL_STALE_TIME_MS,
    run: () =>
      sourceControlClient(environmentId).getChangeRequestDetail({
        cwd,
        reference: input.reference,
        ...(fullContent ? { fullContent: true } : {}),
      }),
  });
}

export interface SourceControlChangeRequestFileContentsInput {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly reference: string;
  readonly path: string;
  /** Pre-rename path on the base side, when the file moved. */
  readonly previousPath?: string | null;
  /** Omit for the whole change request (server resolves the merge base). */
  readonly baseSha?: string | null;
  readonly headSha: string;
}

/**
 * Both sides of one changed file, for diff hunk expansion
 * (`@pierre/diffs` `loadDiffFiles`). Cached in a bounded LRU keyed by
 * environment, checkout, reference, path, and both revisions.
 */
export function loadChangeRequestFileContents(
  input: SourceControlChangeRequestFileContentsInput,
): Promise<ChangeRequestFileContents> {
  if (!input.environmentId || !input.cwd) {
    return Promise.reject(new Error("File contents are unavailable."));
  }
  const environmentId = input.environmentId;
  const cwd = input.cwd;
  const previousPath = input.previousPath ?? null;
  const baseSha = input.baseSha ?? null;
  const cacheKey = [
    "changeRequestFileContents",
    environmentId,
    cwd,
    input.reference,
    input.path,
    previousPath ?? "",
    baseSha ?? "",
    input.headSha,
  ].join(KEY_SEP);
  return fileContentsCache.fetch({
    cacheKey,
    environmentId,
    cwd,
    staleTime: Number.POSITIVE_INFINITY,
    run: () =>
      sourceControlClient(environmentId).getChangeRequestFileContents({
        cwd,
        reference: input.reference,
        path: input.path,
        ...(previousPath !== null && previousPath !== input.path ? { previousPath } : {}),
        ...(baseSha !== null ? { baseSha } : {}),
        headSha: input.headSha,
      }),
  });
}

// ---------------------------------------------------------------------------
// Invalidation
//
// Invalidated reads are marked stale and fenced (a read already in flight can
// no longer publish); mounted ones refetch at once, idle ones on their next
// watch. `invalidateSourceControl` covers every read of a checkout and is for
// changes that can move anything (a merge, a push, a manual refresh). Everything
// else invalidates only the families or keys it changed.
// ---------------------------------------------------------------------------

function invalidateController(
  controller: KeyedQueryControllerBase & Record<string, unknown>,
): void {
  controller.hasData = false;
  sourceControlRegistry.cancel(controller);
  controller.fetching = false;
  if (controller.subscriberCount > 0) {
    void runController(controller);
  }
}

interface SourceControlInvalidationFilter {
  readonly environmentId?: EnvironmentId | null;
  readonly cwd?: string | null;
}

function invalidateFamilies(
  filter: SourceControlInvalidationFilter,
  families: ReadonlyArray<string> | null,
): void {
  const environmentId = filter.environmentId ?? null;
  const cwd = filter.cwd ?? null;
  for (const family of families ?? [null]) {
    const keys = sourceControlRegistry.controllerKeys({
      ...(environmentId !== null ? { environmentId } : {}),
      ...(family !== null ? { family } : {}),
    });
    for (const compositeKey of keys) {
      const controller = controllers.get(compositeKey);
      if (!controller) continue;
      if (cwd !== null && (controller.cwd as string) !== cwd) continue;
      invalidateController(controller);
    }
  }
}

function invalidateKeys(compositeKeys: ReadonlyArray<string | null>): void {
  for (const compositeKey of compositeKeys) {
    const controller = compositeKey === null ? undefined : controllers.get(compositeKey);
    if (controller) invalidateController(controller);
  }
}

/** Every source-control read of a checkout (or environment, or all of them). */
export function invalidateSourceControl(input?: SourceControlInvalidationFilter): void {
  invalidateFamilies(input ?? {}, null);
  detailCache.invalidate({
    environmentId: input?.environmentId ?? null,
    cwd: input?.cwd ?? null,
  });
}

/** Issue list and search reads of a checkout (a new issue, a new comment count). */
export function invalidateSourceControlIssueLists(filter: SourceControlInvalidationFilter): void {
  invalidateFamilies(filter, [ISSUE_LIST_FAMILY, ISSUE_SEARCH_FAMILY]);
}

/** Workflow runs and their job lists for a checkout (never job logs). */
export function invalidateSourceControlWorkflowRuns(filter: SourceControlInvalidationFilter): void {
  invalidateFamilies(filter, [WORKFLOW_RUNS_FAMILY, WORKFLOW_JOBS_FAMILY]);
}

/**
 * After a workflow re-run: the runs and their jobs restart, and the check
 * rollups that change request details and list rows carry move with them.
 * The diff, activity, and logs of earlier attempts are untouched.
 */
export function invalidateSourceControlAfterWorkflowRerun(
  filter: SourceControlInvalidationFilter,
): void {
  invalidateFamilies(filter, [
    WORKFLOW_RUNS_FAMILY,
    WORKFLOW_JOBS_FAMILY,
    CHANGE_REQUEST_DETAIL_FAMILY,
    CHANGE_REQUEST_LIST_FAMILY,
    CHANGE_REQUEST_SEARCH_FAMILY,
  ]);
}

/** Retries one job log (and nothing else). */
export function retrySourceControlWorkflowJobLog(input: SourceControlWorkflowJobLogInput): void {
  invalidateKeys([workflowJobLogBinding.targetKey(input)]);
}

export async function mergeSourceControlChangeRequest(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly reference: string | null;
  readonly mergeMethod: SourceControlChangeRequestMergeMethod;
  /** Delete the head branch after a successful (non-queued) merge. */
  readonly deleteBranch?: boolean;
  /** Refuse to merge when the head moved since the user looked. */
  readonly expectedHeadSha?: string | null;
}): Promise<SourceControlMergeChangeRequestResult> {
  if (!input.environmentId || !input.cwd || !input.reference) {
    throw new Error("Pull request merging is unavailable.");
  }
  const result = await sourceControlClient(input.environmentId).mergeChangeRequest({
    cwd: input.cwd,
    reference: input.reference,
    mergeMethod: input.mergeMethod,
    ...(input.deleteBranch !== undefined ? { deleteBranch: input.deleteBranch } : {}),
    ...(input.expectedHeadSha ? { expectedHeadSha: input.expectedHeadSha } : {}),
  });
  invalidateSourceControl({ environmentId: input.environmentId, cwd: input.cwd });
  return result;
}

// ---------------------------------------------------------------------------
// Change request review and lifecycle mutations
//
// Imperative so they stay testable without React; `useSourceControl` wraps
// them in hooks. Cache writes go through `updateData`, which supersedes reads
// already in flight. Each mutation then refetches exactly the reads it can
// have changed (`resolveChangeRequestRefreshScope`): its detail, activity, or
// the list rows. Diffs, job logs, and file contents are only refetched when
// the head moved or the request merged.
// ---------------------------------------------------------------------------

export interface ChangeRequestMutationTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly reference: string | null;
}

interface ResolvedChangeRequestTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly reference: string;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type SubmitChangeRequestReviewPayload = Omit<
  ChangeRequestSubmitReviewInput,
  "cwd" | "reference"
>;
export type ReplyToReviewThreadPayload = Omit<ChangeRequestReplyToThreadInput, "cwd" | "reference">;
export interface SetReviewThreadResolvedPayload {
  readonly threadId: string;
  readonly resolved: boolean;
}
export type UpdateChangeRequestCommentPayload = DistributiveOmit<
  ChangeRequestUpdateCommentInput,
  "cwd" | "reference"
>;
export type AddCommentPayload = Pick<
  SourceControlAddChangeRequestCommentInput,
  "body" | "clientMutationId"
>;
export type CommentReactionPayload = Pick<
  SourceControlAddCommentReactionInput,
  "commentId" | "content"
>;

function resolveTarget(target: ChangeRequestMutationTarget): ResolvedChangeRequestTarget | null {
  if (!target.environmentId || !target.cwd || !target.reference) return null;
  return { environmentId: target.environmentId, cwd: target.cwd, reference: target.reference };
}

function requireChangeRequestTarget(
  target: ChangeRequestMutationTarget,
  unavailable: string,
): ResolvedChangeRequestTarget {
  const resolved = resolveTarget(target);
  if (resolved === null) throw new Error(unavailable);
  return resolved;
}

function changeRequestDetailInputs(
  target: ResolvedChangeRequestTarget,
): readonly [SourceControlChangeRequestDetailInput, SourceControlChangeRequestDetailInput] {
  return [
    { ...target, fullContent: true },
    { ...target, fullContent: false },
  ];
}

/**
 * Refetches what a change-request mutation changed. Imperative detail reads
 * (agent hand-off, composer context) of the request are dropped either way.
 */
function refreshAfterChangeRequestMutation(
  target: ResolvedChangeRequestTarget,
  mutation: ChangeRequestMutation,
): void {
  const scope = resolveChangeRequestRefreshScope(mutation);
  dropImperativeDetail("changeRequestDetail", target);
  if (scope.checkout) {
    invalidateSourceControl({ environmentId: target.environmentId, cwd: target.cwd });
    return;
  }
  invalidateKeys([
    ...(scope.detail
      ? changeRequestDetailInputs(target).map((input) =>
          changeRequestDetailBinding.targetKey(input),
        )
      : []),
    ...(scope.activity ? [changeRequestActivityBinding.targetKey(target)] : []),
  ]);
  if (scope.lists) {
    invalidateFamilies(target, [CHANGE_REQUEST_LIST_FAMILY, CHANGE_REQUEST_SEARCH_FAMILY]);
  }
}

/**
 * Writes a fresh, uncapped detail the host returned. The target's full
 * variant always takes it, its capped variant when something already holds
 * it, and every other cached detail of the same request (an inbox row or the
 * overview reading through a worktree) through detail sharing.
 */
export function writeChangeRequestDetail(
  target: ChangeRequestMutationTarget,
  detail: SourceControlChangeRequestDetail,
): void {
  const resolved = resolveTarget(target);
  if (resolved === null) return;
  const [fullInput, summaryInput] = changeRequestDetailInputs(resolved);
  changeRequestDetailBinding.updateData(fullInput, () => detail);
  if (changeRequestDetailBinding.snapshotFor(summaryInput).data !== null) {
    changeRequestDetailBinding.updateData(summaryInput, () => detail);
  }
  const fullKey = changeRequestDetailBinding.targetKey(fullInput);
  const summaryKey = changeRequestDetailBinding.targetKey(summaryInput);
  if (fullKey === null) return;
  const now = Date.now();
  shareChangeRequestDetail(
    resolved.environmentId,
    { sourceKey: fullKey, startedAt: now, fetchedAt: now, detail },
    new Set(summaryKey === null ? [] : [summaryKey]),
  );
}

export async function submitChangeRequestReview(
  target: ChangeRequestMutationTarget,
  payload: SubmitChangeRequestReviewPayload,
): Promise<ChangeRequestSubmitReviewResult> {
  const resolved = requireChangeRequestTarget(target, "Pull request reviews are unavailable.");
  const result = await sourceControlClient(resolved.environmentId).submitChangeRequestReview({
    cwd: resolved.cwd,
    reference: resolved.reference,
    ...payload,
  });
  refreshAfterChangeRequestMutation(resolved, { kind: "review" });
  return result;
}

export async function replyToReviewThread(
  target: ChangeRequestMutationTarget,
  payload: ReplyToReviewThreadPayload,
): Promise<ChangeRequestReplyToThreadResult> {
  const resolved = requireChangeRequestTarget(target, "Review replies are unavailable.");
  const result = await sourceControlClient(resolved.environmentId).replyToReviewThread({
    cwd: resolved.cwd,
    reference: resolved.reference,
    ...payload,
  });
  changeRequestActivityBinding.updateData(resolved, (current) =>
    current ? replaceReviewThreadInActivity(current, result.thread) : current,
  );
  refreshAfterChangeRequestMutation(resolved, { kind: "thread-reply" });
  return result;
}

/** Latest resolve/unresolve per activity key + thread; older outcomes must not land over it. */
const pendingThreadResolutions = new Map<string, number>();
let threadResolutionSequence = 0;

/**
 * Optimistically flips a thread, then applies the host's answer. On failure
 * only that thread's resolution is restored, and only while it still shows the
 * optimistic value, so a newer read or toggle is never clobbered.
 */
export async function setReviewThreadResolved(
  target: ChangeRequestMutationTarget,
  payload: SetReviewThreadResolvedPayload,
): Promise<ChangeRequestSetThreadResolvedResult> {
  const resolved = requireChangeRequestTarget(target, "Resolving review threads is unavailable.");
  const pendingKey = `${changeRequestActivityBinding.targetKey(resolved)}${KEY_SEP}${payload.threadId}`;
  const token = ++threadResolutionSequence;
  pendingThreadResolutions.set(pendingKey, token);

  const current = changeRequestActivityBinding.snapshotFor(resolved).data;
  const previous = readReviewThreadResolution(current, payload.threadId);
  const viewerLogin = current?.viewer?.login;
  changeRequestActivityBinding.updateData(resolved, (data) =>
    data
      ? setReviewThreadResolvedInActivity(data, payload.threadId, {
          isResolved: payload.resolved,
          ...(payload.resolved && viewerLogin ? { resolvedBy: viewerLogin } : {}),
        })
      : data,
  );

  try {
    const result = await sourceControlClient(resolved.environmentId).setReviewThreadResolved({
      cwd: resolved.cwd,
      reference: resolved.reference,
      threadId: payload.threadId,
      resolved: payload.resolved,
    });
    if (pendingThreadResolutions.get(pendingKey) === token) {
      changeRequestActivityBinding.updateData(resolved, (data) =>
        data
          ? setReviewThreadResolvedInActivity(data, result.threadId, {
              isResolved: result.isResolved,
              ...(result.resolvedBy !== undefined ? { resolvedBy: result.resolvedBy } : {}),
            })
          : data,
      );
    }
    refreshAfterChangeRequestMutation(resolved, { kind: "thread-resolve" });
    return result;
  } catch (error) {
    if (previous !== null) {
      changeRequestActivityBinding.updateData(resolved, (data) =>
        data
          ? rollbackReviewThreadResolved(data, payload.threadId, previous, payload.resolved)
          : data,
      );
    }
    throw error;
  } finally {
    if (pendingThreadResolutions.get(pendingKey) === token) {
      pendingThreadResolutions.delete(pendingKey);
    }
  }
}

export async function updateChangeRequestComment(
  target: ChangeRequestMutationTarget,
  payload: UpdateChangeRequestCommentPayload,
): Promise<ChangeRequestUpdateCommentResult> {
  const resolved = requireChangeRequestTarget(target, "Editing comments is unavailable.");
  const result = await sourceControlClient(resolved.environmentId).updateChangeRequestComment({
    cwd: resolved.cwd,
    reference: resolved.reference,
    ...payload,
  } as ChangeRequestUpdateCommentInput);
  const update =
    payload.action === "edit"
      ? { commentId: payload.commentId, action: "edit" as const, body: payload.body }
      : result.deleted
        ? { commentId: payload.commentId, action: "delete" as const }
        : null;
  if (update !== null) {
    changeRequestActivityBinding.updateData(resolved, (current) =>
      current ? applyCommentUpdateToActivity(current, update) : current,
    );
    for (const input of changeRequestDetailInputs(resolved)) {
      changeRequestDetailBinding.updateData(input, (current) =>
        current ? applyCommentUpdateToDetail(current, update) : current,
      );
    }
  }
  refreshAfterChangeRequestMutation(resolved, { kind: "comment-update" });
  return result;
}

/**
 * Applies a lifecycle action. Draft state, labels, reviewers, assignees, and
 * title/body/base edits show immediately in both cached detail variants and
 * roll back field by field on failure; the host's fresh detail then replaces
 * both variants (and every other cached copy of the request). Only what the
 * action changed is refetched; a moved head or a merge refreshes the checkout.
 */
export async function updateChangeRequest(
  target: ChangeRequestMutationTarget,
  action: ChangeRequestUpdateAction,
): Promise<ChangeRequestUpdateResult> {
  const resolved = requireChangeRequestTarget(target, "Updating pull requests is unavailable.");
  const inputs = changeRequestDetailInputs(resolved);
  const before =
    changeRequestDetailBinding.snapshotFor(inputs[0]).data ??
    changeRequestDetailBinding.snapshotFor(inputs[1]).data;
  const optimistic = inputs.flatMap((input) => {
    const previous = changeRequestDetailBinding.snapshotFor(input).data;
    if (previous === null) return [];
    const next = applyOptimisticChangeRequestUpdate(previous, action);
    if (next === previous) return [];
    changeRequestDetailBinding.updateData(input, () => next);
    return [{ input, previous, optimistic: next }];
  });

  try {
    const result = await sourceControlClient(resolved.environmentId).updateChangeRequest({
      cwd: resolved.cwd,
      reference: resolved.reference,
      action,
    });
    writeChangeRequestDetail(resolved, result.detail);
    refreshAfterChangeRequestMutation(resolved, {
      kind: "update",
      action,
      previous: before,
      next: result.detail,
    });
    return result;
  } catch (error) {
    for (const entry of optimistic) {
      changeRequestDetailBinding.updateData(entry.input, (current) =>
        current
          ? rollbackOptimisticChangeRequestUpdate(
              current,
              entry.previous,
              entry.optimistic,
              action.kind,
            )
          : current,
      );
    }
    throw error;
  }
}

/** Adds a conversation comment; writes the returned detail and refreshes the timeline. */
export async function addChangeRequestComment(
  target: ChangeRequestMutationTarget,
  payload: AddCommentPayload,
): Promise<SourceControlAddChangeRequestCommentResult> {
  const resolved = requireChangeRequestTarget(target, "Pull request comments are unavailable.");
  const result = await sourceControlClient(resolved.environmentId).addChangeRequestComment({
    cwd: resolved.cwd,
    reference: resolved.reference,
    body: payload.body,
    ...(payload.clientMutationId !== undefined
      ? { clientMutationId: payload.clientMutationId }
      : {}),
  });
  writeChangeRequestDetail(resolved, result.detail);
  refreshAfterChangeRequestMutation(resolved, { kind: "comment" });
  return result;
}

// ── Comment reactions ──────────────────────────────────────────────────

type CommentReactionDetail = SourceControlIssueDetail | SourceControlChangeRequestDetail;

function toggleReactionList(
  reactions: ReadonlyArray<SourceControlCommentReaction> | undefined,
  content: SourceControlCommentReactionContent,
): ReadonlyArray<SourceControlCommentReaction> | undefined {
  const existing = reactions?.find((reaction) => reaction.content === content);
  const others = reactions?.filter((reaction) => reaction.content !== content) ?? [];
  if (!existing) {
    return [...others, { content, count: 1, viewerHasReacted: true }];
  }
  const viewerHasReacted = existing.viewerHasReacted === true;
  const nextCount = viewerHasReacted ? Math.max(0, existing.count - 1) : existing.count + 1;
  if (nextCount <= 0) return others.length > 0 ? others : undefined;
  return [...others, { ...existing, count: nextCount, viewerHasReacted: !viewerHasReacted }];
}

/** The viewer's reaction toggled on one comment; the same object when the comment is absent. */
export function toggleCommentReactionInDetail<TDetail extends CommentReactionDetail>(
  detail: TDetail,
  input: CommentReactionPayload,
): TDetail {
  let changed = false;
  const comments = detail.comments.map((comment): SourceControlIssueComment => {
    if (comment.id !== input.commentId) return comment;
    changed = true;
    const reactions = toggleReactionList(comment.reactions, input.content);
    if (reactions) return { ...comment, reactions };
    const { reactions: _reactions, ...rest } = comment;
    return rest;
  });
  return changed ? ({ ...detail, comments } as TDetail) : detail;
}

/**
 * Toggles the viewer's reaction optimistically in every cached variant, then
 * writes the host's detail. On failure a variant is restored only while it
 * still shows the optimistic toggle, so a newer write is never clobbered.
 */
async function toggleCommentReaction<
  TInput,
  TDetail extends CommentReactionDetail,
  TResult,
>(options: {
  readonly binding: QueryBinding<TInput, TDetail>;
  readonly inputs: ReadonlyArray<TInput>;
  readonly payload: CommentReactionPayload;
  readonly send: () => Promise<TResult>;
}): Promise<TResult> {
  const optimistic = options.inputs.flatMap((input) => {
    const previous = options.binding.snapshotFor(input).data;
    if (previous === null) return [];
    const next = toggleCommentReactionInDetail(previous, options.payload);
    if (next === previous) return [];
    options.binding.updateData(input, () => next);
    return [{ input, previous, next }];
  });
  try {
    return await options.send();
  } catch (error) {
    for (const entry of optimistic) {
      options.binding.updateData(entry.input, (current) =>
        current === entry.next ? entry.previous : current,
      );
    }
    throw error;
  }
}

/** Toggles a reaction on a change-request comment; refreshes only the timeline. */
export async function toggleChangeRequestCommentReaction(
  target: ChangeRequestMutationTarget,
  payload: CommentReactionPayload,
): Promise<SourceControlAddChangeRequestCommentReactionResult> {
  const resolved = requireChangeRequestTarget(target, "Comment reactions are unavailable.");
  const result = await toggleCommentReaction({
    binding: changeRequestDetailBinding,
    inputs: changeRequestDetailInputs(resolved),
    payload,
    send: () =>
      sourceControlClient(resolved.environmentId).addChangeRequestCommentReaction({
        cwd: resolved.cwd,
        reference: resolved.reference,
        commentId: payload.commentId,
        content: payload.content,
      }),
  });
  writeChangeRequestDetail(resolved, result.detail);
  refreshAfterChangeRequestMutation(resolved, { kind: "reaction" });
  return result;
}

export async function createChangeRequest(
  environmentId: EnvironmentId | null,
  input: ChangeRequestCreateInput,
): Promise<ChangeRequest> {
  if (!environmentId) throw new Error("Creating pull requests is unavailable.");
  const result = await sourceControlClient(environmentId).createChangeRequest(input);
  // A new request only joins the lists; no existing read can have changed.
  invalidateFamilies({ environmentId, cwd: input.cwd }, [
    CHANGE_REQUEST_LIST_FAMILY,
    CHANGE_REQUEST_SEARCH_FAMILY,
  ]);
  return result;
}

// ---------------------------------------------------------------------------
// Issue comment mutations
// ---------------------------------------------------------------------------

function issueDetailInputs(
  target: ResolvedChangeRequestTarget,
): readonly [SourceControlIssueDetailInput, SourceControlIssueDetailInput] {
  return [
    { ...target, fullContent: true },
    { ...target, fullContent: false },
  ];
}

/** Writes the host's (uncapped) issue detail into the full variant, and the capped one when held. */
function writeIssueDetail(
  target: ResolvedChangeRequestTarget,
  detail: SourceControlIssueDetail,
): void {
  const [fullInput, summaryInput] = issueDetailInputs(target);
  issueDetailBinding.updateData(fullInput, () => detail);
  if (issueDetailBinding.snapshotFor(summaryInput).data !== null) {
    issueDetailBinding.updateData(summaryInput, () => detail);
  }
  dropImperativeDetail("issueDetail", target);
}

/** Adds an issue comment; writes the returned detail and refreshes the comment counts in lists. */
export async function addIssueComment(
  target: ChangeRequestMutationTarget,
  payload: AddCommentPayload,
): Promise<SourceControlAddIssueCommentResult> {
  const resolved = requireChangeRequestTarget(target, "Issue comments are unavailable.");
  const result = await sourceControlClient(resolved.environmentId).addIssueComment({
    cwd: resolved.cwd,
    reference: resolved.reference,
    body: payload.body,
    ...(payload.clientMutationId !== undefined
      ? { clientMutationId: payload.clientMutationId }
      : {}),
  });
  writeIssueDetail(resolved, result.detail);
  invalidateSourceControlIssueLists(resolved);
  return result;
}

/** Toggles a reaction on an issue comment; the returned detail is all that changed. */
export async function toggleIssueCommentReaction(
  target: ChangeRequestMutationTarget,
  payload: CommentReactionPayload,
): Promise<SourceControlAddIssueCommentReactionResult> {
  const resolved = requireChangeRequestTarget(target, "Comment reactions are unavailable.");
  const result = await toggleCommentReaction({
    binding: issueDetailBinding,
    inputs: issueDetailInputs(resolved),
    payload,
    send: () =>
      sourceControlClient(resolved.environmentId).addIssueCommentReaction({
        cwd: resolved.cwd,
        reference: resolved.reference,
        commentId: payload.commentId,
        content: payload.content,
      }),
  });
  writeIssueDetail(resolved, result.detail);
  return result;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function resetSourceControlAtomsForTests(): void {
  sourceControlRegistry.resetForTests();
  detailCache.reset();
  fileContentsCache.reset();
  pendingThreadResolutions.clear();
  sharedChangeRequestDetails.clear();
}
