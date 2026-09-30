import { describe, expect, it } from "vite-plus/test";

import {
  resolveOverviewRailAgents,
  resolveOverviewRailChanges,
  resolveOverviewRailChecks,
  resolveOverviewRailEnvironment,
  resolveOverviewRailPlan,
} from "./overviewRail.logic";
import type { OverviewPullRequestCheckRun } from "./overviewTypes";

function run(id: string, tone: OverviewPullRequestCheckRun["tone"]): OverviewPullRequestCheckRun {
  return { id, name: id, statusLabel: tone, statusKind: "passed", tone };
}

describe("resolveOverviewRailChecks", () => {
  it("leads with failures, then running, then pending work", () => {
    expect(
      resolveOverviewRailChecks({
        latestRuns: [run("a", "success"), run("b", "failure"), run("c", "running")],
        checksLoading: false,
      }),
    ).toEqual({ value: "1 failing", tone: "error" });
    expect(
      resolveOverviewRailChecks({
        latestRuns: [run("a", "success"), run("b", "running"), run("c", "pending")],
        checksLoading: false,
      }),
    ).toEqual({ value: "1 running", tone: "running" });
    expect(
      resolveOverviewRailChecks({
        latestRuns: [run("a", "success"), run("b", "pending")],
        checksLoading: false,
      }),
    ).toEqual({ value: "1 pending", tone: "pending" });
  });

  it("reports settled runs as passed/total and only dots a clean sweep", () => {
    expect(
      resolveOverviewRailChecks({
        latestRuns: [run("a", "success"), run("b", "success")],
        checksLoading: false,
      }),
    ).toEqual({ value: "2/2 passed", tone: "success" });
    expect(
      resolveOverviewRailChecks({
        latestRuns: [run("a", "success"), run("b", "cancelled")],
        checksLoading: false,
      }),
    ).toEqual({ value: "1/2 passed", tone: null });
  });

  it("describes errors, loading, and an empty run list", () => {
    expect(
      resolveOverviewRailChecks({
        latestRuns: [],
        checksLoading: false,
        checksError: { kind: "transient", message: "timed out", raw: "" },
      }),
    ).toEqual({ value: "Retrying", tone: "warning" });
    expect(
      resolveOverviewRailChecks({
        latestRuns: [],
        checksLoading: false,
        checksError: { kind: "terminal", message: "not found", raw: "" },
      }),
    ).toEqual({ value: "Unavailable", tone: "warning" });
    expect(resolveOverviewRailChecks({ latestRuns: [], checksLoading: true })).toEqual({
      value: "Loading…",
      tone: null,
    });
    expect(resolveOverviewRailChecks({ latestRuns: [], checksLoading: false })).toEqual({
      value: "None reported",
      tone: null,
    });
  });
});

describe("resolveOverviewRailPlan", () => {
  const plan = (statuses: ReadonlyArray<"pending" | "inProgress" | "completed">) => ({
    createdAt: "2026-09-29T00:00:00.000Z",
    turnId: null,
    steps: statuses.map((status, index) => ({ step: `Step ${index + 1}`, status })),
  });

  it("counts reached steps like the phone overview", () => {
    expect(
      resolveOverviewRailPlan({
        activePlan: plan(["completed", "completed", "inProgress", "pending", "pending"]),
        hasProposedPlan: false,
      }),
    ).toEqual({ value: "3/5", tone: "running" });
    expect(
      resolveOverviewRailPlan({
        activePlan: plan(["completed", "completed"]),
        hasProposedPlan: false,
      }),
    ).toEqual({ value: "2/2", tone: "success" });
    expect(
      resolveOverviewRailPlan({ activePlan: plan(["pending", "pending"]), hasProposedPlan: false }),
    ).toEqual({ value: "0/2", tone: null });
  });

  it("falls back to an explanation-only plan, then a proposed plan", () => {
    expect(
      resolveOverviewRailPlan({
        activePlan: { ...plan([]), explanation: "Thinking it through." },
        hasProposedPlan: false,
      }),
    ).toEqual({ value: "In progress", tone: "running" });
    expect(resolveOverviewRailPlan({ activePlan: null, hasProposedPlan: true })).toEqual({
      value: "Proposed",
      tone: "primary",
    });
    expect(resolveOverviewRailPlan({ activePlan: null, hasProposedPlan: false })).toBeNull();
  });
});

describe("resolveOverviewRailAgents", () => {
  it("prioritizes running agents, then agents that need review", () => {
    expect(resolveOverviewRailAgents([])).toBeNull();
    expect(
      resolveOverviewRailAgents([{ status: "running" }, { status: "failed" }, { status: "idle" }]),
    ).toEqual({ value: "1 running", tone: "running" });
    expect(resolveOverviewRailAgents([{ status: "failed" }, { status: "finished" }])).toEqual({
      value: "1 to review",
      tone: "error",
    });
    expect(resolveOverviewRailAgents([{ status: "finished" }])).toEqual({
      value: "1 agent",
      tone: null,
    });
  });
});

describe("resolveOverviewRailChanges", () => {
  it("dots uncommitted work only", () => {
    const base = { refName: "main", aheadCount: 0, behindCount: 0 };
    expect(
      resolveOverviewRailChanges({
        ...base,
        files: [{ path: "a.ts", insertions: 3, deletions: 1, category: "committed" }],
        insertions: 3,
        deletions: 1,
      }),
    ).toEqual({ fileCount: 1, insertions: 3, deletions: 1, tone: null });
    expect(
      resolveOverviewRailChanges({
        ...base,
        files: [
          { path: "a.ts", insertions: 3, deletions: 1, category: "committed" },
          { path: "b.ts", insertions: 2, deletions: 0, category: "local" },
        ],
        insertions: 5,
        deletions: 1,
      }).tone,
    ).toBe("primary");
    expect(resolveOverviewRailChanges(undefined)).toEqual({
      fileCount: 0,
      insertions: 0,
      deletions: 0,
      tone: null,
    });
  });
});

describe("resolveOverviewRailEnvironment", () => {
  it("surfaces an unreachable machine with its connection state", () => {
    expect(
      resolveOverviewRailEnvironment({
        unavailable: { label: "Build box", connectionState: "connecting" },
        active: null,
        hasMultipleEnvironments: false,
      }),
    ).toEqual({ label: "Build box", status: "Connecting", tone: "pending" });
    expect(
      resolveOverviewRailEnvironment({
        unavailable: { label: "Build box", connectionState: "disconnected" },
        active: null,
        hasMultipleEnvironments: true,
      }),
    ).toEqual({ label: "Build box", status: "Disconnected", tone: "warning" });
  });

  it("only shows a connected machine when it is remote or one of several", () => {
    expect(
      resolveOverviewRailEnvironment({
        unavailable: null,
        active: { label: "This Mac", isPrimary: true },
        hasMultipleEnvironments: false,
      }),
    ).toBeNull();
    expect(
      resolveOverviewRailEnvironment({
        unavailable: null,
        active: { label: "This Mac", isPrimary: true },
        hasMultipleEnvironments: true,
      }),
    ).toEqual({ label: "This Mac", status: "Connected", tone: null });
    expect(
      resolveOverviewRailEnvironment({
        unavailable: null,
        active: { label: "Build box", isPrimary: false },
        hasMultipleEnvironments: false,
      }),
    ).toEqual({ label: "Build box", status: "Connected", tone: null });
  });
});
