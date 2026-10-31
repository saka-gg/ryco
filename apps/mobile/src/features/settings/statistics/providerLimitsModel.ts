import type { EnvironmentId } from "@ryco/contracts";
import {
  cliProxyAccountHealth,
  cliProxyAccountPublicName,
  cliProxyHubIdentity,
  cliProxyQuotaNote,
  cliProxyWindowLabel,
  formatCliProxyPlan,
  groupSubscriptionLimits,
  hubKeysByDirectAccount,
  listDirectProviderAccounts,
  subscriptionDriverForProvider,
  type CliProxyAccountHealth,
  type CliProxyEnvironmentHub,
  type CliProxyHubAccountEntry,
  type DirectProviderAccount,
  type LabelledLimitWindow,
  type LimitlessProviderInstance,
  type PooledLimitWindow,
  type RoutedProviderInstance,
  type SubscriptionLimitsEnvironment,
} from "@ryco/client-runtime/usage";

import type { NodeStatistics } from "./useStatisticsData";

/**
 * One device's providers and hubs, as the Limits tab read them: the same shape every shared
 * limits selector takes (`SubscriptionLimitsEnvironment`).
 */
export interface ProviderLimitsNode extends SubscriptionLimitsEnvironment {
  readonly environmentId: EnvironmentId;
  /** Why its hubs are missing: a failed read, or a node that predates hubs. */
  readonly hubsMessage?: string;
}

/** The Limits tab's devices: each device that answered with providers, with its hubs. */
export function providerLimitsNodes(nodes: readonly NodeStatistics[]): ProviderLimitsNode[] {
  return nodes.flatMap((node): ProviderLimitsNode[] => {
    if (!node.providers) return [];
    const { environment, hubs } = node;
    return [
      {
        environmentId: environment.environmentId,
        label: environment.label,
        connected:
          environment.connectionState === "connected" ||
          environment.connectionState === "read-only",
        providers: node.providers,
        hubs: hubs?.hubs ?? [],
        ...(hubs !== undefined && hubs.status !== "ok" && hubs.message
          ? { hubsMessage: hubs.message }
          : {}),
      },
    ];
  });
}

/** One account a hub pools, as a row. Nothing in it names an email. */
export interface HubAccountRow {
  readonly key: string;
  /** `cliProxyAccountPublicName`: its label or file name, or `Account N` when email-like. */
  readonly name: string;
  /** The driver whose icon stands for the hub's provider. */
  readonly driver: string;
  /** Plan, hub and any health other than ready, e.g. `Max · via Home hub · Cooling down`. */
  readonly detail: string;
  readonly windows: ReadonlyArray<LabelledLimitWindow & { readonly id: string }>;
  /** When its quota was read (else when its hub was), for pace. */
  readonly checkedAt: string;
  readonly available: boolean;
  /** What the hub says about it, or why it shows no windows. */
  readonly notes: readonly string[];
}

export interface ProviderLimitsGroup {
  readonly provider: string;
  readonly label: string;
  readonly directAccounts: ReadonlyArray<DirectProviderAccount>;
  readonly withoutLimits: ReadonlyArray<LimitlessProviderInstance>;
  readonly hubAccounts: readonly HubAccountRow[];
  /**
   * Windows several hub accounts share, averaged (the group's `pooled`). A single account's
   * window is already on its row.
   */
  readonly pooled: ReadonlyArray<PooledLimitWindow>;
  /** Instances a hub serves instead, so their own limits are not shown. */
  readonly routed: readonly string[];
}

export interface ProviderLimitsNotice {
  readonly key: string;
  readonly title: string;
  readonly message: string;
}

export interface ProviderLimitsView {
  readonly groups: readonly ProviderLimitsGroup[];
  /** Every window on screen, for the wakeup at the next reset. */
  readonly windows: ReadonlyArray<LabelledLimitWindow>;
  /** Instances without limits named on one line, rather than as panels. */
  readonly limitless: readonly string[];
  /** Routed instances whose provider has no group to be noted in. */
  readonly routed: readonly string[];
  readonly empty: boolean;
  readonly environmentIds: ReadonlyMap<string, EnvironmentId>;
  /** `Also in <hubs>` for each direct account a hub holds too, by account key. */
  readonly alsoInHubs: ReadonlyMap<string, string>;
  /** Devices whose hubs could not be read, and hubs that could not be read. */
  readonly notices: readonly ProviderLimitsNotice[];
}

function healthLabel(health: CliProxyAccountHealth): string | null {
  switch (health.kind) {
    case "ready":
      return null;
    case "limited":
      return "Limit reached";
    case "cooling":
      return "Cooling down";
    case "error":
      return "Error";
    case "disabled":
      return "Disabled";
  }
}

function healthNote(health: CliProxyAccountHealth): string | null {
  if (health.kind === "error" && health.message) return `The hub reports: ${health.message}`;
  if (health.kind === "cooling" && health.until) {
    const until = new Date(health.until);
    if (Number.isFinite(until.getTime())) return `The hub retries it ${until.toLocaleString()}.`;
  }
  return null;
}

function hubAccountRow(
  entry: CliProxyHubAccountEntry,
  position: number,
  hub: { readonly label: string; readonly checkedAt: string },
  nowMs: number,
): HubAccountRow {
  const { account } = entry;
  const health = cliProxyAccountHealth(account, nowMs);
  return {
    key: `${entry.hubKey}\n${account.authIndex}`,
    name: cliProxyAccountPublicName(account, position),
    driver: subscriptionDriverForProvider(account.provider),
    detail: [formatCliProxyPlan(account.quota.planType), `via ${hub.label}`, healthLabel(health)]
      .filter(Boolean)
      .join(" · "),
    windows:
      account.quota.status === "ok"
        ? account.quota.windows.map((window) => ({
            id: window.id,
            label: cliProxyWindowLabel(window),
            window,
          }))
        : [],
    checkedAt: account.quota.checkedAt ?? hub.checkedAt,
    available: !account.disabled,
    notes: [healthNote(health), cliProxyQuotaNote(account)].filter(
      (note): note is string => note !== null,
    ),
  };
}

function routedNote(instance: RoutedProviderInstance, severalNodes: boolean): string {
  const where = severalNodes ? ` on ${instance.environmentLabel}` : "";
  return `${instance.displayName}${where} is routed through ${instance.hubLabel}, so it uses the hub's accounts and its own limits are not shown.`;
}

/**
 * The Limits tab across devices, through the same shared selectors as the web Limits page: each
 * direct account once, the accounts each CLIProxyAPI hub pools, their pooled windows, and the
 * instances a hub serves instead. Direct accounts are never averaged into a pool.
 */
export function deriveProviderLimitsView(
  nodes: readonly ProviderLimitsNode[],
  nowMs: number,
): ProviderLimitsView {
  const severalNodes = nodes.length > 1;
  const hubs: CliProxyEnvironmentHub[] = nodes.flatMap((node) =>
    node.hubs.map((hub) => ({ environmentId: node.environmentId, hub })),
  );
  const nodeLabels = new Map<string, string>(nodes.map((node) => [node.environmentId, node.label]));
  // A loopback hub is a different machine on each device, so its label names the device too.
  const hubsByKey = new Map(
    hubs.map((entry) => {
      const key = cliProxyHubIdentity(entry);
      const nodeLocal = key !== entry.hub.url;
      const label =
        nodeLocal && severalNodes
          ? `${entry.hub.label} · ${nodeLabels.get(entry.environmentId) ?? ""}`
          : entry.hub.label;
      return [key, { label, checkedAt: entry.hub.checkedAt }] as const;
    }),
  );

  const { accounts, routed, withoutLimits } = listDirectProviderAccounts(nodes);
  // A Codex instance keeps its banked resets, and any pending reset attempt, without windows.
  const resettable = withoutLimits.filter((instance) => instance.driver === "codex");
  const groups = groupSubscriptionLimits({
    hubs,
    direct: accounts,
    routed,
    withoutLimits: resettable,
  }).map((group): ProviderLimitsGroup => ({
    provider: group.provider,
    label: group.label,
    directAccounts: group.directAccounts,
    withoutLimits: group.withoutLimits,
    hubAccounts: group.hubAccounts.map((entry, index) =>
      hubAccountRow(
        entry,
        index + 1,
        hubsByKey.get(entry.hubKey) ?? {
          label: entry.hubLabel,
          checkedAt: new Date(nowMs).toISOString(),
        },
        nowMs,
      ),
    ),
    pooled: group.pooled.filter((window) => window.accountCount > 1),
    routed: group.routed.map((instance) => routedNote(instance, severalNodes)),
  }));
  const grouped = new Set(groups.map((group) => group.provider));
  const strayRouted = routed
    .filter((instance) => !grouped.has(instance.provider))
    .map((instance) => routedNote(instance, severalNodes));
  // Every other instance without limits is named on one line.
  const limitless = [
    ...new Set(
      withoutLimits
        .filter((instance) => instance.driver !== "codex")
        .map((instance) =>
          severalNodes
            ? `${instance.displayName} on ${instance.environmentLabel}`
            : instance.displayName,
        ),
    ),
  ];

  const notices: ProviderLimitsNotice[] = [];
  for (const node of nodes) {
    if (node.hubsMessage) {
      notices.push({
        key: `node\n${node.environmentId}`,
        title: node.label,
        message: node.hubsMessage,
      });
    }
    for (const hub of node.hubs) {
      if (hub.status !== "error") continue;
      notices.push({
        key: `hub\n${node.environmentId}\n${hub.hubId}`,
        title: severalNodes ? `${hub.label} · ${node.label}` : hub.label,
        message: hub.error ?? "This hub could not be read.",
      });
    }
  }

  return {
    groups,
    windows: [
      ...accounts.flatMap((account) => account.windows),
      ...groups.flatMap((group) => group.hubAccounts.flatMap((row) => row.windows)),
    ],
    limitless,
    routed: strayRouted,
    empty: groups.length === 0 && limitless.length === 0 && strayRouted.length === 0,
    environmentIds: new Map<string, EnvironmentId>(
      nodes.map((node) => [node.environmentId, node.environmentId]),
    ),
    alsoInHubs: new Map(
      [...hubKeysByDirectAccount(accounts, hubs)].map(([accountKey, hubKeys]) => [
        accountKey,
        `Also in ${[...new Set(hubKeys.flatMap((hubKey) => hubsByKey.get(hubKey)?.label ?? []))].join(", ")}`,
      ]),
    ),
    notices,
  };
}
