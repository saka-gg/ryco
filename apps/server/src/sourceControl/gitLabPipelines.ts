import { DateTime, Option, Schema } from "effect";
import {
  SOURCE_CONTROL_WORKFLOW_LOG_MAX_BYTES,
  type SourceControlCheckRollupItem,
  type SourceControlWorkflowJob,
  type SourceControlWorkflowRun,
} from "@ryco/contracts";

import { GitLabUserRefSchema, parseGitLabTimestamp } from "./gitLabMergeRequests.ts";

/**
 * GitLab CI as the page's checks: pipelines are workflow runs, jobs are jobs
 * (GitLab jobs have no steps), commit statuses are the check rollup. Pure.
 *
 * Docs:
 * - https://docs.gitlab.com/api/merge_requests/#list-merge-request-pipelines
 * - https://docs.gitlab.com/api/pipelines/#list-project-pipelines
 * - https://docs.gitlab.com/api/jobs/#list-all-jobs-by-pipeline
 * - https://docs.gitlab.com/api/jobs/#retrieve-a-log-file-for-a-job
 * - https://docs.gitlab.com/api/commits/#list-commit-statuses
 */

export const GitLabPipelineSchema = Schema.Struct({
  id: Schema.Number,
  iid: Schema.optional(Schema.NullOr(Schema.Number)),
  sha: Schema.String,
  ref: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.String,
  source: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  web_url: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.optional(Schema.NullOr(Schema.String)),
  updated_at: Schema.optional(Schema.NullOr(Schema.String)),
  started_at: Schema.optional(Schema.NullOr(Schema.String)),
  finished_at: Schema.optional(Schema.NullOr(Schema.String)),
  duration: Schema.optional(Schema.NullOr(Schema.Number)),
  user: Schema.optional(Schema.NullOr(GitLabUserRefSchema)),
});
export type GitLabPipeline = typeof GitLabPipelineSchema.Type;

export const GitLabJobSchema = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  stage: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.String,
  allow_failure: Schema.optional(Schema.NullOr(Schema.Boolean)),
  started_at: Schema.optional(Schema.NullOr(Schema.String)),
  finished_at: Schema.optional(Schema.NullOr(Schema.String)),
  duration: Schema.optional(Schema.NullOr(Schema.Number)),
  web_url: Schema.optional(Schema.NullOr(Schema.String)),
});
export type GitLabJob = typeof GitLabJobSchema.Type;

export const GitLabCommitStatusSchema = Schema.Struct({
  id: Schema.Number,
  /** GitLab 17.9+. */
  pipeline_id: Schema.optional(Schema.NullOr(Schema.Number)),
  name: Schema.String,
  status: Schema.String,
  target_url: Schema.optional(Schema.NullOr(Schema.String)),
  allow_failure: Schema.optional(Schema.NullOr(Schema.Boolean)),
  created_at: Schema.optional(Schema.NullOr(Schema.String)),
  started_at: Schema.optional(Schema.NullOr(Schema.String)),
  finished_at: Schema.optional(Schema.NullOr(Schema.String)),
});
export type GitLabCommitStatus = typeof GitLabCommitStatusSchema.Type;

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}

function optionString(value: string | null | undefined): Option.Option<string> {
  const text = trimmed(value);
  return text ? Option.some(text) : Option.none();
}

function optionTime(value: string | null | undefined): Option.Option<DateTime.Utc> {
  const parsed = parseGitLabTimestamp(value);
  return parsed ? Option.some(parsed) : Option.none();
}

function durationMs(seconds: number | null | undefined): Option.Option<number> {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
    ? Option.some(Math.round(seconds * 1000))
    : Option.none();
}

/**
 * GitLab pipeline/job/status values as the GitHub-style status + conclusion
 * the page classifies. A failure GitLab tolerates (`allow_failure`) is
 * neutral, an optional manual job is skipped, a blocking one waits.
 */
export function gitLabCheckState(
  status: string,
  allowFailure = false,
): { readonly status: string; readonly conclusion: string | null } {
  switch (status.trim().toLowerCase()) {
    case "success":
      return { status: "completed", conclusion: "success" };
    case "failed":
      return { status: "completed", conclusion: allowFailure ? "neutral" : "failure" };
    case "canceled":
    case "cancelled":
      return { status: "completed", conclusion: "cancelled" };
    case "skipped":
      return { status: "completed", conclusion: "skipped" };
    case "manual":
      return allowFailure
        ? { status: "completed", conclusion: "skipped" }
        : { status: "waiting", conclusion: null };
    case "running":
    case "canceling":
      return { status: "in_progress", conclusion: null };
    case "created":
    case "pending":
    case "preparing":
    case "scheduled":
    case "waiting_for_resource":
    case "waiting_for_callback":
      return { status: "queued", conclusion: null };
    default:
      return { status: status.trim().toLowerCase() || "unknown", conclusion: null };
  }
}

/**
 * A pipeline's name on the page: its `name` (`workflow:name`), else
 * `Pipeline #<iid>`. The runs list and the check rollup both use it, so the
 * rollup's jobs group under their pipeline.
 */
export function gitLabPipelineRunName(pipeline: {
  readonly id: number;
  readonly iid?: number | null | undefined;
  readonly name?: string | null | undefined;
}): string {
  return trimmed(pipeline.name) ?? `Pipeline #${pipeline.iid ?? pipeline.id}`;
}

/**
 * @param sourceHeadOid The merge request head the pipeline verifies when it
 *   ran on a merged-results or merge-train commit (see `sourceHeadOid`).
 */
export function gitLabWorkflowRun(
  pipeline: GitLabPipeline,
  sourceHeadOid?: string | null,
): SourceControlWorkflowRun | null {
  const sha = trimmed(pipeline.sha);
  const url = trimmed(pipeline.web_url);
  if (!sha || !url) return null;
  const state = gitLabCheckState(pipeline.status);
  const event = trimmed(pipeline.source);
  const source = trimmed(sourceHeadOid);
  return {
    provider: "gitlab",
    runId: String(pipeline.id),
    workflowName: gitLabPipelineRunName(pipeline),
    branch: optionString(pipeline.ref),
    ...(event ? { event } : {}),
    commit: { oid: sha, shortOid: sha.slice(0, 8) },
    ...(source && source !== sha ? { sourceHeadOid: source } : {}),
    actor: optionString(pipeline.user?.username),
    status: state.status,
    conclusion: optionString(state.conclusion),
    startedAt: optionTime(pipeline.started_at ?? pipeline.created_at),
    updatedAt: optionTime(pipeline.updated_at ?? pipeline.finished_at),
    durationMs: durationMs(pipeline.duration),
    url,
  };
}

/**
 * The merge request's pipelines for its current head: those on the head
 * commit plus the head pipeline itself, whose SHA is the merged-results or
 * merge-train commit rather than the head.
 */
export function selectGitLabHeadPipelines(
  pipelines: ReadonlyArray<GitLabPipeline>,
  head: { readonly headSha: string | null; readonly headPipelineId: number | null },
): ReadonlyArray<GitLabPipeline> {
  return pipelines.filter(
    (pipeline) =>
      (head.headSha !== null && pipeline.sha === head.headSha) ||
      (head.headPipelineId !== null && pipeline.id === head.headPipelineId),
  );
}

export function gitLabWorkflowJob(job: GitLabJob): SourceControlWorkflowJob {
  const state = gitLabCheckState(job.status, job.allow_failure === true);
  const stage = trimmed(job.stage);
  const name = trimmed(job.name) ?? `Job ${job.id}`;
  return {
    jobId: String(job.id),
    name: stage ? `${stage} / ${name}` : name,
    status: state.status,
    conclusion: optionString(state.conclusion),
    startedAt: optionTime(job.started_at),
    completedAt: optionTime(job.finished_at),
    durationMs: durationMs(job.duration),
    url: optionString(job.web_url),
    steps: [],
  };
}

/**
 * The newest status per name (retries replace earlier attempts). GitLab lists
 * every CI job as a commit status too (a job is a `CommitStatus` row with the
 * same id), so the head pipeline's jobs become check runs of that pipeline,
 * named and linked as its jobs list names them; only what is left (external
 * statuses, trigger jobs, other pipelines) stays a status context. Without the
 * head pipeline's jobs, every status is a status context.
 */
export function gitLabCheckRollup(
  statuses: ReadonlyArray<GitLabCommitStatus>,
  headPipeline?: {
    readonly runName: string;
    readonly jobs: ReadonlyArray<GitLabJob>;
  } | null,
): SourceControlCheckRollupItem[] {
  const latest = new Map<string, GitLabCommitStatus>();
  for (const status of statuses) {
    const name = trimmed(status.name);
    if (!name) continue;
    const existing = latest.get(name);
    if (!existing || existing.id < status.id) latest.set(name, status);
  }
  const jobsById = new Map((headPipeline?.jobs ?? []).map((job) => [job.id, job] as const));
  return [...latest.values()]
    .toSorted((left, right) => left.id - right.id)
    .map((status): SourceControlCheckRollupItem => {
      const state = gitLabCheckState(status.status, status.allow_failure === true);
      const job = jobsById.get(status.id);
      const statusUrl = optionString(status.target_url);
      const startedAt = optionTime(status.started_at ?? status.created_at);
      const completedAt = optionTime(status.finished_at);
      if (job && headPipeline) {
        const mapped = gitLabWorkflowJob(job);
        return {
          kind: "check-run",
          name: mapped.name,
          workflowName: headPipeline.runName,
          status: Option.some(state.status),
          conclusion: optionString(state.conclusion),
          url: Option.orElse(mapped.url, () => statusUrl),
          startedAt,
          completedAt,
        };
      }
      return {
        kind: "status-context",
        name: status.name.trim(),
        status: Option.some(state.status),
        conclusion: optionString(state.conclusion),
        url: statusUrl,
        startedAt,
        completedAt,
      };
    });
}

/**
 * A list row's pipeline as a one-item rollup: the newest pipeline on the
 * merge request's refs (`refs/merge-requests/<iid>/…`) or its branch head.
 */
export function gitLabListRowRollup(
  pipelines: ReadonlyArray<GitLabPipeline>,
  row: { readonly iid: number; readonly sourceBranch: string; readonly headSha: string | null },
): SourceControlCheckRollupItem[] | null {
  const mergeRequestRef = `refs/merge-requests/${row.iid}/`;
  const pipeline = pipelines
    .filter(
      (candidate) =>
        candidate.ref?.startsWith(mergeRequestRef) === true ||
        (candidate.ref === row.sourceBranch &&
          row.headSha !== null &&
          candidate.sha === row.headSha),
    )
    .toSorted((left, right) => right.id - left.id)[0];
  if (!pipeline) return null;
  const state = gitLabCheckState(pipeline.status);
  return [
    {
      kind: "unknown",
      name: trimmed(pipeline.name) ?? "Pipeline",
      status: Option.some(state.status),
      conclusion: optionString(state.conclusion),
      url: optionString(pipeline.web_url),
      startedAt: optionTime(pipeline.started_at ?? pipeline.created_at),
      completedAt: optionTime(pipeline.finished_at),
    },
  ];
}

// GitLab job logs mark collapsible sections inline and colour with ANSI escapes.
// oxlint-disable-next-line no-control-regex
const SECTION_MARKER = /section_(?:start|end):\d+:[^\r\n\u001b]*(?:\r?\u001b\[0K)?/gu;
// oxlint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[A-Za-z]/gu;

/**
 * Plain text, newest output kept: the end of a log is where a job failed.
 * `startCut`: the raw log is already only its tail, so its first line may
 * begin inside a section marker or escape and is dropped.
 */
export function gitLabJobLogTail(
  raw: string,
  options?: { readonly startCut?: boolean },
): {
  readonly log: string;
  readonly truncated: boolean;
} {
  const startCut = options?.startCut === true;
  const newline = startCut ? raw.indexOf("\n") : -1;
  const log = startCut ? (newline >= 0 ? raw.slice(newline + 1) : "") : raw;
  const plain = log.replace(SECTION_MARKER, "").replace(ANSI_ESCAPE, "").replace(/\r\n/gu, "\n");
  const bytes = Buffer.from(plain, "utf8");
  if (bytes.byteLength <= SOURCE_CONTROL_WORKFLOW_LOG_MAX_BYTES) {
    return { log: plain, truncated: startCut };
  }
  let tail = bytes.subarray(bytes.byteLength - SOURCE_CONTROL_WORKFLOW_LOG_MAX_BYTES);
  // Skip continuation bytes so the tail starts on a whole UTF-8 character.
  let offset = 0;
  while (offset < tail.length && ((tail[offset] ?? 0) & 0xc0) === 0x80) offset += 1;
  tail = tail.subarray(offset);
  return { log: tail.toString("utf8"), truncated: true };
}
