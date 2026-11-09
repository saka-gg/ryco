import { chartColor } from "~/components/ui/chart";
import {
  formatEstimatedUsd,
  formatModelLabel,
  formatProviderLabel,
  formatTokens,
} from "~/lib/statisticsFormat";

import type { ModelAggregate } from "./selectors";

export function ModelLeaderboard({ models }: { models: ReadonlyArray<ModelAggregate> }) {
  if (models.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-muted-foreground text-xs">No model usage yet.</div>
    );
  }
  const max = models.reduce((acc, entry) => Math.max(acc, entry.totalTokens), 0) || 1;
  return (
    <ol className="divide-y divide-border/50">
      {models.map((entry, index) => {
        const color = chartColor(index);
        const widthPct = Math.max(2, (entry.totalTokens / max) * 100);
        return (
          <li
            key={`${entry.provider ?? "unknown"}:${entry.model}`}
            className="flex items-center gap-3 px-4 py-3"
          >
            <span className="w-4 text-center font-medium text-[11px] text-muted-foreground tabular-nums">
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate font-medium text-[13px] text-foreground">
                  {formatModelLabel(entry.model)}
                </span>
                <span className="shrink-0 font-medium text-foreground text-xs tabular-nums">
                  {formatTokens(entry.totalTokens)}
                </span>
              </div>
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full transition-[width] duration-500"
                  style={{ width: `${widthPct}%`, backgroundColor: color }}
                />
              </div>
              <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
                <span className="truncate">{formatProviderLabel(entry.provider)}</span>
                <span className="shrink-0 tabular-nums">
                  {entry.costUsd === null ? "—" : `~${formatEstimatedUsd(entry.costUsd)}`}
                </span>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
