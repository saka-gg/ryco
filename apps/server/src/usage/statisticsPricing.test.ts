import { ProjectId, type StatisticsDailyBucket, type StatisticsSnapshot } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  priceStatisticsBucket,
  priceStatisticsSnapshot,
  statisticsBucketTokenCounts,
} from "./statisticsPricing.ts";
import {
  compileUsagePriceOverrides,
  makeUsagePricingPolicy,
  parseUsageRateTable,
} from "./usagePricing.ts";

const M = 1e-6;
/** LiteLLM-shaped rates: Opus with a 2x fast tier, a GPT with a priority tier. */
const rates = parseUsageRateTable({
  "claude-opus-5-5": {
    input_cost_per_token: 4 * M,
    output_cost_per_token: 20 * M,
    cache_read_input_token_cost: 0.2 * M,
    cache_creation_input_token_cost: 5 * M,
    provider_specific_entry: { fast: 2 },
  },
  "gpt-5.6-sol": {
    input_cost_per_token: 4 * M,
    output_cost_per_token: 20 * M,
    cache_read_input_token_cost: 0.4 * M,
    input_cost_per_token_priority: 8 * M,
    output_cost_per_token_priority: 40 * M,
    cache_read_input_token_cost_priority: 0.8 * M,
  },
});
const policy = () => makeUsagePricingPolicy(rates);

function bucket(over: Partial<StatisticsDailyBucket>): StatisticsDailyBucket {
  return {
    date: "2026-11-09",
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

describe("statisticsBucketTokenCounts", () => {
  it("splits cache reads and writes out of input", () => {
    expect(
      statisticsBucketTokenCounts(
        bucket({
          inputTokens: 1_000,
          cachedInputTokens: 700,
          cacheWriteInputTokens: 200,
          outputTokens: 50,
          totalTokens: 1_050,
        }),
      ),
    ).toEqual({
      uncachedInputTokens: 100,
      cachedInputTokens: 700,
      cacheCreationInputTokens: 200,
      outputTokens: 50,
    });
  });

  it("bills legacy cached reads stored beside input", () => {
    expect(
      statisticsBucketTokenCounts(
        bucket({ inputTokens: 100, cachedInputTokens: 400, outputTokens: 10, totalTokens: 510 }),
      ),
    ).toEqual({
      uncachedInputTokens: 100,
      cachedInputTokens: 400,
      cacheCreationInputTokens: 0,
      outputTokens: 10,
    });
    expect(
      statisticsBucketTokenCounts(
        bucket({ inputTokens: 500, cachedInputTokens: 400, outputTokens: 10, totalTokens: 910 }),
      ),
    ).toEqual({
      uncachedInputTokens: 500,
      cachedInputTokens: 400,
      cacheCreationInputTokens: 0,
      outputTokens: 10,
    });
  });

  it("prices only the split beside an unrelated, larger total", () => {
    expect(
      statisticsBucketTokenCounts(
        bucket({ inputTokens: 100, cachedInputTokens: 80, outputTokens: 10, totalTokens: 1_100 }),
      ),
    ).toEqual({
      uncachedInputTokens: 20,
      cachedInputTokens: 80,
      cacheCreationInputTokens: 0,
      outputTokens: 10,
    });
  });

  it("cannot price a total without a split", () => {
    expect(statisticsBucketTokenCounts(bucket({ totalTokens: 500 }))).toBeUndefined();
  });
});

describe("priceStatisticsBucket", () => {
  const usage = {
    inputTokens: 1_000_000,
    cachedInputTokens: 600_000,
    cacheWriteInputTokens: 300_000,
    outputTokens: 100_000,
    totalTokens: 1_100_000,
  };
  // 0.1M uncached × 4 + 0.6M reads × 0.2 + 0.3M writes × 5 + 0.1M output × 20
  const standard = 0.4 + 0.12 + 1.5 + 2;

  it("prices cache writes at the write rate", () => {
    expect(priceStatisticsBucket(policy(), bucket(usage))).toBeCloseTo(standard, 9);
  });

  it("prices fast and priority usage at the speed tier", () => {
    expect(priceStatisticsBucket(policy(), bucket({ ...usage, speed: "fast" }))).toBeCloseTo(
      standard * 2,
      9,
    );
    const sol = { model: "gpt-5.6-sol", provider: "codex", cacheWriteInputTokens: 0 };
    expect(priceStatisticsBucket(policy(), bucket({ ...usage, ...sol }))).toBeCloseTo(
      0.4 * 4 + 0.6 * 0.4 + 0.1 * 20,
      9,
    );
    expect(
      priceStatisticsBucket(policy(), bucket({ ...usage, ...sol, speed: "fast" })),
    ).toBeCloseTo(0.4 * 8 + 0.6 * 0.8 + 0.1 * 40, 9);
  });

  it("prices a context variant as its base model", () => {
    const opus = { ...usage, cacheWriteInputTokens: 0 };
    const expected = priceStatisticsBucket(policy(), bucket(opus));
    expect(priceStatisticsBucket(policy(), bucket({ ...opus, model: "claude-opus-5-5[1m]" }))).toBe(
      expected,
    );
  });

  it("uses the node's custom prices", () => {
    const custom = makeUsagePricingPolicy(
      rates,
      compileUsagePriceOverrides({
        "my-model": { price: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } },
      }),
    );
    expect(
      priceStatisticsBucket(
        custom,
        bucket({ model: "my-model", inputTokens: 1_000_000, outputTokens: 1_000_000 }),
      ),
    ).toBeCloseTo(3, 9);
  });

  it("leaves unknown models and token-less buckets unpriced", () => {
    expect(priceStatisticsBucket(policy(), bucket({ ...usage, model: "nope" }))).toBeUndefined();
    expect(priceStatisticsBucket(policy(), bucket({ turns: 3 }))).toBeUndefined();
  });
});

describe("priceStatisticsSnapshot", () => {
  it("prices every bucket and reports the rates' state", () => {
    const snapshot = {
      generatedAt: "2026-11-09T00:00:00.000Z",
      projects: [],
      models: [],
      dailyBuckets: [
        bucket({ inputTokens: 1_000_000, totalTokens: 1_000_000, costUsd: 99 }),
        bucket({ model: "nope", inputTokens: 5, totalTokens: 5, costUsd: 99 }),
      ],
      worktrees: { created: 0, archived: 0, active: 0, openPrs: 0 },
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
      recentPullRequests: [],
    } satisfies StatisticsSnapshot;
    const priced = priceStatisticsSnapshot(snapshot, policy(), "cached");
    expect(priced.pricing).toBe("cached");
    expect(priced.dailyBuckets[0]?.costUsd).toBeCloseTo(4, 9);
    expect(priced.dailyBuckets[1]).not.toHaveProperty("costUsd");
  });
});
