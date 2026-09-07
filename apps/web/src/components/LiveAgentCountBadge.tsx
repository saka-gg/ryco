import { cn } from "~/lib/utils";

export function formatLiveAgentCount(count: number): string {
  return `${count} ${count === 1 ? "agent" : "agents"} active`;
}

export function LiveAgentCountBadge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      aria-hidden
      data-live-agent-count={count}
      className={cn(
        "absolute flex items-center justify-center rounded-full bg-info font-semibold tabular-nums text-white shadow-[0_0_0_2px_var(--color-background)]",
        className,
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
