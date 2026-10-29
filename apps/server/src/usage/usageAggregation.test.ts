import type { UsageDailyBucket } from "@ryco/contracts";
import type { UsageRecord } from "./usageRecord.ts";

import { describe, expect, it } from "vite-plus/test";

import { UsageAggregator } from "./usageAggregation.ts";
import {
  compileUsagePriceOverrides,
  makeUsagePricingPolicy,
  parseUsageRateTable,
} from "./usagePricing.ts";

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    provider: "claude",
    // This instant is August 6 in Los Angeles.
    timestampMs: Date.parse("2026-08-07T04:05:13.944Z"),
    model: "claude-sonnet-4-5-20250929",
    sessionId: "session-a",
    totals: {
      uncachedInputTokens: 100,
      cachedInputTokens: 1000,
      cacheCreationInputTokens: 10,
      outputTokens: 50,
      reasoningTokens: 25,
      totalTokens: 1160,
    },
    reportedCostUsd: null,
    dedupeKey: null,
    ...overrides,
  };
}

function aggregate(records: readonly UsageRecord[], timeZone = "UTC") {
  const aggregator = new UsageAggregator({
    sourceId: "source-a",
    timeZone,
    startDate: "2026-08-01",
    endDate: "2026-08-31",
  });
  for (const item of records) aggregator.add(item);
  return aggregator.finish();
}

describe("UsageAggregator", () => {
  it("deduplicates Claude identities globally across files", () => {
    const result = aggregate([
      record({ dedupeKey: "msg_1:req_1" }),
      record({ dedupeKey: "msg_1:req_1" }),
      record({ dedupeKey: "msg_1:req_1" }),
    ]);

    expect(result.duplicatesDropped).toBe(2);
    expect(result.acceptedRecords).toBe(1);
    expect(result.buckets[0]?.tokens.outputTokens).toBe(50);
  });

  it("sums inherently unique records and does not add reasoning twice", () => {
    const result = aggregate([record(), record()]);

    expect(result.buckets[0]?.tokens.reasoningTokens).toBe(50);
    expect(result.buckets[0]?.tokens.totalTokens).toBe(2320);
    expect(result.buckets[0]?.responseCount).toBe(2);
    expect(result.buckets[0]?.sessionCount).toBe(1);
  });

  it("buckets by the caller's IANA time zone", () => {
    expect(aggregate([record()], "UTC").buckets[0]?.date).toBe("2026-08-07");
    expect(aggregate([record()], "America/Los_Angeles").buckets[0]?.date).toBe("2026-08-06");
  });

  it("preserves provider-reported costs and marks unpriced token coverage", () => {
    const result = aggregate([record({ reportedCostUsd: 1.25 }), record()]);
    const bucket = result.buckets[0];

    expect(bucket?.estimatedCostUsd).toBe(1.25);
    expect(bucket?.costSource).toBe("mixed");
    expect(bucket?.pricedTokenCount).toBe(1160);
    expect(bucket?.unpricedTokenCount).toBe(1160);
  });

  it("prices records with the summary's pricing policy", () => {
    const aggregator = new UsageAggregator({
      sourceId: "source-a",
      timeZone: "UTC",
      endDate: "2026-08-31",
      pricing: makeUsagePricingPolicy(
        parseUsageRateTable({
          "claude-sonnet-4-5-20250929": {
            input_cost_per_token: 0.001,
            output_cost_per_token: 0.006,
            cache_read_input_token_cost: 0.0001,
            cache_creation_input_token_cost: 0,
          },
        }),
      ),
    });
    aggregator.add(record());
    const bucket = aggregator.finish().buckets[0];

    expect(bucket?.estimatedCostUsd).toBeCloseTo(0.5, 12);
    expect(bucket?.estimatedCacheSavingsUsd).toBeCloseTo(0.9, 12);
    expect(bucket?.costBreakdown).toEqual({
      inputUsd: 0.1,
      cacheReadUsd: 0.1,
      cacheWriteUsd: 0,
      outputUsd: 0.3,
    });
    expect(bucket?.costSource).toBe("litellm");
  });

  it("drops records outside either edge of the requested window", () => {
    const result = aggregate([
      record({ timestampMs: Date.parse("2026-07-31T12:00:00Z") }),
      record({ timestampMs: Date.parse("2026-09-01T12:00:00Z") }),
    ]);

    expect(result.outOfWindow).toBe(2);
    expect(result.buckets).toHaveLength(0);
  });

  it("throws for an invalid time zone so the RPC can return a typed error", () => {
    expect(
      () =>
        new UsageAggregator({
          sourceId: "source-a",
          timeZone: "Mars/Olympus_Mons",
          endDate: "2026-08-31",
        }),
    ).toThrow();
  });
});

describe("UsageAggregator cost by token type", () => {
  // List cost of `record()`: input 0.001, cache read 0.001, cache write 0.000125, output 0.0025.
  const rates = parseUsageRateTable({
    "claude-sonnet-4-5-20250929": {
      input_cost_per_token: 0.00001,
      output_cost_per_token: 0.00005,
      cache_read_input_token_cost: 0.000001,
      cache_creation_input_token_cost: 0.0000125,
      provider_specific_entry: { fast: 2 },
    },
  });
  const priced = (records: readonly UsageRecord[]) => {
    const aggregator = new UsageAggregator({
      sourceId: "source-a",
      timeZone: "UTC",
      endDate: "2026-08-31",
      pricing: makeUsagePricingPolicy(rates),
    });
    for (const item of records) aggregator.add(item);
    return aggregator.finish().buckets;
  };
  const partsSum = (bucket: UsageDailyBucket | undefined) => {
    const split = bucket?.costBreakdown;
    return split === undefined
      ? undefined
      : split.inputUsd + split.cacheReadUsd + split.cacheWriteUsd + split.outputUsd;
  };

  it("splits a provider-reported cost in proportion to list prices", () => {
    const [bucket] = priced([record({ reportedCostUsd: 0.00925 })]);
    expect(bucket?.costSource).toBe("provider-reported");
    expect(bucket?.costBreakdown).toEqual({
      inputUsd: 0.002,
      cacheReadUsd: 0.002,
      cacheWriteUsd: 0.00025,
      outputUsd: 0.005,
    });
    expect(partsSum(bucket)).toBeCloseTo(bucket!.estimatedCostUsd!, 12);
  });

  it("scales the fast-mode premium of a reported cost with its parts", () => {
    // Fast list cost is 0.00925, of which 0.004625 is the premium; the provider reported twice that.
    const [bucket] = priced([record({ speed: "fast", reportedCostUsd: 0.0185 })]);
    expect(bucket?.costBreakdown).toEqual({
      inputUsd: 0.004,
      cacheReadUsd: 0.004,
      cacheWriteUsd: 0.0005,
      outputUsd: 0.01,
      speedPremiumUsd: 0.00925,
    });
  });

  it("adds rate-based estimates to the reported split of the same bucket", () => {
    const [bucket] = priced([
      record({ speed: "fast" }),
      record({ reportedCostUsd: 0.00925 }),
      record(),
    ]);
    expect(bucket?.costSource).toBe("mixed");
    expect(bucket?.estimatedCostUsd).toBeCloseTo(0.00925 + 0.00925 + 0.004625, 12);
    expect(partsSum(bucket)).toBeCloseTo(bucket!.estimatedCostUsd!, 7);
    expect(bucket?.costBreakdown?.speedPremiumUsd).toBe(0.004625);
    // Emitted values are rounded to 1e-8 USD.
    for (const value of Object.values(bucket!.costBreakdown!))
      expect(Math.round(value! * 1e8) / 1e8).toBe(value);
  });

  it("leaves reported cost without a rate or list cost unsplit", () => {
    const buckets = priced([
      record({ reportedCostUsd: 1.25, model: "kimi-k3" }),
      record({ model: "kimi-k3", timestampMs: Date.parse("2026-08-08T00:00:00Z") }),
      record(),
    ]);
    const bySource = (source: UsageDailyBucket["costSource"]) =>
      buckets.find((bucket) => bucket.costSource === source);
    expect(bySource("provider-reported")?.estimatedCostUsd).toBe(1.25);
    expect(bySource("provider-reported")?.costBreakdown).toBeUndefined();
    expect(bySource("unpriced")?.costBreakdown).toBeUndefined();
    expect(partsSum(bySource("litellm"))).toBeCloseTo(0.004625, 12);

    const zeroTokens = record({
      reportedCostUsd: 0.5,
      totals: {
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
    });
    expect(priced([zeroTokens])[0]?.costBreakdown).toBeUndefined();
    // The default pricer knows no rates.
    expect(
      aggregate([record({ reportedCostUsd: 1.25 })]).buckets[0]?.costBreakdown,
    ).toBeUndefined();
  });
});

describe("UsageAggregator custom prices and model mappings", () => {
  const rates = parseUsageRateTable({
    "claude-sonnet-4-5-20250929": { input_cost_per_token: 0.00001, output_cost_per_token: 0.00005 },
  });
  const aggregateWith = (
    records: readonly UsageRecord[],
    overrides: Parameters<typeof compileUsagePriceOverrides>[0],
  ) => {
    const aggregator = new UsageAggregator({
      sourceId: "source-a",
      timeZone: "UTC",
      endDate: "2026-08-31",
      pricing: makeUsagePricingPolicy(rates, compileUsagePriceOverrides(overrides)),
    });
    for (const item of records) aggregator.add(item);
    return aggregator.finish().buckets;
  };

  it("reports a mapped model under its target and prices custom models over reported cost", () => {
    const buckets = aggregateWith(
      [
        record({ model: "claude-preview" }),
        record({ model: "claude-preview[1m]", reportedCostUsd: 0.25 }),
        record({ model: "kimi-k3", reportedCostUsd: 9 }),
      ],
      {
        "claude-preview": { mapTo: "claude-sonnet-4-5-20250929" },
        "Kimi-K3": { price: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } },
      },
    );
    expect(buckets.map((bucket) => bucket.model)).toEqual([
      "claude-sonnet-4-5-20250929",
      "kimi-k3",
    ]);
    const [mapped, custom] = buckets;
    // Mapping alone keeps the reported cost; the other response is priced at the target's rate.
    expect(mapped).toMatchObject({ responseCount: 2, costSource: "mixed" });
    expect(mapped?.estimatedCostUsd).toBeCloseTo(0.25 + 0.0136, 12);
    expect(mapped?.customPricedTokenCount).toBeUndefined();
    // Every input token (uncached, cached and written) costs the input price without cache prices.
    expect(custom).toMatchObject({ costSource: "litellm", customPricedTokenCount: 1160 });
    expect(custom?.estimatedCostUsd).toBeCloseTo(1110 / 1e6 + 100 / 1e6, 12);
  });
});
