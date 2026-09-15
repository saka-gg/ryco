import type { ServerProviderRateLimitWindow } from "@ryco/contracts";
import { clampUsedPercent, describeRateLimitPace, rateLimitPace } from "@ryco/client-runtime/usage";
import { formatRateLimitResetText } from "../settings/codexUsageLimits";

/** Presentation only: the caller supplies its authoritative connection and snapshot time. */
export function ProviderLimitWindow(props: {
  readonly window: ServerProviderRateLimitWindow;
  readonly label: string;
  readonly checkedAt: string | undefined;
  readonly available: boolean;
  readonly now: number;
  readonly compact?: boolean;
}) {
  const used = clampUsedPercent(props.window.usedPercent);
  const remaining = used === null ? null : 100 - used;
  const highUsage = used !== null && used >= 75;
  const barColor = props.compact
    ? used !== null && used >= 95
      ? "bg-destructive"
      : used !== null && used >= 80
        ? "bg-warning"
        : "bg-foreground/60"
    : highUsage
      ? "bg-warning"
      : "bg-foreground/70";
  const headline =
    used === null
      ? "Unavailable"
      : props.compact || highUsage
        ? `${used}% used`
        : `${remaining}% available`;
  const reset = formatRateLimitResetText(props.window.resetsAt);
  const pace = describeRateLimitPace(
    rateLimitPace(props.window, props.checkedAt, props.now, props.available),
  );
  return (
    <div className="grid min-w-0 gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
        <span className="font-medium text-foreground">{props.label}</span>
        <span className="text-muted-foreground">{headline}</span>
      </div>
      {used !== null ? (
        <div
          className="h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label={`${props.label} window usage`}
          aria-valuenow={used}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={`h-full rounded-full ${props.compact ? "" : "transition-[width]"} ${barColor}`}
            style={{ width: `${used}%` }}
          />
        </div>
      ) : null}
      <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {!props.compact && used !== null ? (
          <span>{highUsage ? `${remaining}% available` : `${used}% used`}</span>
        ) : null}
        {reset ? <span className="first-letter:uppercase">{reset}</span> : null}
      </div>
      {pace ? <p className="text-[11px] leading-relaxed text-muted-foreground">{pace}</p> : null}
    </div>
  );
}
