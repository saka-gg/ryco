import "../../../index.css";
import type { StatisticsSnapshot } from "@ryco/contracts";
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
});
