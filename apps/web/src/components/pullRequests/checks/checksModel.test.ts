import type { SourceControlCheckRollupItem, SourceControlWorkflowJob } from "@ryco/contracts";
import { summarizeChangeRequestChecks } from "@ryco/client-runtime/state/pull-request-review";
import { Option } from "effect";
import { describe, expect, it } from "vitest";

import {
  FIXTURE_703_FAILING_JOB,
  fixtureDetail,
  fixtureWorkflowRunJobs,
  fixtureWorkflowRuns,
} from "../testing/pullRequestFixtures";
import {
  buildPullRequestChecksModel,
  checkStateOverall,
  checksJobExpansionWrites,
  checksJobMemoryKey,
  checksSummarySegments,
  formatWorkflowDuration,
  isChecksJobExpanded,
  orderByCheckGroup,
  pullRequestCheckJobParam,
  resolveChecksJobParam,
} from "./checksModel";

function modelFor(number: number, options: { readonly runs?: boolean; readonly jobs?: boolean }) {
  const detail = fixtureDetail(number);
  const runs = fixtureWorkflowRuns(number);
  const jobsByRunId = new Map<string, ReadonlyArray<SourceControlWorkflowJob>>();
  if (options.jobs !== false) {
    for (const run of runs.runs) jobsByRunId.set(run.runId, fixtureWorkflowRunJobs(run.runId).jobs);
  }
  return buildPullRequestChecksModel({
    rollup: summarizeChangeRequestChecks(detail.checkRollup),
    runs: options.runs === false ? null : runs.runs,
    jobsByRunId,
    headSha: detail.headSha ?? null,
  });
}

function check(
  name: string,
  input: { workflowName?: string; status?: string; conclusion?: string; kind?: string },
): SourceControlCheckRollupItem {
  return {
    kind: (input.kind ?? "check-run") as SourceControlCheckRollupItem["kind"],
    name,
    ...(input.workflowName ? { workflowName: input.workflowName } : {}),
    status: input.status ? Option.some(input.status) : Option.none(),
    conclusion: input.conclusion ? Option.some(input.conclusion) : Option.none(),
    url: Option.none(),
    startedAt: Option.none(),
    completedAt: Option.none(),
  };
}

describe("buildPullRequestChecksModel", () => {
  it("lists head runs only, attention first, and counts what it lists", () => {
    const model = modelFor(703, {});
    expect(model.workflows.map((workflow) => workflow.name)).toEqual(["CI", "Release dry run"]);
    // The older CI run on the previous head is not listed.
    expect(model.workflows.every((workflow) => workflow.run?.commit.shortOid === "8e5d1c6")).toBe(
      true,
    );
    const ci = model.workflows[0]!;
    expect(ci.state).toBe("failure");
    expect(ci.jobs[0]?.name).toBe(FIXTURE_703_FAILING_JOB.name);
    expect(ci.jobs[0]?.failingStep?.name).toBe("bun run test --filter=@ryco/web");
    expect(ci.jobs.map((job) => job.name)).toEqual([
      "Test · web",
      "Format & lint",
      "Typecheck",
      "Test · server",
      "Browser · web",
      "Build",
    ]);
    expect(model.statuses.map((status) => status.check.name)).toEqual(["Vercel – ryco-web"]);
    expect(model.sections.map((section) => section.key)).toEqual([
      "CI#0",
      "Release dry run#0",
      "statuses",
    ]);
    expect(model.counts).toEqual({
      failing: 1,
      actionRequired: 0,
      running: 0,
      passed: 8,
      skipped: 0,
      total: 9,
    });
    expect(model.overall).toBe("failing");
    expect(model.rerunnableRunIds).toEqual([FIXTURE_703_FAILING_JOB.runId]);
    expect(model.live).toBe(false);
  });

  it("paints from the rollup before runs and jobs load, with the same rows and counts", () => {
    const loaded = modelFor(703, {});
    for (const options of [{ runs: false }, { jobs: false }]) {
      const early = modelFor(703, options);
      expect(early.sections.map((section) => section.key)).toEqual(
        loaded.sections.map((section) => section.key),
      );
      expect(early.workflows.map((workflow) => workflow.jobs.map((job) => job.key))).toEqual(
        loaded.workflows.map((workflow) => workflow.jobs.map((job) => job.key)),
      );
      expect(early.counts).toEqual(loaded.counts);
      expect(early.workflows.every((workflow) => !workflow.jobsLoaded)).toBe(true);
    }
  });

  it("keeps running checks live and out of the re-run set", () => {
    const model = modelFor(702, {});
    expect(model.live).toBe(true);
    expect(model.overall).toBe("pending");
    expect(model.counts.running).toBe(4);
    expect(model.rerunnableRunIds).toEqual([]);
    expect(model.workflows[0]?.group).toBe("running");
  });

  it("orders the status list among workflows by its worst check", () => {
    const model = buildPullRequestChecksModel({
      rollup: summarizeChangeRequestChecks([
        check("build", { workflowName: "CI", conclusion: "success" }),
        check("deploy", { kind: "status-context", status: "failure" }),
        check("docs", { kind: "status-context", status: "success" }),
      ]),
      runs: null,
      jobsByRunId: new Map(),
      headSha: null,
    });
    expect(model.sections.map((section) => section.key)).toEqual(["statuses", "CI#0"]);
    expect(model.statuses.map((status) => status.check.name)).toEqual(["deploy", "docs"]);
  });

  it("lists checks without a workflow as statuses and groups the rest by workflow", () => {
    const model = buildPullRequestChecksModel({
      rollup: summarizeChangeRequestChecks([
        check("codecov/patch", { conclusion: "success" }),
        check("lint", { workflowName: "Lint", conclusion: "success" }),
      ]),
      runs: [],
      jobsByRunId: new Map(),
      headSha: "abc",
    });
    // A run list that lags the rollup still shows the workflow, without steps.
    expect(model.workflows.map((workflow) => [workflow.key, workflow.jobsLoaded])).toEqual([
      ["Lint#0", false],
    ]);
    expect(model.statuses.map((status) => status.check.name)).toEqual(["codecov/patch"]);
    expect(model.counts.total).toBe(2);
  });

  it("reports no checks for an empty rollup", () => {
    const model = buildPullRequestChecksModel({
      rollup: summarizeChangeRequestChecks([]),
      runs: [],
      jobsByRunId: new Map(),
      headSha: null,
    });
    expect(model.overall).toBe("none");
    expect(model.sections).toEqual([]);
    expect(checksSummarySegments(model.counts)).toEqual([]);
  });
});

describe("checksSummarySegments", () => {
  it("reads failing · passed · running, leaving zero counts out", () => {
    const segments = checksSummarySegments({
      failing: 1,
      actionRequired: 0,
      running: 1,
      passed: 8,
      skipped: 2,
      total: 12,
    });
    expect(segments.map((segment) => `${segment.count} ${segment.label}`)).toEqual([
      "1 failing",
      "8 passed",
      "1 running",
      "2 skipped",
    ]);
    expect(segments[0]?.tone).toBe("destructive");
  });
});

describe("orderByCheckGroup", () => {
  it("is stable within a group", () => {
    const ordered = orderByCheckGroup([
      { id: "a", group: "completed" as const },
      { id: "b", group: "attention" as const },
      { id: "c", group: "completed" as const },
      { id: "d", group: "skipped" as const },
      { id: "e", group: "running" as const },
      { id: "f", group: "attention" as const },
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(["b", "f", "e", "a", "c", "d"]);
  });
});

describe("job deep links", () => {
  const model = modelFor(703, {});

  it("resolves a job id, workflow/name, or bare name", () => {
    const expected = { workflowKey: "CI#0", jobKey: "Test · web" };
    expect(resolveChecksJobParam(model, FIXTURE_703_FAILING_JOB.jobId)).toEqual(expected);
    expect(resolveChecksJobParam(model, "CI/Test · web")).toEqual(expected);
    expect(resolveChecksJobParam(model, "Test · web")).toEqual(expected);
    expect(resolveChecksJobParam(model, "nope")).toBeNull();
    expect(resolveChecksJobParam(model, undefined)).toBeNull();
  });

  it("resolves a job id from the rollup's link before the jobs load", () => {
    const early = modelFor(703, { jobs: false });
    expect(resolveChecksJobParam(early, FIXTURE_703_FAILING_JOB.jobId)).toEqual({
      workflowKey: "CI#0",
      jobKey: "Test · web",
    });
  });

  it("builds the param from a rollup check", () => {
    const failing = summarizeChangeRequestChecks(fixtureDetail(703).checkRollup).failing[0]!;
    expect(pullRequestCheckJobParam(failing)).toBe(FIXTURE_703_FAILING_JOB.jobId);
    expect(pullRequestCheckJobParam({ name: "lint", workflowName: "CI", url: null })).toBe(
      "CI/lint",
    );
    expect(
      pullRequestCheckJobParam({
        name: "lint",
        workflowName: "CI",
        url: "https://github.com/o/r/actions/runs/1/jobs/42",
      }),
    ).toBe("42");
  });
});

describe("job expansion memory", () => {
  const model = modelFor(703, {});
  const ci = model.workflows[0]!;
  const failing = ci.jobs[0]!;
  const passing = ci.jobs[1]!;

  it("keys rows by workflow and job, stable across the rollup → jobs hand-off", () => {
    const early = modelFor(703, { jobs: false });
    expect(checksJobMemoryKey(ci, failing)).toBe("CI#0/Test · web");
    expect(checksJobMemoryKey(early.workflows[0]!, early.workflows[0]!.jobs[0]!)).toBe(
      checksJobMemoryKey(ci, failing),
    );
  });

  it("opens failing jobs until the reader collapses them", () => {
    const failingKey = checksJobMemoryKey(ci, failing);
    const passingKey = checksJobMemoryKey(ci, passing);
    expect(isChecksJobExpanded([], failingKey, true)).toBe(true);
    expect(isChecksJobExpanded([], passingKey, false)).toBe(false);

    const apply = (memory: ReadonlyArray<string>, key: string, open: boolean, auto: boolean) => {
      let next = [...memory];
      for (const write of checksJobExpansionWrites(key, open, auto)) {
        next = next.filter((id) => id !== write.id);
        if (write.expanded) next.push(write.id);
      }
      return next;
    };
    const collapsed = apply([], failingKey, false, true);
    expect(isChecksJobExpanded(collapsed, failingKey, true)).toBe(false);
    const reopened = apply(collapsed, failingKey, true, true);
    expect(isChecksJobExpanded(reopened, failingKey, true)).toBe(true);
    // Opened by hand, it stays open after the job stops failing.
    expect(isChecksJobExpanded(reopened, failingKey, false)).toBe(true);
    expect(apply([], passingKey, false, false)).toEqual([]);
  });
});

describe("checkStateOverall", () => {
  it("maps job states onto the four-way glyph", () => {
    expect(checkStateOverall("failure")).toBe("failing");
    expect(checkStateOverall("cancelled")).toBe("failing");
    expect(checkStateOverall("running")).toBe("pending");
    expect(checkStateOverall("pending")).toBe("none");
    expect(checkStateOverall("neutral")).toBe("passing");
    expect(checkStateOverall("skipped")).toBe("none");
  });
});

describe("formatWorkflowDuration", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatWorkflowDuration(null)).toBeNull();
    expect(formatWorkflowDuration(48_000)).toBe("48s");
    expect(formatWorkflowDuration(131_000)).toBe("2m 11s");
    expect(formatWorkflowDuration(120_000)).toBe("2m");
    expect(formatWorkflowDuration(3_840_000)).toBe("1h 4m");
  });
});
