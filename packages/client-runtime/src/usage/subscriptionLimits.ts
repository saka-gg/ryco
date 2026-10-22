/**
 * Subscription limits from both sources a client can read: the accounts provider instances sign
 * in to directly (`ServerProvider.rateLimits`) and the accounts CLIProxyAPI hubs pool.
 *
 * @module usage/subscriptionLimits
 */
import type { CliProxyHubSnapshot, ProviderInstanceId, ServerProvider } from "@ryco/contracts";

import {
  cliProxyProviderLabel,
  cliProxyProviderRank,
  cliProxyPoolableWindows,
  findCliProxyRouteForInstance,
  groupCliProxyAccounts,
  type CliProxyEnvironmentHub,
  type CliProxyHubAccountEntry,
} from "./cliProxy.ts";
import {
  clampUsedPercent,
  describeRateLimitWindow,
  isRateLimitSnapshotAvailable,
  poolLimitWindows,
  type LabelledLimitWindow,
  type PooledLimitWindow,
} from "./limits.ts";

/** Provider slugs as hubs name them, so a direct account joins its hub accounts' group. */
const DRIVER_PROVIDERS: Readonly<Record<string, string>> = {
  claudeAgent: "claude",
  codex: "codex",
  opencode: "opencode",
};

export function subscriptionProviderForDriver(driver: string): string {
  return DRIVER_PROVIDERS[driver] ?? driver;
}

/** A provider instance's reported windows; a window without a duration takes its slot's name. */
export function providerLimitWindows(provider: ServerProvider): LabelledLimitWindow[] {
  const limits = provider.rateLimits;
  if (!limits) return [];
  const slots = [
    [limits.primary, "Short window"],
    [limits.secondary, "Weekly"],
    [limits.tertiary, "Monthly"],
  ] as const;
  return slots.flatMap(([window, fallback]) =>
    window
      ? [
          {
            label:
              window.windowDurationMins === undefined
                ? fallback
                : describeRateLimitWindow(window).label,
            window,
          },
        ]
      : [],
  );
}

/** A connected environment's providers and hubs, as the limits view reads them. */
export interface SubscriptionLimitsEnvironment {
  readonly environmentId: string;
  readonly label: string;
  readonly connected: boolean;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly hubs: ReadonlyArray<CliProxyHubSnapshot>;
}

export interface DirectAccountLocation {
  readonly environmentId: string;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
}

/** An account provider instances sign in to themselves, counted once across environments. */
export interface DirectProviderAccount {
  readonly key: string;
  readonly provider: string;
  /** The freshest snapshot among the instances signed in to this account. */
  readonly snapshot: ServerProvider;
  readonly available: boolean;
  readonly windows: ReadonlyArray<LabelledLimitWindow>;
  /** Every instance signed in to the account, in environment order. */
  readonly locations: ReadonlyArray<DirectAccountLocation>;
}

/** An instance whose requests a hub serves; its own limits describe no account the hub uses. */
export interface RoutedProviderInstance extends DirectAccountLocation {
  readonly provider: string;
  readonly hubLabel: string;
}

export type DirectAccountHealth =
  | { readonly kind: "ready" }
  | { readonly kind: "limited" }
  | { readonly kind: "unavailable"; readonly message: string | undefined };

export function directAccountHealth(account: DirectProviderAccount): DirectAccountHealth {
  if (!account.available) return { kind: "unavailable", message: account.snapshot.message };
  const exhausted =
    account.snapshot.rateLimits?.rateLimitReachedType !== undefined ||
    account.windows.some(({ window }) => (clampUsedPercent(window.usedPercent) ?? 0) >= 100);
  return exhausted ? { kind: "limited" } : { kind: "ready" };
}

function providerName(provider: ServerProvider): string {
  return provider.displayName ?? provider.instanceId;
}

/**
 * Direct accounts across environments and the instances hubs route instead. Instances signed in
 * to the same email of the same provider are one account; the freshest available snapshot wins.
 */
export function listDirectProviderAccounts(
  environments: ReadonlyArray<SubscriptionLimitsEnvironment>,
): {
  readonly accounts: DirectProviderAccount[];
  readonly routed: RoutedProviderInstance[];
} {
  const byKey = new Map<string, DirectProviderAccount>();
  const routed: RoutedProviderInstance[] = [];
  for (const environment of environments) {
    for (const provider of environment.providers) {
      if (!provider.enabled) continue;
      const location: DirectAccountLocation = {
        environmentId: environment.environmentId,
        environmentLabel: environment.label,
        instanceId: provider.instanceId,
        displayName: providerName(provider),
      };
      const slug = subscriptionProviderForDriver(provider.driver);
      const hub = findCliProxyRouteForInstance(environment.hubs, provider.instanceId);
      if (hub) {
        routed.push({ ...location, provider: slug, hubLabel: hub.label });
        continue;
      }
      const windows = providerLimitWindows(provider);
      if (windows.length === 0) continue;
      const email = provider.auth.email?.toLowerCase();
      const key = email
        ? `${slug}\n${email}`
        : `${slug}\n${environment.environmentId}\n${provider.instanceId}`;
      const available = isRateLimitSnapshotAvailable(provider, environment.connected);
      const existing = byKey.get(key);
      const fresher =
        !existing ||
        (available && !existing.available) ||
        (available === existing.available &&
          Date.parse(provider.checkedAt) > Date.parse(existing.snapshot.checkedAt));
      byKey.set(key, {
        key,
        provider: slug,
        snapshot: fresher ? provider : existing.snapshot,
        available: fresher ? available : existing.available,
        windows: fresher ? windows : existing.windows,
        locations: [...(existing?.locations ?? []), location],
      });
    }
  }
  return { accounts: [...byKey.values()], routed };
}

export interface SubscriptionLimitGroup {
  readonly provider: string;
  readonly label: string;
  readonly directAccounts: ReadonlyArray<DirectProviderAccount>;
  readonly hubAccounts: ReadonlyArray<CliProxyHubAccountEntry>;
  readonly routed: ReadonlyArray<RoutedProviderInstance>;
  /** Averages over the available direct accounts and the enabled hub accounts together. */
  readonly pooled: ReadonlyArray<PooledLimitWindow>;
}

function accountLabel(account: DirectProviderAccount): string {
  return (
    account.snapshot.auth.email ??
    account.snapshot.displayName ??
    account.snapshot.instanceId
  ).toLowerCase();
}

/** Direct and hub accounts grouped by provider (Claude, Codex, Antigravity first). */
export function groupSubscriptionLimits(input: {
  readonly hubs: ReadonlyArray<CliProxyEnvironmentHub>;
  readonly direct: ReadonlyArray<DirectProviderAccount>;
  readonly routed: ReadonlyArray<RoutedProviderInstance>;
}): SubscriptionLimitGroup[] {
  const hubGroups = new Map(
    groupCliProxyAccounts(input.hubs).map((group) => [group.provider, group.accounts] as const),
  );
  // A routed instance only annotates a group; it adds no account of its own.
  const providers = new Set([
    ...hubGroups.keys(),
    ...input.direct.map((account) => account.provider),
  ]);
  return [...providers]
    .toSorted(
      (left, right) =>
        cliProxyProviderRank(left) - cliProxyProviderRank(right) || left.localeCompare(right),
    )
    .map((provider) => {
      const hubAccounts = hubGroups.get(provider) ?? [];
      const directAccounts = input.direct
        .filter((account) => account.provider === provider)
        .toSorted((left, right) => accountLabel(left).localeCompare(accountLabel(right)));
      return {
        provider,
        label: cliProxyProviderLabel(provider),
        directAccounts,
        hubAccounts,
        routed: input.routed.filter((instance) => instance.provider === provider),
        pooled: poolLimitWindows([
          ...directAccounts
            .filter((account) => account.available)
            .map((account) => account.windows),
          ...hubAccounts.map((entry) => cliProxyPoolableWindows(entry.account)),
        ]),
      };
    });
}
