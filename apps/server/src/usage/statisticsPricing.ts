/**
 * Prices Settings → Statistics with the usage pipeline's rates.
 *
 * Statistics count tokens from Ryco's own turn records; the usage pipeline prices provider
 * transcripts. Both use one rate table (the downloaded LiteLLM price list), the node's custom
 * prices and model mappings, and the same fast/ultrafast tiers, so a model costs the same in
 * both views and a new model is priced as soon as the price list knows it.
 *
 * @module statisticsPricing
 */
import {
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  type StatisticsDailyBucket,
  type StatisticsSnapshot,
  type UsagePricingState,
} from "@ryco/contracts";

import { estimateUsageCost, resolveSpeedRate, resolveUsageModel } from "./usagePricing.ts";
import type { UsagePricingPolicy } from "./usagePricing.ts";

function count(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** A bucket's tokens split the way the usage pipeline bills them. */
export interface StatisticsBucketTokenCounts {
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly outputTokens: number;
}

/** How far a legacy bucket's extra tokens may differ from its cached reads and still be them. */
const SEPARATE_CACHE_TOLERANCE = 0.01;

/**
 * Cached reads and cache writes are normally a subset of `inputTokens`. Two older layouts differ:
 * - Cached reads stored beside input: more cached than input tokens, or a total above input
 *   plus output by about the cached reads. Those reads are billed on top of input.
 * - A total above input plus output by more than that: approximate records (the thread-cumulative
 *   fallback) kept an unreliable total beside part of the split. Only the split is priced; such
 *   totals have been seen at ten times the provider's own transcripts.
 *
 * Undefined when the bucket has no input/output split (a total alone cannot be priced).
 */
export function statisticsBucketTokenCounts(
  bucket: Pick<
    StatisticsDailyBucket,
    "inputTokens" | "cachedInputTokens" | "cacheWriteInputTokens" | "outputTokens" | "totalTokens"
  >,
): StatisticsBucketTokenCounts | undefined {
  const inputTokens = count(bucket.inputTokens);
  const cachedTokens = count(bucket.cachedInputTokens);
  const outputTokens = count(bucket.outputTokens);
  const totalTokens = count(bucket.totalTokens);
  if (inputTokens === 0 && cachedTokens === 0 && outputTokens === 0) return undefined;
  const beyondSplit = Math.max(0, totalTokens - inputTokens - outputTokens);
  const separateCache =
    cachedTokens > inputTokens ||
    (beyondSplit > 0 &&
      Math.abs(beyondSplit - cachedTokens) <= cachedTokens * SEPARATE_CACHE_TOLERANCE);
  const subsetCached = separateCache ? 0 : cachedTokens;
  const cacheWrites = Math.min(
    count(bucket.cacheWriteInputTokens),
    Math.max(0, inputTokens - subsetCached),
  );
  return {
    uncachedInputTokens: Math.max(0, inputTokens - subsetCached - cacheWrites),
    cachedInputTokens: cachedTokens,
    cacheCreationInputTokens: cacheWrites,
    outputTokens,
  };
}

/** A provider alias (`opus`, `sol`, …) priced as the model it stands for. */
function canonicalStatisticsModel(model: string, provider: string | undefined): string {
  const aliases =
    provider === undefined
      ? undefined
      : (MODEL_SLUG_ALIASES_BY_PROVIDER as Partial<Record<string, Record<string, string>>>)[
          provider
        ];
  return aliases?.[model.trim()] ?? model;
}

/** Estimated USD of one bucket, or undefined when it has no tokens or no known price. */
export function priceStatisticsBucket(
  policy: UsagePricingPolicy,
  bucket: StatisticsDailyBucket,
): number | undefined {
  const tokens = statisticsBucketTokenCounts(bucket);
  if (tokens === undefined) return undefined;
  const { rate } = resolveUsageModel(
    policy,
    canonicalStatisticsModel(bucket.model, bucket.provider),
  );
  if (rate === null) return undefined;
  return estimateUsageCost(resolveSpeedRate(rate, bucket.speed), tokens);
}

/** The snapshot with every priceable bucket's `costUsd` and the rates' state. */
export function priceStatisticsSnapshot(
  snapshot: StatisticsSnapshot,
  policy: UsagePricingPolicy,
  state: UsagePricingState,
): StatisticsSnapshot {
  return {
    ...snapshot,
    dailyBuckets: snapshot.dailyBuckets.map((bucket) => {
      const { costUsd: _previous, ...unpriced } = bucket;
      const costUsd = priceStatisticsBucket(policy, unpriced);
      return costUsd === undefined ? unpriced : { ...unpriced, costUsd };
    }),
    pricing: state,
  };
}
