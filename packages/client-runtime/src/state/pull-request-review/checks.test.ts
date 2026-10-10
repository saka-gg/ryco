import type { SourceControlCheckRollupItem } from "@ryco/contracts";
import { DateTime, Option } from "effect";
import { describe, expect, it } from "vitest";

import {
  classifyCheckState,
  pullRequestCheckJobParam,
  summarizeChangeRequestChecks,
  workflowJobIdFromUrl,
} from "./checks.ts";

function check(
  name: string,
  input: {
    readonly workflowName?: string;
    readonly status?: string;
    readonly conclusion?: string;
    readonly startedAt?: string;
    readonly completedAt?: string;
    readonly url?: string;
    readonly isRequired?: boolean;
  } = {},
): SourceControlCheckRollupItem {
  return {
    kind: "check-run",
    name,
    ...(input.workflowName ? { workflowName: input.workflowName } : {}),
    status: input.status ? Option.some(input.status) : Option.none(),
    conclusion: input.conclusion ? Option.some(input.conclusion) : Option.none(),
    url: input.url ? Option.some(input.url) : Option.none(),
    startedAt: input.startedAt ? Option.some(DateTime.makeUnsafe(input.startedAt)) : Option.none(),
    completedAt: input.completedAt
      ? Option.some(DateTime.makeUnsafe(input.completedAt))
      : Option.none(),
    ...(input.isRequired !== undefined ? { isRequired: input.isRequired } : {}),
  };
}

describe("workflowJobIdFromUrl", () => {
  it("reads GitHub Actions and GitLab CI job links only", () => {
    expect(
      workflowJobIdFromUrl("https://github.com/o/r/actions/runs/18214433871/job/52004433871"),
    ).toBe("52004433871");
    expect(workflowJobIdFromUrl("https://gitlab.example.com/group/project/-/jobs/91")).toBe("91");
    expect(workflowJobIdFromUrl("https://gitlab.example.com/group/project/-/jobs/91/raw")).toBe(
      "91",
    );
    expect(workflowJobIdFromUrl("https://gitlab.example.com/group/project/-/pipelines/47")).toBe(
      null,
    );
    expect(workflowJobIdFromUrl("https://ci.example.com/job/build/12")).toBe(null);
    expect(workflowJobIdFromUrl(null)).toBe(null);
  });
});

describe("pullRequestCheckJobParam", () => {
  it("prefers the host's job id, then workflow/name, then the bare name", () => {
    expect(
      pullRequestCheckJobParam({
        name: "lint",
        workflowName: "CI",
        url: "https://github.com/o/r/actions/runs/1/jobs/42",
      }),
    ).toBe("42");
    expect(
      pullRequestCheckJobParam({
        name: "lint",
        workflowName: "CI",
        url: "https://gitlab.example.com/group/project/-/jobs/91",
      }),
    ).toBe("91");
    expect(pullRequestCheckJobParam({ name: "lint", workflowName: "CI", url: null })).toBe(
      "CI/lint",
    );
    expect(
      pullRequestCheckJobParam({
        name: "lint",
        workflowName: "CI",
        url: "https://ci.example.com/job/build/12",
      }),
    ).toBe("CI/lint");
    expect(pullRequestCheckJobParam({ name: "ci/circleci", workflowName: null, url: null })).toBe(
      "ci/circleci",
    );
  });

  it("builds the param from a summarized rollup check", () => {
    const summary = summarizeChangeRequestChecks([
      check("test", {
        workflowName: "CI",
        conclusion: "FAILURE",
        url: "https://github.com/o/r/actions/runs/7/job/99",
      }),
    ]);
    expect(pullRequestCheckJobParam(summary.failing[0]!)).toBe("99");
  });
});

describe("classifyCheckState", () => {
  it("prefers the conclusion and normalizes host tokens", () => {
    expect(classifyCheckState({ status: "COMPLETED", conclusion: "SUCCESS" })).toBe("success");
    expect(classifyCheckState({ status: "COMPLETED", conclusion: "TIMED_OUT" })).toBe("failure");
    expect(classifyCheckState({ status: "COMPLETED", conclusion: "ACTION_REQUIRED" })).toBe(
      "action-required",
    );
    expect(classifyCheckState({ status: "COMPLETED", conclusion: "STALE" })).toBe("cancelled");
    expect(classifyCheckState({ status: "COMPLETED", conclusion: "SKIPPED" })).toBe("skipped");
    expect(classifyCheckState({ status: "IN_PROGRESS" })).toBe("running");
    expect(classifyCheckState({ status: "QUEUED" })).toBe("pending");
    expect(classifyCheckState({ status: "EXPECTED" })).toBe("pending");
    expect(classifyCheckState({ status: "error" })).toBe("failure");
    expect(classifyCheckState({ status: "COMPLETED" })).toBe("unknown");
  });
});

describe("summarizeChangeRequestChecks", () => {
  it("reports no checks for a missing or empty rollup", () => {
    for (const rollup of [undefined, null, []]) {
      const summary = summarizeChangeRequestChecks(rollup);
      expect(summary.overall).toBe("none");
      expect(summary.segments).toEqual([]);
      expect(summary.description).toBe("No checks reported");
    }
  });

  it("collapses re-runs onto the newest run while keeping the first run's position", () => {
    const summary = summarizeChangeRequestChecks([
      check("lint", {
        workflowName: "CI",
        conclusion: "failure",
        startedAt: "2026-01-01T10:00:00Z",
      }),
      check("build", { workflowName: "CI", conclusion: "success" }),
      check("lint", {
        workflowName: "CI",
        status: "in_progress",
        startedAt: "2026-01-01T11:00:00Z",
      }),
    ]);

    expect(summary.checks.map((entry) => [entry.name, entry.state, entry.supersededRuns])).toEqual([
      ["lint", "running", 1],
      ["build", "success", 0],
    ]);
    expect(summary.overall).toBe("pending");
  });

  it("lets a later listed run win a timestamp tie and keeps a dated run over an undated one", () => {
    const tie = summarizeChangeRequestChecks([
      check("test", { conclusion: "failure", startedAt: "2026-01-01T10:00:00Z" }),
      check("test", { conclusion: "success", startedAt: "2026-01-01T10:00:00Z" }),
    ]);
    expect(tie.checks[0]?.state).toBe("success");

    const undated = summarizeChangeRequestChecks([
      check("test", { conclusion: "failure", startedAt: "2026-01-01T10:00:00Z" }),
      check("test", { conclusion: "success" }),
    ]);
    expect(undated.checks[0]?.state).toBe("failure");
  });

  it("labels same-named checks from different workflows as workflow / name", () => {
    const summary = summarizeChangeRequestChecks([
      check("test", { workflowName: "Unit", conclusion: "success" }),
      check("test", { workflowName: "E2E", conclusion: "success" }),
      check("lint", { workflowName: "CI", conclusion: "success" }),
    ]);
    expect(summary.checks.map((entry) => entry.label)).toEqual([
      "Unit / test",
      "E2E / test",
      "lint",
    ]);
    expect(new Set(summary.checks.map((entry) => entry.id)).size).toBe(3);
  });

  it("groups checks and counts donut segments in display order", () => {
    const summary = summarizeChangeRequestChecks([
      check("a", { conclusion: "success" }),
      check("b", { conclusion: "skipped" }),
      check("c", { status: "queued" }),
      check("d", { conclusion: "failure", url: "https://ci.test/d" }),
      check("e", { conclusion: "neutral" }),
    ]);

    expect(summary.groups.attention.map((entry) => entry.name)).toEqual(["d"]);
    expect(summary.groups.running.map((entry) => entry.name)).toEqual(["c"]);
    expect(summary.groups.completed.map((entry) => entry.name)).toEqual(["a", "e"]);
    expect(summary.groups.skipped.map((entry) => entry.name)).toEqual(["b"]);
    expect(summary.segments).toEqual([
      { group: "attention", count: 1 },
      { group: "running", count: 1 },
      { group: "completed", count: 2 },
      { group: "skipped", count: 1 },
    ]);
    expect(summary.overall).toBe("failing");
    expect(summary.failing[0]?.url).toBe("https://ci.test/d");
    expect(summary.description).toBe("1 of 5 running · 1 failed");
  });

  it("describes all-green and partially failing rollups", () => {
    expect(
      summarizeChangeRequestChecks([
        check("a", { conclusion: "success" }),
        check("b", { conclusion: "skipped" }),
      ]).description,
    ).toBe("All checks passed");
    const failing = summarizeChangeRequestChecks([
      check("a", { conclusion: "success" }),
      check("b", { conclusion: "cancelled" }),
    ]);
    expect(failing.description).toBe("1 of 2 failing");
    expect(failing.overall).toBe("failing");
  });

  it("counts required checks and lists required failures first", () => {
    const summary = summarizeChangeRequestChecks([
      check("lint", { conclusion: "failure", isRequired: false }),
      check("e2e", { conclusion: "failure" }),
      check("typecheck", { conclusion: "failure", isRequired: true }),
      check("build", { conclusion: "success", isRequired: true }),
      check("deploy", { status: "in_progress", isRequired: true }),
    ]);
    expect(summary.requiredKnown).toBe(true);
    expect(summary.counts.required).toBe(3);
    expect(summary.checks.map((entry) => entry.required)).toEqual([false, null, true, true, true]);
    expect(summary.failing.map((entry) => entry.name)).toEqual(["typecheck", "lint", "e2e"]);
    expect(summary.failingRequired.map((entry) => entry.name)).toEqual(["typecheck"]);
    // A check the host said nothing about is neither required nor optional.
    expect(summary.failingOptional.map((entry) => entry.name)).toEqual(["lint"]);
    // The host's order stays in the groups.
    expect(summary.groups.attention.map((entry) => entry.name)).toEqual([
      "lint",
      "e2e",
      "typecheck",
    ]);
  });

  it("reports required-ness as unknown when the host did not say", () => {
    const summary = summarizeChangeRequestChecks([check("lint", { conclusion: "failure" })]);
    expect(summary.requiredKnown).toBe(false);
    expect(summary.counts.required).toBe(0);
    expect(summary.checks[0]?.required).toBeNull();
    expect(summary.failingRequired).toEqual([]);
    expect(summary.failingOptional).toEqual([]);
  });

  it("keeps a check's required-ness across a re-run the host has not marked yet", () => {
    const summary = summarizeChangeRequestChecks([
      check("test", {
        conclusion: "failure",
        startedAt: "2026-01-01T10:00:00Z",
        isRequired: true,
      }),
      check("test", { status: "in_progress", startedAt: "2026-01-01T11:00:00Z" }),
    ]);
    expect(summary.checks.map((entry) => [entry.state, entry.required])).toEqual([
      ["running", true],
    ]);
  });

  it("computes durations only for finished checks", () => {
    const summary = summarizeChangeRequestChecks([
      check("done", {
        conclusion: "success",
        startedAt: "2026-01-01T10:00:00Z",
        completedAt: "2026-01-01T10:01:30Z",
      }),
      check("live", { status: "in_progress", startedAt: "2026-01-01T10:00:00Z" }),
    ]);
    expect(summary.checks.map((entry) => entry.durationMs)).toEqual([90_000, null]);
  });
});
