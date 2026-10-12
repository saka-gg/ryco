import {
  cliProxyAccountHealth,
  cliProxyHubIdentity,
  cliProxyProviderLabel,
  cliProxyRecentRequestTotal,
  cliProxyWindowLabel,
  formatCliProxyPlan,
  groupCliProxyAccounts,
  listCliProxyApiKeys,
  type CliProxyAccountHealth,
  type CliProxyApiKeyRow,
  type CliProxyHubAccountEntry,
  type CliProxyPooledWindow,
  type CliProxyProviderGroup,
} from "@ryco/client-runtime/usage";
import type { CliProxyHubSnapshot, EnvironmentId } from "@ryco/contracts";
import { KeyRoundIcon, RefreshCwIcon, ServerIcon, SettingsIcon } from "lucide-react";
import { useMemo } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { formatInteger } from "~/lib/statisticsFormat";
import { cn } from "~/lib/utils";
import { useSettingsDialogStore } from "~/settingsDialogStore";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { formatRateLimitResetText } from "../../settings/codexUsageLimits";
import { SettingsNotice, useRelativeTimeTick } from "../../settings/settingsLayout";
import { Panel, Sparkline, StatePanel, StatSkeleton } from "../../settings/statistics/parts";
import { CliProxyAccountName } from "../../usage/AccountEmail";
import { ProviderLimitWindow } from "../../usage/ProviderLimitWindow";
import { EnvironmentSelect } from "../EnvironmentSelect";
import type { StatisticsSearch } from "../statisticsSearch";
import { useCliProxyHubs, type CliProxyEnvironmentResult } from "./useCliProxyHubs";

interface HubWithEnvironment {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly hub: CliProxyHubSnapshot;
}

export function LimitsView({
  search,
  onSearchChange,
}: {
  readonly search: StatisticsSearch;
  readonly onSearchChange: (next: StatisticsSearch) => void;
}) {
  const result = useCliProxyHubs({ environmentIds: search.environmentIds });
  // The tick can predate freshly received snapshots, which would make them look future-dated.
  const now = Math.max(useRelativeTimeTick(30_000), result.receivedAtMs);
  const openSettings = useSettingsDialogStore((state) => state.openSettings);
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
  const groups = useMemo(() => groupCliProxyAccounts(hubs), [hubs]);
  const failedEnvironments = result.environments.filter(
    (environment): environment is CliProxyEnvironmentResult & { message: string } =>
      environment.status !== "ok",
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
  const showHubLabels = hubLabels.size > 1;
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
  const manageHubs = () =>
    openSettings(
      "providers",
      result.environments.length === 1 ? result.environments[0]!.environmentId : null,
    );

  if (result.loading && result.environments.length === 0) return <StatSkeleton />;

  if (hubs.length === 0) {
    return (
      <div className="space-y-4">
        {environmentFilter}
        {environmentNotices}
        <StatePanel
          icon={ServerIcon}
          title="No CLIProxyAPI hub connected"
          description="Connect a CLIProxyAPI server in Settings → Providers to see how much of each Claude, Codex and Antigravity subscription is left, plus request counts for API keys."
          action={
            <Button size="sm" variant="outline" onClick={manageHubs}>
              <SettingsIcon /> Connect a hub
            </Button>
          }
        />
      </div>
    );
  }

  const accountCount = groups.reduce((total, group) => total + group.accounts.length, 0);
  const lastChecked = hubs
    .map((entry) => entry.hub.checkedAt)
    .toSorted()
    .at(-1);
  const apiKeys = listCliProxyApiKeys(hubs);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-2">
          {environmentFilter}
          <h2 className="text-lg font-semibold tracking-tight">Subscription limits</h2>
          <p className="text-xs text-muted-foreground">
            {accountCount === 1 ? "1 account" : `${accountCount} accounts`} across{" "}
            {hubs.length === 1 ? "1 CLIProxyAPI hub" : `${hubs.length} CLIProxyAPI hubs`}
            {lastChecked ? ` · checked ${formatRelativeTimeLabel(lastChecked)}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="xs" variant="ghost" onClick={manageHubs}>
            <SettingsIcon /> Manage hubs
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
        />
      ))}

      {apiKeys.length > 0 ? (
        <ApiKeyPanel rows={apiKeys} hubLabels={showHubLabels ? hubLabels : null} />
      ) : null}

      <HubList hubs={hubs} multipleEnvironments={multipleEnvironments} />
    </div>
  );
}

function PooledSummary({ pooled }: { readonly pooled: ReadonlyArray<CliProxyPooledWindow> }) {
  return (
    <div className="flex flex-wrap gap-2 border-b border-border/60 px-4 py-3">
      {pooled.map((window) => {
        const reset = formatRateLimitResetText(window.nextResetsAt);
        return (
          <div
            key={window.id}
            className="min-w-36 rounded-lg bg-muted/50 px-3 py-2"
            title="Plans of different sizes count equally in the average."
          >
            <p className="text-[11px] text-muted-foreground">{window.label}</p>
            <p className="text-sm font-semibold tabular-nums">
              {Math.round(100 - window.usedPercent)}% left
            </p>
            <p className="text-[11px] text-muted-foreground">
              avg of {window.accountCount} accounts{reset ? ` · next ${reset}` : ""}
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
}: {
  readonly group: CliProxyProviderGroup;
  readonly now: number;
  readonly hubLabels: HubLabels;
}) {
  // A single account's window is already on its card; only shared windows are pooled.
  const pooled = group.pooled.filter((window) => window.accountCount > 1);
  return (
    <Panel
      title={group.label}
      action={
        <span className="text-[11px] text-muted-foreground">
          {group.accounts.length === 1 ? "1 account" : `${group.accounts.length} accounts`}
        </span>
      }
      bodyClassName="overflow-hidden"
    >
      {pooled.length > 0 ? <PooledSummary pooled={pooled} /> : null}
      {/* Cells draw right and bottom borders; the negative margins clip the outer edges. */}
      <div className="-mr-px -mb-px grid sm:grid-cols-2 xl:grid-cols-3">
        {group.accounts.map((entry) => (
          <AccountCard
            key={`${entry.hubKey}\n${entry.account.authIndex}`}
            entry={entry}
            now={now}
            hubLabel={hubLabels ? (hubLabels.get(entry.hubKey) ?? entry.hubLabel) : null}
          />
        ))}
      </div>
    </Panel>
  );
}

function HealthBadge({ health }: { readonly health: CliProxyAccountHealth }) {
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

function AccountCard({
  entry,
  now,
  hubLabel,
}: {
  readonly entry: CliProxyHubAccountEntry;
  readonly now: number;
  readonly hubLabel: string | null;
}) {
  const { account } = entry;
  const health = cliProxyAccountHealth(account, now);
  const plan = formatCliProxyPlan(account.quota.planType);
  const details = [plan, hubLabel].filter(Boolean).join(" · ");
  const note = quotaNote(entry);
  const recent = cliProxyRecentRequestTotal(account.requests);
  const credits = account.quota.credits;
  return (
    <div className="flex min-w-0 flex-col gap-3 border-r border-b border-border/60 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex min-w-0 text-sm leading-5 font-medium">
            <CliProxyAccountName account={account} className="text-sm leading-5 text-foreground" />
          </p>
          {details ? <p className="truncate text-[11px] text-muted-foreground">{details}</p> : null}
        </div>
        <HealthBadge health={health} />
      </div>
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
      {credits ? (
        <p className="text-[11px] text-muted-foreground">
          Credits: {credits.unlimited ? "unlimited" : (credits.balance ?? "available")}
        </p>
      ) : null}
      <p className="mt-auto text-[11px] text-muted-foreground tabular-nums">
        {formatInteger(account.requests.success)} ok · {formatInteger(account.requests.failed)}{" "}
        failed since the hub started · {formatInteger(recent)} in the last 200 min
      </p>
    </div>
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
