import {
  cliProxyAccountHealth,
  cliProxyHubIdentity,
  cliProxyProviderLabel,
  cliProxyRecentRequestTotal,
  cliProxyWindowLabel,
  directAccountHealth,
  formatCliProxyPlan,
  groupCliProxyAccounts,
  groupSubscriptionLimits,
  hubKeysByDirectAccount,
  listCliProxyApiKeys,
  listDirectProviderAccounts,
  type CliProxyAccountHealth,
  type CliProxyApiKeyRow,
  type CliProxyHubAccountEntry,
  type DirectAccountHealth,
  type DirectProviderAccount,
  type PooledLimitWindow,
  type RoutedProviderInstance,
  type SubscriptionLimitGroup,
} from "@ryco/client-runtime/usage";
import type { CliProxyHubSnapshot, EnvironmentId } from "@ryco/contracts";
import {
  GaugeIcon,
  KeyRoundIcon,
  MonitorIcon,
  PlugIcon,
  RefreshCwIcon,
  RouteIcon,
  ServerIcon,
  SettingsIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { formatInteger } from "~/lib/statisticsFormat";
import { cn } from "~/lib/utils";
import { useSettingsDialogStore } from "~/settingsDialogStore";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { formatRateLimitResetText } from "../../settings/codexUsageLimits";
import { SettingsNotice, useRelativeLabelTick } from "../../settings/settingsLayout";
import { Panel, Sparkline, StatePanel, StatSkeleton } from "../../settings/statistics/parts";
import { AccountEmail, CliProxyAccountName } from "../../usage/AccountEmail";
import { ProviderLimitWindow } from "../../usage/ProviderLimitWindow";
import { EnvironmentSelect } from "../EnvironmentSelect";
import type { StatisticsSearch } from "../statisticsSearch";
import { useSubscriptionLimits, type LimitsEnvironmentResult } from "./useSubscriptionLimits";

interface HubWithEnvironment {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly hub: CliProxyHubSnapshot;
}

type SourceFilter = "all" | "direct" | "hub";

const SOURCE_FILTERS: ReadonlyArray<{ readonly value: SourceFilter; readonly label: string }> = [
  { value: "all", label: "All" },
  { value: "direct", label: "Direct" },
  { value: "hub", label: "CLIProxyAPI" },
];

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

const secondsToMs = (seconds: number | undefined) =>
  seconds === undefined ? undefined : seconds * 1000;

/** The instants the view reads against now: checks, resets and hub retry times. */
function limitsLabelInstants(
  accounts: ReadonlyArray<DirectProviderAccount>,
  hubs: ReadonlyArray<HubWithEnvironment>,
): ReadonlyArray<number | undefined> {
  const instants: Array<number | undefined> = [];
  for (const account of accounts) {
    instants.push(Date.parse(account.snapshot.checkedAt));
    for (const { window } of account.windows) instants.push(secondsToMs(window.resetsAt));
  }
  for (const { hub } of hubs) {
    instants.push(Date.parse(hub.checkedAt));
    for (const account of hub.accounts) {
      for (const window of account.quota.windows) instants.push(secondsToMs(window.resetsAt));
      for (const { retryAt } of account.cooldowns) {
        if (retryAt) instants.push(Date.parse(retryAt));
      }
      if (account.nextRetryAt) instants.push(Date.parse(account.nextRetryAt));
    }
  }
  return instants;
}

export function LimitsView({
  search,
  onSearchChange,
}: {
  readonly search: StatisticsSearch;
  readonly onSearchChange: (next: StatisticsSearch) => void;
}) {
  const result = useSubscriptionLimits({ environmentIds: search.environmentIds });
  const openSettings = useSettingsDialogStore((state) => state.openSettings);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const hubs = useMemo(
    () =>
      result.environments.flatMap((environment) =>
        environment.hubs.map((hub): HubWithEnvironment => ({
          environmentId: environment.environmentId,
          environmentLabel: environment.label,
          hub,
        })),
      ),
    [result.environments],
  );
  const direct = useMemo(
    () =>
      listDirectProviderAccounts(
        result.environments.map((environment) => ({
          environmentId: environment.environmentId,
          label: environment.label,
          connected: environment.connected,
          providers: environment.providers,
          hubs: environment.hubs,
        })),
      ),
    [result.environments],
  );
  // Ticks when a label, pace or health could change, and reads the clock again as soon as a
  // snapshot changes, so a live provider push never looks future-dated to pace. The hub receipt
  // time covers hub reads within the same render.
  const now = Math.max(
    useRelativeLabelTick(
      useMemo(() => limitsLabelInstants(direct.accounts, hubs), [direct.accounts, hubs]),
    ),
    result.receivedAtMs,
  );
  // The filter only narrows the view while both sources have accounts to show.
  const hubAccountCount = useMemo(
    () => groupCliProxyAccounts(hubs).reduce((total, group) => total + group.accounts.length, 0),
    [hubs],
  );
  const directAccountCount = direct.accounts.length;
  const filterable = directAccountCount > 0 && hubAccountCount > 0;
  const source = filterable ? sourceFilter : "all";
  const groups = useMemo(
    () =>
      groupSubscriptionLimits({
        hubs: source === "direct" ? [] : hubs,
        direct: source === "hub" ? [] : direct.accounts,
        routed: source === "hub" ? [] : direct.routed,
      }),
    [direct, hubs, source],
  );
  const readingHubs = result.environments.some((environment) => environment.status === "loading");
  const failedEnvironments = result.environments.filter(
    (environment): environment is LimitsEnvironmentResult & { message: string } =>
      environment.status === "failed" || environment.status === "unsupported",
  );
  const multipleEnvironments = result.environments.length > 1;
  // A loopback hub is a different machine on each node, so its label names the node too.
  const hubLabels = new Map(
    hubs.map((entry) => {
      const key = cliProxyHubIdentity(entry);
      const nodeLocal = key !== entry.hub.url;
      return [
        key,
        nodeLocal && multipleEnvironments
          ? `${entry.hub.label} · ${entry.environmentLabel}`
          : entry.hub.label,
      ] as const;
    }),
  );
  // From every hub, not the filtered groups, so the note stays under the Direct filter.
  const alsoInHubs = new Map(
    [...hubKeysByDirectAccount(direct.accounts, hubs)].map(([accountKey, hubKeys]) => [
      accountKey,
      [...new Set(hubKeys.flatMap((hubKey) => hubLabels.get(hubKey) ?? []))],
    ]),
  );
  // The filter stays visible while it narrows the view, so it can always be cleared.
  const environmentFilter =
    result.availableEnvironments.length > 1 || (search.environmentIds?.length ?? 0) > 0 ? (
      <EnvironmentSelect
        search={search}
        onSearchChange={onSearchChange}
        environments={result.availableEnvironments}
        ariaLabel="Limits environment"
      />
    ) : null;
  const environmentNotices = failedEnvironments.map((environment) => (
    <SettingsNotice
      key={environment.environmentId}
      tone={environment.status === "unsupported" ? "warning" : "error"}
      title={environment.label}
    >
      {environment.message}
    </SettingsNotice>
  ));
  const manageProviders = () =>
    openSettings(
      "providers",
      result.environments.length === 1 ? result.environments[0]!.environmentId : null,
    );

  if (hubs.length === 0 && directAccountCount === 0) {
    return (
      <div className="space-y-4">
        {/* Stays mounted while a filter change re-reads hubs, so it keeps focus. */}
        {environmentFilter}
        {environmentNotices}
        {/* A hub still being read may hold accounts, so nothing is called empty before it answers. */}
        {result.loading || readingHubs ? (
          <StatSkeleton />
        ) : (
          <StatePanel
            icon={GaugeIcon}
            title="No subscription limits to show"
            description="Sign in to Claude, Codex or OpenCode Go with a subscription to see how much of it is left. To pool several subscriptions, connect a CLIProxyAPI hub in Settings → Providers."
            action={
              <Button size="sm" variant="outline" onClick={manageProviders}>
                <SettingsIcon /> Open providers
              </Button>
            }
          />
        )}
      </div>
    );
  }

  const lastChecked = [
    ...hubs.map((entry) => entry.hub.checkedAt),
    ...direct.accounts.map((account) => account.snapshot.checkedAt),
  ]
    .toSorted()
    .at(-1);
  const summary = [
    directAccountCount > 0 ? `${directAccountCount} direct` : null,
    hubAccountCount > 0 || hubs.length > 0
      ? `${hubAccountCount} via ${pluralize(hubs.length, "CLIProxyAPI hub")}`
      : null,
  ]
    .filter(Boolean)
    .join(", ");
  const apiKeys = source === "direct" ? [] : listCliProxyApiKeys(hubs);
  const showHubLabels = hubLabels.size > 1;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-2">
          {environmentFilter}
          <h2 className="text-lg font-semibold tracking-tight">Subscription limits</h2>
          <p className="text-xs text-muted-foreground">
            {pluralize(directAccountCount + hubAccountCount, "account")} · {summary}
            {lastChecked ? ` · checked ${formatRelativeTimeLabel(lastChecked)}` : ""}
            {readingHubs ? " · reading hubs…" : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {filterable ? (
            <div
              role="radiogroup"
              aria-label="Limit source"
              className="inline-flex rounded-lg bg-muted/75 p-0.5"
            >
              {SOURCE_FILTERS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={source === option.value}
                  onClick={() => setSourceFilter(option.value)}
                  className={cn(
                    "inline-flex h-6 items-center rounded-md px-2.5 text-[11px] font-medium transition-colors",
                    source === option.value
                      ? "bg-background text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}
          <Button size="xs" variant="ghost" onClick={manageProviders}>
            <SettingsIcon /> Manage
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={result.refresh}
            disabled={result.refreshing}
            aria-label="Refresh limits"
          >
            <RefreshCwIcon className={result.refreshing ? "animate-spin" : undefined} />
            Refresh
          </Button>
        </div>
      </div>

      {failedEnvironments.length > 0 ||
      hubs.some((entry) => entry.hub.status === "error" || entry.hub.apiKeysError) ? (
        <div className="space-y-2">
          {environmentNotices}
          {hubs.flatMap(({ hub, environmentId, environmentLabel }) =>
            hub.status === "error" ? (
              <SettingsNotice
                key={`${hub.hubId}:${environmentId}`}
                tone="error"
                title={multipleEnvironments ? `${hub.label} · ${environmentLabel}` : hub.label}
              >
                {hub.error}
              </SettingsNotice>
            ) : hub.apiKeysError ? (
              <SettingsNotice
                key={`${hub.hubId}:${environmentId}`}
                tone="warning"
                title={`${hub.label}: API-key counters unavailable`}
              >
                {hub.apiKeysError}
              </SettingsNotice>
            ) : (
              []
            ),
          )}
        </div>
      ) : null}

      {groups.map((group) => (
        <ProviderGroup
          key={group.provider}
          group={group}
          now={now}
          hubLabels={showHubLabels ? hubLabels : null}
          alsoInHubs={alsoInHubs}
          multipleEnvironments={multipleEnvironments}
        />
      ))}

      {hubs.length === 0 && !readingHubs ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-dashed px-4 py-3 text-xs text-muted-foreground">
          <span>
            Pool several subscriptions behind a CLIProxyAPI hub to see each one&apos;s quota and
            request counts here.
          </span>
          <Button size="xs" variant="outline" onClick={manageProviders}>
            <PlugIcon /> Connect a hub
          </Button>
        </div>
      ) : null}

      {apiKeys.length > 0 ? (
        <ApiKeyPanel rows={apiKeys} hubLabels={showHubLabels ? hubLabels : null} />
      ) : null}

      {hubs.length > 0 && source !== "direct" ? (
        <HubList hubs={hubs} multipleEnvironments={multipleEnvironments} />
      ) : null}
    </div>
  );
}

function PooledSummary({
  pooled,
  besideDirect,
}: {
  readonly pooled: ReadonlyArray<PooledLimitWindow>;
  /** Direct cards share the panel; the pool averages hub accounts only, so it says so. */
  readonly besideDirect: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-2 border-b border-border/60 px-3.5 py-2.5">
      {pooled.map((window) => {
        const reset = formatRateLimitResetText(window.nextResetsAt);
        return (
          <div
            key={window.id}
            className="min-w-32 rounded-lg bg-muted/50 px-2.5 py-1.5"
            title="Plans of different sizes count equally in the average."
          >
            <p className="text-[11px] text-muted-foreground">{window.label}</p>
            <p className="text-sm font-semibold tabular-nums">
              {Math.round(100 - window.usedPercent)}% left
            </p>
            <p className="text-[11px] text-muted-foreground">
              avg of {window.accountCount} {besideDirect ? "hub accounts" : "accounts"}
              {reset ? ` · next ${reset}` : ""}
            </p>
          </div>
        );
      })}
    </div>
  );
}

/** Hub labels by `cliProxyHubIdentity`, or null when every account is on one hub. */
type HubLabels = ReadonlyMap<string, string> | null;

function ProviderGroup({
  group,
  now,
  hubLabels,
  alsoInHubs,
  multipleEnvironments,
}: {
  readonly group: SubscriptionLimitGroup;
  readonly now: number;
  readonly hubLabels: HubLabels;
  /** Labels of the hubs that also hold each direct account, by account key. */
  readonly alsoInHubs: ReadonlyMap<string, readonly string[]>;
  readonly multipleEnvironments: boolean;
}) {
  // A single account's window is already on its card; only shared windows are pooled.
  const pooled = group.pooled.filter((window) => window.accountCount > 1);
  const counts = [
    group.directAccounts.length > 0 ? `${group.directAccounts.length} direct` : null,
    group.hubAccounts.length > 0 ? `${group.hubAccounts.length} via hub` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Panel
      title={group.label}
      action={<span className="text-[11px] text-muted-foreground">{counts}</span>}
      bodyClassName="overflow-hidden"
    >
      {pooled.length > 0 ? (
        <PooledSummary pooled={pooled} besideDirect={group.directAccounts.length > 0} />
      ) : null}
      {/* Cells draw right and bottom borders; the negative margins clip the outer edges. */}
      <div className="-mr-px -mb-px grid sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {group.directAccounts.map((account) => (
          <DirectAccountCard
            key={account.key}
            account={account}
            now={now}
            alsoIn={alsoInHubs.get(account.key) ?? []}
            multipleEnvironments={multipleEnvironments}
          />
        ))}
        {group.hubAccounts.map((entry) => (
          <HubAccountCard
            key={`${entry.hubKey}\n${entry.account.authIndex}`}
            entry={entry}
            now={now}
            hubLabel={hubLabels?.get(entry.hubKey) ?? entry.hubLabel}
          />
        ))}
      </div>
      {group.routed.map((instance) => (
        <RoutedNote
          key={`${instance.environmentId}:${instance.instanceId}`}
          instance={instance}
          multipleEnvironments={multipleEnvironments}
        />
      ))}
    </Panel>
  );
}

function RoutedNote({
  instance,
  multipleEnvironments,
}: {
  readonly instance: RoutedProviderInstance;
  readonly multipleEnvironments: boolean;
}) {
  return (
    <p className="flex items-start gap-2 border-t border-border/60 px-3.5 py-2.5 text-xs text-muted-foreground">
      <RouteIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>
        <span className="font-medium text-foreground">{instance.displayName}</span>
        {multipleEnvironments ? ` on ${instance.environmentLabel}` : ""} is routed through{" "}
        {instance.hubLabel}, so it uses the hub&apos;s accounts and its own limits are not shown.
      </span>
    </p>
  );
}

function SourceBadge({ kind }: { readonly kind: "direct" | "hub" }) {
  return kind === "direct" ? (
    <Badge size="sm" variant="secondary" className="gap-1">
      <MonitorIcon aria-hidden className="size-2.5" /> Direct
    </Badge>
  ) : (
    <Badge size="sm" variant="info" className="gap-1">
      <ServerIcon aria-hidden className="size-2.5" /> CLIProxyAPI
    </Badge>
  );
}

function AccountCard({
  name,
  health,
  source,
  details,
  children,
  footer,
}: {
  readonly name: ReactNode;
  readonly health: ReactNode;
  readonly source: "direct" | "hub";
  readonly details: string;
  readonly children: ReactNode;
  readonly footer: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2.5 border-r border-b border-border/60 px-3.5 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <p className="flex min-w-0 text-[13px] leading-5 font-medium">{name}</p>
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <SourceBadge kind={source} />
            {details ? <span className="truncate">{details}</span> : null}
          </div>
        </div>
        {health}
      </div>
      {children}
      <div className="mt-auto text-[11px] text-muted-foreground tabular-nums">{footer}</div>
    </div>
  );
}

function DirectHealthBadge({ health }: { readonly health: DirectAccountHealth }) {
  switch (health.kind) {
    case "ready":
      return <Badge variant="success">Ready</Badge>;
    case "limited":
      return <Badge variant="warning">Limit reached</Badge>;
    case "unavailable":
      return (
        <Badge variant="outline" title={health.message}>
          Not ready
        </Badge>
      );
  }
}

function DirectAccountCard({
  account,
  now,
  alsoIn,
  multipleEnvironments,
}: {
  readonly account: DirectProviderAccount;
  readonly now: number;
  readonly alsoIn: readonly string[];
  readonly multipleEnvironments: boolean;
}) {
  const { snapshot } = account;
  const instanceNames = [...new Set(account.locations.map((location) => location.displayName))];
  const nodes = [...new Set(account.locations.map((location) => location.environmentLabel))];
  const where = multipleEnvironments
    ? `${instanceNames.join(", ")} on ${nodes.join(" · ")}`
    : instanceNames.join(", ");
  const details = [account.plan, where].filter(Boolean).join(" · ");
  const credits = snapshot.rateLimits?.credits;
  const resets = account.resetCredits?.availableCount;
  return (
    <AccountCard
      source="direct"
      details={details}
      health={<DirectHealthBadge health={directAccountHealth(account)} />}
      name={
        snapshot.auth.email ? (
          <AccountEmail email={snapshot.auth.email} className="text-[13px] leading-5" />
        ) : (
          <span className="truncate">{snapshot.displayName ?? snapshot.instanceId}</span>
        )
      }
      footer={
        <>
          checked {formatRelativeTimeLabel(snapshot.checkedAt, now)}
          {nodes.length > 1 ? ` · signed in on ${nodes.length} nodes` : ""}
          {alsoIn.length > 0 ? ` · also in ${alsoIn.join(", ")}` : ""}
          {resets ? ` · ${pluralize(resets, "banked reset")}` : ""}
          {credits?.hasCredits
            ? ` · credits ${credits.unlimited ? "unlimited" : (credits.balance ?? "available")}`
            : ""}
        </>
      }
    >
      {account.windows.map(({ label, window }) => (
        <ProviderLimitWindow
          key={label}
          window={window}
          label={label}
          checkedAt={snapshot.checkedAt}
          available={account.available}
          now={now}
          compact
        />
      ))}
    </AccountCard>
  );
}

function HubHealthBadge({ health }: { readonly health: CliProxyAccountHealth }) {
  switch (health.kind) {
    case "ready":
      return <Badge variant="success">Ready</Badge>;
    case "limited":
      return <Badge variant="warning">Limit reached</Badge>;
    case "cooling":
      return (
        <Badge
          variant="warning"
          title={
            health.until
              ? `The hub retries this account ${formatRateLimitResetText(Date.parse(health.until) / 1000) ?? "later"}.`
              : undefined
          }
        >
          Cooling down
        </Badge>
      );
    case "error":
      return (
        <Badge variant="error" title={health.message}>
          Error
        </Badge>
      );
    case "disabled":
      return <Badge variant="outline">Disabled</Badge>;
  }
}

function quotaNote(entry: CliProxyHubAccountEntry): string | null {
  const { quota } = entry.account;
  switch (quota.status) {
    case "ok":
      return quota.windows.length === 0 ? "No usage windows reported." : null;
    case "unsupported":
      return `${cliProxyProviderLabel(entry.account.provider)} has no quota API Ryco reads; request counts only.`;
    case "skipped":
      return "Disabled on the hub, so its quota is not read.";
    case "failed":
      return quota.message ?? "The quota could not be read.";
  }
}

function HubAccountCard({
  entry,
  now,
  hubLabel,
}: {
  readonly entry: CliProxyHubAccountEntry;
  readonly now: number;
  readonly hubLabel: string;
}) {
  const { account } = entry;
  const health = cliProxyAccountHealth(account, now);
  const plan = formatCliProxyPlan(account.quota.planType);
  const note = quotaNote(entry);
  const recent = cliProxyRecentRequestTotal(account.requests);
  const credits = account.quota.credits;
  return (
    <AccountCard
      source="hub"
      details={[plan, hubLabel].filter(Boolean).join(" · ")}
      health={<HubHealthBadge health={health} />}
      name={
        <CliProxyAccountName account={account} className="text-[13px] leading-5 text-foreground" />
      }
      footer={
        <span
          title={`${formatInteger(account.requests.success)} ok and ${formatInteger(account.requests.failed)} failed since the hub started`}
        >
          {formatInteger(account.requests.success)} ok · {formatInteger(account.requests.failed)}{" "}
          failed · {formatInteger(recent)} in the last 200 min
          {credits
            ? ` · credits ${credits.unlimited ? "unlimited" : (credits.balance ?? "available")}`
            : ""}
        </span>
      }
    >
      {health.kind === "error" && health.message ? (
        <p className="text-xs leading-relaxed text-destructive-foreground">
          The hub reports: {health.message}
        </p>
      ) : null}
      {account.quota.status === "ok"
        ? account.quota.windows.map((window) => (
            <ProviderLimitWindow
              key={window.id}
              window={window}
              label={cliProxyWindowLabel(window)}
              checkedAt={account.quota.checkedAt}
              available={!account.disabled}
              now={now}
              compact
            />
          ))
        : null}
      {note ? (
        <p
          className={cn(
            "text-xs leading-relaxed",
            account.quota.status === "failed"
              ? "text-destructive-foreground"
              : "text-muted-foreground",
          )}
        >
          {note}
        </p>
      ) : null}
    </AccountCard>
  );
}

function apiKeyHost(baseUrl: string | undefined): string {
  if (!baseUrl) return "Default endpoint";
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function ApiKeyPanel({
  rows,
  hubLabels,
}: {
  readonly rows: ReadonlyArray<CliProxyApiKeyRow>;
  readonly hubLabels: HubLabels;
}) {
  return (
    <Panel title="API keys" icon={KeyRoundIcon} bodyClassName="overflow-x-auto">
      <table className="w-full min-w-[36rem] text-xs">
        <thead>
          <tr className="border-b border-border/60 text-left text-[11px] text-muted-foreground">
            <th className="px-4 py-2.5 font-medium">Provider</th>
            <th className="px-4 py-2.5 font-medium">Endpoint</th>
            <th className="px-4 py-2.5 font-medium">Key</th>
            <th className="px-4 py-2.5 font-medium">Last 200 min</th>
            <th className="px-4 py-2.5 text-right font-medium">Requests</th>
            <th className="px-4 py-2.5 text-right font-medium">Failed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ id, hubKey, hubLabel, usage }) => (
            <tr key={id} className="border-b border-border/40 last:border-b-0">
              <td className="px-4 py-2.5 font-medium">
                {cliProxyProviderLabel(usage.provider)}
                {hubLabels ? (
                  <span className="ml-1.5 font-normal text-muted-foreground">
                    {hubLabels.get(hubKey) ?? hubLabel}
                  </span>
                ) : null}
              </td>
              <td className="px-4 py-2.5 text-muted-foreground" title={usage.baseUrl}>
                {apiKeyHost(usage.baseUrl)}
              </td>
              <td className="px-4 py-2.5 font-mono text-muted-foreground">{usage.keyHint}</td>
              <td className="px-4 py-2.5">
                <Sparkline
                  points={usage.requests.recent.map((bucket) => bucket.success + bucket.failed)}
                  className="h-5 w-24"
                />
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums">
                {formatInteger(usage.requests.success + usage.requests.failed)}
              </td>
              <td
                className={cn(
                  "px-4 py-2.5 text-right tabular-nums",
                  usage.requests.failed > 0
                    ? "text-destructive-foreground"
                    : "text-muted-foreground",
                )}
              >
                {formatInteger(usage.requests.failed)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-border/60 px-4 py-2.5 text-[11px] text-muted-foreground">
        API keys have no subscription quota to read; counts come from the hub and reset when it
        restarts.
      </p>
    </Panel>
  );
}

function HubList({
  hubs,
  multipleEnvironments,
}: {
  readonly hubs: ReadonlyArray<HubWithEnvironment>;
  readonly multipleEnvironments: boolean;
}) {
  return (
    <Panel title="Hubs" icon={ServerIcon}>
      <ul className="divide-y divide-border/60">
        {hubs.map(({ hub, environmentId, environmentLabel }) => (
          <li
            key={`${hub.hubId}:${environmentId}`}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 text-xs"
          >
            <div className="min-w-0">
              <p className="font-medium">
                {hub.label}
                {multipleEnvironments ? (
                  <span className="ml-1.5 font-normal text-muted-foreground">
                    via {environmentLabel}
                  </span>
                ) : null}
              </p>
              <p className="break-all font-mono text-[11px] text-muted-foreground">{hub.url}</p>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              {hub.version ? <span>CLIProxyAPI {hub.version}</span> : null}
              <span>checked {formatRelativeTimeLabel(hub.checkedAt)}</span>
              <Badge variant={hub.status === "ok" ? "success" : "error"}>
                {hub.status === "ok" ? "Connected" : "Unreachable"}
              </Badge>
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
