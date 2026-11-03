import {
  USAGE_COST_TYPE_COLORS,
  USAGE_COST_TYPE_LABELS,
  formatUsageCostShare,
  listUsageCostTypeShares,
  type UsageCostBreakdownTotals,
} from "@ryco/client-runtime/usage";

import { formatUsd } from "~/lib/statisticsFormat";
import { cn } from "~/lib/utils";

/**
 * Estimated cost by token type as one stacked share bar with a legend, the Fast-mode premium
 * and what could not be split. Renders nothing when nothing is split.
 */
export function CostByTypeBar({
  totals,
  className,
}: {
  readonly totals: UsageCostBreakdownTotals;
  readonly className?: string;
}) {
  const shares = listUsageCostTypeShares(totals);
  if (shares.length === 0) return null;
  return (
    <div className={cn("space-y-3", className)}>
      <p className="text-xs font-medium">Cost by type</p>
      <div aria-hidden className="flex h-2 gap-px overflow-hidden rounded-full bg-muted">
        {shares.map((entry) => (
          // Grow from a zero basis: the shares split what the 1px gaps leave.
          <div
            key={entry.type}
            className="h-full basis-0"
            style={{ flexGrow: entry.share, backgroundColor: USAGE_COST_TYPE_COLORS[entry.type] }}
          />
        ))}
      </div>
      <ul aria-label="Cost by type" className="space-y-1.5 text-xs">
        {shares.map((entry) => (
          <li key={entry.type} className="flex items-center justify-between gap-4">
            <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground">
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-sm"
                style={{ backgroundColor: USAGE_COST_TYPE_COLORS[entry.type] }}
              />
              {USAGE_COST_TYPE_LABELS[entry.type]}
            </span>
            <span className="inline-flex items-baseline gap-2 tabular-nums">
              <span className="font-medium">{formatUsd(entry.usd)}</span>
              <span className="w-9 text-right text-muted-foreground">
                {formatUsageCostShare(entry.share)}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {totals.speedPremiumUsd > 0 ? (
        <div className="flex items-center justify-between gap-4 text-xs">
          <span className="text-muted-foreground">Fast-mode premium (included)</span>
          <span className="font-medium tabular-nums">{formatUsd(totals.speedPremiumUsd)}</span>
        </div>
      ) : null}
      {totals.otherUsd > 0 && totals.unsplitBucketCount > 0 ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Some cost could not be split: provider-reported costs without published rates, or nodes
          that need an update.
        </p>
      ) : null}
    </div>
  );
}
