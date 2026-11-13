import type { StatisticsDailyBucket } from "@ryco/contracts";
import { emptyTotals, accumulate, type MetricTotals } from "@ryco/client-runtime/usage";
export * from "@ryco/client-runtime/usage";
function snapshotTotals(totals: MetricTotals): MetricTotals {
  return { ...totals };
}
export interface ModelAggregate extends MetricTotals {
  readonly model: string;
  readonly provider: string | undefined;
  /** Estimated USD; null when any of the model's usage has no known price. */
  readonly costUsd: number | null;
}

/** Usage a price applies to: buckets of turn counts or file changes alone cost nothing. */
function hasTokens(bucket: StatisticsDailyBucket): boolean {
  return (
    bucket.inputTokens > 0 ||
    bucket.outputTokens > 0 ||
    bucket.cachedInputTokens > 0 ||
    bucket.totalTokens > 0
  );
}

interface CostSum {
  usd: number;
  priced: boolean;
  unpriced: boolean;
  unpricedTokens: number;
}

function emptyCostSum(): CostSum {
  return { usd: 0, priced: false, unpriced: false, unpricedTokens: 0 };
}

/** Add one bucket's node-priced cost (see `StatisticsDailyBucket.costUsd`). */
function addBucketCost(sum: CostSum, bucket: StatisticsDailyBucket): void {
  if (bucket.costUsd !== undefined) {
    sum.usd += bucket.costUsd;
    sum.priced = true;
  } else if (hasTokens(bucket)) {
    sum.unpriced = true;
    sum.unpricedTokens += bucket.totalTokens;
  }
}

export function aggregateByModel(
  buckets: ReadonlyArray<StatisticsDailyBucket>,
): Array<ModelAggregate> {
  const byModel = new Map<
    string,
    { totals: MetricTotals; cost: CostSum; model: string; provider: string | undefined }
  >();
  for (const bucket of buckets) {
    const key = `${bucket.provider ?? ""}\u0000${bucket.model}`;
    let entry = byModel.get(key);
    if (!entry) {
      entry = {
        totals: emptyTotals(),
        cost: emptyCostSum(),
        model: bucket.model,
        provider: bucket.provider,
      };
      byModel.set(key, entry);
    }
    accumulate(entry.totals, bucket);
    addBucketCost(entry.cost, bucket);
  }
  return [...byModel.values()]
    .map((entry) =>
      Object.assign(snapshotTotals(entry.totals), {
        model: entry.model,
        provider: entry.provider,
        costUsd: entry.cost.unpriced || !entry.cost.priced ? null : entry.cost.usd,
      }),
    )
    .toSorted((a, b) => b.totalTokens - a.totalTokens);
}

export interface AggregateCost {
  /** Estimated spend of the priced usage, in USD. */
  readonly usd: number;
  /** True when at least one bucket with tokens has no known price. */
  readonly hasUnpriced: boolean;
  /** True when any usage was priced. */
  readonly priced: boolean;
  /** Tokens of the buckets without a known price. */
  readonly unpricedTokens: number;
}

function toAggregateCost(sum: CostSum): AggregateCost {
  return {
    usd: sum.usd,
    hasUnpriced: sum.unpriced,
    priced: sum.priced,
    unpricedTokens: sum.unpricedTokens,
  };
}

/** Sum the node-priced cost of buckets. */
export function aggregateCost(buckets: ReadonlyArray<StatisticsDailyBucket>): AggregateCost {
  const sum = emptyCostSum();
  for (const bucket of buckets) addBucketCost(sum, bucket);
  return toAggregateCost(sum);
}

/**
 * Who ran a bucket's usage. Ryco's own turn records and the subagents of sessions Ryco ran
 * (`ryco-subagent`, read from the provider's session files) are Ryco's; `outside` is a Claude
 * Code or Codex session Ryco did not run.
 */
export type UsageOrigin = "ryco" | "outside";

export function bucketOrigin(bucket: StatisticsDailyBucket): UsageOrigin {
  return bucket.source === "outside" ? "outside" : "ryco";
}

/** Tokens and node-priced cost of some usage. */
export interface TokenCost {
  readonly totalTokens: number;
  readonly cost: AggregateCost;
}

interface TokenCostSum {
  totalTokens: number;
  readonly cost: CostSum;
}

function emptyTokenCostSum(): TokenCostSum {
  return { totalTokens: 0, cost: emptyCostSum() };
}

function addTokenCost(sum: TokenCostSum, bucket: StatisticsDailyBucket): void {
  sum.totalTokens += bucket.totalTokens;
  addBucketCost(sum.cost, bucket);
}

function toTokenCost(sum: TokenCostSum): TokenCost {
  return { totalTokens: sum.totalTokens, cost: toAggregateCost(sum.cost) };
}

export interface TokenCostByOrigin {
  readonly all: TokenCost;
  readonly ryco: TokenCost;
  readonly outside: TokenCost;
}

/** Tokens and cost of `buckets`, in all and split by {@link UsageOrigin}. */
export function aggregateTokenCostByOrigin(
  buckets: ReadonlyArray<StatisticsDailyBucket>,
): TokenCostByOrigin {
  const all = emptyTokenCostSum();
  const byOrigin: Record<UsageOrigin, TokenCostSum> = {
    ryco: emptyTokenCostSum(),
    outside: emptyTokenCostSum(),
  };
  for (const bucket of buckets) {
    addTokenCost(all, bucket);
    addTokenCost(byOrigin[bucketOrigin(bucket)], bucket);
  }
  return {
    all: toTokenCost(all),
    ryco: toTokenCost(byOrigin.ryco),
    outside: toTokenCost(byOrigin.outside),
  };
}

export type TokenCostDimension = "provider" | "model" | "project";

/** One provider, model or project: its tokens and cost, and how many tokens each origin ran. */
export interface TokenCostRow extends TokenCost {
  readonly key: string;
  /** Provider and model rows. */
  readonly provider: string | undefined;
  /** Model rows. */
  readonly model: string | undefined;
  /** Project rows. */
  readonly projectId: string | undefined;
  readonly rycoTokens: number;
  readonly outsideTokens: number;
}

function dimensionKey(bucket: StatisticsDailyBucket, dimension: TokenCostDimension): string {
  switch (dimension) {
    case "provider":
      return bucket.provider ?? "";
    case "model":
      return `${bucket.provider ?? ""}\u0000${bucket.model}`;
    case "project":
      return bucket.projectId;
  }
}

/**
 * Tokens and cost of `buckets` per provider, model or project, largest first. Rows that ran no
 * tokens (turn counts or file changes alone) are left out.
 */
export function aggregateTokenCostRows(
  buckets: ReadonlyArray<StatisticsDailyBucket>,
  dimension: TokenCostDimension,
): Array<TokenCostRow> {
  const rows = new Map<
    string,
    {
      readonly sum: TokenCostSum;
      readonly first: StatisticsDailyBucket;
      readonly origin: Record<UsageOrigin, number>;
    }
  >();
  for (const bucket of buckets) {
    const key = dimensionKey(bucket, dimension);
    let row = rows.get(key);
    if (!row) {
      row = { sum: emptyTokenCostSum(), first: bucket, origin: { ryco: 0, outside: 0 } };
      rows.set(key, row);
    }
    addTokenCost(row.sum, bucket);
    row.origin[bucketOrigin(bucket)] += bucket.totalTokens;
  }
  return [...rows.entries()]
    .filter(([, row]) => row.sum.totalTokens > 0 || row.sum.cost.usd > 0)
    .map(([key, row]) => ({
      totalTokens: row.sum.totalTokens,
      cost: toAggregateCost(row.sum.cost),
      key,
      provider: dimension === "project" ? undefined : row.first.provider,
      model: dimension === "model" ? row.first.model : undefined,
      projectId: dimension === "project" ? row.first.projectId : undefined,
      rycoTokens: row.origin.ryco,
      outsideTokens: row.origin.outside,
    }))
    .toSorted((a, b) => b.totalTokens - a.totalTokens || b.cost.usd - a.cost.usd);
}
