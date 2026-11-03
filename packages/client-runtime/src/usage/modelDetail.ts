import type { UsageProviderKind } from "@ryco/contracts";

import {
  sumUsageCostBreakdown,
  usageCacheReadShare,
  type UsageCostBreakdownTotals,
} from "./costBreakdown.ts";
import type { MergedUsageBucket, MergedUsageSummary } from "./merge.ts";
import { buildUsageDaySeries, sumUsageTotals } from "./selectors.ts";

/** One provider's model, as the model breakdown lists it. */
export interface UsageModelKey {
  readonly provider: UsageProviderKind;
  readonly model: string;
}

export interface UsageModelDay {
  readonly date: string;
  /** Null on a day with unpriced usage only, or when the provider's coverage is incomplete. */
  readonly costUsd: number | null;
  /** Null when the provider's coverage is incomplete: unknown, not zero. */
  readonly tokens: number | null;
}

/**
 * One model's usage in the selected buckets. There is no session count: buckets count
 * sessions per day and model, so summing them counts a multi-day session more than once.
 */
export interface UsageModelDetail extends UsageModelKey {
  /** Null when none of the model's tokens has a price. */
  readonly costUsd: number | null;
  /** Of the selected buckets' estimated cost; null when either side has none. */
  readonly costShare: number | null;
  readonly totalTokens: number;
  /** Of the selected buckets' tokens. */
  readonly tokenShare: number;
  readonly pricedTokenCount: number;
  readonly unpricedTokenCount: number;
  readonly responseCount: number;
  /** The effective rate over the priced tokens only, which unpriced ones would dilute. */
  readonly costPerMillionPricedTokensUsd: number | null;
  /** Cache reads as a share of all input tokens; null without input. */
  readonly cacheReadShare: number | null;
  readonly breakdown: UsageCostBreakdownTotals | null;
  /** Every day of the summary window; an open window starts at the model's first day. */
  readonly days: readonly UsageModelDay[];
}

/** Null when no selected bucket belongs to the model. */
export function buildUsageModelDetail(
  summary: MergedUsageSummary,
  buckets: readonly MergedUsageBucket[],
  { provider, model }: UsageModelKey,
): UsageModelDetail | null {
  const modelBuckets: MergedUsageBucket[] = [];
  let allTokens = 0;
  let allCostUsd: number | null = null;
  for (const bucket of buckets) {
    allTokens += bucket.tokens.totalTokens;
    if (bucket.estimatedCostUsd !== undefined) {
      allCostUsd = (allCostUsd ?? 0) + bucket.estimatedCostUsd;
    }
    if (bucket.provider === provider && bucket.model === model) modelBuckets.push(bucket);
  }
  if (modelBuckets.length === 0) return null;

  const totals = sumUsageTotals(summary, modelBuckets);
  const costUsd = totals.estimatedCostUsd;
  return {
    provider,
    model,
    costUsd,
    costShare:
      costUsd === null || allCostUsd === null || allCostUsd <= 0 ? null : costUsd / allCostUsd,
    totalTokens: totals.totalTokens,
    tokenShare: allTokens > 0 ? totals.totalTokens / allTokens : 0,
    pricedTokenCount: totals.pricedTokenCount,
    unpricedTokenCount: totals.unpricedTokenCount,
    responseCount: totals.responseCount,
    costPerMillionPricedTokensUsd:
      costUsd === null || totals.pricedTokenCount <= 0
        ? null
        : (costUsd / totals.pricedTokenCount) * 1_000_000,
    cacheReadShare: usageCacheReadShare(totals),
    breakdown: sumUsageCostBreakdown(modelBuckets),
    // The page's day series over this model's buckets: the same window, gaps and zeros.
    days: buildUsageDaySeries(summary, modelBuckets).map((point) => ({
      date: point.date,
      costUsd: point[`${provider}Cost`],
      tokens: point[`${provider}Tokens`],
    })),
  };
}
