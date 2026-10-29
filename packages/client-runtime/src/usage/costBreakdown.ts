import type { UsageTokenTotals } from "@ryco/contracts/usage";
import type { MergedUsageBucket } from "./merge.ts";

/** Estimated cost of a set of usage buckets by token type, at the billed speed. */
export interface UsageCostBreakdownTotals {
  /** Σ `estimatedCostUsd` of the buckets. */
  readonly totalUsd: number;
  readonly inputUsd: number;
  readonly cacheReadUsd: number;
  readonly cacheWriteUsd: number;
  readonly outputUsd: number;
  /** Cost no node split: the total minus the parts, 0 below half a cent (rounding, float noise). */
  readonly otherUsd: number;
  /** Included in the four parts: what fast/ultrafast tiers added over standard rates. */
  readonly speedPremiumUsd: number;
  /**
   * Priced buckets whose cost is not (fully) split: provider-reported cost without a published
   * rate, or a node that predates the split (merged with a newer one's bucket or alone).
   */
  readonly unsplitBucketCount: number;
}

/** Unsplit cost below half a cent would show as "$0.00 · 0%": rounding, not a share. */
const OTHER_NOISE_USD = 0.005;
/** Nodes round each emitted part to 1e-8 USD, and merged buckets add a few of those. */
const SPLIT_TOLERANCE_USD = 1e-6;

/** Null when no bucket has a cost. */
export function sumUsageCostBreakdown(
  buckets: readonly MergedUsageBucket[],
): UsageCostBreakdownTotals | null {
  let hasCost = false;
  let totalUsd = 0;
  let inputUsd = 0;
  let cacheReadUsd = 0;
  let cacheWriteUsd = 0;
  let outputUsd = 0;
  let speedPremiumUsd = 0;
  let unsplitBucketCount = 0;
  for (const bucket of buckets) {
    const costUsd = bucket.estimatedCostUsd;
    if (costUsd === undefined) continue;
    hasCost = true;
    totalUsd += costUsd;
    const split = bucket.costBreakdown;
    if (split === undefined) {
      if (costUsd > 0) unsplitBucketCount += 1;
      continue;
    }
    inputUsd += split.inputUsd;
    cacheReadUsd += split.cacheReadUsd;
    cacheWriteUsd += split.cacheWriteUsd;
    outputUsd += split.outputUsd;
    speedPremiumUsd += split.speedPremiumUsd ?? 0;
    const splitUsd = split.inputUsd + split.cacheReadUsd + split.cacheWriteUsd + split.outputUsd;
    if (costUsd - splitUsd > SPLIT_TOLERANCE_USD) unsplitBucketCount += 1;
  }
  if (!hasCost) return null;
  const otherUsd = totalUsd - (inputUsd + cacheReadUsd + cacheWriteUsd + outputUsd);
  return {
    totalUsd,
    inputUsd,
    cacheReadUsd,
    cacheWriteUsd,
    outputUsd,
    otherUsd: otherUsd < OTHER_NOISE_USD ? 0 : otherUsd,
    speedPremiumUsd,
    unsplitBucketCount,
  };
}

export type UsageCostType = "input" | "cacheRead" | "cacheWrite" | "output" | "other";

export const USAGE_COST_TYPE_LABELS: Readonly<Record<UsageCostType, string>> = {
  input: "Input",
  cacheRead: "Cache read",
  cacheWrite: "Cache write",
  output: "Output",
  other: "Other",
};

// Mid tones that read on light and dark cards and stay apart from the provider colors.
export const USAGE_COST_TYPE_COLORS: Readonly<Record<UsageCostType, string>> = {
  input: "#5b8def",
  cacheRead: "#3fb3a3",
  cacheWrite: "#d4a23c",
  output: "#b072d6",
  other: "#8b9099",
};

export interface UsageCostTypeShare {
  readonly type: UsageCostType;
  readonly usd: number;
  /** Of the shown types' sum, so a stacked bar fills exactly. */
  readonly share: number;
}

/**
 * The types with a cost, in display order. Empty when nothing is split: a bar that is all
 * "Other" says nothing the total does not.
 */
export function listUsageCostTypeShares(
  totals: UsageCostBreakdownTotals,
): readonly UsageCostTypeShare[] {
  const amounts: readonly (readonly [UsageCostType, number])[] = [
    ["input", totals.inputUsd],
    ["cacheRead", totals.cacheReadUsd],
    ["cacheWrite", totals.cacheWriteUsd],
    ["output", totals.outputUsd],
    ["other", totals.otherUsd],
  ];
  const shown = amounts.filter(([, usd]) => usd > 0);
  const shownUsd = shown.reduce((sum, [, usd]) => sum + usd, 0);
  if (shown.every(([type]) => type === "other")) return [];
  return shown.map(([type, usd]) => ({ type, usd, share: usd / shownUsd }));
}

/** "32%", or "<1%" for a share that would round to a misleading 0%. */
export function formatUsageCostShare(share: number): string {
  return share > 0 && share < 0.005 ? "<1%" : `${Math.round(share * 100)}%`;
}

/** Cache reads as a share of all input tokens; null without input tokens. */
export function usageCacheReadShare(
  totals: Pick<
    UsageTokenTotals,
    "uncachedInputTokens" | "cachedInputTokens" | "cacheCreationInputTokens"
  >,
): number | null {
  const inputTokens =
    totals.uncachedInputTokens + totals.cachedInputTokens + totals.cacheCreationInputTokens;
  return inputTokens > 0 ? totals.cachedInputTokens / inputTokens : null;
}
