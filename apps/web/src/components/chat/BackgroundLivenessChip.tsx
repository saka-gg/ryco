import { BotIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";

/**
 * Compact status chip for native background work that outlives the turn
 * (subagent fleets, workflow runs, watch loops). Mirrors the pending
 * context-handoff chip: left-aligned above the composer, pill-shaped, small
 * type. Stop routes through the stop-everything interrupt — it kills every
 * live background task before interrupting, so no active turn is needed.
 */
export const BackgroundLivenessChip = memo(function BackgroundLivenessChip(props: {
  liveness: "working" | "monitoring";
  liveCount: number;
  waitingCount?: number;
  onOpenAgents?: () => void;
  stopping: boolean;
  onStop: () => void;
}) {
  const working = props.liveness === "working";
  const label = working
    ? props.liveCount > 0
      ? `${props.liveCount} ${props.liveCount === 1 ? "agent" : "agents"} active in the background`
      : "Background work running"
    : "Monitoring in the background";

  return (
    <div
      role="status"
      aria-label={label}
      data-background-liveness-chip="true"
      className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-border/70 bg-popover/95 px-2.5 py-1 text-[11px] leading-4 text-muted-foreground shadow-sm backdrop-blur-xs"
    >
      <BotIcon className={cn("size-3.5 shrink-0", working && "animate-status-pulse")} aria-hidden />
      <button
        type="button"
        onClick={props.onOpenAgents}
        disabled={!props.onOpenAgents}
        className="truncate font-medium hover:text-foreground"
      >
        {label}
        {props.waitingCount ? ` · ${props.waitingCount} waiting` : ""}
      </button>
      <span className="text-muted-foreground/45" aria-hidden>
        ·
      </span>
      <button
        type="button"
        onClick={props.onStop}
        disabled={props.stopping}
        className="shrink-0 font-medium text-foreground/85 transition-colors hover:text-foreground disabled:cursor-default disabled:text-muted-foreground/60"
      >
        {props.stopping ? "Stopping…" : "Stop"}
      </button>
    </div>
  );
});
