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
}

/** Add one bucket's node-priced cost (see `StatisticsDailyBucket.costUsd`). */
function addBucketCost(sum: CostSum, bucket: StatisticsDailyBucket): void {
  if (bucket.costUsd !== undefined) {
    sum.usd += bucket.costUsd;
    sum.priced = true;
  } else if (hasTokens(bucket)) {
    sum.unpriced = true;
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
        cost: { usd: 0, priced: false, unpriced: false },
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
}

/** Sum the node-priced cost of buckets. */
export function aggregateCost(buckets: ReadonlyArray<StatisticsDailyBucket>): AggregateCost {
  const sum: CostSum = { usd: 0, priced: false, unpriced: false };
  for (const bucket of buckets) addBucketCost(sum, bucket);
  return { usd: sum.usd, hasUnpriced: sum.unpriced, priced: sum.priced };
}
