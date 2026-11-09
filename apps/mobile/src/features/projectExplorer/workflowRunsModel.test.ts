import type {
  SourceControlWorkflowJob,
  SourceControlWorkflowRun,
  SourceControlWorkflowStep,
} from "@ryco/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";

import {
  buildWorkflowRerunInput,
  canRerunFailedJobs,
  deriveWorkflowLog,
  findWorkflowRun,
  isWorkflowRunActive,
  workflowJobRows,
  workflowRerunNotice,
  workflowRerunTargetKey,
  workflowRunRow,
  workflowRunRows,
  workflowState,
} from "./workflowRunsModel";

function at(iso: string) {
  return Option.some(DateTime.makeUnsafe(iso));
}

function run(runId: string, extra?: Partial<SourceControlWorkflowRun>): SourceControlWorkflowRun {
  return {
    provider: "github",
    runId,
    workflowName: "CI",
    branch: Option.some("main"),
    commit: { oid: "abcdef1234", shortOid: "abcdef1" },
    actor: Option.some("alice"),
    status: "completed",
    conclusion: Option.some("success"),
    startedAt: at("2026-11-01T10:00:00Z"),
    updatedAt: at("2026-11-01T10:05:00Z"),
    durationMs: Option.some(131_000),
    url: `https://github.com/acme/app/actions/runs/${runId}`,
    ...extra,
  } as SourceControlWorkflowRun;
}

function step(number: number, conclusion: string): SourceControlWorkflowStep {
  return {
    number,
    name: `Step ${number}`,
    status: "completed",
    conclusion: Option.some(conclusion),
    startedAt: Option.none(),
    completedAt: Option.none(),
    durationMs: Option.some(4_000),
  } as SourceControlWorkflowStep;
}

function job(jobId: string, status: string, conclusion: string | null): SourceControlWorkflowJob {
  return {
    jobId,
    name: `Job ${jobId}`,
    status,
    conclusion: conclusion === null ? Option.none() : Option.some(conclusion),
    startedAt: Option.none(),
    completedAt: Option.none(),
    durationMs: Option.none(),
    url: Option.none(),
    steps: [step(1, "success"), step(2, conclusion ?? "success")],
  } as SourceControlWorkflowJob;
}

describe("workflowState", () => {
  it("lets the conclusion decide once there is one", () => {
    expect(workflowState({ status: "completed", conclusion: Option.some("failure") })).toEqual({
      state: "failure",
      overall: "failing",
      label: "Failed",
    });
    expect(workflowState({ status: "in_progress", conclusion: Option.none() })).toEqual({
      state: "running",
      overall: "pending",
      label: "Running",
    });
    expect(workflowState({ status: "queued", conclusion: Option.none() }).label).toBe("Queued");
  });
});

describe("run rows", () => {
  it("shows what the run ran on and how long it took", () => {
    expect(workflowRunRow(run("1", { displayTitle: "Fix login", event: "push" }))).toMatchObject({
      runId: "1",
      title: "Fix login",
      branch: "main",
      shortSha: "abcdef1",
      actor: "alice",
      event: "push",
      duration: "2m 11s",
      atMs: DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-01T10:05:00Z")),
    });
  });

  it("drops a title that only repeats the workflow", () => {
    expect(workflowRunRow(run("1", { displayTitle: "CI" })).title).toBeNull();
  });

  it("lists the newest first", () => {
    const rows = workflowRunRows([
      run("old", { updatedAt: at("2026-11-01T09:00:00Z") }),
      run("new", { updatedAt: at("2026-11-01T11:00:00Z") }),
    ]);
    expect(rows.map((row) => row.runId)).toEqual(["new", "old"]);
  });

  it("finds a run among those read", () => {
    expect(findWorkflowRun([run("1"), run("2")], "2")?.runId).toBe("2");
    expect(findWorkflowRun(null, "2")).toBeNull();
  });
});

describe("jobs and re-runs", () => {
  it("puts failed jobs first and offers each a re-run once it finished", () => {
    const rows = workflowJobRows([
      job("a", "completed", "success"),
      job("b", "completed", "failure"),
      job("c", "in_progress", null),
    ]);
    expect(rows.map((row) => [row.jobId, row.canRerun])).toEqual([
      ["b", true],
      ["a", false],
      ["c", false],
    ]);
    expect(rows[0]?.steps.map((entry) => entry.status.label)).toEqual(["Passed", "Failed"]);
  });

  it("offers re-running failed jobs only for a finished, failed run", () => {
    expect(canRerunFailedJobs(run("1", { conclusion: Option.some("failure") }))).toBe(true);
    expect(canRerunFailedJobs(run("1"))).toBe(false);
    expect(canRerunFailedJobs(run("1", { status: "in_progress", conclusion: Option.none() }))).toBe(
      false,
    );
    expect(canRerunFailedJobs(null)).toBe(false);
  });

  it("builds the re-run request for the failed jobs or one job", () => {
    expect(buildWorkflowRerunInput("/w", "9", { target: "failed-jobs" })).toEqual({
      cwd: "/w",
      runId: "9",
      target: "failed-jobs",
    });
    const one = { target: "job", jobId: "j1", jobName: "build" } as const;
    expect(buildWorkflowRerunInput("/w", "9", one)).toEqual({
      cwd: "/w",
      runId: "9",
      target: "job",
      jobId: "j1",
    });
    expect(workflowRerunTargetKey(one)).toBe("job:j1");
    expect(workflowRerunNotice(one)).toBe("Re-run requested for build.");
  });

  it("knows a run is still moving while it or a job is unfinished", () => {
    expect(isWorkflowRunActive(run("1"), [job("a", "completed", "success")])).toBe(false);
    expect(isWorkflowRunActive(run("1"), [job("a", "queued", null)])).toBe(true);
    expect(isWorkflowRunActive(run("1", { status: "in_progress" }), null)).toBe(true);
    expect(isWorkflowRunActive(null, null)).toBe(false);
  });
});

describe("deriveWorkflowLog", () => {
  it("drops timestamps and group ends, and marks groups and errors", () => {
    const view = deriveWorkflowLog({
      provider: "github",
      runId: "9",
      jobId: "j1",
      truncated: true,
      log: [
        "2026-11-01T10:00:00.1234567Z ##[group]Run bun install",
        "2026-11-01T10:00:01.0000000Z bun install v1.3",
        "2026-11-01T10:00:02.0000000Z ##[endgroup]",
        "2026-11-01T10:00:03.0000000Z ##[error]Process completed with exit code 1.",
        "",
      ].join("\n"),
    });
    expect(view.lines.map((line) => [line.tone, line.text])).toEqual([
      ["group", "Run bun install"],
      ["plain", "bun install v1.3"],
      ["error", "Process completed with exit code 1."],
    ]);
    expect(view.firstErrorIndex).toBe(2);
    expect(view.truncated).toBe(true);
  });

  it("has no error to jump to in a clean log", () => {
    expect(
      deriveWorkflowLog({
        provider: "github",
        runId: "9",
        jobId: "j1",
        truncated: false,
        log: "ok",
      }).firstErrorIndex,
    ).toBeNull();
  });
});
