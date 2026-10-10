import type {
  SourceControlWorkflowJob,
  SourceControlWorkflowRun,
  SourceControlWorkflowStep,
} from "@ryco/contracts";
import {
  checkStateGroup,
  classifyCheckState,
  workflowJobIdFromUrl,
  type ChangeRequestCheck,
  type ChangeRequestCheckGroup,
  type ChangeRequestCheckState,
  type ChangeRequestChecksOverall,
  type ChangeRequestChecksSummary,
} from "@ryco/client-runtime/state/pull-request-review";
import { DateTime, Option } from "effect";

/**
 * The Checks tab as one list: GitHub Actions runs on the head commit (workflow
 * → job → step), plus every rollup check no run accounts for (third-party
 * check runs, commit status contexts) as plain links. The summary line counts
 * exactly these rows, so its totals always match what is listed below it.
 *
 * Before the runs (or a run's jobs) load, the rollup stands in: its check runs
 * already name their workflow and job, so the list paints at its final shape
 * and only gains steps and logs once the jobs arrive.
 */

export const CHECK_GROUP_ORDER: ReadonlyArray<ChangeRequestCheckGroup> = [
  "attention",
  "running",
  "completed",
  "skipped",
];

export interface ChecksJobEntry {
  /** Stable across the rollup → jobs hand-off (the job name, de-duplicated). */
  readonly key: string;
  readonly name: string;
  readonly state: ChangeRequestCheckState;
  readonly group: ChangeRequestCheckGroup;
  readonly durationMs: number | null;
  readonly startedAtMs: number | null;
  readonly url: string | null;
  /** The Actions job; null while only the rollup describes it. */
  readonly job: SourceControlWorkflowJob | null;
  readonly runId: string | null;
  /** First failing step, for the auto-opened log. */
  readonly failingStep: SourceControlWorkflowStep | null;
  /** The host requires this job to pass before merging ("Required" tag). */
  readonly required: boolean;
}

export interface ChecksWorkflowEntry {
  /** `workflow#occurrence`, stable across the rollup → runs hand-off. */
  readonly key: string;
  readonly name: string;
  /** The Actions run; null while only the rollup describes the workflow. */
  readonly run: SourceControlWorkflowRun | null;
  readonly state: ChangeRequestCheckState;
  readonly group: ChangeRequestCheckGroup;
  readonly durationMs: number | null;
  readonly url: string | null;
  readonly jobs: ReadonlyArray<ChecksJobEntry>;
  /** Steps and logs are available (the run's jobs loaded). */
  readonly jobsLoaded: boolean;
}

export interface ChecksStatusEntry {
  readonly key: string;
  readonly check: ChangeRequestCheck;
}

export interface ChecksCounts {
  readonly failing: number;
  readonly actionRequired: number;
  readonly running: number;
  readonly passed: number;
  readonly skipped: number;
  readonly total: number;
  /** Listed rows the host requires, in any state. */
  readonly required: number;
}

export type ChecksSection =
  | { readonly kind: "workflow"; readonly key: string; readonly workflow: ChecksWorkflowEntry }
  | {
      readonly kind: "statuses";
      readonly key: "statuses";
      readonly statuses: ReadonlyArray<ChecksStatusEntry>;
    };

export interface PullRequestChecksModel {
  readonly workflows: ReadonlyArray<ChecksWorkflowEntry>;
  /** Checks no Actions run accounts for, attention first. */
  readonly statuses: ReadonlyArray<ChecksStatusEntry>;
  /** Workflows and the status list in display order (attention → skipped). */
  readonly sections: ReadonlyArray<ChecksSection>;
  readonly counts: ChecksCounts;
  readonly overall: ChangeRequestChecksOverall;
  /** Finished runs with failed or cancelled jobs ("Re-run failed"). */
  readonly rerunnableRunIds: ReadonlyArray<string>;
  /** Something is queued or running, so the tab keeps polling. */
  readonly live: boolean;
}

function groupRank(group: ChangeRequestCheckGroup): number {
  return CHECK_GROUP_ORDER.indexOf(group);
}

/** Stable sort by display group; the host's order breaks ties. */
export function orderByCheckGroup<T extends { readonly group: ChangeRequestCheckGroup }>(
  entries: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return entries
    .map((entry, index) => ({ entry, index }))
    .toSorted(
      (left, right) =>
        groupRank(left.entry.group) - groupRank(right.entry.group) || left.index - right.index,
    )
    .map(({ entry }) => entry);
}

function epochMillis(value: Option.Option<DateTime.Utc>): number | null {
  return Option.match(value, {
    onNone: () => null,
    onSome: (inner) => DateTime.toEpochMillis(inner),
  });
}

export function isCompletedStatus(status: string): boolean {
  return status.trim().toLowerCase() === "completed";
}

/** Normalized state of anything with a host status and an optional conclusion. */
export function workflowItemState(item: {
  readonly status: string;
  readonly conclusion: Option.Option<string>;
}): ChangeRequestCheckState {
  return classifyCheckState({
    status: item.status,
    conclusion: Option.getOrNull(item.conclusion),
  });
}

function jobDurationMs(job: SourceControlWorkflowJob): number | null {
  const reported = Option.getOrNull(job.durationMs);
  if (reported !== null) return reported;
  const started = epochMillis(job.startedAt);
  const completed = epochMillis(job.completedAt);
  return started !== null && completed !== null ? Math.max(0, completed - started) : null;
}

function uniqueKeys(names: ReadonlyArray<string>): ReadonlyArray<string> {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const occurrence = seen.get(name) ?? 0;
    seen.set(name, occurrence + 1);
    return occurrence === 0 ? name : `${name}#${occurrence}`;
  });
}

function jobEntryFromJob(
  job: SourceControlWorkflowJob,
  runId: string,
  key: string,
  /** The rollup's check run for this job: its link and required-ness. */
  rollupCheck: ChangeRequestCheck | undefined,
): ChecksJobEntry {
  const state = workflowItemState(job);
  const group = checkStateGroup(state);
  return {
    key,
    name: job.name,
    state,
    group,
    durationMs: group === "running" ? null : jobDurationMs(job),
    startedAtMs: epochMillis(job.startedAt),
    url: Option.getOrNull(job.url) ?? rollupCheck?.url ?? null,
    job,
    runId,
    failingStep:
      group === "attention"
        ? (job.steps.find((step) => checkStateGroup(workflowItemState(step)) === "attention") ??
          null)
        : null,
    required: rollupCheck?.required === true,
  };
}

function jobEntryFromCheck(check: ChangeRequestCheck, key: string): ChecksJobEntry {
  return {
    key,
    name: check.name,
    state: check.state,
    group: check.group,
    durationMs: check.durationMs,
    startedAtMs: check.startedAtMs,
    url: check.url,
    job: null,
    runId: null,
    failingStep: null,
    required: check.required === true,
  };
}

function worstOf(
  jobs: ReadonlyArray<ChecksJobEntry>,
  fallback: ChangeRequestCheckState,
): ChangeRequestCheckState {
  // Jobs arrive ordered by group, so the first one carries the workflow's worst state.
  return jobs[0]?.state ?? fallback;
}

function workflowEntry(input: {
  readonly key: string;
  readonly name: string;
  readonly run: SourceControlWorkflowRun | null;
  readonly jobs: ReadonlyArray<ChecksJobEntry>;
  readonly jobsLoaded: boolean;
}): ChecksWorkflowEntry {
  const jobs = orderByCheckGroup(input.jobs);
  const runState = input.run ? workflowItemState(input.run) : "unknown";
  const state = worstOf(jobs, runState);
  const group = checkStateGroup(state);
  return {
    key: input.key,
    name: input.name,
    run: input.run,
    state,
    group,
    durationMs: input.run && group !== "running" ? Option.getOrNull(input.run.durationMs) : null,
    url: input.run?.url ?? null,
    jobs,
    jobsLoaded: input.jobsLoaded,
  };
}

function emptyCounts(): { -readonly [K in keyof ChecksCounts]: ChecksCounts[K] } {
  return {
    failing: 0,
    actionRequired: 0,
    running: 0,
    passed: 0,
    skipped: 0,
    total: 0,
    required: 0,
  };
}

function countRow(
  counts: { -readonly [K in keyof ChecksCounts]: ChecksCounts[K] },
  state: ChangeRequestCheckState,
  required: boolean,
) {
  counts.total += 1;
  if (required) counts.required += 1;
  switch (state) {
    case "failure":
    case "cancelled":
      counts.failing += 1;
      return;
    case "action-required":
      counts.actionRequired += 1;
      return;
    case "running":
    case "pending":
    case "unknown":
      counts.running += 1;
      return;
    case "success":
    case "neutral":
      counts.passed += 1;
      return;
    case "skipped":
      counts.skipped += 1;
      return;
  }
}

/**
 * The run verifies `headSha`: it ran on the head, or on a merge of the head
 * into the target (GitLab merged-results and merge-train pipelines, which
 * name the head they verify in `sourceHeadOid`). Unknown heads keep every run.
 */
export function isHeadWorkflowRun(run: SourceControlWorkflowRun, headSha: string | null): boolean {
  return headSha === null || run.commit.oid === headSha || run.sourceHeadOid === headSha;
}

/**
 * @param rollup  The selected change request's checks summary (detail rollup).
 * @param runs    Workflow runs for the change request, or null while unknown
 *                (loading, or a host without Actions).
 * @param jobsByRunId  Jobs of the runs that have loaded.
 * @param headSha Head commit; runs on older heads are left out.
 */
export function buildPullRequestChecksModel(input: {
  readonly rollup: ChangeRequestChecksSummary;
  readonly runs: ReadonlyArray<SourceControlWorkflowRun> | null;
  readonly jobsByRunId: ReadonlyMap<string, ReadonlyArray<SourceControlWorkflowJob>>;
  readonly headSha: string | null;
}): PullRequestChecksModel {
  const { rollup, jobsByRunId, headSha } = input;
  const headRuns = (input.runs ?? []).filter((run) => isHeadWorkflowRun(run, headSha));

  // Rollup check runs by workflow, in host order.
  const rollupByWorkflow = new Map<string, ChangeRequestCheck[]>();
  for (const check of rollup.checks) {
    if (check.kind !== "check-run" || check.workflowName === null) continue;
    const list = rollupByWorkflow.get(check.workflowName) ?? [];
    list.push(check);
    rollupByWorkflow.set(check.workflowName, list);
  }

  const workflows: ChecksWorkflowEntry[] = [];
  const coveredWorkflows = new Set<string>();
  {
    const occurrences = new Map<string, number>();
    for (const run of headRuns) {
      const occurrence = occurrences.get(run.workflowName) ?? 0;
      occurrences.set(run.workflowName, occurrence + 1);
      coveredWorkflows.add(run.workflowName);
      const rollupJobs = rollupByWorkflow.get(run.workflowName) ?? [];
      const jobs = jobsByRunId.get(run.runId);
      if (jobs) {
        const keys = uniqueKeys(jobs.map((job) => job.name));
        workflows.push(
          workflowEntry({
            key: `${run.workflowName}#${occurrence}`,
            name: run.workflowName,
            run,
            jobs: jobs.map((job, index) =>
              jobEntryFromJob(
                job,
                run.runId,
                keys[index] ?? job.name,
                rollupJobs.find((check) => check.name === job.name),
              ),
            ),
            jobsLoaded: true,
          }),
        );
      } else {
        // Only the first run of a workflow borrows the rollup's jobs, so a
        // workflow that ran twice on the head is not counted twice.
        const borrowed = occurrence === 0 ? rollupJobs : [];
        const keys = uniqueKeys(borrowed.map((check) => check.name));
        workflows.push(
          workflowEntry({
            key: `${run.workflowName}#${occurrence}`,
            name: run.workflowName,
            run,
            jobs: borrowed.map((check, index) => jobEntryFromCheck(check, keys[index] ?? check.id)),
            jobsLoaded: false,
          }),
        );
      }
    }
    // Workflows no listed run accounts for (runs still loading, a lagging runs
    // list after a push, or a host without run details): the rollup's check
    // runs already name their workflow, so they group the same way.
    for (const [name, checks] of rollupByWorkflow) {
      if (coveredWorkflows.has(name)) continue;
      coveredWorkflows.add(name);
      const keys = uniqueKeys(checks.map((check) => check.name));
      workflows.push(
        workflowEntry({
          key: `${name}#0`,
          name,
          run: null,
          jobs: checks.map((check, index) => jobEntryFromCheck(check, keys[index] ?? check.id)),
          jobsLoaded: false,
        }),
      );
    }
  }

  const statuses = orderByCheckGroup(
    rollup.checks
      .filter(
        (check) =>
          check.kind !== "check-run" ||
          check.workflowName === null ||
          !coveredWorkflows.has(check.workflowName),
      )
      .map((check): ChecksStatusEntry & { group: ChangeRequestCheckGroup } => ({
        key: check.id,
        check,
        group: check.group,
      })),
  ).map(({ key, check }): ChecksStatusEntry => ({ key, check }));

  const orderedWorkflows = orderByCheckGroup(workflows);
  const sections: Array<ChecksSection & { group: ChangeRequestCheckGroup }> = orderedWorkflows.map(
    (workflow) => ({
      kind: "workflow",
      key: workflow.key,
      workflow,
      group: workflow.group,
    }),
  );
  if (statuses.length > 0) {
    const worst = statuses[0]!.check.group;
    sections.push({ kind: "statuses", key: "statuses", statuses, group: worst });
  }

  const counts = emptyCounts();
  for (const workflow of orderedWorkflows) {
    for (const job of workflow.jobs) countRow(counts, job.state, job.required);
  }
  for (const status of statuses) {
    countRow(counts, status.check.state, status.check.required === true);
  }

  const overall: ChangeRequestChecksOverall =
    counts.total === 0
      ? "none"
      : counts.failing + counts.actionRequired > 0
        ? "failing"
        : counts.running > 0
          ? "pending"
          : "passing";

  // GitHub re-runs failed jobs only once the whole run has finished.
  const rerunnableRunIds = orderedWorkflows.flatMap((workflow) =>
    workflow.run !== null &&
    isCompletedStatus(workflow.run.status) &&
    workflow.jobs.some((job) => job.state === "failure" || job.state === "cancelled")
      ? [workflow.run.runId]
      : [],
  );

  return {
    workflows: orderedWorkflows,
    statuses,
    sections: orderByCheckGroup(sections).map(({ group: _group, ...section }) => section),
    counts,
    overall,
    rerunnableRunIds,
    live: counts.running > 0,
  };
}

// ── Summary line ─────────────────────────────────────────────────────

export interface ChecksSummarySegment {
  readonly key: "failing" | "action-required" | "passed" | "running" | "skipped" | "required";
  readonly count: number;
  readonly label: string;
  readonly tone: "destructive" | "warning" | "muted";
}

/**
 * "1 failing · 8 passed · 1 running · 4 required"; zero counts are left out,
 * so a host that does not mark required checks never shows the last one.
 */
export function checksSummarySegments(counts: ChecksCounts): ReadonlyArray<ChecksSummarySegment> {
  const segments: ChecksSummarySegment[] = [];
  const push = (
    key: ChecksSummarySegment["key"],
    count: number,
    label: string,
    tone: ChecksSummarySegment["tone"],
  ) => {
    if (count > 0) segments.push({ key, count, label, tone });
  };
  push("failing", counts.failing, "failing", "destructive");
  push("action-required", counts.actionRequired, "awaiting action", "warning");
  push("passed", counts.passed, "passed", "muted");
  push("running", counts.running, "running", "muted");
  push("skipped", counts.skipped, "skipped", "muted");
  push("required", counts.required, "required", "muted");
  return segments;
}

// ── Durations ────────────────────────────────────────────────────────

/** "48s", "2m 11s", "1h 4m". */
export function formatWorkflowDuration(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = seconds % 60;
  if (minutes < 60)
    return remainderSeconds > 0 ? `${minutes}m ${remainderSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  return remainderMinutes > 0 ? `${hours}h ${remainderMinutes}m` : `${hours}h`;
}

// ── Deep links (`job` URL param) ─────────────────────────────────────

export interface ChecksJobTarget {
  readonly workflowKey: string;
  readonly jobKey: string;
}

/** Resolve a `job` URL value to a listed job: by job id, `workflow/name`, or a bare name. */
export function resolveChecksJobParam(
  model: Pick<PullRequestChecksModel, "workflows">,
  param: string | null | undefined,
): ChecksJobTarget | null {
  if (!param) return null;
  // Job ids first: from loaded jobs, then from the rollup's check-run links.
  for (const workflow of model.workflows) {
    for (const job of workflow.jobs) {
      const jobId = job.job?.jobId ?? workflowJobIdFromUrl(job.url);
      if (jobId === param) return { workflowKey: workflow.key, jobKey: job.key };
    }
  }
  for (const workflow of model.workflows) {
    for (const job of workflow.jobs) {
      if (param === `${workflow.name}/${job.name}` || param === job.name) {
        return { workflowKey: workflow.key, jobKey: job.key };
      }
    }
  }
  return null;
}

// ── Expansion memory ─────────────────────────────────────────────────

/**
 * Identity of a job row for expansion memory. Workflow and job keys survive
 * the rollup → jobs hand-off and re-runs, so a remembered row stays open.
 */
export function checksJobMemoryKey(
  workflow: Pick<ChecksWorkflowEntry, "key">,
  job: Pick<ChecksJobEntry, "key">,
): string {
  return `${workflow.key}/${job.key}`;
}

const COLLAPSED_MARK = "collapsed:";

/**
 * Failing jobs open on their own; every other job opens when the reader
 * opens it. Collapsing a failing job is remembered too (as a marker), so it
 * stays closed until it is opened again.
 */
export function isChecksJobExpanded(
  memory: ReadonlyArray<string>,
  key: string,
  autoOpen: boolean,
): boolean {
  if (memory.includes(key)) return true;
  return autoOpen && !memory.includes(`${COLLAPSED_MARK}${key}`);
}

/** The `setJobExpanded` writes that record a reader's toggle. */
export function checksJobExpansionWrites(
  key: string,
  expanded: boolean,
  autoOpen: boolean,
): ReadonlyArray<{ readonly id: string; readonly expanded: boolean }> {
  return [
    { id: key, expanded },
    { id: `${COLLAPSED_MARK}${key}`, expanded: !expanded && autoOpen },
  ];
}

// ── Display vocabulary ───────────────────────────────────────────────

/**
 * One job's or step's state as the page's four-way checks glyph. Only work
 * that is actually running spins; queued and skipped work is a quiet dot.
 */
export function checkStateOverall(state: ChangeRequestCheckState): ChangeRequestChecksOverall {
  switch (state) {
    case "failure":
    case "cancelled":
    case "action-required":
      return "failing";
    case "running":
      return "pending";
    case "success":
    case "neutral":
      return "passing";
    case "pending":
    case "unknown":
    case "skipped":
      return "none";
  }
}

export const CHECK_STATE_LABEL: Record<ChangeRequestCheckState, string> = {
  failure: "Failed",
  cancelled: "Cancelled",
  "action-required": "Awaiting action",
  running: "Running",
  pending: "Queued",
  unknown: "Waiting",
  success: "Passed",
  neutral: "Neutral",
  skipped: "Skipped",
};
