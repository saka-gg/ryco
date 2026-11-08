import type {
  EnvironmentId,
  ProjectId,
  SourceControlIssueDetail,
  SourceControlWorkflowJobLogResult,
  SourceControlWorkflowRun,
  SourceControlWorkflowRunJobsResult,
  WorkItemDetail,
  WorkItemStateFilter,
} from "@ryco/contracts";
import { useEffect, useMemo, useState } from "react";

import {
  issueAssigneesQuery,
  issueDetailQuery,
  issueLabelsQuery,
  issueListQuery,
  issueSearchQuery,
  jiraProjectLinkQuery,
  workflowJobLogQuery,
  workflowRunJobsQuery,
  workflowRunsQuery,
  workItemDetailQuery,
  workItemListQuery,
  workItemSearchQuery,
} from "../../rpc/projectExplorerAtoms";
import { useMobileQuery, type MobileQueryResult } from "../../rpc/useMobileQuery";
import {
  deriveIssueListScreen,
  ISSUE_LIST_LIMIT,
  ISSUE_SEARCH_LIMIT,
  planIssueSearch,
  type IssueListScreen,
  type IssueStateFilter,
} from "./issuesModel";
import { describeExplorerProblem, type ExplorerProblem } from "./projectExplorerModel";
import {
  findWorkflowRun,
  isWorkflowRunActive,
  WORKFLOW_RUN_LIST_LIMIT,
  WORKFLOW_RUN_POLL_MS,
  workflowRunRows,
  type WorkflowRunRow,
} from "./workflowRunsModel";
import {
  isJiraConfigured,
  planWorkItemSearch,
  WORK_ITEM_LIST_LIMIT,
  WORK_ITEM_SEARCH_LIMIT,
  workItemRow,
  type WorkItemRow,
} from "./workItemsModel";

/**
 * The project explorer's reads, as hooks over the bounded explorer cache
 * (`rpc/projectExplorerAtoms`). The rules live in the React-free models beside
 * this file; these only wire reads to them.
 */

const SEARCH_SETTLE_MS = 250;

/** The value once it has stopped changing for `delayMs`. */
export function useSettledValue<T>(value: T, delayMs: number = SEARCH_SETTLE_MS): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs, value]);
  return settled;
}

function problemOf(error: Error | null, what: string): ExplorerProblem | null {
  return error === null ? null : describeExplorerProblem(error, what);
}

// ── Issues ───────────────────────────────────────────────────────────

export interface IssueListData {
  readonly screen: IssueListScreen;
  readonly refreshing: boolean;
  readonly refresh: () => void;
}

export function useIssueList(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly state: IssueStateFilter;
  readonly query: string;
}): IssueListData {
  const { environmentId, cwd, state, query } = input;
  const settledQuery = useSettledValue(query);
  const list = useMobileQuery(
    issueListQuery,
    { environmentId, cwd, state, limit: ISSUE_LIST_LIMIT },
    environmentId,
  );
  const plan = useMemo(
    () => planIssueSearch({ items: list.data ?? [], query, settledQuery }),
    [list.data, query, settledQuery],
  );
  const search = useMobileQuery(
    issueSearchQuery,
    {
      environmentId,
      cwd,
      query: settledQuery,
      limit: ISSUE_SEARCH_LIMIT,
      enabled: plan.searchHost,
    },
    environmentId,
  );
  const screen = useMemo(
    () => deriveIssueListScreen({ list, search, plan, query, state }),
    [list, plan, query, search, state],
  );
  return {
    screen,
    refreshing: list.isFetching && list.data !== null,
    refresh: () => {
      void list.refetch();
      if (plan.searchHost) void search.refetch();
    },
  };
}

export interface IssueData {
  readonly detail: MobileQueryResult<SourceControlIssueDetail>;
  readonly problem: ExplorerProblem | null;
}

export function useIssue(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly number: number | null;
}): IssueData {
  const detail = useMobileQuery(issueDetailQuery, input, input.environmentId);
  return { detail, problem: problemOf(detail.error, "issue") };
}

/** Labels and assignees the new-issue form offers; empty until read (or where the host has none). */
export function useIssueMeta(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
}) {
  const labels = useMobileQuery(issueLabelsQuery, input, input.environmentId);
  const assignees = useMobileQuery(issueAssigneesQuery, input, input.environmentId);
  return { labels: labels.data, assignees: assignees.data };
}

// ── Workflow runs ────────────────────────────────────────────────────

export interface WorkflowRunsData {
  readonly rows: ReadonlyArray<WorkflowRunRow>;
  readonly loading: boolean;
  readonly problem: ExplorerProblem | null;
  readonly refreshing: boolean;
  readonly refresh: () => void;
}

/** The checkout's latest runs: the list and each run screen read the same entry. */
function useWorkflowRunList(environmentId: EnvironmentId | null, cwd: string | null) {
  return useMobileQuery(
    workflowRunsQuery,
    { environmentId, cwd, limit: WORKFLOW_RUN_LIST_LIMIT },
    environmentId,
  );
}

/** Re-reads while `active`, so a running run's status moves on screen. */
function usePollWhile(active: boolean, refresh: () => void): void {
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(refresh, WORKFLOW_RUN_POLL_MS);
    return () => clearInterval(timer);
  }, [active, refresh]);
}

export function useWorkflowRuns(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
}): WorkflowRunsData {
  const runs = useWorkflowRunList(input.environmentId, input.cwd);
  const data = runs.data;
  const rows = useMemo(() => (data === null ? [] : workflowRunRows(data.runs)), [data]);
  const active = useMemo(
    () => (data === null ? false : data.runs.some((run) => isWorkflowRunActive(run, null))),
    [data],
  );
  const { refetch } = runs;
  usePollWhile(active, () => void refetch());
  return {
    rows,
    loading: runs.isLoading || (data === null && runs.error === null),
    problem: problemOf(runs.error, "workflow runs"),
    refreshing: runs.isFetching && data !== null,
    refresh: () => void refetch(),
  };
}

export interface WorkflowRunData {
  /** Null when the run is not among the latest runs read (an older run's link). */
  readonly run: SourceControlWorkflowRun | null;
  readonly jobs: MobileQueryResult<SourceControlWorkflowRunJobsResult>;
  readonly problem: ExplorerProblem | null;
  readonly refreshing: boolean;
  readonly refresh: () => void;
}

export function useWorkflowRun(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly runId: string | null;
}): WorkflowRunData {
  const { environmentId, cwd, runId } = input;
  const runs = useWorkflowRunList(environmentId, cwd);
  const jobs = useMobileQuery(workflowRunJobsQuery, { environmentId, cwd, runId }, environmentId);
  const run = useMemo(() => findWorkflowRun(runs.data?.runs ?? null, runId), [runs.data, runId]);
  const jobList = jobs.data?.jobs ?? null;
  const active = useMemo(() => isWorkflowRunActive(run, jobList), [jobList, run]);
  const refreshRuns = runs.refetch;
  const refreshJobs = jobs.refetch;
  const refresh = () => {
    void refreshRuns();
    void refreshJobs();
  };
  usePollWhile(active, refresh);
  return {
    run,
    jobs,
    problem: problemOf(jobs.error, "workflow jobs"),
    refreshing: (jobs.isFetching && jobs.data !== null) || (runs.isFetching && runs.data !== null),
    refresh,
  };
}

export function useWorkflowJobLog(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly runId: string | null;
  readonly jobId: string | null;
}): {
  readonly log: MobileQueryResult<SourceControlWorkflowJobLogResult>;
  readonly problem: ExplorerProblem | null;
} {
  const log = useMobileQuery(workflowJobLogQuery, input, input.environmentId);
  return { log, problem: problemOf(log.error, "job log") };
}

// ── Jira work items ──────────────────────────────────────────────────

export type JiraLinkStatus = "loading" | "linked" | "unlinked" | "problem";

export function useJiraLink(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
}): {
  readonly status: JiraLinkStatus;
  readonly problem: ExplorerProblem | null;
  readonly refresh: () => void;
} {
  const link = useMobileQuery(jiraProjectLinkQuery, input, input.environmentId);
  const problem = problemOf(link.error, "Jira link");
  const status: JiraLinkStatus =
    link.data !== null
      ? isJiraConfigured(link.data.link)
        ? "linked"
        : "unlinked"
      : problem !== null
        ? "problem"
        : "loading";
  const { refetch } = link;
  return { status, problem, refresh: () => void refetch() };
}

export interface WorkItemListData {
  readonly rows: ReadonlyArray<WorkItemRow>;
  readonly loading: boolean;
  readonly problem: ExplorerProblem | null;
  readonly refreshing: boolean;
  readonly refresh: () => void;
}

export function useWorkItemList(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly state: WorkItemStateFilter;
  readonly query: string;
  readonly enabled: boolean;
}): WorkItemListData {
  const { environmentId, projectId, state, query, enabled } = input;
  const settledQuery = useSettledValue(query);
  const list = useMobileQuery(
    workItemListQuery,
    { environmentId, projectId, state, limit: WORK_ITEM_LIST_LIMIT, enabled },
    environmentId,
  );
  const plan = useMemo(
    () => planWorkItemSearch({ items: list.data ?? [], query, settledQuery }),
    [list.data, query, settledQuery],
  );
  const search = useMobileQuery(
    workItemSearchQuery,
    {
      environmentId,
      projectId,
      query: settledQuery,
      limit: WORK_ITEM_SEARCH_LIMIT,
      enabled: enabled && plan.searchHost,
    },
    environmentId,
  );
  const items = plan.searchHost ? search.data : plan.local;
  const rows = useMemo(() => (items ?? []).map(workItemRow), [items]);
  const error = list.error ?? (plan.searchHost ? search.error : null);
  return {
    rows,
    loading: list.isLoading || (plan.searchHost && search.isLoading),
    problem: problemOf(error, "work items"),
    refreshing: list.isFetching && list.data !== null,
    refresh: () => {
      void list.refetch();
      if (plan.searchHost) void search.refetch();
    },
  };
}

export function useWorkItem(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly key: string | null;
}): {
  readonly detail: MobileQueryResult<WorkItemDetail>;
  readonly problem: ExplorerProblem | null;
} {
  const detail = useMobileQuery(workItemDetailQuery, input, input.environmentId);
  return { detail, problem: problemOf(detail.error, "work item") };
}
