import { DateTime, Option, Schema } from "effect";
import { SOURCE_CONTROL_WORKFLOW_LOG_MAX_BYTES } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  GITLAB_COMMIT_STATUSES,
  GITLAB_JOBS,
  GITLAB_PIPELINES,
} from "./gitLabMergeRequestPage.fixtures.ts";
import {
  GitLabCommitStatusSchema,
  GitLabJobSchema,
  GitLabPipelineSchema,
  gitLabCheckRollup,
  gitLabCheckState,
  gitLabJobLogTail,
  gitLabListRowRollup,
  gitLabWorkflowJob,
  gitLabWorkflowRun,
  selectGitLabHeadPipelines,
} from "./gitLabPipelines.ts";

const pipelines = GITLAB_PIPELINES.map((pipeline) =>
  Schema.decodeUnknownSync(GitLabPipelineSchema)(pipeline),
);

describe("gitLabCheckState", () => {
  it("maps GitLab statuses to status + conclusion", () => {
    expect(gitLabCheckState("success")).toEqual({ status: "completed", conclusion: "success" });
    expect(gitLabCheckState("failed")).toEqual({ status: "completed", conclusion: "failure" });
    expect(gitLabCheckState("failed", true)).toEqual({
      status: "completed",
      conclusion: "neutral",
    });
    expect(gitLabCheckState("canceled")).toEqual({ status: "completed", conclusion: "cancelled" });
    expect(gitLabCheckState("skipped")).toEqual({ status: "completed", conclusion: "skipped" });
    expect(gitLabCheckState("manual", true)).toEqual({
      status: "completed",
      conclusion: "skipped",
    });
    expect(gitLabCheckState("manual")).toEqual({ status: "waiting", conclusion: null });
    expect(gitLabCheckState("running")).toEqual({ status: "in_progress", conclusion: null });
    expect(gitLabCheckState("waiting_for_resource")).toEqual({
      status: "queued",
      conclusion: null,
    });
  });
});

describe("gitLabWorkflowRun", () => {
  it("maps a pipeline to a workflow run", () => {
    expect(gitLabWorkflowRun(pipelines[0]!)).toEqual({
      provider: "gitlab",
      runId: "47",
      workflowName: "Build pipeline",
      branch: Option.some("new-pipeline"),
      event: "push",
      commit: { oid: "a91957a858320c0e17f3a0eca7cfacbff50ea29a", shortOid: "a91957a8" },
      actor: Option.none(),
      status: "queued",
      conclusion: Option.none(),
      startedAt: Option.some(DateTime.makeUnsafe("2016-08-11T11:28:34.085Z")),
      updatedAt: Option.some(DateTime.makeUnsafe("2016-08-11T11:32:35.169Z")),
      durationMs: Option.none(),
      url: "https://example.com/foo/bar/pipelines/47",
    });
  });

  it("keeps the head commit's pipelines and the merged-results head pipeline", () => {
    expect(
      selectGitLabHeadPipelines(pipelines, {
        headSha: "eb94b618fb5865b26e80fdd8ae531b7a63ad851a",
        headPipelineId: 47,
      }).map((pipeline) => pipeline.id),
    ).toEqual([47, 48]);
    expect(selectGitLabHeadPipelines(pipelines, { headSha: "nope", headPipelineId: null })).toEqual(
      [],
    );
  });
});

describe("gitLabWorkflowJob", () => {
  it("folds the stage into the name; GitLab jobs have no steps", () => {
    const job = Schema.decodeUnknownSync(GitLabJobSchema)(GITLAB_JOBS[0]);
    expect(gitLabWorkflowJob(job)).toEqual({
      jobId: "6",
      name: "test / rspec:other",
      status: "completed",
      conclusion: Option.some("failure"),
      startedAt: Option.some(DateTime.makeUnsafe("2015-12-24T17:54:24.729Z")),
      completedAt: Option.some(DateTime.makeUnsafe("2015-12-24T17:54:24.921Z")),
      durationMs: Option.some(192),
      url: Option.some("https://example.com/foo/bar/-/jobs/6"),
      steps: [],
    });
  });
});

describe("gitLabCheckRollup", () => {
  it("maps commit statuses to status contexts, newest per name", () => {
    const statuses = GITLAB_COMMIT_STATUSES.map((status) =>
      Schema.decodeUnknownSync(GitLabCommitStatusSchema)(status),
    );
    const retried = { ...statuses[1]!, id: 95, status: "success" };
    expect(gitLabCheckRollup([...statuses, retried])).toEqual([
      {
        kind: "status-context",
        name: "bundler:audit",
        status: Option.some("queued"),
        conclusion: Option.none(),
        url: Option.some("https://gitlab.example.com/janedoe/gitlab-foss/builds/91"),
        startedAt: Option.some(DateTime.makeUnsafe("2016-01-19T08:40:25.934Z")),
        completedAt: Option.none(),
      },
      {
        kind: "status-context",
        name: "test",
        status: Option.some("completed"),
        conclusion: Option.some("success"),
        url: Option.some("https://gitlab.example.com/janedoe/gitlab-foss/builds/90"),
        startedAt: Option.some(DateTime.makeUnsafe("2016-01-19T08:40:25.832Z")),
        completedAt: Option.none(),
      },
    ]);
  });

  it("gives a list row its newest merge request or branch pipeline", () => {
    const mergeRequestPipeline = {
      ...pipelines[0]!,
      id: 60,
      ref: "refs/merge-requests/7/merge",
      status: "failed",
    };
    expect(
      gitLabListRowRollup([...pipelines, mergeRequestPipeline], {
        iid: 7,
        sourceBranch: "new-pipeline",
        headSha: "eb94b618fb5865b26e80fdd8ae531b7a63ad851a",
      }),
    ).toMatchObject([
      { kind: "unknown", name: "Build pipeline", conclusion: Option.some("failure") },
    ]);
    expect(
      gitLabListRowRollup(pipelines, { iid: 8, sourceBranch: "other", headSha: null }),
    ).toBeNull();
  });
});

describe("gitLabJobLogTail", () => {
  it("strips section markers and colours", () => {
    const raw =
      "section_start:1700000000:prepare_script\r\u001b[0K\u001b[36;1mPreparing\u001b[0;m\nok\r\nsection_end:1700000001:prepare_script\r\u001b[0K\n";
    expect(gitLabJobLogTail(raw)).toEqual({ log: "Preparing\nok\n\n", truncated: false });
  });

  it("keeps the end of a long log on a whole character", () => {
    // Two-byte characters with an odd cut: the tail must not start mid-character.
    const log = `${"é".repeat(SOURCE_CONTROL_WORKFLOW_LOG_MAX_BYTES)}END`;
    const tail = gitLabJobLogTail(log);
    expect(tail.truncated).toBe(true);
    expect(tail.log.endsWith("END")).toBe(true);
    expect(tail.log.startsWith("é")).toBe(true);
    expect(tail.log.includes("\uFFFD")).toBe(false);
    expect(Buffer.byteLength(tail.log, "utf8")).toBeLessThanOrEqual(
      SOURCE_CONTROL_WORKFLOW_LOG_MAX_BYTES,
    );
  });

  it("drops the partial first line of a log whose start was already cut", () => {
    // The process kept only the end of the trace: its first line starts mid-marker.
    const raw = "0:prepare_script\r\u001b[0Kpartial\nRunning tests\nFAILED: 1 test\n";
    expect(gitLabJobLogTail(raw, { startCut: true })).toEqual({
      log: "Running tests\nFAILED: 1 test\n",
      truncated: true,
    });
  });
});
