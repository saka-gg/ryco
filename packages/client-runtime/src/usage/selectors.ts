// @effect-diagnostics globalDate:off
import type { UsageImportedMetric, UsageProviderKind } from "@ryco/contracts";
import { USAGE_PROVIDERS } from "./providers.ts";
import type { MergedUsageBucket, MergedUsageSummary } from "./merge.ts";

export interface UsageTotals {
  readonly totalTokens: number;
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number | null;
  readonly responseCount: number;
  readonly distinctSessionCount: number;
  readonly estimatedCostUsd: number | null;
  readonly estimatedCacheSavingsUsd: number | null;
  readonly pricedTokenCount: number;
  readonly unpricedTokenCount: number;
}

export interface UsageDayPoint {
  readonly date: string;
  readonly claudeCost: number | null;
  readonly codexCost: number | null;
  readonly claudeTokens: number | null;
  readonly codexTokens: number | null;
  readonly cursorCost: number | null;
  readonly opencodeCost: number | null;
  readonly cursorTokens: number | null;
  readonly opencodeTokens: number | null;
}

export interface UsageBreakdownRow {
  readonly key: string;
  readonly label: string;
  readonly provider?: UsageProviderKind;
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
  let reasoningTokens: number | null = 0;
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
    reasoningTokens =
      reasoningTokens === null || bucket.tokens.reasoningTokens === undefined
        ? null
        : reasoningTokens + bucket.tokens.reasoningTokens;
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
  const exportSessions = new Set(buckets.flatMap((bucket) => bucket.exportSessionIds ?? []));
  const distinctSessionCount =
    exportSessions.size +
    summary.sources
      .filter(
        (source) =>
          source.included &&
          activeProviders.has(source.provider) &&
          !(source.provider === "cursor" && source.deduplicationKind === "declared") &&
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
  const emptyDay = (date: string): UsageDayPoint => ({
    date,
    claudeCost: null,
    codexCost: null,
    cursorCost: null,
    opencodeCost: null,
    claudeTokens: null,
    codexTokens: null,
    cursorTokens: null,
    opencodeTokens: null,
  });
  for (const bucket of buckets) {
    const current = byDate.get(bucket.date) ?? emptyDay(bucket.date);
    const provider = bucket.provider;
    const costKey = `${provider}Cost` as const;
    const tokenKey = `${provider}Tokens` as const;
    byDate.set(bucket.date, {
      ...current,
      [costKey]:
        bucket.estimatedCostUsd === undefined
          ? current[costKey]
          : (current[costKey] ?? 0) + bucket.estimatedCostUsd,
      [tokenKey]: (current[tokenKey] ?? 0) + bucket.tokens.totalTokens,
    });
  }
  const firstDate = summary.startDate ?? [...byDate.keys()].toSorted()[0];
  if (firstDate === undefined) return [];
  const selected = new Set(buckets.map((bucket) => bucket.provider));
  const completeProviders = new Set(
    USAGE_PROVIDERS.filter((provider) => {
      const coverage = summary.sources.filter(
        (source) => source.included && source.provider === provider,
      );
      return (
        selected.has(provider) &&
        coverage.length > 0 &&
        coverage.every((source) => source.status === "complete")
      );
    }),
  );
  const points: UsageDayPoint[] = [];
  // Provider timestamps are untrusted; bound chart expansion to 100 years.
  for (
    let date = firstDate;
    date <= summary.endDate && points.length < 36_600;
    date = shiftDate(date, 1)
  ) {
    const day = byDate.get(date) ?? emptyDay(date);
    const filled = { ...day };
    for (const provider of USAGE_PROVIDERS) {
      if (completeProviders.has(provider)) {
        filled[`${provider}Tokens`] ??= 0;
        // A day containing unpriced tokens cannot assert a zero cost.
        if (day[`${provider}Tokens`] === null) filled[`${provider}Cost`] ??= 0;
      }
    }
    points.push(filled);
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

export function filterUsageImports(
  summary: MergedUsageSummary,
  providers?: readonly string[],
): readonly UsageImportedMetric[] {
  return providers === undefined || providers.length === 0 || providers.includes("cursor")
    ? (summary.imports ?? [])
    : [];
}
export function sumUsageImports(rows: readonly UsageImportedMetric[]): {
  readonly requests: number | null;
  readonly costs: readonly { currency: string; value: number }[];
} {
  let requests: number | null = null;
  const costs = new Map<string, number>();
  for (const row of rows) {
    if (row.metric === "requests") requests = (requests ?? 0) + row.value;
    else if (row.currency) costs.set(row.currency, (costs.get(row.currency) ?? 0) + row.value);
  }
  return { requests, costs: [...costs].map(([currency, value]) => ({ currency, value })) };
}
