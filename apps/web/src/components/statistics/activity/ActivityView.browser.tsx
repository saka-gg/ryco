import "../../../index.css";
import { ProjectId, type StatisticsDailyBucket, type StatisticsSnapshot } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { parseStatisticsSearch } from "../statisticsSearch";
import { ActivityView } from "./ActivityView";

const state = vi.hoisted(() => ({
  snapshot: null as StatisticsSnapshot | null,
  error: null as string | null,
}));

vi.mock("../../settings/statistics/useStatistics", () => ({
  useStatistics: () => ({
    snapshot: state.snapshot,
    error: state.error,
    loading: false,
    refreshing: false,
    refresh: () => {},
  }),
}));

function emptySnapshot(): StatisticsSnapshot {
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    turns: 0,
    activeMs: 0,
    toolUses: 0,
    filesChanged: 0,
    additions: 0,
    deletions: 0,
    commits: 0,
    pushes: 0,
    threadsCreated: 0,
  };
  return {
    generatedAt: "2026-06-27T12:00:00.000Z",
    projects: [],
    models: [],
    dailyBuckets: [],
    worktrees: { created: 0, archived: 0, active: 0, openPrs: 0 },
    recentPullRequests: [],
    totals,
  } as unknown as StatisticsSnapshot;
}

function bucket(over: Partial<StatisticsDailyBucket>): StatisticsDailyBucket {
  return {
    date: "2026-06-27",
    projectId: ProjectId.make("project-1"),
    model: "claude-opus-5-5",
    provider: "claudeAgent",
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    turns: 0,
    activeMs: 0,
    toolUses: 0,
    filesChanged: 0,
    additions: 0,
    deletions: 0,
    commits: 0,
    pushes: 0,
    threadsCreated: 0,
    ...over,
  };
}

function machineSnapshot(machine: Partial<NonNullable<StatisticsSnapshot["machine"]>>) {
  return {
    ...emptySnapshot(),
    scope: "machine",
    projects: [
      { id: ProjectId.make("project-1"), title: "Ryco" },
      { id: ProjectId.make("folder:scratch"), title: "scratch", kind: "folder" },
    ],
    dailyBuckets: [
      bucket({ inputTokens: 100, totalTokens: 100, turns: 1, costUsd: 1 }),
      bucket({
        projectId: ProjectId.make("folder:scratch"),
        source: "outside",
        inputTokens: 300,
        totalTokens: 300,
        costUsd: 3,
      }),
    ],
    machine: {
      state: "ready",
      readAt: "2026-06-27T11:00:00.000Z",
      fileCount: 12,
      totalBytes: 2048,
      parsedFileCount: 12,
      reusedFileCount: 0,
      malformedLineCount: 0,
      failedFileCount: 0,
      unreadableDirectoryCount: 0,
      duplicateResponseCount: 0,
      rycoResponseCount: 0,
      outsideSessionCount: 3,
      ...machine,
    },
  } as unknown as StatisticsSnapshot;
}

describe("ActivityView", () => {
  it("reports a failed refresh while it keeps showing the earlier snapshot", async () => {
    state.snapshot = emptySnapshot();
    state.error = "node unavailable";
    await render(
      <ActivityView
        search={parseStatisticsSearch({ view: "activity" })}
        onSearchChange={() => {}}
      />,
    );
    await expect.element(page.getByText(/The refresh failed: node unavailable/)).toBeVisible();
    await expect.element(page.getByText("No Ryco activity yet")).toBeVisible();
  });

  it("shows no notice when the snapshot is current", async () => {
    state.snapshot = emptySnapshot();
    state.error = null;
    await render(
      <ActivityView
        search={parseStatisticsSearch({ view: "activity" })}
        onSearchChange={() => {}}
      />,
    );
    await expect.element(page.getByText("No Ryco activity yet")).toBeVisible();
    expect(page.getByText(/The refresh failed/).elements()).toHaveLength(0);
  });

  it("splits Ryco from sessions outside Ryco and shows the read in progress", async () => {
    state.snapshot = machineSnapshot({
      state: "reading",
      progress: { readFileCount: 3, fileCount: 12, readBytes: 512, totalBytes: 2048 },
    });
    state.error = null;
    await render(
      <ActivityView
        search={parseStatisticsSearch({ view: "activity", scope: "machine", range: "all" })}
        onSearchChange={() => {}}
      />,
    );
    await expect
      .element(page.getByRole("button", { name: "This machine" }))
      .toHaveAttribute("aria-pressed", "true");
    await expect
      .element(page.getByText("Reading Claude Code and Codex sessions on this machine…"))
      .toBeVisible();
    await expect.element(page.getByText("3 of 12 files · 512 B of 2.0 KB")).toBeVisible();
    await expect
      .element(page.getByRole("progressbar", { name: "Reading session files" }))
      .toHaveAttribute("aria-valuenow", "25");
    const split = page.getByRole("list", { name: "Tokens and cost by source" });
    await expect.element(split.getByText("Outside Ryco")).toBeVisible();
    await expect.element(split.getByText("75%")).toBeVisible();
    await expect.element(split.getByText("$3.00")).toBeVisible();
    await expect
      .element(page.getByText("Read 12 session files (2.0 KB) ·", { exact: false }))
      .toBeVisible();
  });

  it("lists folders outside Ryco projects in the project breakdown", async () => {
    state.snapshot = machineSnapshot({});
    state.error = null;
    await render(
      <ActivityView
        search={parseStatisticsSearch({ view: "activity", scope: "machine", range: "all" })}
        onSearchChange={() => {}}
      />,
    );
    await page.getByRole("button", { name: "project", exact: true }).click();
    const rows = page.getByRole("list", { name: "Tokens and cost by project" });
    await expect.element(rows.getByText("scratch")).toBeVisible();
    await expect.element(rows.getByText(/Folder outside Ryco projects/)).toBeVisible();
    expect(page.getByRole("progressbar").elements()).toHaveLength(0);
  });

  it("asks to update a node that answers for Ryco's threads only", async () => {
    state.snapshot = emptySnapshot();
    state.error = null;
    await render(
      <ActivityView
        search={parseStatisticsSearch({ view: "activity", scope: "machine" })}
        onSearchChange={() => {}}
      />,
    );
    await expect
      .element(page.getByText("Update Ryco on this node to include sessions outside Ryco."))
      .toBeVisible();
  });

  it("points to the setting when the node does not count sessions outside Ryco", async () => {
    state.snapshot = machineSnapshot({ state: "disabled" });
    state.error = null;
    await render(
      <ActivityView
        search={parseStatisticsSearch({ view: "activity", scope: "machine" })}
        onSearchChange={() => {}}
      />,
    );
    await expect
      .element(page.getByText("Counting sessions outside Ryco is turned off on this node."))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Open settings" })).toBeVisible();
  });
});
