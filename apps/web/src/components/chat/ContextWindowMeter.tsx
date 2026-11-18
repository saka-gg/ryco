import type {
  ProviderInstanceId,
  EnvironmentId,
  ClaudeCacheObservation,
  ServerProviderRateLimits,
} from "@ryco/contracts";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { formatTokenCount } from "@ryco/shared/tokenCount";
import type { ContextWindowUsage } from "~/lib/contextWindow";
import { preloadableLazy, useLazyComponentReady } from "../../lib/preloadableLazy";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { notifySurfaceLoadFailure } from "../ui/surfaceLoadFailure";

/*
 * The popup body (account, prompt cache, CLIProxyAPI route and usage limits) is its own chunk:
 * the composer shows the meter on every thread, the popup only on hover. The trigger preloads it
 * as the pointer arrives, and the popup opens once it is in.
 */
const LazyContextWindowDetails = preloadableLazy(() =>
  import("./ContextWindowDetails").then((module) => module.ContextWindowDetails),
);
const preloadContextWindowDetails = () => void LazyContextWindowDetails.preload();

/** The provider instance the composer sends to, as the usage popup names it. */
export interface ContextWindowAccount {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  /** The login or plan, such as "Claude Max Subscription". */
  readonly label: string | undefined;
  readonly email: string | undefined;
  /** A Claude instance on a node with an enabled CLIProxyAPI hub, which may route it. */
  readonly checkCliProxyRoute: boolean;
}

/** Compact now for the thread the composer sends to. */
export interface ContextWindowCompactNow {
  /**
   * Why it cannot run now, or null when it can. Once the node took a request, the caller keeps
   * this set until the thread's session reports the turn: the meter is pending only until then.
   */
  readonly blocker: string | null;
  /** Settles once the node took the request or its failure was reported. */
  readonly onCompact: () => Promise<void>;
}

export interface ContextWindowMeterProps {
  usage: ContextWindowUsage;
  /** When the provider read `rateLimits`; absent while they are not live, which disables pace. */
  checkedAt?: string | undefined;
  available?: boolean | undefined;
  rateLimits?: ServerProviderRateLimits | undefined;
  claudeCache?: ClaudeCacheObservation | null | undefined;
  account?: ContextWindowAccount | undefined;
  compactNow?: ContextWindowCompactNow | undefined;
}

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

export function hasAccountDetails(account: ContextWindowAccount | undefined): boolean {
  return Boolean(account?.label || account?.email);
}

export function ContextWindowMeter(props: ContextWindowMeterProps) {
  const { usage, account } = props;
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (normalizedPercentage / 100) * circumference;
  const wide = hasAccountDetails(account) || account?.checkCliProxyRoute === true;
  // Held here, not in the popup body, so closing and reopening the popup keeps it.
  const [compacting, setCompacting] = useState(false);
  const onCompactNow = () => {
    const onCompact = props.compactNow?.onCompact;
    if (!onCompact || compacting) return;
    setCompacting(true);
    void onCompact().finally(() => setCompacting(false));
  };
  const [open, setOpen] = useState(false);
  const detailsReady = useLazyComponentReady(LazyContextWindowDetails, open, {
    // Closed again, so the next hover or click loads it afresh.
    onLoadError: (error) => {
      setOpen(false);
      notifySurfaceLoadFailure("usage details", error, () => setOpen(true));
    },
  });

  return (
    <Popover open={open && detailsReady} onOpenChange={setOpen}>
      <PopoverTrigger
        onPointerEnter={preloadContextWindowDetails}
        onFocus={preloadContextWindowDetails}
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
                : `Context window ${formatTokenCount(usage.usedTokens)} tokens used`
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
                  : formatTokenCount(usage.usedTokens)}
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
        className={cn("max-w-none py-2", wide ? "w-72 phone:w-64" : "w-64")}
        // The inset lives on the viewport: when content changes while open (a hub read
        // landing), Base UI sizes the content from the popup width minus this padding only.
        viewportClassName="[--viewport-inline-padding:--spacing(5)]"
      >
        <LazyContextWindowDetails
          {...props}
          usedPercentage={usedPercentage}
          normalizedPercentage={normalizedPercentage}
          compacting={compacting}
          onCompactNow={onCompactNow}
        />
      </PopoverPopup>
    </Popover>
  );
}
