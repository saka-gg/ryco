import { AccountEmail, CliProxyAccountName } from "../usage/AccountEmail";
import { cliProxyHubsQueryOptions } from "../usage/cliProxyHubsQuery";
import { ProviderLimitWindow } from "../usage/ProviderLimitWindow";
import { useRelativeLabelTick } from "../settings/settingsLayout";
import {
  cliProxyCurrentAccount,
  cliProxyWindowLabel,
  findCliProxyRouteForInstance,
  formatCliProxyPlan,
  poolCliProxyWindows,
} from "@ryco/client-runtime/usage";
import type {
  ClaudeCacheObservation,
  CliProxyHubSnapshot,
  EnvironmentId,
  ProviderInstanceId,
  ServerProviderRateLimits,
  ServerProviderRateLimitWindow,
} from "@ryco/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon } from "lucide-react";
import { type ReactNode, useMemo } from "react";

import { cn } from "~/lib/utils";
import { type ContextWindowUsage, formatContextWindowTokens } from "~/lib/contextWindow";
import { useQuery } from "~/rpc/queryClient";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { usePresentationTier } from "../../hooks/usePresentationTier";
import { describeRateLimitWindow } from "../settings/codexUsageLimits";
import { parseStatisticsSearch } from "../statistics/statisticsSearch";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

// The hub's provider slug for the accounts serving a routed Claude instance.
const CLI_PROXY_CLAUDE_PROVIDER = "claude";

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

interface ContextWindowMeterProps {
  usage: ContextWindowUsage;
  checkedAt?: string | undefined;
  available?: boolean | undefined;
  rateLimits?: ServerProviderRateLimits | undefined;
  claudeCache?: ClaudeCacheObservation | null | undefined;
  account?: ContextWindowAccount | undefined;
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

function hasAccountDetails(account: ContextWindowAccount | undefined): boolean {
  return Boolean(account?.label || account?.email);
}

function SectionLabel(props: { readonly children: ReactNode }) {
  return (
    <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
      {props.children}
    </div>
  );
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
  readonly checkedAt: string | undefined;
  readonly available: boolean;
  readonly now: number;
}) {
  const descriptor = describeRateLimitWindow(props.window);
  const label =
    props.window.windowDurationMins === undefined ? props.fallbackLabel : descriptor.label;
  return <ProviderLimitWindow {...props} label={label} compact />;
}

/** The instance and login the composer sends with. The web phone tier is frozen without it. */
function AccountSection(props: { readonly account: ContextWindowAccount }) {
  const { account } = props;
  return (
    <div className="phone:hidden mb-2.5 space-y-1 border-b border-border/60 pb-2 leading-tight">
      <SectionLabel>Account</SectionLabel>
      <div className="truncate text-xs font-medium text-foreground">{account.displayName}</div>
      {account.label ? (
        <div className="truncate text-xs text-muted-foreground">{account.label}</div>
      ) : null}
      {/* On its own line: beside the plan label, a typical email does not fit the popup. */}
      {account.email ? (
        <div className="flex min-w-0">
          <AccountEmail email={account.email} />
        </div>
      ) : null}
    </div>
  );
}

/** Observed counters from Claude's last main-loop request; no future-hit claim. */
function PromptCacheSection(props: {
  readonly observation: ClaudeCacheObservation;
  readonly now: number;
}) {
  const { observation } = props;
  const lifetimeMinutes = observation.observedTtlSeconds
    ? Math.round(observation.observedTtlSeconds / 60)
    : null;
  return (
    <div className="mt-2.5 space-y-1 border-t border-border/60 pt-2 leading-tight">
      <SectionLabel>Prompt cache</SectionLabel>
      <div className="whitespace-nowrap text-xs font-medium text-foreground">
        {formatContextWindowTokens(observation.cacheReadInputTokens)} read
        <span className="mx-1">⋅</span>
        {formatContextWindowTokens(observation.cacheWriteInputTokens)} written
        <span className="mx-1">⋅</span>
        {formatContextWindowTokens(observation.directInputTokens)} uncached
      </div>
      <div className="text-xs text-muted-foreground">
        Last request {formatRelativeTimeLabel(observation.observedAt, props.now)}
        {lifetimeMinutes !== null ? ` · ${lifetimeMinutes}m write lifetime` : null}
      </div>
    </div>
  );
}

/**
 * Usage of a Claude instance routed through a CLIProxyAPI hub. The hub picks an account per
 * request, so "last request" is the account the hub used last for any of its clients.
 */
function CliProxyRouteSection(props: {
  readonly hub: CliProxyHubSnapshot;
  readonly environmentId: EnvironmentId;
  readonly available: boolean;
  readonly now: number;
}) {
  const { hub, now } = props;
  const navigate = useNavigate();
  const current = cliProxyCurrentAccount(hub, CLI_PROXY_CLAUDE_PROVIDER, now);
  const quota = current?.account.quota;
  const plan = formatCliProxyPlan(quota?.planType);
  const lastUsed = current?.account.lastUsedAt
    ? formatRelativeTimeLabel(current.account.lastUsedAt, now)
    : undefined;
  const pooled = poolCliProxyWindows(
    hub.accounts.filter((account) => account.provider === CLI_PROXY_CLAUDE_PROVIDER),
  ).filter((window) => window.accountCount > 1);
  return (
    <div className="mt-2.5 space-y-1.5 border-t border-border/60 pt-2 leading-tight">
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>Usage limits</SectionLabel>
        <button
          type="button"
          className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() =>
            void navigate({
              to: "/statistics",
              search: parseStatisticsSearch({
                view: "limits",
                environmentIds: [props.environmentId],
              }),
            })
          }
        >
          All accounts
          <ArrowUpRightIcon aria-hidden className="size-3" />
        </button>
      </div>
      <div className="truncate text-xs font-medium text-foreground">
        Via CLIProxyAPI · {hub.label}
      </div>
      {hub.status === "error" ? (
        <div className="text-xs text-destructive-foreground">{hub.error}</div>
      ) : current ? (
        <>
          <div
            className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground"
            title="The account the hub used last for any of its clients."
          >
            <span>Last request:</span>
            <CliProxyAccountName account={current.account} />
            {plan || lastUsed ? (
              <span className="whitespace-nowrap">
                · {[plan, lastUsed].filter(Boolean).join(" · ")}
              </span>
            ) : null}
          </div>
          {current.recentAccountCount > 1 ? (
            <div className="text-[11px] text-muted-foreground">
              Rotating across {current.recentAccountCount} accounts
            </div>
          ) : null}
          {quota?.status === "ok" && quota.windows.length > 0 ? (
            <div className="grid gap-1">
              {quota.windows.map((window) => (
                <ProviderLimitWindow
                  key={window.id}
                  window={window}
                  label={cliProxyWindowLabel(window)}
                  checkedAt={quota.checkedAt}
                  available={props.available}
                  now={now}
                  compact
                />
              ))}
            </div>
          ) : quota?.status === "failed" ? (
            <div className="text-xs text-destructive-foreground">
              {quota.message ?? "The quota could not be read."}
            </div>
          ) : null}
        </>
      ) : (
        <div className="text-xs text-muted-foreground">
          The hub has not reported which account it used yet.
        </div>
      )}
      {pooled.length > 0 ? (
        <div
          className="text-[11px] text-muted-foreground"
          title="Plans of different sizes count equally in the average."
        >
          Pool of {Math.max(...pooled.map((window) => window.accountCount))} accounts:{" "}
          {pooled
            .map((window) => `${window.label} ${Math.round(window.usedPercent)}% used`)
            .join(" · ")}
        </div>
      ) : null}
    </div>
  );
}

const secondsToMs = (seconds: number | undefined) =>
  seconds === undefined ? undefined : seconds * 1000;

/** The instants the popup labels relative to now: resets, the last cache read, the hub's last use. */
export function contextWindowLabelInstants(
  rateLimits: ServerProviderRateLimits | undefined,
  claudeCache: ClaudeCacheObservation | null | undefined,
  route: CliProxyHubSnapshot | undefined,
): ReadonlyArray<number | undefined> {
  const instants: Array<number | undefined> = [
    secondsToMs(rateLimits?.primary?.resetsAt),
    secondsToMs(rateLimits?.secondary?.resetsAt),
    secondsToMs(rateLimits?.tertiary?.resetsAt),
  ];
  if (claudeCache) instants.push(Date.parse(claudeCache.observedAt));
  for (const hubAccount of route?.accounts ?? []) {
    if (hubAccount.lastUsedAt) instants.push(Date.parse(hubAccount.lastUsedAt));
    if (hubAccount.quota?.status === "ok") {
      for (const window of hubAccount.quota.windows) instants.push(secondsToMs(window.resetsAt));
    }
  }
  return instants;
}

/** The popup body. It mounts only while the popup is open, so nothing ticks or reads when closed. */
function ContextWindowDetails(
  props: ContextWindowMeterProps & {
    readonly usedPercentage: string | null;
    readonly normalizedPercentage: number;
  },
) {
  const { usage, rateLimits, account, usedPercentage, normalizedPercentage } = props;
  const phone = usePresentationTier() === "phone";
  const hubsQuery = useQuery(
    cliProxyHubsQueryOptions(account?.checkCliProxyRoute && !phone ? account.environmentId : null),
  );
  const route =
    account && hubsQuery.data
      ? findCliProxyRouteForInstance(hubsQuery.data, account.instanceId)
      : undefined;
  // Re-render when one of the popup's relative labels changes, not every second.
  const now = useRelativeLabelTick(
    useMemo(
      () => contextWindowLabelInstants(rateLimits, props.claudeCache, route),
      [rateLimits, props.claudeCache, route],
    ),
  );
  // A routed instance's own limits describe no account the hub uses.
  const showUsageLimits =
    route === undefined &&
    Boolean(rateLimits && (rateLimits.primary || rateLimits.secondary || rateLimits.tertiary));

  return (
    <>
      {account && hasAccountDetails(account) ? <AccountSection account={account} /> : null}
      <div className="space-y-1.5 leading-tight">
        <SectionLabel>Context window</SectionLabel>
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
            usage.maxTokens !== null && usage.usedPercentage !== null ? normalizedPercentage : null
          }
        />
        {(usage.totalProcessedTokens ?? null) !== null &&
        (usage.totalProcessedTokens ?? 0) > usage.usedTokens ? (
          <div className="text-xs text-muted-foreground">
            Total processed: {formatContextWindowTokens(usage.totalProcessedTokens ?? null)} tokens
          </div>
        ) : null}
        {usage.compactsAutomatically ? (
          <div className="text-xs text-muted-foreground">
            Automatically compacts its context when needed.
          </div>
        ) : null}
      </div>
      {props.claudeCache ? <PromptCacheSection observation={props.claudeCache} now={now} /> : null}
      {route && account ? (
        <CliProxyRouteSection
          hub={route}
          environmentId={account.environmentId}
          available={props.available === true}
          now={now}
        />
      ) : hubsQuery.isFetching && hubsQuery.data === undefined ? (
        <div className="mt-2.5 border-t border-border/60 pt-2 text-xs text-muted-foreground">
          Checking CLIProxyAPI hubs…
        </div>
      ) : null}
      {hubsQuery.error ? (
        <div className="mt-2 text-xs text-destructive-foreground">
          Couldn't read CLIProxyAPI hubs: {hubsQuery.error.message}
        </div>
      ) : null}
      {showUsageLimits && rateLimits ? (
        <div className="mt-2.5 space-y-1.5 border-t border-border/60 pt-2 leading-tight">
          <SectionLabel>Usage limits</SectionLabel>
          <div className="grid gap-1">
            {rateLimits.primary ? (
              <UsageLimitRow
                checkedAt={props.checkedAt}
                available={props.available === true}
                now={now}
                window={rateLimits.primary}
                fallbackLabel="Short window"
              />
            ) : null}
            {rateLimits.secondary ? (
              <UsageLimitRow
                checkedAt={props.checkedAt}
                available={props.available === true}
                now={now}
                window={rateLimits.secondary}
                fallbackLabel="Weekly"
              />
            ) : null}
            {rateLimits.tertiary ? (
              <UsageLimitRow
                checkedAt={props.checkedAt}
                available={props.available === true}
                now={now}
                window={rateLimits.tertiary}
                fallbackLabel="Monthly"
              />
            ) : null}
          </div>
        </div>
      ) : null}
      {rateLimits?.resetCredits ? (
        <div className="phone:hidden mt-2 border-t border-border/60 pt-2 text-xs text-muted-foreground">
          {props.available
            ? `${rateLimits.resetCredits.availableCount} banked resets`
            : "Banked resets unavailable while disconnected"}
          <div>Review and redeem in Settings → Providers.</div>
        </div>
      ) : null}
    </>
  );
}

export function ContextWindowMeter(props: ContextWindowMeterProps) {
  const { usage, account } = props;
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (normalizedPercentage / 100) * circumference;
  const wide = hasAccountDetails(account) || account?.checkCliProxyRoute === true;

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
        className={cn("max-w-none py-2", wide ? "w-72 phone:w-64" : "w-64")}
        // The inset lives on the viewport: when content changes while open (a hub read
        // landing), Base UI sizes the content from the popup width minus this padding only.
        viewportClassName="[--viewport-inline-padding:--spacing(5)]"
      >
        <ContextWindowDetails
          {...props}
          usedPercentage={usedPercentage}
          normalizedPercentage={normalizedPercentage}
        />
      </PopoverPopup>
    </Popover>
  );
}
