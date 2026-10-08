import type {
  SourceControlCheckRollupItem,
  SourceControlWorkflowJob,
  SourceControlWorkflowRun,
  SourceControlWorkflowStep,
} from "@ryco/contracts";
import { DateTime, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  areOverviewWorkflowRunsSupported,
  buildOverviewCheckRollupRows,
  buildOverviewWorkflowCheckRows,
  selectOverviewChecksError,
  summarizeActiveWorkflowJob,
} from "./overviewPullRequestChecks.logic";

const now = DateTime.fromDateUnsafe(new Date("2026-06-04T12:00:00.000Z"));

function workflowRun(input: Partial<SourceControlWorkflowRun>): SourceControlWorkflowRun {
  return {
    provider: "github",
    runId: "run-1",
    workflowName: "Quality",
    displayTitle: "Quality checks",
    branch: Option.some("feature/check-tooltip"),
    event: "pull_request",
    commit: {
      oid: "abcdef123456",
      shortOid: "abcdef1",
      messageHeadline: "Update overview checks",
    },
    actor: Option.some("octocat"),
    status: "completed",
    conclusion: Option.some("success"),
    startedAt: Option.some(now),
    updatedAt: Option.some(now),
    durationMs: Option.some(60_000),
    url: "https://github.com/acme/repo/actions/runs/run-1",
    ...input,
  };
}

function workflowStep(input: Partial<SourceControlWorkflowStep>): SourceControlWorkflowStep {
  return {
    number: 1,
    name: "Run command",
    status: "completed",
    conclusion: Option.some("success"),
    startedAt: Option.some(now),
    completedAt: Option.some(now),
    durationMs: Option.some(1_000),
    ...input,
  };
}

function workflowJob(input: Partial<SourceControlWorkflowJob>): SourceControlWorkflowJob {
  return {
    jobId: "job-1",
    name: "Branch Preflight",
    status: "completed",
    conclusion: Option.some("success"),
    startedAt: Option.some(now),
    completedAt: Option.some(now),
    durationMs: Option.some(10_000),
    url: Option.some("https://github.com/acme/repo/actions/runs/run-1/job/1"),
    steps: [],
    ...input,
  };
}

function checkRollup(
  input: Partial<SourceControlCheckRollupItem> & Pick<SourceControlCheckRollupItem, "name">,
): SourceControlCheckRollupItem {
  return {
    kind: "check-run",
    status: Option.some("COMPLETED"),
    conclusion: Option.some("SUCCESS"),
    url: Option.none(),
    startedAt: Option.none(),
    completedAt: Option.none(),
    ...input,
  };
}

describe("overview pull request checks", () => {
  it("only supports workflow runs after the provider resolves to GitHub", () => {
    expect(areOverviewWorkflowRunsSupported("github")).toBe(true);
    expect(areOverviewWorkflowRunsSupported(null)).toBe(false);
    expect(areOverviewWorkflowRunsSupported("gitlab")).toBe(false);
    expect(areOverviewWorkflowRunsSupported("bitbucket")).toBe(false);
    expect(areOverviewWorkflowRunsSupported("azure-devops")).toBe(false);
  });

  it("ignores workflow errors when workflow runs are unsupported", () => {
    const workflowError = new Error("Unsupported workflow runs");
    const detailError = new Error("Change request detail failed");

    expect(
      selectOverviewChecksError({
        workflowRunsSupported: false,
        workflowError,
        detailError: null,
      }),
    ).toBeNull();
    expect(
      selectOverviewChecksError({
        workflowRunsSupported: false,
        workflowError,
        detailError,
      }),
    ).toBe(detailError);
    expect(
      selectOverviewChecksError({
        workflowRunsSupported: true,
        workflowError,
        detailError,
      }),
    ).toBe(workflowError);
  });

  it("prefers workflow jobs over workflow run summaries for tooltip rows", () => {
    const run = workflowRun({ runId: "run-1", workflowName: "Release Smoke" });
    const rows = buildOverviewWorkflowCheckRows({
      runs: [run],
      jobsByRunId: new Map([
        [
          "run-1",
          [
            workflowJob({
              jobId: "job-skipped",
              name: "Branch",
              conclusion: Option.some("skipped"),
            }),
            workflowJob({
              jobId: "job-passed",
              name: "Label PR size",
              conclusion: Option.some("success"),
            }),
            workflowJob({
              jobId: "job-failed",
              name: "CodeRabbit",
              conclusion: Option.some("failure"),
            }),
          ],
        ],
      ]),
    });

    expect(rows.map((row) => [row.name, row.statusLabel])).toEqual([
      ["Branch", "Skipped"],
      ["Label PR size", "Succeeded"],
      ["CodeRabbit", "Failed"],
    ]);
    expect(rows.map((row) => row.id)).toEqual([
      "run:run-1:job:job-skipped",
      "run:run-1:job:job-passed",
      "run:run-1:job:job-failed",
    ]);
  });

  it("falls back to workflow run rows until job details are available", () => {
    const rows = buildOverviewWorkflowCheckRows({
      runs: [workflowRun({ runId: "run-1", workflowName: "Quality" })],
      jobsByRunId: new Map(),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Quality");
    expect(rows[0]?.statusLabel).toBe("Succeeded");
  });

  it("includes the notable job step in row detail and active summaries", () => {
    const job = workflowJob({
      name: "Test",
      status: "in_progress",
      conclusion: Option.none(),
      steps: [
        workflowStep({ number: 1, name: "Install", status: "completed" }),
        workflowStep({
          number: 2,
          name: "Run vitest",
          status: "in_progress",
          conclusion: Option.none(),
        }),
      ],
    });
    const rows = buildOverviewWorkflowCheckRows({
      runs: [workflowRun({ runId: "run-1", workflowName: "Quality" })],
      jobsByRunId: new Map([["run-1", [job]]]),
    });

    expect(rows[0]?.detail).toBe("Quality / Run vitest");
    expect(rows[0]?.statusLabel).toBe("Running");
    expect(summarizeActiveWorkflowJob([job])).toBe("Test / Run vitest");
  });

  it("builds tooltip rows from PR check rollup data when workflow details are absent", () => {
    const rows = buildOverviewCheckRollupRows({
      rollup: [
        checkRollup({
          name: "Branch",
          conclusion: Option.some("SKIPPED"),
        }),
        checkRollup({
          name: "Label PR size",
          workflowName: "Pull Request / Quality",
          conclusion: Option.some("SUCCESS"),
        }),
        checkRollup({
          name: "CodeRabbit",
          conclusion: Option.some("FAILURE"),
          url: Option.some("https://github.com/acme/repo/actions/runs/1/job/3"),
        }),
      ],
    });

    expect(rows.map((row) => [row.name, row.statusLabel, row.detail])).toEqual([
      ["Branch", "Skipped", undefined],
      ["Label PR size", "Succeeded", "Pull Request / Quality"],
      ["CodeRabbit", "Failed", undefined],
    ]);
    expect(rows[2]?.url).toBe("https://github.com/acme/repo/actions/runs/1/job/3");
  });

  describe("jobParam", () => {
    it("lands job rows on their job id", () => {
      const rows = buildOverviewWorkflowCheckRows({
        runs: [workflowRun({ runId: "run-1" })],
        jobsByRunId: new Map([["run-1", [workflowJob({ jobId: "4242", name: "Test" })]]]),
      });

      expect(rows[0]?.jobParam).toBe("4242");
    });

    it("leaves workflow run rows without one (they open the Checks tab)", () => {
      const rows = buildOverviewWorkflowCheckRows({
        runs: [workflowRun({ runId: "run-1" })],
        jobsByRunId: new Map(),
      });

      expect(rows[0]).not.toHaveProperty("jobParam");
    });

    it("gives rollup check runs the reader's job value", () => {
      const rows = buildOverviewCheckRollupRows({
        rollup: [
          checkRollup({
            name: "CodeRabbit",
            url: Option.some("https://github.com/acme/repo/actions/runs/1/job/3"),
          }),
          checkRollup({ name: "Test · web", workflowName: "CI" }),
          checkRollup({ name: "Lint" }),
          checkRollup({ kind: "unknown", name: "Mystery" }),
        ],
      });

      expect(rows.map((row) => row.jobParam)).toEqual(["3", "CI/Test · web", "Lint", "Mystery"]);
    });

    it("leaves status contexts without one", () => {
      const rows = buildOverviewCheckRollupRows({
        rollup: [
          checkRollup({
            kind: "status-context",
            name: "netlify/deploy-preview",
            url: Option.some("https://app.netlify.com/sites/acme/deploys/1"),
          }),
        ],
      });

      expect(rows[0]).not.toHaveProperty("jobParam");
    });
  });
});
