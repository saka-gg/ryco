import type {
  SourceControlWorkflowJob,
  SourceControlWorkflowJobLogResult,
  SourceControlWorkflowRerunInput,
  SourceControlWorkflowRun,
  SourceControlWorkflowStep,
} from "@ryco/contracts";
import {
  CHECK_STATE_LABEL,
  checkStateGroup,
  checkStateOverall,
  classifyCheckState,
  formatWorkflowDuration,
  type ChangeRequestCheckState,
  type ChangeRequestChecksOverall,
} from "@ryco/client-runtime/state/pull-request-review";
import { epochMillis, optionalValue } from "@ryco/shared/changeRequestChecks";
import { resolveChangeRequestPresentationForKind } from "@ryco/shared/sourceControl";
import type * as Option from "effect/Option";

/**
 * A project's workflow runs on the phone, as the web's Actions tab lists them:
 * the latest runs, each run's jobs and steps, a job's log, and re-runs of what
 * failed. States use the checks vocabulary every client shares. React-free.
 */

/** The web's Actions tab reads the same amount. */
export const WORKFLOW_RUN_LIST_LIMIT = 20;

export interface WorkflowStateView {
  readonly state: ChangeRequestCheckState;
  /** The checks glyph: only work that is actually running reads as pending. */
  readonly overall: ChangeRequestChecksOverall;
  readonly label: string;
}

export function workflowState(input: {
  readonly status: string;
  readonly conclusion: Option.Option<string>;
}): WorkflowStateView {
  const state = classifyCheckState({
    status: input.status,
    conclusion: optionalValue(input.conclusion),
  });
  return { state, overall: checkStateOverall(state), label: CHECK_STATE_LABEL[state] };
}

/** The host says the run or job is done (any conclusion). */
export function isCompletedWorkflowStatus(status: string): boolean {
  return status.trim().toLowerCase() === "completed";
}

function failedAndDone(view: WorkflowStateView, status: string): boolean {
  return checkStateGroup(view.state) === "attention" && isCompletedWorkflowStatus(status);
}

export interface WorkflowRunRow {
  readonly runId: string;
  readonly workflowName: string;
  /** The run's own title (the commit or pull request), when it says more than the workflow. */
  readonly title: string | null;
  readonly status: WorkflowStateView;
  readonly branch: string | null;
  readonly shortSha: string;
  readonly actor: string | null;
  readonly event: string | null;
  /** When it last moved (or started). */
  readonly atMs: number | null;
  readonly duration: string | null;
  readonly url: string;
  /** "GitHub", "GitLab": where "Open on …" goes. */
  readonly hostName: string;
}

export function workflowRunRow(run: SourceControlWorkflowRun): WorkflowRunRow {
  const title = run.displayTitle?.trim() ?? "";
  return {
    runId: run.runId,
    workflowName: run.workflowName,
    title: title.length > 0 && title !== run.workflowName ? title : null,
    status: workflowState(run),
    branch: optionalValue(run.branch),
    shortSha: run.commit.shortOid,
    actor: optionalValue(run.actor),
    event: run.event ?? null,
    atMs: epochMillis(run.updatedAt) ?? epochMillis(run.startedAt),
    duration: formatWorkflowDuration(optionalValue(run.durationMs)),
    url: run.url,
    hostName: resolveChangeRequestPresentationForKind(run.provider).providerName,
  };
}

/** Newest first; the host's order breaks ties. */
export function workflowRunRows(
  runs: ReadonlyArray<SourceControlWorkflowRun>,
): ReadonlyArray<WorkflowRunRow> {
  return runs
    .map((run, index) => ({ row: workflowRunRow(run), index }))
    .toSorted((a, b) => (b.row.atMs ?? 0) - (a.row.atMs ?? 0) || a.index - b.index)
    .map(({ row }) => row);
}

export function findWorkflowRun(
  runs: ReadonlyArray<SourceControlWorkflowRun> | null,
  runId: string | null,
): SourceControlWorkflowRun | null {
  if (runs === null || runId === null) return null;
  return runs.find((run) => run.runId === runId) ?? null;
}

// ── One run ──────────────────────────────────────────────────────────

export interface WorkflowStepRow {
  readonly key: string;
  readonly name: string;
  readonly status: WorkflowStateView;
  readonly duration: string | null;
}

export interface WorkflowJobRow {
  readonly jobId: string;
  readonly name: string;
  readonly status: WorkflowStateView;
  readonly duration: string | null;
  readonly url: string | null;
  readonly steps: ReadonlyArray<WorkflowStepRow>;
  /** A failed job that finished can be re-run on its own. */
  readonly canRerun: boolean;
}

function stepRow(step: SourceControlWorkflowStep): WorkflowStepRow {
  return {
    key: `${step.number}:${step.name}`,
    name: step.name,
    status: workflowState(step),
    duration: formatWorkflowDuration(optionalValue(step.durationMs)),
  };
}

export function workflowJobRow(job: SourceControlWorkflowJob): WorkflowJobRow {
  const status = workflowState(job);
  return {
    jobId: job.jobId,
    name: job.name,
    status,
    duration: formatWorkflowDuration(optionalValue(job.durationMs)),
    url: optionalValue(job.url),
    steps: job.steps.map(stepRow),
    canRerun: failedAndDone(status, job.status),
  };
}

/** Failed jobs first (they are what the reader came for), then the host's order. */
export function workflowJobRows(
  jobs: ReadonlyArray<SourceControlWorkflowJob>,
): ReadonlyArray<WorkflowJobRow> {
  return jobs
    .map((job, index) => ({ row: workflowJobRow(job), index }))
    .toSorted(
      (a, b) =>
        Number(checkStateGroup(b.row.status.state) === "attention") -
          Number(checkStateGroup(a.row.status.state) === "attention") || a.index - b.index,
    )
    .map(({ row }) => row);
}

/** Re-running a run's failed jobs is offered once it finished with a failure. */
export function canRerunFailedJobs(run: SourceControlWorkflowRun | null): boolean {
  return run !== null && failedAndDone(workflowState(run), run.status);
}

export type WorkflowRerunTarget =
  | { readonly target: "failed-jobs" }
  | { readonly target: "job"; readonly jobId: string; readonly jobName: string };

export function buildWorkflowRerunInput(
  cwd: string,
  runId: string,
  target: WorkflowRerunTarget,
): SourceControlWorkflowRerunInput {
  return target.target === "job"
    ? { cwd, runId, target: "job", jobId: target.jobId }
    : { cwd, runId, target: "failed-jobs" };
}

export function workflowRerunTargetKey(target: WorkflowRerunTarget): string {
  return target.target === "job" ? `job:${target.jobId}` : "failed-jobs";
}

export function workflowRerunNotice(target: WorkflowRerunTarget): string {
  return target.target === "job"
    ? `Re-run requested for ${target.jobName}.`
    : "Re-run requested for the failed jobs.";
}

/** A run still moving is read again on this cadence while its screen is open. */
export const WORKFLOW_RUN_POLL_MS = 15_000;

/** Whether the run or any of its jobs is still queued or running. */
export function isWorkflowRunActive(
  run: SourceControlWorkflowRun | null,
  jobs: ReadonlyArray<SourceControlWorkflowJob> | null,
): boolean {
  if (run !== null && !isCompletedWorkflowStatus(run.status)) return true;
  return (jobs ?? []).some((job) => !isCompletedWorkflowStatus(job.status));
}

// ── Job log ──────────────────────────────────────────────────────────

/** GitHub prefixes every log line with an ISO timestamp; the phone has no room for it. */
const LOG_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/u;
// GitHub Actions' grouping and command markers ("##[group]Run …", "##[error]…").
const LOG_COMMAND = /^##\[(group|endgroup|error|warning|notice|debug|command)\]/u;

export type WorkflowLogLineTone = "plain" | "group" | "error" | "warning" | "muted";

export interface WorkflowLogLine {
  readonly key: string;
  readonly text: string;
  readonly tone: WorkflowLogLineTone;
}

export interface WorkflowLogView {
  readonly lines: ReadonlyArray<WorkflowLogLine>;
  readonly truncated: boolean;
  /** The first error line's index, for "jump to the error"; null without one. */
  readonly firstErrorIndex: number | null;
}

function logLine(raw: string, index: number): WorkflowLogLine | null {
  const withoutTime = raw.replace(LOG_TIMESTAMP, "").replace(/\r$/u, "");
  const command = LOG_COMMAND.exec(withoutTime)?.[1];
  if (command === "endgroup") return null;
  const text = command ? withoutTime.slice(command.length + 4) : withoutTime;
  const tone: WorkflowLogLineTone =
    command === "group"
      ? "group"
      : command === "error"
        ? "error"
        : command === "warning"
          ? "warning"
          : command === "debug" || command === "command"
            ? "muted"
            : "plain";
  return { key: String(index), text, tone };
}

export function deriveWorkflowLog(result: SourceControlWorkflowJobLogResult): WorkflowLogView {
  const lines: Array<WorkflowLogLine> = [];
  const raw = result.log.split("\n");
  // A trailing newline is not a line of its own.
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
  raw.forEach((text, index) => {
    const line = logLine(text, index);
    if (line !== null) lines.push(line);
  });
  const firstError = lines.findIndex((line) => line.tone === "error");
  return {
    lines,
    truncated: result.truncated,
    firstErrorIndex: firstError === -1 ? null : firstError,
  };
}
