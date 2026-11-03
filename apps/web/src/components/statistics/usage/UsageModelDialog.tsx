import {
  USAGE_PROVIDER_COLORS,
  buildUsageModelDetail,
  formatUsageCostShare,
  type MergedUsageBucket,
  type MergedUsageSummary,
  type UsageModelDetail,
  type UsageModelKey,
} from "@ryco/client-runtime/usage";
import { useMemo } from "react";

import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  formatInteger,
  formatModelLabel,
  formatProviderLabel,
  formatTokens,
  formatUsd,
} from "~/lib/statisticsFormat";

import { CostByTypeBar } from "./CostByTypeBar";
import { UsageMetricChart, type UsageChartMetric } from "./UsageMetricChart";

/**
 * One model of the usage view's breakdown: its totals, effective rate, cache reads, cost by type
 * and daily trend over the selected buckets. The usage view loads it on the first open.
 */
export function UsageModelDialog({
  target,
  open,
  onOpenChange,
  onClosed,
  summary,
  buckets,
  metric,
}: {
  readonly target: UsageModelKey;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** After the close animation: the owner can unmount the dialog. */
  readonly onClosed: () => void;
  readonly summary: MergedUsageSummary;
  readonly buckets: readonly MergedUsageBucket[];
  readonly metric: UsageChartMetric;
}) {
  const detail = useMemo(
    () => buildUsageModelDetail(summary, buckets, target),
    [summary, buckets, target],
  );
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(next) => {
        if (!next) onClosed();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{formatModelLabel(target.model)}</DialogTitle>
          <DialogDescription>
            {formatProviderLabel(target.provider)} ·{" "}
            <span className="font-mono text-xs">{target.model}</span>
          </DialogDescription>
        </DialogHeader>
        {detail === null ? (
          <DialogPanel>
            <p className="text-sm text-muted-foreground">
              No usage of this model matches the current filters.
            </p>
          </DialogPanel>
        ) : (
          <ModelDetail detail={detail} metric={metric} timeZone={summary.timeZone} />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function ModelDetail({
  detail,
  metric,
  timeZone,
}: {
  readonly detail: UsageModelDetail;
  readonly metric: UsageChartMetric;
  readonly timeZone: string;
}) {
  // An unpriced model's cost is unknown, not zero, so its trend shows tokens.
  const chartMetric = detail.costUsd === null ? "tokens" : metric;
  const dates = useMemo(() => detail.days.map((day) => day.date), [detail]);
  const series = useMemo(
    () => [
      {
        key: detail.provider,
        label: chartMetric === "cost" ? "Estimated cost" : "Tokens",
        color: USAGE_PROVIDER_COLORS[detail.provider],
        values: detail.days.map((day) => (chartMetric === "cost" ? day.costUsd : day.tokens)),
      },
    ],
    [detail, chartMetric],
  );
  const stats = [
    {
      label: "Estimated cost",
      value: detail.costUsd === null ? "Unpriced" : formatUsd(detail.costUsd),
      detail:
        detail.costShare === null
          ? `${formatUsageCostShare(detail.tokenShare)} of tokens`
          : `${formatUsageCostShare(detail.costShare)} of estimated cost`,
    },
    {
      label: "Tokens",
      value: formatTokens(detail.totalTokens),
      detail: `${formatInteger(detail.responseCount)} responses`,
    },
    {
      label: "Per 1M tokens",
      value:
        detail.costPerMillionPricedTokensUsd === null
          ? "Unavailable"
          : formatUsd(detail.costPerMillionPricedTokensUsd),
      detail:
        detail.costPerMillionPricedTokensUsd === null
          ? "no priced tokens"
          : detail.unpricedTokenCount > 0
            ? "priced tokens only"
            : "all token types",
    },
    {
      label: "Cache read",
      value:
        detail.cacheReadShare === null
          ? "Unavailable"
          : formatUsageCostShare(detail.cacheReadShare),
      detail: "of input tokens",
    },
  ];
  return (
    <>
      <DialogPanel>
        <div className="space-y-6">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
            {stats.map((stat) => (
              <div key={stat.label} className="min-w-0">
                <dt className="text-[10px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
                  {stat.label}
                </dt>
                <dd className="mt-1.5 text-xl font-semibold tracking-tight tabular-nums">
                  {stat.value}
                </dd>
                <dd className="mt-0.5 text-[11px] text-muted-foreground">{stat.detail}</dd>
              </div>
            ))}
          </dl>
          <section>
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <h3 className="text-sm font-semibold">
                {chartMetric === "cost" ? "Daily cost" : "Daily tokens"}
              </h3>
              <p className="text-xs text-muted-foreground">in {timeZone}</p>
            </div>
            <UsageMetricChart
              className="h-52"
              label={chartMetric === "cost" ? "Daily cost" : "Daily tokens"}
              dates={dates}
              series={series}
              metric={chartMetric}
            />
          </section>
          {detail.breakdown === null ? null : <CostByTypeBar totals={detail.breakdown} />}
        </div>
      </DialogPanel>
      {detail.unpricedTokenCount > 0 ? (
        <DialogFooter variant="bare" className="sm:justify-start">
          <p className="text-xs leading-relaxed text-muted-foreground">
            {detail.pricedTokenCount > 0
              ? `${formatTokens(detail.unpricedTokenCount)} of these tokens have no published API rate, so their cost is not estimated.`
              : "This model has no published API rate, so its cost is not estimated."}
          </p>
        </DialogFooter>
      ) : null}
    </>
  );
}
