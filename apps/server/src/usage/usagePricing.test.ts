import type { UsageCostBreakdown, UsagePriceOverrides } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { UsageRecord } from "./usageRecord.ts";
import {
  compileUsagePriceOverrides,
  encodeUsageRateTable,
  estimateUsageCost,
  estimateUsageCostParts,
  lookupUsageModelRate,
  makeUsagePricingPolicy,
  normalizeUsageModelName,
  parseUsageRateTable,
  priceUsageRecord,
  resolveUsageModel,
  type UsageRateTable,
} from "./usagePricing.ts";

/** Prices one record under published rates and, optionally, the node's overrides. */
function price(
  table: UsageRateTable,
  item: UsageRecord,
  overrides: UsagePriceOverrides = {},
): ReturnType<typeof priceUsageRecord> {
  const policy = makeUsagePricingPolicy(table, compileUsagePriceOverrides(overrides));
  return priceUsageRecord(resolveUsageModel(policy, item.model), item);
}

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
    const priced = price(rates, record);

    expect(priced.estimatedCostUsd).toBeCloseTo(0.004625, 9);
    expect(priced.estimatedCacheSavingsUsd).toBeCloseTo(0.009, 9);
    expect(priced.costSource).toBe("litellm");
    expect(priced.pricedTokenCount).toBe(1160);
  });

  it("prefers provider-reported cost while retaining rate-based cache savings", () => {
    const priced = price(rates, { ...record, reportedCostUsd: 1.25 });
    expect(priced.estimatedCostUsd).toBe(1.25);
    expect(priced.costSource).toBe("provider-reported");
    expect(priced.estimatedCacheSavingsUsd).toBeCloseTo(0.009, 9);
  });

  it("uses input rates for cache categories without a published discount", () => {
    const priced = price(rates, { ...record, model: "no-cache-rates" });
    expect(priced.estimatedCostUsd).toBeCloseTo(0.0136, 9);
    expect(priced.estimatedCacheSavingsUsd).toBeNull();
    expect(priced.pricedTokenCount).toBe(1160);
    expect(priced.unpricedTokenCount).toBe(0);
  });

  it("keeps tokens but leaves unknown and ambiguous model families unpriced", () => {
    for (const model of ["kimi-k3", "sonnet", "<synthetic>"]) {
      const priced = price(rates, { ...record, model });
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
    expect(price(parsed, { ...record, model: "gpt-5.6-sol" }).estimatedCostUsd).toBeCloseTo(
      0.00185,
    );
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
  expect(price(parsed, { ...record, model: "model" }).estimatedCacheSavingsUsd).toBeCloseTo(0.0036);
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
  const base = price(parsed, { ...record, model: "model" });
  for (const table of [parsed, parseUsageRateTable(encodeUsageRateTable(parsed))]) {
    expect(price(table, { ...record, model: "model", speed: "fast" }).estimatedCostUsd).toBeCloseTo(
      base.estimatedCostUsd! * 2,
    );
    expect(
      price(table, { ...record, model: "model", speed: "ultrafast" }).estimatedCacheSavingsUsd,
    ).toBeCloseTo(base.estimatedCacheSavingsUsd! * 4);
  }
});
it("applies Claude's published fast multiplier and retains explicit zero cache prices", () => {
  const parsed = parseUsageRateTable({
    model: { ...canonical, cache_read_input_token_cost: 0, provider_specific_entry: { fast: 6 } },
  });
  const base = price(parsed, { ...record, model: "model" });
  expect(price(parsed, { ...record, model: "model", speed: "fast" }).estimatedCostUsd).toBeCloseTo(
    base.estimatedCostUsd! * 6,
  );
  expect(lookupUsageModelRate(parsed, "model")?.cacheReadCostPerToken).toBe(0);
});

describe("usage cost by token type", () => {
  const sum = (
    split: Pick<UsageCostBreakdown, "inputUsd" | "cacheReadUsd" | "cacheWriteUsd" | "outputUsd">,
  ) => split.inputUsd + split.cacheReadUsd + split.cacheWriteUsd + split.outputUsd;
  const tiered = parseUsageRateTable({
    model: {
      ...canonical,
      input_cost_per_token_priority: 0.000008,
      output_cost_per_token_priority: 0.00004,
    },
  });

  it("splits an estimate into parts that sum to the estimate", () => {
    for (const model of ["claude-sonnet-4-5-20250929", "no-cache-rates"]) {
      const rate = lookupUsageModelRate(rates, model)!;
      const parts = estimateUsageCostParts(rate, record.totals);
      expect(Math.abs(sum(parts) - estimateUsageCost(rate, record.totals))).toBeLessThan(1e-12);
      const priced = price(rates, { ...record, model });
      expect(priced.listCostBreakdown).toEqual(parts);
      expect(priced.estimatedCostUsd).toBe(sum(parts));
    }
    // Cache tokens without a published cache rate cost the input rate.
    expect(
      estimateUsageCostParts(lookupUsageModelRate(rates, "no-cache-rates")!, record.totals),
    ).toEqual({
      inputUsd: 100 * 0.00001,
      cacheReadUsd: 1000 * 0.00001,
      cacheWriteUsd: 10 * 0.00001,
      outputUsd: 50 * 0.00005,
    });
  });

  it("prices fast tokens at the priority tier and reports the premium over standard rates", () => {
    const standard = price(tiered, { ...record, model: "model" });
    const fast = price(tiered, { ...record, model: "model", speed: "fast" });
    const fastRate = lookupUsageModelRate(tiered, "model")!.fast!;
    expect(fast.listCostBreakdown).toMatchObject(estimateUsageCostParts(fastRate, record.totals));
    expect(fast.listCostBreakdown?.speedPremiumUsd).toBeCloseTo(
      fast.estimatedCostUsd! - standard.estimatedCostUsd!,
      12,
    );
    expect(fast.listCostBreakdown?.speedPremiumUsd).toBeGreaterThan(0);
    expect(standard.listCostBreakdown).not.toHaveProperty("speedPremiumUsd");
  });

  it("bills a speed without its own tier at standard rates without a premium", () => {
    const standard = price(tiered, { ...record, model: "model" });
    for (const speed of ["ultrafast", "standard"] as const) {
      const priced = price(tiered, { ...record, model: "model", speed });
      expect(priced.listCostBreakdown).toEqual(standard.listCostBreakdown);
      expect(priced.listCostBreakdown).not.toHaveProperty("speedPremiumUsd");
    }
  });

  it("keeps the list split of a reported cost and leaves unknown models unsplit", () => {
    const reported = price(rates, { ...record, reportedCostUsd: 1.25 });
    expect(reported.estimatedCostUsd).toBe(1.25);
    expect(reported.listCostBreakdown).toEqual(price(rates, record).listCostBreakdown);
    for (const model of ["kimi-k3", "sonnet"]) {
      expect(price(rates, { ...record, model }).listCostBreakdown).toBeNull();
      expect(
        price(rates, { ...record, model, reportedCostUsd: 1.25 }).listCostBreakdown,
      ).toBeNull();
    }
  });
});

describe("custom model prices and model mappings", () => {
  // $3 / $15 per million tokens; record() has 100 uncached, 1000 cached, 10 written, 50 output.
  const custom: UsagePriceOverrides = {
    "Kimi-K3": { price: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 } },
  };
  const customCost = (1110 * 3 + 50 * 15) / 1e6;

  it("prices a model without published rates, and every speed alike", () => {
    expect(price(rates, { ...record, model: "kimi-k3" }).costSource).toBe("unpriced");
    for (const speed of [undefined, "fast", "ultrafast"] as const) {
      const priced = price(
        rates,
        { ...record, model: "kimi-k3", ...(speed === undefined ? {} : { speed }) },
        custom,
      );
      expect(priced).toMatchObject({
        costSource: "litellm",
        pricedTokenCount: 1160,
        unpricedTokenCount: 0,
        customPricedTokenCount: 1160,
      });
      expect(priced.estimatedCostUsd).toBeCloseTo(customCost, 12);
      expect(priced.listCostBreakdown).not.toHaveProperty("speedPremiumUsd");
      // A missing cache price is the input price: nothing is saved.
      expect(priced.estimatedCacheSavingsUsd).toBe(0);
    }
  });

  it("replaces published rates and provider-reported cost", () => {
    const model = "anthropic/claude-sonnet-4-5-20250929";
    const overrides: UsagePriceOverrides = {
      [model]: {
        price: {
          inputUsdPerMillion: 1,
          outputUsdPerMillion: 2,
          cacheReadUsdPerMillion: 0,
          cacheWriteUsdPerMillion: 4,
        },
      },
    };
    for (const reportedCostUsd of [null, 1.25]) {
      const priced = price(rates, { ...record, reportedCostUsd }, overrides);
      expect(priced.costSource).toBe("litellm");
      expect(priced.estimatedCostUsd).toBeCloseTo((100 * 1 + 10 * 4 + 50 * 2) / 1e6, 12);
      expect(priced.listCostBreakdown?.cacheReadUsd).toBe(0);
      expect(priced.estimatedCacheSavingsUsd).toBeCloseTo(1000 / 1e6, 12);
    }
  });

  it("matches IDs case-insensitively and context variants by their base model", () => {
    for (const model of ["KIMI-K3", " kimi-k3[1m] "]) {
      expect(price(rates, { ...record, model }, custom).estimatedCostUsd).toBeCloseTo(
        customCost,
        12,
      );
    }
    // An entry for the variant itself wins over its base model's.
    const variant = price(
      rates,
      { ...record, model: "kimi-k3[1m]" },
      {
        ...custom,
        "kimi-k3[1M]": { price: { inputUsdPerMillion: 6, outputUsdPerMillion: 30 } },
      },
    );
    expect(variant.estimatedCostUsd).toBeCloseTo(customCost * 2, 12);
  });

  it("lets a context variant's own entry of either kind win over its base model's", () => {
    const variantPrice = { inputUsdPerMillion: 6, outputUsdPerMillion: 30 };
    const policy = makeUsagePricingPolicy(
      rates,
      compileUsagePriceOverrides({
        "claude-x": { mapTo: "claude-sonnet-4-5-20250929" },
        "claude-x[1m]": { price: variantPrice },
        "kimi-k3[1m]": { mapTo: "claude-x[1m]" },
        ...custom,
      }),
    );
    expect(resolveUsageModel(policy, "Claude-X[1M]")).toMatchObject({
      model: "Claude-X[1M]",
      custom: true,
    });
    expect(
      priceUsageRecord(resolveUsageModel(policy, "claude-x[1m]"), record).estimatedCostUsd,
    ).toBeCloseTo(customCost * 2, 12);
    expect(resolveUsageModel(policy, "kimi-k3[1m]")).toMatchObject({
      model: "claude-x[1m]",
      custom: true,
    });
    // Without an own entry, a variant follows its base model's mapping.
    expect(resolveUsageModel(policy, "claude-x[200k]")).toEqual({
      model: "claude-sonnet-4-5-20250929",
      rate: lookupUsageModelRate(rates, "claude-sonnet-4-5-20250929"),
      custom: false,
    });
  });

  it("prices model families without a generation only when explicitly set", () => {
    expect(price(rates, { ...record, model: "opus" }).costSource).toBe("unpriced");
    expect(price(rates, { ...record, model: "opus" }, { opus: custom["Kimi-K3"]! })).toMatchObject({
      costSource: "litellm",
      customPricedTokenCount: 1160,
    });
    expect(
      price(
        rates,
        { ...record, model: "opus[1m]" },
        { "my-opus": { mapTo: "claude-sonnet-4-5-20250929" }, "opus[1m]": { mapTo: "my-opus" } },
      ).estimatedCostUsd,
    ).toBeCloseTo(price(rates, record).estimatedCostUsd!, 12);
    // Synthetic placeholders are never priced or mapped.
    for (const model of ["<synthetic>", "synthetic"]) {
      const priced = price(
        rates,
        { ...record, model },
        {
          [model]: custom["Kimi-K3"]!,
        },
      );
      expect(priced.costSource).toBe("unpriced");
    }
  });

  it("reports a mapped model under its target and prices it like the target", () => {
    const overrides: UsagePriceOverrides = {
      "claude-preview": { mapTo: "Claude-Next" },
      "claude-next": { mapTo: "claude-sonnet-4-5-20250929" },
      "loop-a": { mapTo: "loop-b" },
      "loop-b": { mapTo: "loop-a" },
      "to-custom": { mapTo: "kimi-k3" },
      ...custom,
    };
    const policy = makeUsagePricingPolicy(rates, compileUsagePriceOverrides(overrides));
    const target = lookupUsageModelRate(rates, "claude-sonnet-4-5-20250929");
    expect(resolveUsageModel(policy, "claude-preview[1m]")).toEqual({
      model: "claude-sonnet-4-5-20250929",
      rate: target,
      custom: false,
    });
    // Mapping alone keeps a provider-reported cost.
    const reported = priceUsageRecord(resolveUsageModel(policy, "claude-preview"), {
      ...record,
      model: "claude-preview",
      reportedCostUsd: 1.25,
    });
    expect(reported).toMatchObject({ estimatedCostUsd: 1.25, costSource: "provider-reported" });
    expect(resolveUsageModel(policy, "loop-a")).toEqual({
      model: "loop-a",
      rate: null,
      custom: false,
    });
    expect(resolveUsageModel(policy, "to-custom")).toMatchObject({
      model: "kimi-k3",
      custom: true,
    });
    // Resolved once per model and policy.
    expect(resolveUsageModel(policy, "to-custom")).toBe(resolveUsageModel(policy, "to-custom"));
  });

  it("reports a mapped model under its target's key, whatever case the target was typed in", () => {
    const policy = makeUsagePricingPolicy(
      rates,
      compileUsagePriceOverrides({
        "claude-opus-5-preview": { mapTo: "Claude-Sonnet-4-5-20250929" },
      }),
    );
    expect(resolveUsageModel(policy, "claude-opus-5-preview").model).toBe(
      resolveUsageModel(policy, "claude-sonnet-4-5-20250929").model,
    );
  });
});
