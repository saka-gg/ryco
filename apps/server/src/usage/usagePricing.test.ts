import { describe, expect, it } from "vite-plus/test";

import type { UsageRecord } from "./usageRecord.ts";
import {
  encodeUsageRateTable,
  lookupUsageModelRate,
  normalizeUsageModelName,
  parseUsageRateTable,
  priceUsageRecord,
} from "./usagePricing.ts";

const record: UsageRecord = {
  provider: "claude",
  timestampMs: 0,
  model: "anthropic/CLAUDE-SONNET-4-5-20250929",
  sessionId: "session-a",
  totals: {
    uncachedInputTokens: 100,
    cachedInputTokens: 1000,
    cacheCreationInputTokens: 10,
    outputTokens: 50,
    reasoningTokens: 0,
    totalTokens: 1160,
  },
  reportedCostUsd: null,
  dedupeKey: null,
};

const rates = parseUsageRateTable({
  "claude-sonnet-4-5-20250929": {
    input_cost_per_token: 0.00001,
    output_cost_per_token: 0.00005,
    cache_read_input_token_cost: 0.000001,
    cache_creation_input_token_cost: 0.0000125,
  },
  partial: { input_cost_per_token: 1 },
  "no-cache-rates": {
    input_cost_per_token: 0.00001,
    output_cost_per_token: 0.00005,
  },
});

describe("usage pricing", () => {
  it("normalizes provider prefixes and rejects partial rate entries", () => {
    expect(normalizeUsageModelName(" Anthropic/Claude-SONNET ")).toBe("claude-sonnet");
    expect(lookupUsageModelRate(rates, record.model)).not.toBeNull();
    expect(lookupUsageModelRate(rates, "partial")).toBeNull();
  });

  it("prices each token class and estimates cache savings", () => {
    const priced = priceUsageRecord(rates, record);

    expect(priced.estimatedCostUsd).toBeCloseTo(0.004625, 9);
    expect(priced.estimatedCacheSavingsUsd).toBeCloseTo(0.009, 9);
    expect(priced.costSource).toBe("litellm");
    expect(priced.pricedTokenCount).toBe(1160);
  });

  it("prefers provider-reported cost while retaining rate-based cache savings", () => {
    const priced = priceUsageRecord(rates, { ...record, reportedCostUsd: 1.25 });
    expect(priced.estimatedCostUsd).toBe(1.25);
    expect(priced.costSource).toBe("provider-reported");
    expect(priced.estimatedCacheSavingsUsd).toBeCloseTo(0.009, 9);
  });

  it("uses input rates for cache categories without a published discount", () => {
    const priced = priceUsageRecord(rates, { ...record, model: "no-cache-rates" });
    expect(priced.estimatedCostUsd).toBeCloseTo(0.0136, 9);
    expect(priced.estimatedCacheSavingsUsd).toBeNull();
    expect(priced.pricedTokenCount).toBe(1160);
    expect(priced.unpricedTokenCount).toBe(0);
  });

  it("keeps tokens but leaves unknown and ambiguous model families unpriced", () => {
    for (const model of ["kimi-k3", "sonnet", "<synthetic>"]) {
      const priced = priceUsageRecord(rates, { ...record, model });
      expect(priced.estimatedCostUsd).toBeNull();
      expect(priced.pricedTokenCount).toBe(0);
      expect(priced.unpricedTokenCount).toBe(1160);
      expect(priced.costSource).toBe("unpriced");
    }
  });
});

const canonical = {
  input_cost_per_token: 0.000004,
  output_cost_per_token: 0.00002,
  cache_read_input_token_cost: 0.0000004,
  cache_creation_input_token_cost: 0.000005,
};
it("keeps canonical and qualified prices regardless of document order", () => {
  const gateway = {
    ...canonical,
    input_cost_per_token: 0.00004,
    cache_creation_input_token_cost: undefined,
  };
  for (const document of [
    { "gpt-5.6-sol": canonical, "perplexity/openai/gpt-5.6-sol": gateway },
    { "perplexity/openai/gpt-5.6-sol": gateway, "gpt-5.6-sol": canonical },
  ]) {
    const parsed = parseUsageRateTable(document);
    expect(lookupUsageModelRate(parsed, "gpt-5.6-sol")?.cacheCreationCostPerToken).toBe(0.000005);
    expect(lookupUsageModelRate(parsed, "perplexity/openai/gpt-5.6-sol")?.inputCostPerToken).toBe(
      0.00004,
    );
    expect(parseUsageRateTable(encodeUsageRateTable(parsed))).toEqual(parsed);
    expect(
      priceUsageRecord(parsed, { ...record, model: "gpt-5.6-sol" }).estimatedCostUsd,
    ).toBeCloseTo(0.00185);
  }
});
it("does not guess a bare alias when qualified providers disagree", () => {
  const parsed = parseUsageRateTable({
    "a/custom": canonical,
    "b/custom": { ...canonical, input_cost_per_token: 1 },
  });
  expect(lookupUsageModelRate(parsed, "custom")).toBeNull();
  expect(lookupUsageModelRate(parsed, "a/custom")).not.toBeNull();
  expect(lookupUsageModelRate(parsed, "unknown/custom")).toBeNull();
  expect(
    lookupUsageModelRate(parseUsageRateTable({ "a/custom": canonical }), "custom"),
  ).not.toBeNull();
});
it("resolves explicit context variants without guessing a model generation", () => {
  expect(lookupUsageModelRate(rates, "anthropic/claude-sonnet-4-5-20250929[1m]")).not.toBeNull();
  expect(lookupUsageModelRate(rates, "sonnet[1m]")).toBeNull();
});
it("retains cache read savings when the cache write price is absent", () => {
  const parsed = parseUsageRateTable({
    model: { ...canonical, cache_creation_input_token_cost: undefined },
  });
  expect(
    priceUsageRecord(parsed, { ...record, model: "model" }).estimatedCacheSavingsUsd,
  ).toBeCloseTo(0.0036);
});
it("prices priority and ultrafast tokens at their recorded tier and preserves tiers on disk", () => {
  const parsed = parseUsageRateTable({
    model: {
      ...canonical,
      input_cost_per_token_priority: 0.000008,
      output_cost_per_token_priority: 0.00004,
      input_cost_per_token_ultrafast: 0.000016,
      output_cost_per_token_ultrafast: 0.00008,
    },
  });
  const base = priceUsageRecord(parsed, { ...record, model: "model" });
  for (const table of [parsed, parseUsageRateTable(encodeUsageRateTable(parsed))]) {
    expect(
      priceUsageRecord(table, { ...record, model: "model", speed: "fast" }).estimatedCostUsd,
    ).toBeCloseTo(base.estimatedCostUsd! * 2);
    expect(
      priceUsageRecord(table, { ...record, model: "model", speed: "ultrafast" })
        .estimatedCacheSavingsUsd,
    ).toBeCloseTo(base.estimatedCacheSavingsUsd! * 4);
  }
});
it("applies Claude's published fast multiplier and retains explicit zero cache prices", () => {
  const parsed = parseUsageRateTable({
    model: { ...canonical, cache_read_input_token_cost: 0, provider_specific_entry: { fast: 6 } },
  });
  const base = priceUsageRecord(parsed, { ...record, model: "model" });
  expect(
    priceUsageRecord(parsed, { ...record, model: "model", speed: "fast" }).estimatedCostUsd,
  ).toBeCloseTo(base.estimatedCostUsd! * 6);
  expect(lookupUsageModelRate(parsed, "model")?.cacheReadCostPerToken).toBe(0);
});
