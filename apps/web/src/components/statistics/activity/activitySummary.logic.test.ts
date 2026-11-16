import { describe, expect, it } from "vite-plus/test";

import type { DayPoint } from "../../settings/statistics/selectors";
import { summarizeActivity } from "./activitySummary.logic";

function day(date: string, turns: number): DayPoint {
  return {
    date,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    uncategorizedTokens: 0,
    totalTokens: 0,
    turns,
    activeMs: 0,
    filesChanged: 0,
    additions: 0,
    deletions: 0,
  };
}

describe("summarizeActivity", () => {
  it("keeps the streak through yesterday while today is still empty", () => {
    const summary = summarizeActivity(
      [day("2026-11-13", 1), day("2026-11-14", 1), day("2026-11-15", 1), day("2026-11-16", 0)],
      "turns",
    );
    expect(summary.currentStreak).toBe(3);
    expect(summary.activeDays).toBe(3);
  });

  it("counts today once it has activity", () => {
    const summary = summarizeActivity(
      [day("2026-11-14", 1), day("2026-11-15", 1), day("2026-11-16", 2)],
      "turns",
    );
    expect(summary.currentStreak).toBe(3);
  });

  it("is zero when yesterday was empty too", () => {
    const summary = summarizeActivity(
      [day("2026-11-14", 1), day("2026-11-15", 0), day("2026-11-16", 0)],
      "turns",
    );
    expect(summary.currentStreak).toBe(0);
  });

  it("stops at an older gap", () => {
    const summary = summarizeActivity(
      [day("2026-11-14", 0), day("2026-11-15", 1), day("2026-11-16", 0)],
      "turns",
    );
    expect(summary.currentStreak).toBe(1);
  });

  it("handles no days", () => {
    const summary = summarizeActivity([], "turns");
    expect(summary.currentStreak).toBe(0);
    expect(summary.busiestLabel).toBe("—");
  });
});
