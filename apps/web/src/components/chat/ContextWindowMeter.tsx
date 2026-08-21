import type { ServerProviderRateLimits, ServerProviderRateLimitWindow } from "@ryco/contracts";

import { cn } from "~/lib/utils";
import { type ContextWindowUsage, formatContextWindowTokens } from "~/lib/contextWindow";
import {
  clampUsedPercent,
  formatRateLimitResetText,
  hasRateLimitWindows,
  resolveRateLimitWindowLabel,
} from "../settings/codexUsageLimits";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

function MeterBar(props: { readonly percent: number | null }) {
  if (props.percent === null) return null;
  const percent = Math.max(0, Math.min(100, props.percent));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={
          percent >= 95
            ? "h-full rounded-full bg-destructive"
            : percent >= 80
              ? "h-full rounded-full bg-warning"
              : "h-full rounded-full bg-foreground/60"
        }
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function UsageLimitRow(props: {
  readonly window: ServerProviderRateLimitWindow;
  readonly fallbackLabel: string;
}) {
  const label = resolveRateLimitWindowLabel(props.window, props.fallbackLabel);
  const used = clampUsedPercent(props.window.usedPercent);
  const resetText = formatRateLimitResetText(props.window.resetsAt);

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-3 whitespace-nowrap text-xs">
        <span className="font-medium text-foreground">{label}</span>
        <span className="text-muted-foreground">
          {used}% used
          {resetText ? <span className="ml-1">· {resetText}</span> : null}
        </span>
      </div>
      <MeterBar percent={used} />
    </div>
  );
}

export function ContextWindowMeter(props: {
  usage: ContextWindowUsage;
  rateLimits?: ServerProviderRateLimits | undefined;
}) {
  const { usage, rateLimits } = props;
  const showUsageLimits = hasRateLimitWindows(rateLimits);
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (normalizedPercentage / 100) * circumference;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            className="group inline-flex h-9 w-6 items-center justify-center rounded-full transition-opacity hover:opacity-85 sm:h-8"
            aria-label={
              usage.maxTokens !== null && usedPercentage
                ? `Context window ${usedPercentage} used`
                : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
            }
          >
            <span className="relative flex h-6 w-6 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 h-full w-full"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="color-mix(in oklab, var(--color-muted) 70%, transparent)"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="var(--color-muted-foreground)"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
              <span
                className={cn(
                  "relative flex h-[15px] w-[15px] items-center justify-center rounded-full bg-background text-[8px] font-medium",
                  "text-muted-foreground",
                )}
              >
                {usage.usedPercentage !== null
                  ? Math.round(usage.usedPercentage)
                  : formatContextWindowTokens(usage.usedTokens)}
              </span>
            </span>
          </button>
        }
      />
      <PopoverPopup
        tooltipStyle
        surface="glass"
        side="top"
        align="end"
        className="w-64 max-w-none px-3 py-2"
      >
        <div className="space-y-1.5 leading-tight">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Context window
          </div>
          {usage.maxTokens !== null && usedPercentage ? (
            <div className="whitespace-nowrap text-xs font-medium text-foreground">
              <span>{usedPercentage}</span>
              <span className="mx-1">⋅</span>
              <span>{formatContextWindowTokens(usage.usedTokens)}</span>
              <span>/</span>
              <span>{formatContextWindowTokens(usage.maxTokens ?? null)} context used</span>
            </div>
          ) : (
            <div className="whitespace-nowrap text-xs font-medium text-foreground">
              {formatContextWindowTokens(usage.usedTokens)} context used
            </div>
          )}
          <MeterBar
            percent={
              usage.maxTokens !== null && usage.usedPercentage !== null
                ? normalizedPercentage
                : null
            }
          />
          {(usage.totalProcessedTokens ?? null) !== null &&
          (usage.totalProcessedTokens ?? 0) > usage.usedTokens ? (
            <div className="text-xs text-muted-foreground">
              Total processed: {formatContextWindowTokens(usage.totalProcessedTokens ?? null)}{" "}
              tokens
            </div>
          ) : null}
          {usage.compactsAutomatically ? (
            <div className="text-xs text-muted-foreground">
              Automatically compacts its context when needed.
            </div>
          ) : null}
        </div>
        {showUsageLimits && rateLimits ? (
          <div className="mt-2.5 space-y-1.5 border-t border-border/60 pt-2 leading-tight">
            <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Usage limits
            </div>
            <div className="grid gap-1">
              {rateLimits.primary ? (
                <UsageLimitRow window={rateLimits.primary} fallbackLabel="Short window" />
              ) : null}
              {rateLimits.secondary ? (
                <UsageLimitRow window={rateLimits.secondary} fallbackLabel="Weekly" />
              ) : null}
              {rateLimits.tertiary ? (
                <UsageLimitRow window={rateLimits.tertiary} fallbackLabel="Model weekly" />
              ) : null}
            </div>
          </div>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}
