import type * as React from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { chartColor, ChartTooltipContent } from "~/components/ui/chart";
import { cn } from "~/lib/utils";
import { formatDayLabel, formatProviderLabel, formatTokens } from "~/lib/statisticsFormat";

import type { DayPoint, ProviderAggregate } from "./selectors";

/*
 * Charts for the settings StatisticsPanel (the frozen phone tier). Its token
 * area and provider donut still use Recharts; the bar charts are the Statistics
 * page's plain SVG ones, which keep Recharts out of that page's bundle.
 */
export { CodeChangesChart, ProjectBars } from "../../statistics/charts";

/**
 * Responsive wrapper around Recharts. The caller controls the size via
 * `className` (e.g. `h-[240px] w-full`); the chart fills it. Tick/grid/cursor
 * styling is normalised to the design tokens here so individual charts stay
 * declarative.
 */
function ChartContainer({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { children: React.ReactElement }) {
  return (
    <div
      data-slot="chart"
      className={cn(
        "w-full text-xs",
        "[&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground",
        "[&_.recharts-cartesian-axis-line]:stroke-border/70",
        "[&_.recharts-cartesian-grid_line]:stroke-border/50",
        "[&_.recharts-curve.recharts-tooltip-cursor]:stroke-border",
        "[&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted/50",
        "[&_.recharts-sector]:outline-none [&_.recharts-surface]:outline-none",
        className,
      )}
      {...props}
    >
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  );
}

const ChartTooltip = Tooltip;

export function TokensOverTimeChart({ data }: { data: ReadonlyArray<DayPoint> }) {
  const hasUncategorized = data.some((point) => point.uncategorizedTokens > 0);
  return (
    <ChartContainer className="h-[240px]">
      <AreaChart data={[...data]} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
        <defs>
          <linearGradient id="statFillInput" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={chartColor(0)} stopOpacity={0.4} />
            <stop offset="95%" stopColor={chartColor(0)} stopOpacity={0.04} />
          </linearGradient>
          <linearGradient id="statFillOutput" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={chartColor(1)} stopOpacity={0.4} />
            <stop offset="95%" stopColor={chartColor(1)} stopOpacity={0.04} />
          </linearGradient>
          <linearGradient id="statFillOther" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={chartColor(2)} stopOpacity={0.35} />
            <stop offset="95%" stopColor={chartColor(2)} stopOpacity={0.04} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={28}
          tickFormatter={(value) => formatDayLabel(String(value))}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={38}
          tickFormatter={(value) => formatTokens(Number(value) || 0)}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(label) => formatDayLabel(String(label))}
              formatter={(value) => formatTokens(Number(value) || 0)}
            />
          }
        />
        <Area
          dataKey="inputTokens"
          name="Input"
          type="monotone"
          stackId="tokens"
          stroke={chartColor(0)}
          fill="url(#statFillInput)"
          strokeWidth={1.5}
        />
        <Area
          dataKey="outputTokens"
          name="Output"
          type="monotone"
          stackId="tokens"
          stroke={chartColor(1)}
          fill="url(#statFillOutput)"
          strokeWidth={1.5}
        />
        {hasUncategorized ? (
          <Area
            dataKey="uncategorizedTokens"
            name="Other"
            type="monotone"
            stackId="tokens"
            stroke={chartColor(2)}
            fill="url(#statFillOther)"
            strokeWidth={1.5}
          />
        ) : null}
      </AreaChart>
    </ChartContainer>
  );
}

export function ProviderDonut({ data }: { data: ReadonlyArray<ProviderAggregate> }) {
  const chartData = data.map((entry, index) => ({
    name: formatProviderLabel(entry.provider),
    value: entry.totalTokens,
    fill: chartColor(index),
  }));
  const total = chartData.reduce((acc, entry) => acc + entry.value, 0);

  if (total === 0) {
    return (
      <div className="py-10 text-center text-muted-foreground text-xs">No token usage yet.</div>
    );
  }

  return (
    <div className="flex items-center gap-4">
      <ChartContainer className="h-[200px] w-[200px] shrink-0">
        <PieChart>
          <ChartTooltip
            content={
              <ChartTooltipContent
                hideLabel
                formatter={(value) => formatTokens(Number(value) || 0)}
              />
            }
          />
          <Pie
            data={chartData}
            dataKey="value"
            nameKey="name"
            innerRadius={56}
            outerRadius={84}
            paddingAngle={2}
            strokeWidth={2}
          >
            {chartData.map((entry) => (
              <Cell key={entry.name} fill={entry.fill} stroke="var(--card)" />
            ))}
          </Pie>
        </PieChart>
      </ChartContainer>
      <ul className="flex min-w-0 flex-1 flex-col gap-2">
        {chartData.map((entry) => {
          const share = Math.round((entry.value / total) * 100);
          return (
            <li key={entry.name} className="flex items-center gap-2 text-xs">
              <span
                className="size-2.5 shrink-0 rounded-[3px]"
                style={{ backgroundColor: entry.fill }}
              />
              <span className="min-w-0 flex-1 truncate text-foreground">{entry.name}</span>
              <span className="text-muted-foreground tabular-nums">{share}%</span>
              <span className="w-12 text-right font-medium text-foreground tabular-nums">
                {formatTokens(entry.value)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
