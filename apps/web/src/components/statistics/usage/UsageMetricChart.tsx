import { formatInteger, formatTokens, formatUsd } from "~/lib/statisticsFormat";

import { SeriesAreaChart, type AreaSeries } from "../charts";

export type UsageChartMetric = "cost" | "tokens";

/** Daily usage in USD or tokens, with the axis and tooltip formats of the usage view. */
export function UsageMetricChart({
  dates,
  series,
  metric,
  label,
  className,
}: {
  readonly dates: readonly string[];
  readonly series: readonly AreaSeries[];
  readonly metric: UsageChartMetric;
  readonly label: string;
  readonly className: string;
}) {
  return (
    <SeriesAreaChart
      className={className}
      label={label}
      dates={dates}
      series={series}
      yAxisWidth={44}
      dashedGrid
      formatYTick={(value) =>
        metric === "cost" ? `$${value.toFixed(value < 10 ? 1 : 0)}` : formatTokens(value)
      }
      formatValue={(value) => (metric === "cost" ? formatUsd(value) : formatInteger(value))}
    />
  );
}
