import { describe, expect, it } from "vite-plus/test";

import { parseStatisticsSearch } from "./statisticsSearch";

describe("parseStatisticsSearch", () => {
  it("uses the approved usage defaults", () => {
    expect(parseStatisticsSearch({})).toEqual({
      view: "usage",
      range: "30d",
      usageMetric: "cost",
      usageBreakdown: "model",
      activityMetric: "turns",
    });
  });

  it("canonicalizes arrays and drops invalid enum values", () => {
    expect(
      parseStatisticsSearch({
        view: "invalid",
        range: "90d",
        environmentIds: ["z", "a", "z", ""],
        providers: ["codex", "unknown", "claude", "codex"],
        usageMetric: "tokens",
      }),
    ).toMatchObject({
      view: "usage",
      range: "90d",
      environmentIds: ["a", "z"],
      providers: ["claude", "codex"],
      usageMetric: "tokens",
    });
  });

  it("preserves inactive-view filters", () => {
    expect(
      parseStatisticsSearch({
        view: "activity",
        projectId: " project-a ",
        model: "gpt-5",
        modelProvider: "codex",
        usageBreakdown: "day",
      }),
    ).toMatchObject({
      view: "activity",
      projectId: "project-a",
      model: "gpt-5",
      modelProvider: "codex",
      usageBreakdown: "day",
    });
  });
});

it("preserves useful native history and export provider filters", () => {
  expect(
    parseStatisticsSearch({ providers: ["cursor", "opencode", "cursor", "unknown"] }).providers,
  ).toEqual(["cursor", "opencode"]);
});
