import type {
  SourceControlCheckRollupItem,
  SourceControlProviderKind,
  SourceControlWorkflowJob,
  SourceControlWorkflowRun,
  SourceControlWorkflowStep,
} from "@ryco/contracts";
import { pullRequestCheckJobParam } from "@ryco/client-runtime/state/pull-request-review";

import {
  getCheckStatusFromRaw,
  getCheckStatusFromWorkflowRun,
  normalizeCheckToken,
  sourceControlOptionValue,
  type PrCheckStatusView,
} from "./projectExplorer/prCheckStatus";

export const OVERVIEW_CHECK_DETAIL_RUN_LIMIT = 8;
export const OVERVIEW_CHECK_TOOLTIP_ITEM_LIMIT = 40;

export function areOverviewWorkflowRunsSupported(
  provider: SourceControlProviderKind | null,
): boolean {
  return provider === "github";
}

export function selectOverviewChecksError(input: {
  readonly workflowRunsSupported: boolean;
  readonly workflowError: unknown;
  readonly detailError: unknown;
}): unknown {
  return input.workflowRunsSupported
    ? (input.workflowError ?? input.detailError)
    : input.detailError;
}

export interface OverviewWorkflowCheckRow {
  id: string;
  name: string;
  detail?: string;
  activeDetail?: string;
  statusLabel: string;
  statusKind: PrCheckStatusView["kind"];
  tone: PrCheckStatusView["tone"];
  url?: string;
  /**
   * The PR reader's Checks-tab `job` value that lands on this row's job: the
   * job id for Actions job rows, the shared rollup value for check runs.
   * Absent for workflow-run rows and status contexts, which open the Checks
   * tab only.
   */
  jobParam?: string;
}

type CheckStatusView = Pick<PrCheckStatusView, "kind" | "tone">;

function statusLabel(input: {
  readonly status?: string | null | undefined;
  readonly conclusion?: string | null | undefined;
  readonly statusKind: PrCheckStatusView["kind"];
}): string {
  const status = normalizeCheckToken(input.status);
  const conclusion = normalizeCheckToken(input.conclusion);
  if (status === "skipped" || conclusion === "skipped") return "Skipped";
  if (input.statusKind === "passed") return "Succeeded";
  if (input.statusKind === "failed" || input.statusKind === "api-error") return "Failed";
  if (input.statusKind === "cancelled") return "Cancelled";
  if (input.statusKind === "running") return "Running";
  if (input.statusKind === "pending" || input.statusKind === "loading") return "Pending";
  return "Unknown";
}

export function isOverviewActiveCheckKind(kind: string): boolean {
  return kind === "loading" || kind === "pending" || kind === "running";
}

export function isOverviewActiveWorkflowRun(run: SourceControlWorkflowRun): boolean {
  return isOverviewActiveCheckKind(getCheckStatusFromWorkflowRun(run).kind);
}

function getWorkflowJobStatus(job: SourceControlWorkflowJob): PrCheckStatusView {
  return getCheckStatusFromRaw({
    name: job.name,
    status: job.status,
    conclusion: sourceControlOptionValue(job.conclusion),
    url: sourceControlOptionValue(job.url),
  });
}

function getWorkflowStepStatus(step: SourceControlWorkflowStep): PrCheckStatusView {
  return getCheckStatusFromRaw({
    name: step.name,
    status: step.status,
    conclusion: sourceControlOptionValue(step.conclusion),
  });
}

function selectFirstStepByKind(
  annotatedSteps: ReadonlyArray<{
    readonly step: SourceControlWorkflowStep;
    readonly status: CheckStatusView;
  }>,
  kinds: ReadonlyArray<PrCheckStatusView["kind"]>,
): SourceControlWorkflowStep | null {
  return annotatedSteps.find(({ status }) => kinds.includes(status.kind))?.step ?? null;
}

function isSkippedStep(step: SourceControlWorkflowStep): boolean {
  return (
    normalizeCheckToken(step.status) === "skipped" ||
    normalizeCheckToken(sourceControlOptionValue(step.conclusion)) === "skipped"
  );
}

function selectOverviewWorkflowStep(
  job: SourceControlWorkflowJob,
): SourceControlWorkflowStep | null {
  const annotatedSteps = job.steps.map((step) => ({
    step,
    status: getWorkflowStepStatus(step),
  }));

  return (
    selectFirstStepByKind(annotatedSteps, ["failed", "api-error"]) ??
    selectFirstStepByKind(annotatedSteps, ["running"]) ??
    selectFirstStepByKind(annotatedSteps, ["pending", "loading"]) ??
    selectFirstStepByKind(annotatedSteps, ["cancelled"]) ??
    annotatedSteps.find(({ step }) => isSkippedStep(step))?.step ??
    null
  );
}

export function summarizeActiveWorkflowJob(
  jobs: ReadonlyArray<SourceControlWorkflowJob> | null | undefined,
): string | undefined {
  const annotatedJobs = (jobs ?? []).map((job) => ({
    job,
    status: getWorkflowJobStatus(job),
  }));
  const activeJob =
    annotatedJobs.find(({ status }) => status.kind === "running") ??
    annotatedJobs.find(({ status }) => status.kind === "pending" || status.kind === "loading") ??
    null;
  if (!activeJob) return undefined;

  const activeStep = selectOverviewWorkflowStep(activeJob.job);
  return activeStep ? `${activeJob.job.name} / ${activeStep.name}` : activeJob.job.name;
}

function workflowRunRow(run: SourceControlWorkflowRun): OverviewWorkflowCheckRow {
  const status = getCheckStatusFromWorkflowRun(run);
  const row: OverviewWorkflowCheckRow = {
    id: `run:${run.runId}`,
    name: run.workflowName,
    statusLabel: statusLabel({
      status: run.status,
      conclusion: sourceControlOptionValue(run.conclusion),
      statusKind: status.kind,
    }),
    tone: status.tone,
    statusKind: status.kind,
    url: run.url,
  };
  if (run.displayTitle && run.displayTitle !== run.workflowName) {
    row.detail = run.displayTitle;
  }
  return row;
}

function workflowJobRow(input: {
  readonly run: SourceControlWorkflowRun;
  readonly job: SourceControlWorkflowJob;
}): OverviewWorkflowCheckRow {
  const status = getWorkflowJobStatus(input.job);
  const notableStep = selectOverviewWorkflowStep(input.job);
  const jobUrl = sourceControlOptionValue(input.job.url);
  const detailParts = [
    input.run.workflowName !== input.job.name ? input.run.workflowName : null,
    notableStep?.name ?? null,
  ].filter((part): part is string => Boolean(part));
  const row: OverviewWorkflowCheckRow = {
    id: `run:${input.run.runId}:job:${input.job.jobId}`,
    name: input.job.name,
    statusLabel: statusLabel({
      status: input.job.status,
      conclusion: sourceControlOptionValue(input.job.conclusion),
      statusKind: status.kind,
    }),
    tone: status.tone,
    statusKind: status.kind,
    url: jobUrl ?? input.run.url,
    jobParam: input.job.jobId,
  };
  if (detailParts.length > 0) {
    row.detail = detailParts.join(" / ");
  }
  return row;
}

function checkRollupRow(
  item: SourceControlCheckRollupItem,
  index: number,
): OverviewWorkflowCheckRow {
  const status = getCheckStatusFromRaw({
    name: item.name,
    workflowName: item.workflowName,
    status: sourceControlOptionValue(item.status),
    conclusion: sourceControlOptionValue(item.conclusion),
    url: sourceControlOptionValue(item.url),
  });
  const url = sourceControlOptionValue(item.url);
  const row: OverviewWorkflowCheckRow = {
    id: `rollup:${index}:${item.kind}:${item.name}`,
    name: item.name,
    statusLabel: statusLabel({
      status: sourceControlOptionValue(item.status),
      conclusion: sourceControlOptionValue(item.conclusion),
      statusKind: status.kind,
    }),
    tone: status.tone,
    statusKind: status.kind,
  };
  if (item.workflowName && item.workflowName !== item.name) {
    row.detail = item.workflowName;
  }
  if (url) {
    row.url = url;
  }
  // Status contexts are not jobs; the reader can only list them.
  if (item.kind !== "status-context") {
    row.jobParam = pullRequestCheckJobParam({
      name: item.name,
      workflowName: item.workflowName ?? null,
      url: url ?? null,
    });
  }
  return row;
}

export function buildOverviewWorkflowCheckRows(input: {
  readonly runs: ReadonlyArray<SourceControlWorkflowRun>;
  readonly jobsByRunId: ReadonlyMap<string, ReadonlyArray<SourceControlWorkflowJob>>;
  readonly limit?: number;
}): ReadonlyArray<OverviewWorkflowCheckRow> {
  const rows: OverviewWorkflowCheckRow[] = [];
  const limit = input.limit ?? OVERVIEW_CHECK_TOOLTIP_ITEM_LIMIT;

  for (const run of input.runs) {
    const jobs = input.jobsByRunId.get(run.runId);
    if (jobs && jobs.length > 0) {
      for (const job of jobs) {
        rows.push(workflowJobRow({ run, job }));
        if (rows.length >= limit) return rows;
      }
    } else {
      rows.push(workflowRunRow(run));
      if (rows.length >= limit) return rows;
    }
  }

  return rows;
}

export function buildOverviewCheckRollupRows(input: {
  readonly rollup: ReadonlyArray<SourceControlCheckRollupItem> | null | undefined;
  readonly limit?: number;
}): ReadonlyArray<OverviewWorkflowCheckRow> {
  const limit = input.limit ?? OVERVIEW_CHECK_TOOLTIP_ITEM_LIMIT;
  return (input.rollup ?? []).slice(0, limit).map(checkRollupRow);
}
