import { ProjectId, type StatisticsDailyBucket, type StatisticsSnapshot } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  aggregateByModel,
  aggregateCost,
  aggregateTokenCostByOrigin,
  aggregateTokenCostRows,
  buildTimeSeries,
  filterBuckets,
  previousTotals,
} from "./selectors";

const PROJECT = ProjectId.make("project-1");

function makeBucket(
  date: string,
  over: Partial<StatisticsDailyBucket> = {},
): StatisticsDailyBucket {
  return {
    date,
    projectId: PROJECT,
    model: "gpt-5.4",
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

function makeSnapshot(
  buckets: ReadonlyArray<StatisticsDailyBucket>,
  generatedAt = "2026-06-27T12:00:00.000Z",
): StatisticsSnapshot {
  return {
    generatedAt,
    projects: [],
    models: [],
    dailyBuckets: buckets,
    worktrees: { created: 0, archived: 0, active: 0, openPrs: 0 },
    recentPullRequests: [],
    // The functions under test read only generatedAt + dailyBuckets; totals is
    // required by the type but unused here.
    totals: {
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
      threads: 0,
      projects: 0,
    },
  };
}

describe("buildTimeSeries", () => {
  it("'all' keeps the most recent days, not the oldest (recency regression)", () => {
    const buckets = [
      makeBucket("2024-01-01", { inputTokens: 111 }), // far in the past
      makeBucket("2026-06-27", { inputTokens: 5 }), // today
    ];
    const snapshot = makeSnapshot(buckets);
    const series = buildTimeSeries(snapshot, buckets, "all");

    expect(series.length).toBeLessThanOrEqual(372);
    const last = series[series.length - 1];
    expect(last?.date).toBe("2026-06-27");
    expect(last?.inputTokens).toBe(5); // today's data is present
    // The >372-day-old bucket is dropped from the (capped) window.
    expect(series.some((point) => point.date === "2024-01-01")).toBe(false);
  });

  it("fills gaps across a bounded range", () => {
    const snapshot = makeSnapshot([makeBucket("2026-06-27", { turns: 3 })]);
    const series = buildTimeSeries(snapshot, snapshot.dailyBuckets, "7d");
    expect(series.length).toBe(7);
    expect(series[0]?.date).toBe("2026-06-21");
    expect(series.at(-1)?.date).toBe("2026-06-27");
    expect(series.at(-1)?.turns).toBe(3);
  });
});

describe("previousTotals", () => {
  it("sums exactly the window immediately preceding the active range", () => {
    const buckets = [
      makeBucket("2026-06-25", { inputTokens: 100 }), // current 7d window
      makeBucket("2026-06-18", { inputTokens: 50 }), // previous 7d window
      makeBucket("2026-06-10", { inputTokens: 999 }), // older, excluded
    ];
    const snapshot = makeSnapshot(buckets);
    const prev = previousTotals(snapshot, {
      range: "7d",
      projectId: null,
      model: null,
      provider: null,
    });
    expect(prev?.inputTokens).toBe(50);
  });

  it("is null for the 'all' range", () => {
    const snapshot = makeSnapshot([makeBucket("2026-06-25")]);
    expect(
      previousTotals(snapshot, {
        range: "all",
        projectId: null,
        model: null,
        provider: null,
      }),
    ).toBeNull();
  });
});

describe("filterBuckets", () => {
  it("filters by range and model", () => {
    const buckets = [
      makeBucket("2026-06-26", { model: "gpt-5.4", inputTokens: 1 }),
      makeBucket("2026-06-26", { model: "claude-opus-4-8", inputTokens: 2 }),
      makeBucket("2026-01-01", { model: "gpt-5.4", inputTokens: 9 }),
    ];
    const snapshot = makeSnapshot(buckets);
    const filtered = filterBuckets(snapshot, {
      range: "7d",
      projectId: null,
      model: "gpt-5.4",
      provider: null,
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.inputTokens).toBe(1);
  });

  it("filters by provider when a model/provider pair is selected", () => {
    const buckets = [
      makeBucket("2026-06-26", {
        model: "gpt-5.4",
        provider: "codex",
        totalTokens: 100,
      }),
      makeBucket("2026-06-26", {
        model: "gpt-5.4",
        provider: "copilot",
        totalTokens: 200,
      }),
    ];
    const snapshot = makeSnapshot(buckets);
    const filtered = filterBuckets(snapshot, {
      range: "7d",
      projectId: null,
      model: "gpt-5.4",
      provider: "copilot",
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.provider).toBe("copilot");
  });
});

describe("aggregateByModel", () => {
  it("keeps identical model slugs separate by provider and uses bucket totalTokens", () => {
    const buckets = [
      makeBucket("2026-06-26", {
        model: "gpt-5.4",
        provider: "codex",
        inputTokens: 100,
        outputTokens: 10,
        totalTokens: 110,
        costUsd: 0.0004,
      }),
      makeBucket("2026-06-26", {
        model: "gpt-5.4",
        provider: "copilot",
        inputTokens: 100,
        outputTokens: 10,
        totalTokens: 500,
        costUsd: 0.000225,
      }),
    ];

    const models = aggregateByModel(buckets);

    expect(models).toHaveLength(2);
    expect(models.map((entry) => [entry.provider, entry.totalTokens])).toEqual([
      ["copilot", 500],
      ["codex", 110],
    ]);
    expect(models[0]?.costUsd).toBeCloseTo(0.000225, 8);
    expect(models[1]?.costUsd).toBeCloseTo(0.0004, 8);
  });
});

describe("node-priced costs", () => {
  it("sums each model's bucket costs, speed buckets included", () => {
    const models = aggregateByModel([
      makeBucket("2026-06-26", {
        model: "claude-opus-5-5",
        provider: "claudeAgent",
        inputTokens: 100,
        totalTokens: 100,
        costUsd: 1,
      }),
      makeBucket("2026-06-27", {
        model: "claude-opus-5-5",
        provider: "claudeAgent",
        speed: "fast",
        inputTokens: 100,
        totalTokens: 100,
        costUsd: 2,
      }),
    ]);
    expect(models).toHaveLength(1);
    expect(models[0]?.totalTokens).toBe(200);
    expect(models[0]?.costUsd).toBe(3);
  });

  it("leaves a model unpriced when any of its usage has no price", () => {
    const models = aggregateByModel([
      makeBucket("2026-06-26", { model: "x", inputTokens: 10, totalTokens: 10, costUsd: 1 }),
      makeBucket("2026-06-27", { model: "x", inputTokens: 10, totalTokens: 10 }),
    ]);
    expect(models[0]?.costUsd).toBeNull();
  });

  it("totals priced usage and flags unpriced usage, ignoring token-less buckets", () => {
    expect(
      aggregateCost([
        makeBucket("2026-06-26", { model: "a", inputTokens: 10, totalTokens: 10, costUsd: 1.5 }),
        makeBucket("2026-06-26", { model: "b", inputTokens: 10, totalTokens: 10 }),
        makeBucket("2026-06-27", { model: "c" }),
      ]),
    ).toEqual({ usd: 1.5, hasUnpriced: true, priced: true, unpricedTokens: 10 });
    expect(aggregateCost([makeBucket("2026-06-27", { model: "c" })])).toEqual({
      usd: 0,
      hasUnpriced: false,
      priced: false,
      unpricedTokens: 0,
    });
  });
});

describe("tokens and cost by origin", () => {
  const FOLDER = ProjectId.make("folder:scratch");
  const buckets = [
    // Ryco's own turn records: tokens and turns.
    makeBucket("2026-06-26", {
      provider: "codex",
      model: "gpt-5.4",
      totalTokens: 100,
      inputTokens: 100,
      turns: 2,
      costUsd: 1,
    }),
    // Subagents of a session Ryco ran count as Ryco's.
    makeBucket("2026-06-26", {
      provider: "claudeAgent",
      model: "claude-opus-5-5",
      source: "ryco-subagent",
      totalTokens: 50,
      inputTokens: 50,
      costUsd: 2,
    }),
    // Outside Ryco, in a Ryco project and in a folder.
    makeBucket("2026-06-27", {
      provider: "claudeAgent",
      model: "claude-opus-5-5",
      source: "outside",
      totalTokens: 300,
      inputTokens: 300,
      costUsd: 4,
    }),
    makeBucket("2026-06-27", {
      projectId: FOLDER,
      provider: "codex",
      model: "gpt-5.4-unpriced",
      source: "outside",
      totalTokens: 40,
      inputTokens: 40,
    }),
    // Turns alone: no tokens, no row.
    makeBucket("2026-06-27", { provider: "cursor", model: "auto", turns: 3 }),
  ];

  it("splits Ryco's usage (subagents included) from sessions outside Ryco", () => {
    const split = aggregateTokenCostByOrigin(buckets);
    expect(split.all.totalTokens).toBe(490);
    expect(split.all.cost).toEqual({
      usd: 7,
      hasUnpriced: true,
      priced: true,
      unpricedTokens: 40,
    });
    expect(split.ryco).toEqual({
      totalTokens: 150,
      cost: { usd: 3, hasUnpriced: false, priced: true, unpricedTokens: 0 },
    });
    expect(split.outside).toEqual({
      totalTokens: 340,
      cost: { usd: 4, hasUnpriced: true, priced: true, unpricedTokens: 40 },
    });
  });

  it("breaks tokens and cost down by provider, model and project with each origin's tokens", () => {
    expect(
      aggregateTokenCostRows(buckets, "provider").map((row) => ({
        provider: row.provider,
        tokens: row.totalTokens,
        usd: row.cost.usd,
        ryco: row.rycoTokens,
        outside: row.outsideTokens,
      })),
    ).toEqual([
      { provider: "claudeAgent", tokens: 350, usd: 6, ryco: 50, outside: 300 },
      { provider: "codex", tokens: 140, usd: 1, ryco: 100, outside: 40 },
    ]);

    const models = aggregateTokenCostRows(buckets, "model");
    expect(models.map((row) => [row.provider, row.model, row.totalTokens])).toEqual([
      ["claudeAgent", "claude-opus-5-5", 350],
      ["codex", "gpt-5.4", 100],
      ["codex", "gpt-5.4-unpriced", 40],
    ]);
    expect(models[2]?.cost.unpricedTokens).toBe(40);
    expect(models[2]?.cost.priced).toBe(false);

    const projects = aggregateTokenCostRows(buckets, "project");
    expect(projects.map((row) => [row.projectId, row.rycoTokens, row.outsideTokens])).toEqual([
      [PROJECT, 150, 300],
      [FOLDER, 0, 40],
    ]);
    expect(projects.every((row) => row.provider === undefined && row.model === undefined)).toBe(
      true,
    );
  });
});
