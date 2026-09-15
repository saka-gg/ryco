import type { ServerProviderRateLimitWindow } from "@ryco/contracts";
import { clampUsedPercent, describeRateLimitPace, rateLimitPace } from "@ryco/client-runtime/usage";
import { formatRateLimitResetText } from "../settings/codexUsageLimits";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function PaceReference(props: {
  readonly expectedUsedPercent: number;
  readonly description: string;
}) {
  const expected = clampUsedPercent(props.expectedUsedPercent);
  if (expected === null) return null;

  const marker = (
    <button
      type="button"
      title={props.description}
      aria-label={`Even-pace reference: ${props.description}`}
      className="absolute top-1/2 z-10 flex size-4 -translate-x-1/2 -translate-y-1/2 cursor-help items-center justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      style={{ left: `${expected}%` }}
    >
      <span
        aria-hidden="true"
        className="relative h-2.5 w-[3px] rounded-full bg-background shadow-xs"
      >
        <span className="absolute inset-y-px left-1/2 w-px -translate-x-1/2 rounded-full bg-foreground/70" />
      </span>
    </button>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={marker} />
      <TooltipPopup side="top" className="max-w-72 leading-tight">
        {props.description}
      </TooltipPopup>
    </Tooltip>
  );
}

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
  const pace = rateLimitPace(props.window, props.checkedAt, props.now, props.available);
  const paceDescription = describeRateLimitPace(pace);
  const paceReference =
    pace.status === "reserve" || pace.status === "deficit" ? pace.expectedUsedPercent : null;
  return (
    <div className="grid min-w-0 gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
        <span className="font-medium text-foreground">{props.label}</span>
        <span className="text-muted-foreground">{headline}</span>
      </div>
      {used !== null ? (
        <div className="relative">
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
          {paceReference !== null && paceDescription ? (
            <PaceReference expectedUsedPercent={paceReference} description={paceDescription} />
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {!props.compact && used !== null ? (
          <span>{highUsage ? `${remaining}% available` : `${used}% used`}</span>
        ) : null}
        {reset ? <span className="first-letter:uppercase">{reset}</span> : null}
      </div>
      {pace.status === "unavailable" && paceDescription ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">{paceDescription}</p>
      ) : null}
    </div>
  );
}
