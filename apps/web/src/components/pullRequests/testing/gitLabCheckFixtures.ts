import type {
  SourceControlChangeRequestDetail,
  SourceControlCheckRollupItem,
  SourceControlWorkflowJob,
  SourceControlWorkflowRun,
  SourceControlWorkflowRunListResult,
} from "@ryco/contracts";
import { DateTime, Option } from "effect";

import { fixtureDetail } from "./pullRequestFixtures";

/**
 * A GitLab merge request's checks as the server maps them
 * (`apps/server/src/sourceControl/gitLabPipelines.ts`): a merged-results head
 * pipeline that ran on a merge commit of the head (so the run names the head
 * in `sourceHeadOid`), its jobs as `stage / name` check runs of that pipeline
 * in the rollup (GitLab lists every CI job as a commit status too), and one
 * external commit status. One of the nine jobs fails.
 */

const NUMBER = 703;
const PROJECT_URL = "https://gitlab.example.com/ryco/ryco";
export const GITLAB_FIXTURE_PIPELINE_NAME = "Pipeline #1877";
export const GITLAB_FIXTURE_RUN_ID = "538317940";
export const GITLAB_FIXTURE_MERGE_SHA = "1604b0c46c395822e4e9478777f8e54ac99fe5b9";
export const GITLAB_FIXTURE_EXTERNAL_STATUS = "jenkins/build";

const STARTED = DateTime.makeUnsafe("2026-09-30T09:46:50.032Z");
const FINISHED = DateTime.makeUnsafe("2026-09-30T09:47:20.697Z");

const JOBS: ReadonlyArray<{ readonly id: number; readonly name: string; readonly failed?: true }> =
  [
    { id: 9001, name: "build / compile" },
    { id: 9002, name: "build / assets" },
    { id: 9003, name: "test / unit" },
    { id: 9004, name: "test / browser", failed: true },
    { id: 9005, name: "test / integration" },
    { id: 9006, name: "lint / eslint" },
    { id: 9007, name: "lint / format" },
    { id: 9008, name: "security / sast" },
    { id: 9009, name: "security / dependency-scan" },
  ];

export const GITLAB_FIXTURE_FAILING_JOB = {
  jobId: "9004",
  name: "test / browser",
} as const;

function headSha(): string {
  const sha = fixtureDetail(NUMBER).headSha;
  if (!sha) throw new Error(`fixture #${NUMBER} has no head`);
  return sha;
}

export function gitLabFixtureRollup(): ReadonlyArray<SourceControlCheckRollupItem> {
  return [
    ...JOBS.map((job): SourceControlCheckRollupItem => ({
      kind: "check-run",
      name: job.name,
      workflowName: GITLAB_FIXTURE_PIPELINE_NAME,
      status: Option.some("completed"),
      conclusion: Option.some(job.failed ? "failure" : "success"),
      url: Option.some(`${PROJECT_URL}/-/jobs/${job.id}`),
      startedAt: Option.some(STARTED),
      completedAt: Option.some(FINISHED),
    })),
    {
      kind: "status-context",
      name: GITLAB_FIXTURE_EXTERNAL_STATUS,
      status: Option.some("completed"),
      conclusion: Option.some("success"),
      url: Option.some("https://ci.example.com/job/build/12"),
      startedAt: Option.some(STARTED),
      completedAt: Option.some(FINISHED),
    },
  ];
}

/** #703's detail with the GitLab rollup, for a test provider's `detailState.data`. */
export function gitLabFixtureDetail(): SourceControlChangeRequestDetail {
  return { ...fixtureDetail(NUMBER), checkRollup: gitLabFixtureRollup() };
}

export function gitLabFixtureRun(): SourceControlWorkflowRun {
  return {
    provider: "gitlab",
    runId: GITLAB_FIXTURE_RUN_ID,
    workflowName: GITLAB_FIXTURE_PIPELINE_NAME,
    branch: Option.some(`refs/merge-requests/${NUMBER}/merge`),
    event: "merge_request_event",
    commit: { oid: GITLAB_FIXTURE_MERGE_SHA, shortOid: GITLAB_FIXTURE_MERGE_SHA.slice(0, 8) },
    sourceHeadOid: headSha(),
    actor: Option.some("marcel.amirault"),
    status: "completed",
    conclusion: Option.some("failure"),
    startedAt: Option.some(STARTED),
    updatedAt: Option.some(FINISHED),
    durationMs: Option.some(30_000),
    url: `${PROJECT_URL}/-/pipelines/${GITLAB_FIXTURE_RUN_ID}`,
  };
}

export function gitLabFixtureRuns(): SourceControlWorkflowRunListResult {
  return {
    provider: "gitlab",
    repository: Option.none(),
    pullRequestNumber: Option.some(NUMBER),
    headSha: Option.some(headSha()),
    runs: [gitLabFixtureRun()],
  };
}

export function gitLabFixtureJobs(): ReadonlyArray<SourceControlWorkflowJob> {
  return JOBS.map((job) => ({
    jobId: String(job.id),
    name: job.name,
    status: "completed",
    conclusion: Option.some(job.failed ? "failure" : "success"),
    startedAt: Option.some(STARTED),
    completedAt: Option.some(FINISHED),
    durationMs: Option.some(30_000),
    url: Option.some(`${PROJECT_URL}/-/jobs/${job.id}`),
    steps: [],
  }));
}
