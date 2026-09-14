// @effect-diagnostics globalDate:off
import type { MergedUsageBucket, MergedUsageSummary } from "./merge.ts";

export interface UsageTotals {
  readonly totalTokens: number;
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly responseCount: number;
  readonly distinctSessionCount: number;
  readonly estimatedCostUsd: number | null;
  readonly estimatedCacheSavingsUsd: number | null;
  readonly pricedTokenCount: number;
  readonly unpricedTokenCount: number;
}

export interface UsageDayPoint {
  readonly date: string;
  readonly claudeCost: number;
  readonly codexCost: number;
  readonly claudeTokens: number;
  readonly codexTokens: number;
}

export interface UsageBreakdownRow {
  readonly key: string;
  readonly label: string;
  readonly provider?: "claude" | "codex";
  readonly tokens: number;
  readonly costUsd: number | null;
  readonly unpricedTokens: number;
  readonly responses: number;
}

export function filterUsageBuckets(
  summary: MergedUsageSummary,
  providers?: readonly string[],
): readonly MergedUsageBucket[] {
  if (providers === undefined || providers.length === 0) return summary.buckets;
  const selected = new Set(providers);
  return summary.buckets.filter((bucket) => selected.has(bucket.provider));
}

export function sumUsageTotals(
  summary: MergedUsageSummary,
  buckets: readonly MergedUsageBucket[],
): UsageTotals {
  let totalTokens = 0;
  let uncachedInputTokens = 0;
  let cachedInputTokens = 0;
  let cacheCreationInputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let responseCount = 0;
  let estimatedCostUsd = 0;
  let estimatedCacheSavingsUsd = 0;
  let hasCost = false;
  let hasSavings = false;
  let pricedTokenCount = 0;
  let unpricedTokenCount = 0;
  for (const bucket of buckets) {
    totalTokens += bucket.tokens.totalTokens;
    uncachedInputTokens += bucket.tokens.uncachedInputTokens;
    cachedInputTokens += bucket.tokens.cachedInputTokens;
    cacheCreationInputTokens += bucket.tokens.cacheCreationInputTokens;
    outputTokens += bucket.tokens.outputTokens;
    reasoningTokens += bucket.tokens.reasoningTokens;
    responseCount += bucket.responseCount;
    pricedTokenCount += bucket.pricedTokenCount;
    unpricedTokenCount += bucket.unpricedTokenCount;
    if (bucket.estimatedCostUsd !== undefined) {
      estimatedCostUsd += bucket.estimatedCostUsd;
      hasCost = true;
    }
    if (bucket.estimatedCacheSavingsUsd !== undefined) {
      estimatedCacheSavingsUsd += bucket.estimatedCacheSavingsUsd;
      hasSavings = true;
    }
  }
  const activeProviders = new Set(buckets.map((bucket) => bucket.provider));
  const distinctSessionCount = summary.sources
    .filter(
      (source) =>
        source.included &&
        activeProviders.has(source.provider) &&
        source.status !== "not-found" &&
        source.status !== "failed",
    )
    .reduce((sum, source) => sum + source.distinctSessionCount, 0);
  return {
    totalTokens,
    uncachedInputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    outputTokens,
    reasoningTokens,
    responseCount,
    distinctSessionCount,
    estimatedCostUsd: hasCost ? estimatedCostUsd : null,
    estimatedCacheSavingsUsd: hasSavings ? estimatedCacheSavingsUsd : null,
    pricedTokenCount,
    unpricedTokenCount,
  };
}

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T12:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

export function buildUsageDaySeries(
  summary: MergedUsageSummary,
  buckets: readonly MergedUsageBucket[],
): readonly UsageDayPoint[] {
  const byDate = new Map<string, UsageDayPoint>();
  for (const bucket of buckets) {
    const current = byDate.get(bucket.date) ?? {
      date: bucket.date,
      claudeCost: 0,
      codexCost: 0,
      claudeTokens: 0,
      codexTokens: 0,
    };
    byDate.set(bucket.date, {
      ...current,
      ...(bucket.provider === "claude"
        ? {
            claudeCost: current.claudeCost + (bucket.estimatedCostUsd ?? 0),
            claudeTokens: current.claudeTokens + bucket.tokens.totalTokens,
          }
        : {
            codexCost: current.codexCost + (bucket.estimatedCostUsd ?? 0),
            codexTokens: current.codexTokens + bucket.tokens.totalTokens,
          }),
    });
  }
  const firstDate =
    summary.startDate ?? [...byDate.keys()].toSorted((left, right) => left.localeCompare(right))[0];
  if (firstDate === undefined) return [];
  const points: UsageDayPoint[] = [];
  for (let date = firstDate; date <= summary.endDate; date = shiftDate(date, 1)) {
    points.push(
      byDate.get(date) ?? {
        date,
        claudeCost: 0,
        codexCost: 0,
        claudeTokens: 0,
        codexTokens: 0,
      },
    );
  }
  return points;
}

export function buildUsageBreakdown(
  buckets: readonly MergedUsageBucket[],
  dimension: "model" | "day",
): readonly UsageBreakdownRow[] {
  const rows = new Map<string, UsageBreakdownRow>();
  for (const bucket of buckets) {
    const key = dimension === "model" ? `${bucket.provider}\0${bucket.model}` : bucket.date;
    const current = rows.get(key) ?? {
      key,
      label: dimension === "model" ? bucket.model : bucket.date,
      ...(dimension === "model" ? { provider: bucket.provider } : {}),
      tokens: 0,
      costUsd: null,
      unpricedTokens: 0,
      responses: 0,
    };
    rows.set(key, {
      ...current,
      tokens: current.tokens + bucket.tokens.totalTokens,
      costUsd:
        bucket.estimatedCostUsd === undefined
          ? current.costUsd
          : (current.costUsd ?? 0) + bucket.estimatedCostUsd,
      unpricedTokens: current.unpricedTokens + bucket.unpricedTokenCount,
      responses: current.responses + bucket.responseCount,
    });
  }
  const hasAnyCost = [...rows.values()].some((row) => row.costUsd !== null);
  return [...rows.values()].toSorted((left, right) =>
    hasAnyCost
      ? (right.costUsd ?? -1) - (left.costUsd ?? -1) || right.tokens - left.tokens
      : right.tokens - left.tokens,
  );
}
