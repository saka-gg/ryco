// Project explorer reads for the phone: a project's issues, workflow runs and
// Jira work items, through the same RPCs the web's project explorer reads,
// cached per environment in one bounded mobile query cache. Requests resolve
// the live RPC client inside `run` (never at module load); the typed
// environment facade leaves these methods out.
//
// Environment teardown imports this module, so it stays light on the launch
// graph: no explorer rules here (the screens' models own those).
//
// Reads only: the changes a reader makes (comments, new issues, re-runs,
// transitions) are sent by the screens and read these again afterwards
// (`refreshProjectExplorerReads`). Node-owned content lives in the atom state —
// never logged — and is dropped when the environment is torn down or the
// retained-key budget is exceeded. The lists (issues, runs, work items) are
// also kept on the device (the saved query cache, `persist`) and show at once
// on the next open while they are read again; details and logs are not.
import type {
  AtlassianProjectLink,
  EnvironmentId,
  ProjectId,
  SourceControlAssigneeCandidate,
  SourceControlIssueDetail,
  SourceControlIssueSummary,
  SourceControlLabel,
  SourceControlWorkflowJobLogResult,
  SourceControlWorkflowRunJobsResult,
  SourceControlWorkflowRunListResult,
  WorkItemDetail,
  WorkItemStateFilter,
  WorkItemSummary,
} from "@ryco/contracts";
import { KEY_SEP, type KeyedQueryEnabledInput } from "@ryco/client-runtime/rpc";
import {
  SourceControlIssueSummary as IssueSummarySchema,
  SourceControlWorkflowRunListResult as WorkflowRunListSchema,
} from "@ryco/contracts/source-control";
import { WorkItemSummary as WorkItemSummarySchema } from "@ryco/contracts/work-items";
import * as Schema from "effect/Schema";

import { readRpcClient } from "../connection/environmentApi";
import { cachedPayloadBytes } from "../persistence/cacheSize";
import { createMobileQueryCache, runWithRetry } from "./mobileQueryCache";
import { PullRequestNodeOfflineError } from "./pullRequestAtoms";
import { schemaSavedQueryCodec } from "./savedQueryCodec";

// A list reopened within this window answers from cache; pull to refresh and a
// reconnect always read again. Runs move fastest, so they go stale soonest.
const LIST_STALE_TIME_MS = 30_000;
const DETAIL_STALE_TIME_MS = 15_000;
const RUNS_STALE_TIME_MS = 10_000;
const LOG_STALE_TIME_MS = 60_000;
const META_STALE_TIME_MS = 5 * 60_000;

// Boundedness: rows and one item's detail are small, a job log is up to the
// host's 200 KB cap. Once a key has no observers it becomes evictable; each
// family keeps only its most recently released keys.
const LIST_RETAINED_KEY_LIMIT = 6;
const DETAIL_RETAINED_KEY_LIMIT = 8;
const LOG_RETAINED_KEY_LIMIT = 2;
const META_RETAINED_KEY_LIMIT = 2;

const explorerCache = createMobileQueryCache("project-explorer", { storage: "own" });

function client(environmentId: EnvironmentId) {
  const live = readRpcClient(environmentId);
  if (live === null) throw new PullRequestNodeOfflineError();
  return live;
}

function key(...parts: ReadonlyArray<string | number | null | undefined>): string {
  return parts.map((part) => String(part ?? "")).join(KEY_SEP);
}

interface CheckoutInput {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly enabled?: boolean;
}

function checkoutEnabled<T extends CheckoutInput>(
  input: T,
): input is KeyedQueryEnabledInput<T, "environmentId" | "cwd"> {
  return (input.enabled ?? true) && input.environmentId !== null && input.cwd !== null;
}

const resolveEnvironmentId = (input: { readonly environmentId: EnvironmentId }) =>
  input.environmentId;

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export interface IssueListInput extends CheckoutInput {
  readonly state: "open" | "closed" | "all";
  readonly limit: number;
}

type EnabledIssueListInput = KeyedQueryEnabledInput<IssueListInput, "environmentId" | "cwd">;

export const issueListQuery = explorerCache.defineQuery<
  IssueListInput,
  ReadonlyArray<SourceControlIssueSummary>,
  EnabledIssueListInput
>({
  label: "issues",
  staleTime: LIST_STALE_TIME_MS,
  persist: schemaSavedQueryCodec(Schema.Array(IssueSummarySchema), 1),
  retainedKeyLimit: LIST_RETAINED_KEY_LIMIT,
  isEnabled: checkoutEnabled,
  buildKey: (input) => key(input.environmentId, input.cwd, input.state, input.limit),
  resolveEnvironmentId,
  run: (input) =>
    runWithRetry(() =>
      client(input.environmentId).sourceControl.listIssues({
        cwd: input.cwd,
        state: input.state,
        limit: input.limit,
      }),
    ),
});

export interface IssueSearchInput extends CheckoutInput {
  readonly query: string;
  readonly limit: number;
}

type EnabledIssueSearchInput = KeyedQueryEnabledInput<IssueSearchInput, "environmentId" | "cwd">;

export const issueSearchQuery = explorerCache.defineQuery<
  IssueSearchInput,
  ReadonlyArray<SourceControlIssueSummary>,
  EnabledIssueSearchInput
>({
  label: "issue-search",
  staleTime: LIST_STALE_TIME_MS,
  retainedKeyLimit: LIST_RETAINED_KEY_LIMIT,
  isEnabled: (input): input is EnabledIssueSearchInput =>
    checkoutEnabled(input) && input.query.trim().length > 0,
  buildKey: (input) => key(input.environmentId, input.cwd, input.query.trim(), input.limit),
  resolveEnvironmentId,
  run: (input) =>
    client(input.environmentId).sourceControl.searchIssues({
      cwd: input.cwd,
      query: input.query.trim(),
      limit: input.limit,
    }),
});

export interface IssueInput extends CheckoutInput {
  readonly number: number | null;
}

type EnabledIssueInput = KeyedQueryEnabledInput<IssueInput, "environmentId" | "cwd" | "number">;

export const issueDetailQuery = explorerCache.defineQuery<
  IssueInput,
  SourceControlIssueDetail,
  EnabledIssueInput
>({
  label: "issue",
  staleTime: DETAIL_STALE_TIME_MS,
  retainedKeyLimit: DETAIL_RETAINED_KEY_LIMIT,
  isEnabled: (input): input is EnabledIssueInput => checkoutEnabled(input) && input.number !== null,
  buildKey: (input) => key(input.environmentId, input.cwd, input.number),
  resolveEnvironmentId,
  run: (input) =>
    runWithRetry(() =>
      client(input.environmentId).sourceControl.getIssue({
        cwd: input.cwd,
        reference: String(input.number),
        fullContent: true,
      }),
    ),
});

type EnabledCheckoutInput = KeyedQueryEnabledInput<CheckoutInput, "environmentId" | "cwd">;

export const issueLabelsQuery = explorerCache.defineQuery<
  CheckoutInput,
  ReadonlyArray<SourceControlLabel>,
  EnabledCheckoutInput
>({
  label: "issue-labels",
  staleTime: META_STALE_TIME_MS,
  retainedKeyLimit: META_RETAINED_KEY_LIMIT,
  isEnabled: checkoutEnabled,
  buildKey: (input) => key(input.environmentId, input.cwd),
  resolveEnvironmentId,
  run: (input) =>
    client(input.environmentId).sourceControl.listIssueLabels({
      cwd: input.cwd,
    }),
});

export const issueAssigneesQuery = explorerCache.defineQuery<
  CheckoutInput,
  ReadonlyArray<SourceControlAssigneeCandidate>,
  EnabledCheckoutInput
>({
  label: "issue-assignees",
  staleTime: META_STALE_TIME_MS,
  retainedKeyLimit: META_RETAINED_KEY_LIMIT,
  isEnabled: checkoutEnabled,
  buildKey: (input) => key(input.environmentId, input.cwd),
  resolveEnvironmentId,
  run: (input) =>
    client(input.environmentId).sourceControl.listIssueAssignees({
      cwd: input.cwd,
    }),
});

// ---------------------------------------------------------------------------
// Workflow runs
// ---------------------------------------------------------------------------

export interface WorkflowRunsInput extends CheckoutInput {
  readonly limit: number;
}

type EnabledWorkflowRunsInput = KeyedQueryEnabledInput<WorkflowRunsInput, "environmentId" | "cwd">;

export const workflowRunsQuery = explorerCache.defineQuery<
  WorkflowRunsInput,
  SourceControlWorkflowRunListResult,
  EnabledWorkflowRunsInput
>({
  label: "runs",
  persist: schemaSavedQueryCodec(WorkflowRunListSchema, 1),
  staleTime: RUNS_STALE_TIME_MS,
  retainedKeyLimit: LIST_RETAINED_KEY_LIMIT,
  isEnabled: checkoutEnabled,
  buildKey: (input) => key(input.environmentId, input.cwd, input.limit),
  resolveEnvironmentId,
  run: (input) =>
    runWithRetry(() =>
      client(input.environmentId).sourceControl.listWorkflowRuns({
        cwd: input.cwd,
        limit: input.limit,
      }),
    ),
});

export interface WorkflowRunInput extends CheckoutInput {
  readonly runId: string | null;
}

type EnabledWorkflowRunInput = KeyedQueryEnabledInput<
  WorkflowRunInput,
  "environmentId" | "cwd" | "runId"
>;

export const workflowRunJobsQuery = explorerCache.defineQuery<
  WorkflowRunInput,
  SourceControlWorkflowRunJobsResult,
  EnabledWorkflowRunInput
>({
  label: "run-jobs",
  staleTime: RUNS_STALE_TIME_MS,
  retainedKeyLimit: DETAIL_RETAINED_KEY_LIMIT,
  isEnabled: (input): input is EnabledWorkflowRunInput =>
    checkoutEnabled(input) && input.runId !== null,
  buildKey: (input) => key(input.environmentId, input.cwd, input.runId),
  resolveEnvironmentId,
  run: (input) =>
    runWithRetry(() =>
      client(input.environmentId).sourceControl.getWorkflowRunJobs({
        cwd: input.cwd,
        runId: input.runId,
      }),
    ),
});

export interface WorkflowJobLogInput extends WorkflowRunInput {
  readonly jobId: string | null;
}

type EnabledWorkflowJobLogInput = KeyedQueryEnabledInput<
  WorkflowJobLogInput,
  "environmentId" | "cwd" | "runId" | "jobId"
>;

export const workflowJobLogQuery = explorerCache.defineQuery<
  WorkflowJobLogInput,
  SourceControlWorkflowJobLogResult,
  EnabledWorkflowJobLogInput
>({
  label: "job-log",
  staleTime: LOG_STALE_TIME_MS,
  retainedKeyLimit: LOG_RETAINED_KEY_LIMIT,
  isEnabled: (input): input is EnabledWorkflowJobLogInput =>
    checkoutEnabled(input) && input.runId !== null && input.jobId !== null,
  buildKey: (input) => key(input.environmentId, input.cwd, input.runId, input.jobId),
  resolveEnvironmentId,
  run: (input) =>
    client(input.environmentId).sourceControl.getWorkflowJobLog({
      cwd: input.cwd,
      runId: input.runId,
      jobId: input.jobId,
    }),
});

// ---------------------------------------------------------------------------
// Jira work items (keyed by project: the node resolves the project's Jira link)
// ---------------------------------------------------------------------------

export interface ProjectInput {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly enabled?: boolean;
}

function projectEnabled<T extends ProjectInput>(
  input: T,
): input is KeyedQueryEnabledInput<T, "environmentId" | "projectId"> {
  return (input.enabled ?? true) && input.environmentId !== null && input.projectId !== null;
}

/** Wrapped, so "read: not linked" (`link: null`) differs from "not read yet" (`data: null`). */
export interface JiraProjectLinkRead {
  readonly link: AtlassianProjectLink | null;
}

type EnabledProjectInput = KeyedQueryEnabledInput<ProjectInput, "environmentId" | "projectId">;

export const jiraProjectLinkQuery = explorerCache.defineQuery<
  ProjectInput,
  JiraProjectLinkRead,
  EnabledProjectInput
>({
  label: "jira-link",
  staleTime: META_STALE_TIME_MS,
  retainedKeyLimit: META_RETAINED_KEY_LIMIT,
  isEnabled: projectEnabled,
  buildKey: (input) => key(input.environmentId, input.projectId),
  resolveEnvironmentId,
  run: (input) =>
    runWithRetry(() =>
      client(input.environmentId)
        .atlassian.getProjectLink({ projectId: input.projectId })
        .then((link) => ({ link })),
    ),
});

export interface WorkItemListInput extends ProjectInput {
  readonly state: WorkItemStateFilter;
  readonly limit: number;
}

type EnabledWorkItemListInput = KeyedQueryEnabledInput<
  WorkItemListInput,
  "environmentId" | "projectId"
>;

export const workItemListQuery = explorerCache.defineQuery<
  WorkItemListInput,
  ReadonlyArray<WorkItemSummary>,
  EnabledWorkItemListInput
>({
  label: "work-items",
  staleTime: LIST_STALE_TIME_MS,
  persist: schemaSavedQueryCodec(Schema.Array(WorkItemSummarySchema), 1),
  retainedKeyLimit: LIST_RETAINED_KEY_LIMIT,
  isEnabled: projectEnabled,
  buildKey: (input) => key(input.environmentId, input.projectId, input.state, input.limit),
  resolveEnvironmentId,
  run: (input) =>
    runWithRetry(() =>
      client(input.environmentId).workItems.list({
        projectId: input.projectId,
        state: input.state,
        limit: input.limit,
      }),
    ),
});

export interface WorkItemSearchInput extends ProjectInput {
  readonly query: string;
  readonly limit: number;
}

type EnabledWorkItemSearchInput = KeyedQueryEnabledInput<
  WorkItemSearchInput,
  "environmentId" | "projectId"
>;

export const workItemSearchQuery = explorerCache.defineQuery<
  WorkItemSearchInput,
  ReadonlyArray<WorkItemSummary>,
  EnabledWorkItemSearchInput
>({
  label: "work-item-search",
  staleTime: LIST_STALE_TIME_MS,
  retainedKeyLimit: LIST_RETAINED_KEY_LIMIT,
  isEnabled: (input): input is EnabledWorkItemSearchInput =>
    projectEnabled(input) && input.query.trim().length > 0,
  buildKey: (input) => key(input.environmentId, input.projectId, input.query.trim(), input.limit),
  resolveEnvironmentId,
  run: (input) =>
    client(input.environmentId).workItems.search({
      projectId: input.projectId,
      query: input.query.trim(),
      limit: input.limit,
    }),
});

export interface WorkItemInput extends ProjectInput {
  readonly key: string | null;
}

type EnabledWorkItemInput = KeyedQueryEnabledInput<
  WorkItemInput,
  "environmentId" | "projectId" | "key"
>;

export const workItemDetailQuery = explorerCache.defineQuery<
  WorkItemInput,
  WorkItemDetail,
  EnabledWorkItemInput
>({
  label: "work-item",
  staleTime: DETAIL_STALE_TIME_MS,
  retainedKeyLimit: DETAIL_RETAINED_KEY_LIMIT,
  isEnabled: (input): input is EnabledWorkItemInput => projectEnabled(input) && input.key !== null,
  buildKey: (input) => key(input.environmentId, input.projectId, input.key),
  resolveEnvironmentId,
  run: (input) =>
    runWithRetry(() =>
      client(input.environmentId).workItems.get({
        projectId: input.projectId,
        key: input.key,
        fullContent: true,
      }),
    ),
});

// ---------------------------------------------------------------------------
// Refresh after a change
// ---------------------------------------------------------------------------

/** The reads a change made stale, by family: every family named is read again for this scope. */
export type ProjectExplorerReadFamily = "issues" | "runs" | "work-items";

const FAMILY_LABELS: Readonly<Record<ProjectExplorerReadFamily, ReadonlySet<string>>> = {
  issues: new Set(["issues", "issue-search", "issue"]),
  runs: new Set(["runs", "run-jobs"]),
  "work-items": new Set(["work-items", "work-item-search", "work-item"]),
};

/**
 * Reads again one family of explorer reads for a checkout (issues, runs) or a
 * project (work items): lists and details alike, since a comment changes a
 * list row's count and a re-run changes its run's row.
 */
export function refreshProjectExplorerReads(input: {
  readonly environmentId: EnvironmentId;
  /** The checkout (issues, runs) or the project id (work items) the reads are keyed on. */
  readonly scope: string;
  readonly family: ProjectExplorerReadFamily;
}): void {
  const labels = FAMILY_LABELS[input.family];
  explorerCache.refreshMatching(
    ([label, environment, scope]) =>
      labels.has(label ?? "") && environment === input.environmentId && scope === input.scope,
  );
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

/** Environment teardown: forget every explorer read this cache holds for one node. */
export function clearProjectExplorerStateForEnvironment(environmentId: EnvironmentId): void {
  explorerCache.clearEnvironment(environmentId);
}

/** Estimated bytes of one node's cached explorer reads that are not on screen (Storage settings). */
export function projectExplorerCacheBytes(environmentId: EnvironmentId): number {
  let bytes = 0;
  for (const [, data] of explorerCache.unobservedEntries(environmentId)) {
    bytes += cachedPayloadBytes(data);
  }
  return bytes;
}

/** Cache-only eviction of one node's explorer reads that are not on screen. */
export function clearProjectExplorerCache(environmentId: EnvironmentId): void {
  explorerCache.clearUnobserved(environmentId);
}

export function resetProjectExplorerAtomsForTests(): void {
  explorerCache.resetForTests();
}
