import type { StatisticsDailyBucket } from "@ryco/contracts";
import { estimateAggregateCost, estimateCostUsd } from "~/lib/modelPricing";
import { emptyTotals, accumulate, type MetricTotals } from "@ryco/client-runtime/usage";
export * from "@ryco/client-runtime/usage";
function snapshotTotals(totals: MetricTotals): MetricTotals {
  return { ...totals };
}
export interface ModelAggregate extends MetricTotals {
  readonly model: string;
  readonly provider: string | undefined;
  readonly costUsd: number | null;
}

export function aggregateByModel(
  buckets: ReadonlyArray<StatisticsDailyBucket>,
): Array<ModelAggregate> {
  const byModel = new Map<string, MetricTotals>();
  const modelRefByKey = new Map<string, { model: string; provider: string | undefined }>();
  for (const bucket of buckets) {
    const key = `${bucket.provider ?? ""}\u0000${bucket.model}`;
    let totals = byModel.get(key);
    if (!totals) {
      totals = emptyTotals();
      byModel.set(key, totals);
      modelRefByKey.set(key, { model: bucket.model, provider: bucket.provider });
    }
    accumulate(totals, bucket);
  }
  return [...byModel.entries()]
    .map(([key, totals]) => {
      const ref = modelRefByKey.get(key) ?? { model: "unknown", provider: undefined };
      return Object.assign(snapshotTotals(totals), {
        model: ref.model,
        provider: ref.provider,
        costUsd: estimateCostUsd(
          {
            inputTokens: totals.inputTokens,
            cachedInputTokens: totals.cachedInputTokens,
            outputTokens: totals.outputTokens,
            totalTokens: totals.totalTokens,
          },
          ref.model,
          ref.provider,
        ),
      });
    })
    .toSorted((a, b) => b.totalTokens - a.totalTokens);
}

export function aggregateCostForModels(models: ReadonlyArray<ModelAggregate>) {
  return estimateAggregateCost(
    models.map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      inputTokens: entry.inputTokens,
      cachedInputTokens: entry.cachedInputTokens,
      outputTokens: entry.outputTokens,
      totalTokens: entry.totalTokens,
    })),
  );
}
