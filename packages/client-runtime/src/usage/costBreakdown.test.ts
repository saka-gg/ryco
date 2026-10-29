import {
  EnvironmentId,
  USAGE_CONTRACT_VERSION,
  type UsageCostBreakdown,
  type UsageDailyBucket,
  type UsageSourceCoverage,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatUsageCostShare,
  listUnpricedUsageModels,
  listUsageCostTypeShares,
  sumUsageCostBreakdown,
  usageCacheReadShare,
  type UsageCostBreakdownTotals,
} from "./costBreakdown.ts";
import { mergeUsageEnvironmentResults, type UsageEnvironmentResult } from "./merge.ts";

function source(sourceId: string): UsageSourceCoverage {
  return {
    sourceId,
    provider: "claude",
    deduplicationKind: "physical",
    status: "complete",
    transcriptFileCount: 1,
    reusedCacheFileCount: 0,
    parsedFileCount: 1,
    skippedLineCount: 0,
    malformedLineCount: 0,
    distinctSessionCount: 1,
    distinctResponseCount: 1,
    scanStartedAt: "2026-08-10T12:00:00.000Z",
    scanFinishedAt: "2026-08-10T12:00:01.000Z",
    scanDurationMs: 1000,
  };
}

function bucket(sourceId: string, overrides: Partial<UsageDailyBucket> = {}): UsageDailyBucket {
  return {
    sourceId,
    date: "2026-08-10",
    provider: "claude",
    model: "claude-sonnet-4-5-20250929",
    tokens: {
      uncachedInputTokens: 100,
      cachedInputTokens: 1000,
      cacheCreationInputTokens: 10,
      outputTokens: 50,
      reasoningTokens: 0,
      totalTokens: 1160,
    },
    responseCount: 1,
    sessionCount: 1,
    estimatedCostUsd: 1,
    pricedTokenCount: 1160,
    unpricedTokenCount: 0,
    costSource: "litellm",
    ...overrides,
  };
}

function environment(
  id: string,
  sources: readonly UsageSourceCoverage[],
  buckets: readonly UsageDailyBucket[],
): UsageEnvironmentResult {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    status: "complete",
    summary: {
      contractVersion: USAGE_CONTRACT_VERSION,
      startDate: "2026-08-01",
      endDate: "2026-08-10",
      timeZone: "UTC",
      generatedAt: "2026-08-10T12:00:02.000Z",
      scanDurationMs: 1000,
      sources,
      buckets,
      pricing: { state: "live", recognizedModelCount: 1, unrecognizedModelCount: 0 },
    },
  };
}

// Sums to 1 USD, the fixture bucket's cost.
const split = (speedPremiumUsd?: number): UsageCostBreakdown => ({
  inputUsd: 0.2,
  cacheReadUsd: 0.1,
  cacheWriteUsd: 0.05,
  outputUsd: 0.65,
  ...(speedPremiumUsd === undefined ? {} : { speedPremiumUsd }),
});

function totalsOf(
  environments: readonly UsageEnvironmentResult[],
): UsageCostBreakdownTotals | null {
  return sumUsageCostBreakdown(mergeUsageEnvironmentResults(environments)?.buckets ?? []);
}

describe("sumUsageCostBreakdown", () => {
  it("adds the parts and premiums of every environment and skips duplicate sources", () => {
    const totals = totalsOf([
      environment(
        "environment-a",
        [source("source-a"), source("shared")],
        [
          bucket("source-a", { costBreakdown: split(0.25) }),
          bucket("shared", { date: "2026-08-09", costBreakdown: split(0.25) }),
        ],
      ),
      environment(
        "environment-b",
        [source("source-b"), source("shared")],
        [
          bucket("source-b", { model: "claude-opus-4-1", costBreakdown: split() }),
          bucket("shared", { date: "2026-08-09", costBreakdown: split(0.25) }),
        ],
      ),
    ]);

    expect(totals?.totalUsd).toBeCloseTo(3);
    expect(totals?.inputUsd).toBeCloseTo(0.6);
    expect(totals?.cacheReadUsd).toBeCloseTo(0.3);
    expect(totals?.cacheWriteUsd).toBeCloseTo(0.15);
    expect(totals?.outputUsd).toBeCloseTo(1.95);
    expect(totals?.speedPremiumUsd).toBeCloseTo(0.5);
    expect(totals?.otherUsd).toBe(0);
    expect(totals?.unsplitBucketCount).toBe(0);
  });

  it("shows cost from older nodes and reported cost without a rate as Other", () => {
    const totals = totalsOf([
      // The same day and model as environment-b's bucket: merged, half split.
      environment("environment-a", [source("source-a")], [bucket("source-a")]),
      environment(
        "environment-b",
        [source("source-b")],
        [
          bucket("source-b", { costBreakdown: split() }),
          bucket("source-b", {
            model: "custom-preview",
            estimatedCostUsd: 0.4,
            costSource: "provider-reported",
          }),
        ],
      ),
    ]);

    expect(totals?.totalUsd).toBeCloseTo(2.4);
    expect(totals?.inputUsd).toBeCloseTo(0.2);
    expect(totals?.outputUsd).toBeCloseTo(0.65);
    expect(totals?.otherUsd).toBeCloseTo(1.4);
    expect(totals?.unsplitBucketCount).toBe(2);
  });

  it("does not turn the parts' rounding into Other", () => {
    const totals = sumUsageCostBreakdown(
      Array.from({ length: 30 }, (_, index) => ({
        ...bucket("source-a", { date: `2026-07-${String(index + 1).padStart(2, "0")}` }),
        sourceIds: ["source-a"],
        // Nodes round each part to 1e-8 USD; the estimate keeps full precision.
        estimatedCostUsd: 1 + 3e-9,
        costBreakdown: split(),
      })),
    );

    expect(totals?.otherUsd).toBe(0);
    expect(totals?.unsplitBucketCount).toBe(0);
  });

  it("is null without any cost and ignores unpriced buckets", () => {
    const { sourceId: _sourceId, estimatedCostUsd: _unpriced, ...fields } = bucket("source-a");
    const unpriced = { ...fields, sourceIds: ["source-a"] };
    expect(sumUsageCostBreakdown([])).toBeNull();
    expect(sumUsageCostBreakdown([unpriced])).toBeNull();

    const totals = sumUsageCostBreakdown([
      unpriced,
      { ...bucket("source-b", { costBreakdown: split() }), sourceIds: ["source-b"] },
    ]);
    expect(totals?.totalUsd).toBe(1);
    expect(totals?.unsplitBucketCount).toBe(0);
  });

  it("does not count a zero-cost bucket without a split as unsplit", () => {
    const totals = sumUsageCostBreakdown([
      { ...bucket("source-a", { estimatedCostUsd: 0 }), sourceIds: ["source-a"] },
    ]);
    expect(totals).toMatchObject({ totalUsd: 0, otherUsd: 0, unsplitBucketCount: 0 });
  });
});

describe("listUsageCostTypeShares", () => {
  const totals = (overrides: Partial<UsageCostBreakdownTotals>): UsageCostBreakdownTotals => ({
    totalUsd: 0,
    inputUsd: 0,
    cacheReadUsd: 0,
    cacheWriteUsd: 0,
    outputUsd: 0,
    otherUsd: 0,
    speedPremiumUsd: 0,
    unsplitBucketCount: 0,
    ...overrides,
  });

  it("lists the types with a cost in display order with shares that fill the bar", () => {
    const shares = listUsageCostTypeShares(
      totals({ totalUsd: 4, inputUsd: 1, outputUsd: 2, otherUsd: 1 }),
    );
    expect(shares).toEqual([
      { type: "input", usd: 1, share: 0.25 },
      { type: "output", usd: 2, share: 0.5 },
      { type: "other", usd: 1, share: 0.25 },
    ]);
  });

  it("is empty when nothing is split", () => {
    expect(listUsageCostTypeShares(totals({ totalUsd: 2, otherUsd: 2 }))).toEqual([]);
    expect(listUsageCostTypeShares(totals({}))).toEqual([]);
  });

  it("formats shares without rounding a cost to 0%", () => {
    expect(formatUsageCostShare(0.3249)).toBe("32%");
    expect(formatUsageCostShare(0.001)).toBe("<1%");
    expect(formatUsageCostShare(0)).toBe("0%");
    expect(formatUsageCostShare(1)).toBe("100%");
  });
});

describe("usageCacheReadShare", () => {
  it("is the cache reads' share of all input tokens", () => {
    expect(
      usageCacheReadShare({
        uncachedInputTokens: 100,
        cachedInputTokens: 300,
        cacheCreationInputTokens: 100,
      }),
    ).toBe(0.6);
  });

  it("is null without input tokens", () => {
    expect(
      usageCacheReadShare({
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
      }),
    ).toBeNull();
  });
});

describe("listUnpricedUsageModels", () => {
  const unpriced = (sourceId: string, model: string, tokens: number, date = "2026-08-10") => {
    const { estimatedCostUsd: _cost, ...rest } = bucket(sourceId, {
      date,
      model,
      pricedTokenCount: 0,
      unpricedTokenCount: tokens,
      costSource: "unpriced",
    });
    return rest;
  };

  it("lists models with unpriced tokens, most first, with the environments that left them unpriced", () => {
    const environments = [
      environment(
        "environment-a",
        [source("source-a"), source("shared")],
        [
          bucket("source-a"),
          unpriced("source-a", "claude-preview-x", 300),
          unpriced("source-a", "claude-preview-x", 200, "2026-08-09"),
          unpriced("shared", "gateway-model", 100),
        ],
      ),
      environment(
        "environment-b",
        [source("source-b"), source("shared")],
        [
          // Priced on this node (a custom price): only environment-a needs one.
          bucket("source-b", { model: "claude-preview-x", customPricedTokenCount: 1160 }),
          unpriced("source-b", "gateway-model", 900),
          // A duplicate of environment-a's shared source: excluded from the merge.
          unpriced("shared", "gateway-model", 100),
        ],
      ),
    ];
    const merged = mergeUsageEnvironmentResults(environments)!;

    expect(listUnpricedUsageModels(merged, merged.buckets)).toEqual([
      {
        provider: "claude",
        model: "gateway-model",
        unpricedTokens: 1000,
        environmentIds: ["environment-a", "environment-b"],
      },
      {
        provider: "claude",
        model: "claude-preview-x",
        unpricedTokens: 500,
        environmentIds: ["environment-a"],
      },
    ]);
  });

  it("follows the shown buckets and is empty when every token is priced", () => {
    const merged = mergeUsageEnvironmentResults([
      environment(
        "environment-a",
        [source("source-a")],
        [bucket("source-a"), unpriced("source-a", "claude-preview-x", 300)],
      ),
    ])!;

    expect(
      listUnpricedUsageModels(
        merged,
        merged.buckets.filter((entry) => entry.unpricedTokenCount === 0),
      ),
    ).toEqual([]);
  });
});
