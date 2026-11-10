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
// (`refreshProjectExplorerReads`). Node-owned content lives only in the atom
// state — never persisted, never logged — and is dropped when the environment
// is torn down or the retained-key budget is exceeded.
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
import { KEY_SEP } from "@ryco/client-runtime/rpc";

import { readRpcClient } from "../connection/environmentApi";
import { cachedPayloadBytes } from "../persistence/cacheSize";
import { createMobileQueryCache, runWithRetry } from "./mobileQueryCache";
import { PullRequestNodeOfflineError } from "./pullRequestAtoms";

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

function checkoutEnabled(input: CheckoutInput): boolean {
  return (input.enabled ?? true) && input.environmentId !== null && input.cwd !== null;
}

const resolveEnvironmentId = (input: { readonly environmentId: EnvironmentId | null }) =>
  input.environmentId as EnvironmentId;

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export interface IssueListInput extends CheckoutInput {
  readonly state: "open" | "closed" | "all";
  readonly limit: number;
}

export const issueListQuery = explorerCache.defineQuery<
  IssueListInput,
  ReadonlyArray<SourceControlIssueSummary>
>({
  label: "issues",
  staleTime: LIST_STALE_TIME_MS,
  retainedKeyLimit: LIST_RETAINED_KEY_LIMIT,
  isEnabled: checkoutEnabled,
  buildKey: (input) => key(input.environmentId, input.cwd, input.state, input.limit),
  resolveEnvironmentId,
  run: (input) =>
    runWithRetry(() =>
      client(input.environmentId as EnvironmentId).sourceControl.listIssues({
        cwd: input.cwd as string,
        state: input.state,
        limit: input.limit,
      }),
    ),
});

export interface IssueSearchInput extends CheckoutInput {
  readonly query: string;
  readonly limit: number;
}

export const issueSearchQuery = explorerCache.defineQuery<
  IssueSearchInput,
  ReadonlyArray<SourceControlIssueSummary>
>({
  label: "issue-search",
  staleTime: LIST_STALE_TIME_MS,
  retainedKeyLimit: LIST_RETAINED_KEY_LIMIT,
  isEnabled: (input) => checkoutEnabled(input) && input.query.trim().length > 0,
  buildKey: (input) => key(input.environmentId, input.cwd, input.query.trim(), input.limit),
  resolveEnvironmentId,
  run: (input) =>
    client(input.environmentId as EnvironmentId).sourceControl.searchIssues({
      cwd: input.cwd as string,
      query: input.query.trim(),
      limit: input.limit,
    }),
});

export interface IssueInput extends CheckoutInput {
  readonly number: number | null;
}

export const issueDetailQuery = explorerCache.defineQuery<IssueInput, SourceControlIssueDetail>({
  label: "issue",
  staleTime: DETAIL_STALE_TIME_MS,
  retainedKeyLimit: DETAIL_RETAINED_KEY_LIMIT,
  isEnabled: (input) => checkoutEnabled(input) && input.number !== null,
  buildKey: (input) => key(input.environmentId, input.cwd, input.number),
  resolveEnvironmentId,
  run: (input) =>
    runWithRetry(() =>
      client(input.environmentId as EnvironmentId).sourceControl.getIssue({
        cwd: input.cwd as string,
        reference: String(input.number),
        fullContent: true,
      }),
    ),
});

export const issueLabelsQuery = explorerCache.defineQuery<
  CheckoutInput,
  ReadonlyArray<SourceControlLabel>
>({
  label: "issue-labels",
  staleTime: META_STALE_TIME_MS,
  retainedKeyLimit: META_RETAINED_KEY_LIMIT,
  isEnabled: checkoutEnabled,
  buildKey: (input) => key(input.environmentId, input.cwd),
  resolveEnvironmentId,
  run: (input) =>
    client(input.environmentId as EnvironmentId).sourceControl.listIssueLabels({
      cwd: input.cwd as string,
    }),
});

export const issueAssigneesQuery = explorerCache.defineQuery<
  CheckoutInput,
  ReadonlyArray<SourceControlAssigneeCandidate>
>({
  label: "issue-assignees",
  staleTime: META_STALE_TIME_MS,
  retainedKeyLimit: META_RETAINED_KEY_LIMIT,
  isEnabled: checkoutEnabled,
  buildKey: (input) => key(input.environmentId, input.cwd),
  resolveEnvironmentId,
  run: (input) =>
    client(input.environmentId as EnvironmentId).sourceControl.listIssueAssignees({
      cwd: input.cwd as string,
    }),
});

// ---------------------------------------------------------------------------
// Workflow runs
// ---------------------------------------------------------------------------

export interface WorkflowRunsInput extends CheckoutInput {
  readonly limit: number;
}

export const workflowRunsQuery = explorerCache.defineQuery<
  WorkflowRunsInput,
  SourceControlWorkflowRunListResult
>({
  label: "runs",
  staleTime: RUNS_STALE_TIME_MS,
  retainedKeyLimit: LIST_RETAINED_KEY_LIMIT,
  isEnabled: checkoutEnabled,
  buildKey: (input) => key(input.environmentId, input.cwd, input.limit),
  resolveEnvironmentId,
  run: (input) =>
    runWithRetry(() =>
      client(input.environmentId as EnvironmentId).sourceControl.listWorkflowRuns({
        cwd: input.cwd as string,
        limit: input.limit,
      }),
    ),
});

export interface WorkflowRunInput extends CheckoutInput {
  readonly runId: string | null;
}

export const workflowRunJobsQuery = explorerCache.defineQuery<
  WorkflowRunInput,
  SourceControlWorkflowRunJobsResult
>({
  label: "run-jobs",
  staleTime: RUNS_STALE_TIME_MS,
  retainedKeyLimit: DETAIL_RETAINED_KEY_LIMIT,
  isEnabled: (input) => checkoutEnabled(input) && input.runId !== null,
  buildKey: (input) => key(input.environmentId, input.cwd, input.runId),
  resolveEnvironmentId,
  run: (input) =>
    runWithRetry(() =>
      client(input.environmentId as EnvironmentId).sourceControl.getWorkflowRunJobs({
        cwd: input.cwd as string,
        runId: input.runId as string,
      }),
    ),
});

export interface WorkflowJobLogInput extends WorkflowRunInput {
  readonly jobId: string | null;
}

export const workflowJobLogQuery = explorerCache.defineQuery<
  WorkflowJobLogInput,
  SourceControlWorkflowJobLogResult
>({
  label: "job-log",
  staleTime: LOG_STALE_TIME_MS,
  retainedKeyLimit: LOG_RETAINED_KEY_LIMIT,
  isEnabled: (input) => checkoutEnabled(input) && input.runId !== null && input.jobId !== null,
  buildKey: (input) => key(input.environmentId, input.cwd, input.runId, input.jobId),
  resolveEnvironmentId,
  run: (input) =>
    client(input.environmentId as EnvironmentId).sourceControl.getWorkflowJobLog({
      cwd: input.cwd as string,
      runId: input.runId as string,
      jobId: input.jobId as string,
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

function projectEnabled(input: ProjectInput): boolean {
  return (input.enabled ?? true) && input.environmentId !== null && input.projectId !== null;
}

/** Wrapped, so "read: not linked" (`link: null`) differs from "not read yet" (`data: null`). */
export interface JiraProjectLinkRead {
  readonly link: AtlassianProjectLink | null;
}

export const jiraProjectLinkQuery = explorerCache.defineQuery<ProjectInput, JiraProjectLinkRead>({
  label: "jira-link",
  staleTime: META_STALE_TIME_MS,
  retainedKeyLimit: META_RETAINED_KEY_LIMIT,
  isEnabled: projectEnabled,
  buildKey: (input) => key(input.environmentId, input.projectId),
  resolveEnvironmentId,
  run: (input) =>
    runWithRetry(() =>
      client(input.environmentId as EnvironmentId)
        .atlassian.getProjectLink({ projectId: input.projectId as ProjectId })
        .then((link) => ({ link })),
    ),
});

export interface WorkItemListInput extends ProjectInput {
  readonly state: WorkItemStateFilter;
  readonly limit: number;
}

export const workItemListQuery = explorerCache.defineQuery<
  WorkItemListInput,
  ReadonlyArray<WorkItemSummary>
>({
  label: "work-items",
  staleTime: LIST_STALE_TIME_MS,
  retainedKeyLimit: LIST_RETAINED_KEY_LIMIT,
  isEnabled: projectEnabled,
  buildKey: (input) => key(input.environmentId, input.projectId, input.state, input.limit),
  resolveEnvironmentId,
  run: (input) =>
    runWithRetry(() =>
      client(input.environmentId as EnvironmentId).workItems.list({
        projectId: input.projectId as ProjectId,
        state: input.state,
        limit: input.limit,
      }),
    ),
});

export interface WorkItemSearchInput extends ProjectInput {
  readonly query: string;
  readonly limit: number;
}

export const workItemSearchQuery = explorerCache.defineQuery<
  WorkItemSearchInput,
  ReadonlyArray<WorkItemSummary>
>({
  label: "work-item-search",
  staleTime: LIST_STALE_TIME_MS,
  retainedKeyLimit: LIST_RETAINED_KEY_LIMIT,
  isEnabled: (input) => projectEnabled(input) && input.query.trim().length > 0,
  buildKey: (input) => key(input.environmentId, input.projectId, input.query.trim(), input.limit),
  resolveEnvironmentId,
  run: (input) =>
    client(input.environmentId as EnvironmentId).workItems.search({
      projectId: input.projectId as ProjectId,
      query: input.query.trim(),
      limit: input.limit,
    }),
});

export interface WorkItemInput extends ProjectInput {
  readonly key: string | null;
}

export const workItemDetailQuery = explorerCache.defineQuery<WorkItemInput, WorkItemDetail>({
  label: "work-item",
  staleTime: DETAIL_STALE_TIME_MS,
  retainedKeyLimit: DETAIL_RETAINED_KEY_LIMIT,
  isEnabled: (input) => projectEnabled(input) && input.key !== null,
  buildKey: (input) => key(input.environmentId, input.projectId, input.key),
  resolveEnvironmentId,
  run: (input) =>
    runWithRetry(() =>
      client(input.environmentId as EnvironmentId).workItems.get({
        projectId: input.projectId as ProjectId,
        key: input.key as string,
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
