import type {
  UsageCalendarDate,
  UsageDailyBucket,
  UsagePriceOverrides,
  UsageProviderKind,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { UsageAggregator } from "./usageAggregation.ts";
import { buildUsageFileAggregate, UsageSlotAggregator } from "./usageFileAggregate.ts";
import {
  compileUsagePriceOverrides,
  makeUsagePricingPolicy,
  parseUsageRateTable,
  resolveUsageModel,
} from "./usagePricing.ts";
import type { UsageRecord, UsageSpeed } from "./usageRecord.ts";
import { withTokenTotal } from "./usageRecord.ts";

const rates = parseUsageRateTable({
  "claude-sonnet-4-5": {
    input_cost_per_token: 3e-6,
    output_cost_per_token: 15e-6,
    cache_read_input_token_cost: 3e-7,
    cache_creation_input_token_cost: 3.75e-6,
  },
  // No cache-read price: savings are unknown for responses with cached input.
  "gpt-5": {
    input_cost_per_token: 1.25e-6,
    output_cost_per_token: 10e-6,
    output_cost_per_token_priority: 20e-6,
    input_cost_per_token_priority: 2.5e-6,
  },
  // A cache read dearer than input: savings clamp to zero.
  "odd-model": {
    input_cost_per_token: 1e-6,
    output_cost_per_token: 2e-6,
    cache_read_input_token_cost: 3e-6,
  },
});

/** Deterministic pseudo-random numbers (mulberry32). */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const MODELS = ["claude-sonnet-4-5", "gpt-5", "odd-model", "unknown-model", "<synthetic>"];
const SPEEDS: Array<UsageSpeed | undefined> = [undefined, "standard", "fast", "ultrafast"];

/** Files of records spanning month and DST boundaries, with cross-file copies. */
function makeFiles(seed: number, provider: UsageProviderKind, keyed: boolean) {
  const next = random(seed);
  const pick = <T>(values: readonly T[]) => values[Math.floor(next() * values.length)]!;
  const start = Date.parse("2026-03-27T00:00:00.000Z");
  const files: UsageRecord[][] = [];
  const all: UsageRecord[] = [];
  let id = 0;
  for (let file = 0; file < 12; file++) {
    const records: UsageRecord[] = [];
    const sessionId = next() < 0.1 ? "" : `session-${Math.floor(next() * 6)}`;
    for (let index = 0; index < 120; index++) {
      if (keyed && all.length > 0 && next() < 0.15) {
        // A provider copy of an earlier response, possibly under another session.
        const copy = pick(all);
        records.push({ ...copy, sessionId: next() < 0.5 ? copy.sessionId : sessionId });
        continue;
      }
      const cached = next() < 0.3 ? 0 : Math.floor(next() * 50_000);
      const reasoning = next() < 0.2 ? undefined : Math.floor(next() * 500);
      const totals = withTokenTotal({
        uncachedInputTokens: Math.floor(next() * 5_000),
        cachedInputTokens: cached,
        cacheCreationInputTokens: next() < 0.5 ? 0 : Math.floor(next() * 3_000),
        outputTokens: Math.floor(next() * 4_000),
        ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
      });
      const speed = pick(SPEEDS);
      const record: UsageRecord = {
        ...(speed === undefined ? {} : { speed }),
        provider,
        // Eight days around the EU and US DST changes, at minute resolution.
        timestampMs:
          start + Math.floor(next() * 8 * 24 * 60) * 60_000 + Math.floor(next() * 60_000),
        model: pick(MODELS),
        sessionId,
        totals: next() < 0.1 ? { ...totals, totalTokens: totals.totalTokens + 17 } : totals,
        reportedCostUsd: next() < 0.2 ? Math.round(next() * 1e6) / 1e7 : null,
        dedupeKey: keyed && next() < 0.9 ? `key-${id++}` : null,
      };
      records.push(record);
      all.push(record);
    }
    // The scan cache keeps one record per key within a file.
    const seen = new Set<string>();
    files.push(
      records.filter((record) => {
        if (record.dedupeKey === null) return true;
        if (seen.has(record.dedupeKey)) return false;
        seen.add(record.dedupeKey);
        return true;
      }),
    );
  }
  return files;
}

function expectSameBuckets(
  actual: readonly UsageDailyBucket[],
  expected: readonly UsageDailyBucket[],
) {
  const usd = (bucket: UsageDailyBucket) => ({
    estimatedCostUsd: bucket.estimatedCostUsd,
    estimatedCacheSavingsUsd: bucket.estimatedCacheSavingsUsd,
  });
  const exact = ({
    estimatedCostUsd,
    estimatedCacheSavingsUsd,
    costBreakdown,
    ...rest
  }: UsageDailyBucket) => ({
    ...rest,
    hasCost: estimatedCostUsd !== undefined,
    hasSavings: estimatedCacheSavingsUsd !== undefined,
    hasBreakdown: costBreakdown !== undefined,
    hasSpeedPremium: costBreakdown?.speedPremiumUsd !== undefined,
  });
  expect(actual.map(exact)).toEqual(expected.map(exact));
  for (const [index, bucket] of actual.entries()) {
    const want = usd(expected[index]!);
    const got = usd(bucket);
    for (const field of ["estimatedCostUsd", "estimatedCacheSavingsUsd"] as const) {
      if (want[field] === undefined) continue;
      // Only the floating-point summation order differs.
      expect(got[field]).toBeCloseTo(want[field], 9);
      expect(Math.abs(got[field]! - want[field]) <= Math.abs(want[field]) * 1e-12 + 1e-15).toBe(
        true,
      );
    }
    const wantSplit = expected[index]!.costBreakdown;
    for (const field of SPLIT_FIELDS) {
      if (wantSplit?.[field] === undefined) continue;
      // Emitted at 1e-8 USD: a summation-order difference may round to the neighbouring step.
      expect(Math.abs(bucket.costBreakdown![field]! - wantSplit[field]) <= 1.5e-8).toBe(true);
    }
  }
}

const SPLIT_FIELDS = [
  "inputUsd",
  "cacheReadUsd",
  "cacheWriteUsd",
  "outputUsd",
  "speedPremiumUsd",
] as const;

const splitSum = (split: NonNullable<UsageDailyBucket["costBreakdown"]>) =>
  split.inputUsd + split.cacheReadUsd + split.cacheWriteUsd + split.outputUsd;

/** A custom price for a model with published rates, and a mapping that merges two models. */
const OVERRIDES: UsagePriceOverrides = {
  "Odd-Model": { price: { inputUsdPerMillion: 2, outputUsdPerMillion: 8 } },
  "unknown-model": { mapTo: "gpt-5" },
};

describe("usage file aggregates", () => {
  it.each([
    { timeZone: "UTC", provider: "claude" as const, keyed: true, seed: 1, overrides: {} },
    { timeZone: "Europe/Berlin", provider: "claude" as const, keyed: true, seed: 2, overrides: {} },
    {
      timeZone: "America/Los_Angeles",
      provider: "codex" as const,
      keyed: false,
      seed: 3,
      overrides: OVERRIDES,
    },
    {
      timeZone: "Asia/Kathmandu",
      provider: "claude" as const,
      keyed: true,
      seed: 4,
      overrides: {},
    },
    {
      timeZone: "Australia/Lord_Howe",
      provider: "opencode" as const,
      keyed: true,
      seed: 5,
      overrides: OVERRIDES,
    },
    {
      timeZone: "Pacific/Chatham",
      provider: "codex" as const,
      keyed: false,
      seed: 6,
      overrides: {},
    },
  ])(
    "match per-record aggregation ($provider, $timeZone)",
    ({ timeZone, provider, keyed, seed, overrides }) => {
      const files = makeFiles(seed, provider, keyed);
      const tables = compileUsagePriceOverrides(overrides);
      for (const window of [
        { endDate: "2026-04-10" as UsageCalendarDate },
        {
          startDate: "2026-03-29" as UsageCalendarDate,
          endDate: "2026-04-01" as UsageCalendarDate,
        },
      ]) {
        const policy = makeUsagePricingPolicy(rates, tables);
        const reference = new UsageAggregator({
          sourceId: "source",
          timeZone,
          ...window,
          pricing: policy,
        });
        const sessions = new Set<string>();
        const recognized = new Set<string>();
        const unrecognized = new Set<string>();
        for (const record of files.flat()) {
          if (!reference.add(record)) continue;
          if (record.sessionId.length > 0) sessions.add(record.sessionId);
          const resolution = resolveUsageModel(policy, record.model);
          const known = record.reportedCostUsd !== null || resolution.rate !== null;
          (known ? recognized : unrecognized).add(resolution.model);
        }
        const expected = reference.finish();

        const aggregator = new UsageSlotAggregator({
          sourceId: "source",
          provider,
          timeZone,
          ...window,
          pricing: makeUsagePricingPolicy(rates, tables),
        });
        for (const file of files) aggregator.addFile(buildUsageFileAggregate(file));
        const actual = aggregator.finish();

        expect(actual.acceptedRecords).toBe(expected.acceptedRecords);
        expect(actual.duplicatesDropped).toBe(expected.duplicatesDropped);
        expect([...actual.sessionIds].toSorted()).toEqual([...sessions].toSorted());
        expect([...actual.recognizedModels].toSorted()).toEqual([...recognized].toSorted());
        expect([...actual.unrecognizedModels].toSorted()).toEqual([...unrecognized].toSorted());
        expect(expected.buckets.length).toBeGreaterThan(0);
        expectSameBuckets(actual.buckets, expected.buckets);
        // The data exercises every split path: fast premiums, reported cost split by list
        // prices, and reported cost of unknown models left unsplit.
        const split = actual.buckets.filter((bucket) => bucket.costBreakdown !== undefined);
        expect(split.some((bucket) => bucket.costBreakdown?.speedPremiumUsd)).toBe(true);
        expect(split.some((bucket) => bucket.costSource !== "litellm")).toBe(true);
        expect(
          actual.buckets.some(
            (bucket) => bucket.estimatedCostUsd !== undefined && bucket.costBreakdown === undefined,
          ),
        ).toBe(true);
        for (const bucket of split) {
          // Rate-priced models split all of their cost, reported or not.
          expect(Math.abs(splitSum(bucket.costBreakdown!) - bucket.estimatedCostUsd!)).toBeLessThan(
            1e-7,
          );
        }
        if (overrides === OVERRIDES) {
          // The mapped model's usage counts under its target; the custom price covers all of
          // its model's tokens, reported cost included.
          expect(actual.buckets.some((bucket) => bucket.model === "unknown-model")).toBe(false);
          const custom = actual.buckets.filter((bucket) => bucket.model === "odd-model");
          expect(custom.length).toBeGreaterThan(0);
          for (const bucket of custom) {
            expect(bucket.customPricedTokenCount).toBe(bucket.tokens.totalTokens);
            expect(bucket.costSource).toBe("litellm");
          }
          expect(
            actual.buckets.every(
              (bucket) =>
                bucket.model === "odd-model" || bucket.customPricedTokenCount === undefined,
            ),
          ).toBe(true);
        }
      }
    },
  );

  it("reprices the same cached aggregates under custom prices and mappings", () => {
    const at = Date.parse("2026-04-02T10:00:00.000Z");
    const response = (model: string, reportedCostUsd: number | null = null): UsageRecord => ({
      provider: "claude",
      timestampMs: at,
      model,
      sessionId: "session",
      totals: withTokenTotal({
        uncachedInputTokens: 1_000_000,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 0,
      }),
      reportedCostUsd,
      dedupeKey: null,
    });
    const file = buildUsageFileAggregate([
      response("claude-sonnet-4-5"),
      response("claude-preview-x"),
      response("claude-preview-x", 0.5),
    ]);
    const summarize = (overrides: UsagePriceOverrides) => {
      const aggregator = new UsageSlotAggregator({
        sourceId: "source",
        provider: "claude",
        timeZone: "UTC",
        endDate: "2026-04-10",
        pricing: makeUsagePricingPolicy(rates, compileUsagePriceOverrides(overrides)),
      });
      aggregator.addFile(file);
      return aggregator.finish();
    };

    const published = summarize({});
    expect(published.buckets.map((bucket) => [bucket.model, bucket.estimatedCostUsd])).toEqual([
      ["claude-preview-x", 0.5],
      ["claude-sonnet-4-5", 3],
    ]);
    expect([...published.unrecognizedModels]).toEqual(["claude-preview-x"]);

    // A custom price replaces published rates and reported cost for the whole history.
    const custom = summarize({
      "claude-sonnet-4-5": { price: { inputUsdPerMillion: 5, outputUsdPerMillion: 25 } },
      "claude-preview-x": { price: { inputUsdPerMillion: 1, outputUsdPerMillion: 5 } },
    });
    expect(custom.buckets.map((bucket) => [bucket.model, bucket.estimatedCostUsd])).toEqual([
      ["claude-preview-x", 2],
      ["claude-sonnet-4-5", 5],
    ]);
    expect(custom.buckets[0]).toMatchObject({
      costSource: "litellm",
      customPricedTokenCount: 2_000_000,
      pricedTokenCount: 2_000_000,
    });
    expect([...custom.unrecognizedModels]).toEqual([]);

    // A mapped preview ID lands in its target's row at the target's rate; reported cost stays.
    const mapped = summarize({ "Claude-Preview-X": { mapTo: "claude-sonnet-4-5" } });
    expect(mapped.buckets).toHaveLength(1);
    expect(mapped.buckets[0]).toMatchObject({
      model: "claude-sonnet-4-5",
      responseCount: 3,
      estimatedCostUsd: 6.5,
      costSource: "mixed",
    });
    expect(mapped.buckets[0]?.customPricedTokenCount).toBeUndefined();
    expect([...mapped.recognizedModels]).toEqual(["claude-sonnet-4-5"]);
    expect([...mapped.unrecognizedModels]).toEqual([]);
  });

  it("keeps far fewer slots than records for a long single-session transcript", () => {
    const records: UsageRecord[] = Array.from({ length: 2_000 }, (_, index) => ({
      provider: "codex",
      timestampMs: Date.parse("2026-10-01T08:00:00.000Z") + index * 9_000,
      model: "gpt-5",
      sessionId: "session",
      totals: withTokenTotal({
        uncachedInputTokens: 10,
        cachedInputTokens: 20,
        cacheCreationInputTokens: 0,
        outputTokens: 5,
      }),
      reportedCostUsd: null,
      dedupeKey: null,
    }));
    const aggregate = buildUsageFileAggregate(records);
    expect(aggregate.recordCount).toBe(2_000);
    // Five hours of responses every nine seconds: 20 quarter-hour slots.
    expect(aggregate.slots).toHaveLength(20);
    expect(aggregate.keys).toHaveLength(0);
  });
});
