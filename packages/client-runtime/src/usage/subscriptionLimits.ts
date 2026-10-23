/**
 * Subscription limits from both sources a client can read: the accounts provider instances sign
 * in to directly (`ServerProvider.rateLimits`) and the accounts CLIProxyAPI hubs pool.
 *
 * @module usage/subscriptionLimits
 */
import type {
  CliProxyHubSnapshot,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderRateLimits,
} from "@ryco/contracts";

import {
  cliProxyHubIdentity,
  cliProxyProviderLabel,
  cliProxyProviderRank,
  findCliProxyRouteForInstance,
  formatCliProxyPlan,
  groupCliProxyAccounts,
  type CliProxyEnvironmentHub,
  type CliProxyHubAccountEntry,
} from "./cliProxy.ts";
import {
  clampUsedPercent,
  describeRateLimitWindow,
  isRateLimitSnapshotAvailable,
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

/** An instance's reported windows; one without a valid duration takes its slot's name. */
export function providerLimitWindows(provider: ServerProvider): LabelledLimitWindow[] {
  const limits = provider.rateLimits;
  if (!limits) return [];
  const slots = [
    [limits.primary, "Short window"],
    [limits.secondary, "Weekly"],
    [limits.tertiary, "Monthly"],
  ] as const;
  return slots.flatMap(([window, fallback]) => {
    if (!window) return [];
    const { label } = describeRateLimitWindow(window);
    return [{ label: label === "Window" ? fallback : label, window }];
  });
}

/** When the soonest of these windows resets after `nowMs`, in epoch ms; null when none will. */
export function nextLimitResetAtMs(
  windows: Iterable<LabelledLimitWindow>,
  nowMs: number,
): number | null {
  let next: number | null = null;
  for (const { window } of windows) {
    const reset = (window.resetsAt ?? NaN) * 1000;
    if (Number.isFinite(reset) && reset > nowMs && (next === null || reset < next)) next = reset;
  }
  return next;
}

/** A connected environment's providers and hubs, as the limits view reads them. */
export interface SubscriptionLimitsEnvironment {
  readonly environmentId: string;
  readonly label: string;
  readonly connected: boolean;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly hubs: ReadonlyArray<CliProxyHubSnapshot>;
}

/** One enabled provider instance on one environment. */
export interface DirectAccountLocation {
  readonly environmentId: string;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly driver: ProviderDriverKind;
  /** Whether this instance's limits are live enough for pace (`isRateLimitSnapshotAvailable`). */
  readonly available: boolean;
  /** Whether the instance is signed in; reset redemption gates on this, not on `available`. */
  readonly authenticated: boolean;
  readonly checkedAt: string;
}

/** An account provider instances sign in to themselves, counted once across environments. */
export interface DirectProviderAccount {
  readonly key: string;
  readonly provider: string;
  /** The freshest snapshot among the instances signed in to this account. */
  readonly snapshot: ServerProvider;
  readonly available: boolean;
  readonly windows: ReadonlyArray<LabelledLimitWindow>;
  /** The plan the freshest snapshot names (`Claude Max Subscription`, `Plus`…). */
  readonly plan: string | undefined;
  /** Banked resets from the newest read that reported them, which may not be the snapshot's. */
  readonly resetCredits: ServerProviderRateLimits["resetCredits"];
  /** Every instance signed in to the account, in environment order. */
  readonly locations: ReadonlyArray<DirectAccountLocation>;
}

/** An instance whose requests a hub serves; its own limits describe no account the hub uses. */
export interface RoutedProviderInstance extends DirectAccountLocation {
  readonly provider: string;
  readonly hubLabel: string;
}

/** An enabled instance no hub routes that reports no limit windows. */
export interface LimitlessProviderInstance extends DirectAccountLocation {
  readonly provider: string;
  readonly snapshot: ServerProvider;
  /** The plan its snapshot names, worded like `DirectProviderAccount.plan`. */
  readonly plan: string | undefined;
  readonly reason: string | undefined;
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

interface DirectInstance {
  readonly provider: ServerProvider;
  readonly location: DirectAccountLocation;
  readonly windows: ReadonlyArray<LabelledLimitWindow>;
}

function emailAccountKey(provider: ServerProvider): string | undefined {
  const email = provider.auth.email?.toLowerCase();
  return email ? `${subscriptionProviderForDriver(provider.driver)}\n${email}` : undefined;
}

function planKey(provider: ServerProvider): string | undefined {
  return provider.rateLimits?.planType?.toLowerCase();
}

/**
 * Keys an instance's account by provider, email and plan, so one email on two plans (a personal
 * and a team workspace) stays two accounts. A planless snapshot from an older node joins its
 * email's only known plan, and stays apart when several are known. An instance without an email
 * is its own account. Keys never contain credentials.
 */
function directAccountKeyResolver(
  instances: ReadonlyArray<DirectInstance>,
): (instance: DirectInstance) => string {
  // Every instance counts, read or not, so a plan without windows still makes the email ambiguous.
  const plansByEmail = new Map<string, Set<string>>();
  for (const { provider } of instances) {
    const email = emailAccountKey(provider);
    const plan = planKey(provider);
    if (email && plan) plansByEmail.set(email, (plansByEmail.get(email) ?? new Set()).add(plan));
  }
  return ({ provider, location }) => {
    const email = emailAccountKey(provider);
    const known = email ? plansByEmail.get(email) : undefined;
    const plan = planKey(provider) ?? (known?.size === 1 ? [...known][0] : undefined);
    if (email && plan) return `${email}\n${plan}`;
    if (email && !known) return email;
    // No email, or a planless snapshot of an email with several plans: never merged.
    const slug = subscriptionProviderForDriver(provider.driver);
    return `${slug}\n${location.environmentId}\n${provider.instanceId}`;
  };
}

/** A read's time in ms; an unparsable one is older than any other. */
function checkedAtMs(location: DirectAccountLocation): number {
  const ms = Date.parse(location.checkedAt);
  return Number.isNaN(ms) ? -Infinity : ms;
}

/** Available beats unavailable, then the newer read. */
function isFresher(candidate: DirectAccountLocation, current: DirectAccountLocation): boolean {
  return (
    (candidate.available && !current.available) ||
    (candidate.available === current.available && checkedAtMs(candidate) > checkedAtMs(current))
  );
}

/** Banked resets from the newest read that reported them. */
function newestResetCredits(
  instances: ReadonlyArray<DirectInstance>,
): ServerProviderRateLimits["resetCredits"] {
  let newest: DirectInstance | undefined;
  for (const instance of instances) {
    if (instance.provider.rateLimits?.resetCredits === undefined) continue;
    if (!newest || checkedAtMs(instance.location) > checkedAtMs(newest.location)) newest = instance;
  }
  return newest?.provider.rateLimits?.resetCredits;
}

/** The plan a snapshot names (`Claude Max Subscription`, `Plus`…). */
function snapshotPlan(provider: ServerProvider): string | undefined {
  return (
    provider.auth.label ??
    provider.rateLimits?.limitName ??
    formatCliProxyPlan(provider.rateLimits?.planType)
  );
}

/**
 * Direct accounts across environments, the instances hubs route instead, and the instances that
 * report no limits. Instances signed in to the same email and plan of the same provider are one
 * account; the freshest available snapshot wins.
 *
 * A hub-routed instance is set aside before any keying: it never supplies windows, never becomes
 * an account's location and never matches a direct account's email.
 */
export function listDirectProviderAccounts(
  environments: ReadonlyArray<SubscriptionLimitsEnvironment>,
): {
  readonly accounts: DirectProviderAccount[];
  readonly routed: RoutedProviderInstance[];
  readonly withoutLimits: LimitlessProviderInstance[];
} {
  const routed: RoutedProviderInstance[] = [];
  const direct: DirectInstance[] = [];
  for (const environment of environments) {
    for (const provider of environment.providers) {
      if (!provider.enabled) continue;
      const location: DirectAccountLocation = {
        environmentId: environment.environmentId,
        environmentLabel: environment.label,
        instanceId: provider.instanceId,
        displayName: providerName(provider),
        driver: provider.driver,
        available: isRateLimitSnapshotAvailable(provider, environment.connected),
        authenticated: provider.auth.status === "authenticated",
        checkedAt: provider.checkedAt,
      };
      const slug = subscriptionProviderForDriver(provider.driver);
      const hub = findCliProxyRouteForInstance(environment.hubs, provider.instanceId);
      if (hub) {
        routed.push({ ...location, provider: slug, hubLabel: hub.label });
        continue;
      }
      direct.push({ provider, location, windows: providerLimitWindows(provider) });
    }
  }

  const accountKey = directAccountKeyResolver(direct);
  const byKey = new Map<string, DirectInstance[]>();
  const withoutLimits: LimitlessProviderInstance[] = [];
  for (const instance of direct) {
    const { provider, location } = instance;
    if (instance.windows.length === 0) {
      withoutLimits.push({
        ...location,
        provider: subscriptionProviderForDriver(provider.driver),
        snapshot: provider,
        plan: snapshotPlan(provider),
        reason: provider.unavailableReason ?? provider.message,
      });
      continue;
    }
    const key = accountKey(instance);
    byKey.set(key, [...(byKey.get(key) ?? []), instance]);
  }

  const accounts = [...byKey].map(([key, instances]): DirectProviderAccount => {
    const winner = instances.reduce((best, next) =>
      isFresher(next.location, best.location) ? next : best,
    );
    const snapshot = winner.provider;
    return {
      key,
      provider: subscriptionProviderForDriver(snapshot.driver),
      snapshot,
      available: winner.location.available,
      windows: winner.windows,
      plan: snapshotPlan(snapshot),
      resetCredits: newestResetCredits(instances),
      locations: instances.map(({ location }) => location),
    };
  });
  return { accounts, routed, withoutLimits };
}

/**
 * The hubs that also hold each direct account, as `cliProxyHubIdentity` keys by account key: hub
 * accounts of the same provider with the same email. A hub account named only by its credential
 * file never matches.
 */
export function hubKeysByDirectAccount(
  accounts: ReadonlyArray<DirectProviderAccount>,
  hubs: ReadonlyArray<CliProxyEnvironmentHub>,
): ReadonlyMap<string, readonly string[]> {
  const hubKeysByEmail = new Map<string, Set<string>>();
  for (const entry of hubs) {
    const hubKey = cliProxyHubIdentity(entry);
    for (const account of entry.hub.accounts) {
      if (!account.email) continue;
      const email = `${account.provider}\n${account.email.toLowerCase()}`;
      hubKeysByEmail.set(email, (hubKeysByEmail.get(email) ?? new Set()).add(hubKey));
    }
  }
  const matches = new Map<string, readonly string[]>();
  for (const account of accounts) {
    const email = emailAccountKey(account.snapshot);
    const hubKeys = email ? hubKeysByEmail.get(email) : undefined;
    if (hubKeys) matches.set(account.key, [...hubKeys]);
  }
  return matches;
}

export interface SubscriptionLimitGroup {
  readonly provider: string;
  readonly label: string;
  readonly directAccounts: ReadonlyArray<DirectProviderAccount>;
  readonly hubAccounts: ReadonlyArray<CliProxyHubAccountEntry>;
  readonly routed: ReadonlyArray<RoutedProviderInstance>;
  /** The instances without limits the caller asked to list under this provider. */
  readonly withoutLimits: ReadonlyArray<LimitlessProviderInstance>;
  /**
   * Averages over the enabled hub accounts only. Direct accounts are never averaged: different
   * accounts are not one allowance, and a direct account may be one a hub holds too.
   */
  readonly pooled: ReadonlyArray<PooledLimitWindow>;
}

function accountLabel(account: DirectProviderAccount): string {
  return (
    account.snapshot.auth.email ??
    account.snapshot.displayName ??
    account.snapshot.instanceId
  ).toLowerCase();
}

/**
 * Direct and hub accounts grouped by provider (Claude, Codex, Antigravity first). Instances
 * without limits join their provider's group only when passed in `withoutLimits`, such as Codex
 * instances that still hold banked resets.
 */
export function groupSubscriptionLimits(input: {
  readonly hubs: ReadonlyArray<CliProxyEnvironmentHub>;
  readonly direct: ReadonlyArray<DirectProviderAccount>;
  readonly routed: ReadonlyArray<RoutedProviderInstance>;
  readonly withoutLimits?: ReadonlyArray<LimitlessProviderInstance>;
}): SubscriptionLimitGroup[] {
  const withoutLimits = input.withoutLimits ?? [];
  const hubGroups = new Map(
    groupCliProxyAccounts(input.hubs).map((group) => [group.provider, group] as const),
  );
  // A routed instance only annotates a group; it adds no account of its own.
  const providers = new Set([
    ...hubGroups.keys(),
    ...input.direct.map((account) => account.provider),
    ...withoutLimits.map((instance) => instance.provider),
  ]);
  return [...providers]
    .toSorted(
      (left, right) =>
        cliProxyProviderRank(left) - cliProxyProviderRank(right) || left.localeCompare(right),
    )
    .map((provider) => {
      const hubGroup = hubGroups.get(provider);
      const directAccounts = input.direct
        .filter((account) => account.provider === provider)
        .toSorted((left, right) => accountLabel(left).localeCompare(accountLabel(right)));
      return {
        provider,
        label: cliProxyProviderLabel(provider),
        directAccounts,
        hubAccounts: hubGroup?.accounts ?? [],
        routed: input.routed.filter((instance) => instance.provider === provider),
        withoutLimits: withoutLimits.filter((instance) => instance.provider === provider),
        pooled: hubGroup?.pooled ?? [],
      };
    });
}
