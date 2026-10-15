import type { ReactNode } from "react";
import {
  AlertCircleIcon,
  ArrowDownRightIcon,
  ArrowUpRightIcon,
  type LucideIcon,
} from "lucide-react";

import { formatTimestamp } from "~/lib/statisticsFormat";
import { cn } from "~/lib/utils";

/** Section wrapper matching the settings aesthetic but without clipping (so chart tooltips can overflow). */
export function Panel({
  title,
  icon: Icon,
  action,
  children,
  className,
  bodyClassName,
}: {
  title: string;
  icon?: LucideIcon;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn("space-y-2.5", className)}>
      <div className="flex items-center justify-between px-1">
        <h2 className="flex items-center gap-2 font-semibold text-[11px] text-foreground/50 uppercase tracking-[0.08em]">
          <span className="inline-block h-px w-3 bg-border" aria-hidden />
          {Icon ? <Icon className="size-3.5" /> : null}
          {title}
        </h2>
        <div className="flex h-5 items-center justify-end">{action}</div>
      </div>
      <div
        className={cn(
          "rounded-2xl border bg-card text-card-foreground shadow-sm/4 not-dark:bg-clip-padding",
          bodyClassName,
        )}
      >
        {children}
      </div>
    </section>
  );
}

export function DeltaBadge({ percent }: { percent: number | null }) {
  if (percent === null || !Number.isFinite(percent)) {
    return null;
  }
  const rounded = Math.round(percent);
  if (rounded === 0) {
    return <span className="text-[11px] text-muted-foreground tabular-nums">0%</span>;
  }
  const up = rounded > 0;
  const Icon = up ? ArrowUpRightIcon : ArrowDownRightIcon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 font-medium text-[11px] tabular-nums",
        up ? "text-success-foreground" : "text-muted-foreground",
      )}
    >
      <Icon className="size-3" />
      {Math.abs(rounded)}%
    </span>
  );
}

export function Sparkline({
  points,
  className,
  stroke = "var(--primary)",
}: {
  points: ReadonlyArray<number>;
  className?: string;
  stroke?: string;
}) {
  if (points.length < 2) {
    return null;
  }
  const width = 72;
  const height = 24;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = max - min || 1;
  const step = width / (points.length - 1);
  const coords = points.map((value, index) => {
    const x = index * step;
    const y = height - ((value - min) / span) * (height - 2) - 1;
    return [x, y] as const;
  });
  const line = coords
    .map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("overflow-visible", className)}
      aria-hidden
      preserveAspectRatio="none"
    >
      <path d={area} fill={stroke} opacity={0.1} />
      <path
        d={line}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function StatCard({
  label,
  value,
  sub,
  delta,
  icon: Icon,
  sparkline,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  delta?: number | null;
  icon?: LucideIcon;
  sparkline?: ReadonlyArray<number>;
}) {
  return (
    <div className="relative flex flex-col gap-2 rounded-xl border bg-card p-4 not-dark:bg-clip-padding shadow-xs/5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 font-medium text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
          {Icon ? <Icon className="size-3.5 opacity-70" /> : null}
          {label}
        </span>
        {delta !== undefined ? <DeltaBadge percent={delta} /> : null}
      </div>
      <div className="flex items-end justify-between gap-2">
        <span className="font-semibold text-2xl text-foreground tabular-nums leading-none">
          {value}
        </span>
        {sparkline && sparkline.length > 1 ? (
          <Sparkline points={sparkline} className="text-primary" />
        ) : null}
      </div>
      {sub ? <span className="text-muted-foreground text-xs">{sub}</span> : null}
    </div>
  );
}

export function StatePanel({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-72 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed bg-card/50 p-10 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-5" />
      </div>
      <div className="space-y-1">
        <p className="font-semibold text-foreground text-sm">{title}</p>
        {description ? (
          <p className="mx-auto max-w-sm text-muted-foreground text-xs">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

/** A refresh failed while an earlier snapshot stays on screen: say so instead of hiding it. */
export function StaleSnapshotNotice({
  generatedAt,
  error,
}: {
  generatedAt: string;
  error: string;
}) {
  return (
    <div
      role="status"
      className="flex gap-2 rounded-lg border border-warning/30 bg-warning/8 px-3 py-2.5 text-xs text-muted-foreground"
    >
      <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
      <span>
        Showing data from {formatTimestamp(generatedAt)}. The refresh failed: {error}
      </span>
    </div>
  );
}

export function StatSkeleton() {
  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, index) => (
          <div key={index} className="h-24 animate-pulse rounded-xl border bg-muted/40" />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-2xl border bg-muted/40" />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="h-56 animate-pulse rounded-2xl border bg-muted/40" />
        <div className="h-56 animate-pulse rounded-2xl border bg-muted/40" />
      </div>
    </div>
  );
}
