import {
  availablePercent,
  cliProxyAccountPublicName,
  cliProxyHubIdentity,
  cliProxyPoolableWindows,
  describeRateLimitWindow,
  formatCliProxyPlan,
  groupSubscriptionLimits,
  listDirectProviderAccounts,
  poolLimitWindows,
  rateLimitsObservedAt,
  type CliProxyEnvironmentHub,
  type CliProxyHubAccountEntry,
  type DirectProviderAccount,
  type LabelledLimitWindow,
  type PooledLimitWindow,
  type SubscriptionLimitGroup,
  type SubscriptionLimitsEnvironment,
} from "@ryco/client-runtime/usage";
import type { ServerProviderRateLimitWindow } from "@ryco/contracts";

import type { WidgetTimelineEntry } from "./widgetTimeline";

/**
 * The subscription usage widget's data (`modules/ryco-widgets/extension/SubscriptionUsageWidget.swift`),
 * built from the same shared selectors as the Limits tab: each direct account once, the accounts
 * CLIProxyAPI hubs pool, and their pooled windows. Direct accounts are never averaged.
 *
 * It holds only what a Lock Screen may show: percentages, reset times, plans, account counts and
 * account names that are not email-like. No email, Hub or hub address, instance id or node name.
 */

/** How long an account's read stays on the widget. */
export const SUBSCRIPTION_USAGE_MAX_AGE_MS = 15 * 60_000;
/**
 * Deadlines fall on whole minutes (an account leaves at most a minute early), so the timeline has
 * at most one entry per minute of {@link SUBSCRIPTION_USAGE_MAX_AGE_MS}, however many accounts.
 */
const DEADLINE_STEP_MS = 60_000;
/** Windows kept per provider and view: the largest widget shows six. */
export const SUBSCRIPTION_USAGE_MAX_WINDOWS = 6;
/** Provider columns kept: the largest widget shows three. */
export const SUBSCRIPTION_USAGE_MAX_PROVIDERS = 3;
/**
 * A provider with no current read left. A tap opens Limits, which reads every provider again;
 * opening Ryco from its icon only reads the hubs again.
 */
export const TAP_TO_REFRESH = "Tap to refresh";

/** What the widget's period filter picks: the short window, the week, or neither (monthly…). */
export type UsageWindowKind = "session" | "weekly" | "other";

export interface UsageRow {
  /** The account the row belongs to, when its view lists more than one. Never email-like. */
  readonly account?: string;
  /** `5h`, `Weekly`, `Weekly · Opus`. */
  readonly label: string;
  readonly kind: UsageWindowKind;
  /** Whole percent left, 0–100. */
  readonly remaining: number;
  /** When the window resets, epoch ms; null when it is not known. */
  readonly resetsAt: number | null;
}

export interface UsageView {
  readonly detail: string;
  /** Tightest first, at most {@link SUBSCRIPTION_USAGE_MAX_WINDOWS}. */
  readonly rows: readonly UsageRow[];
  /** Rows before the cap, so the widget can say how many more Ryco shows. */
  readonly total: number;
}

/** One provider as the widget shows it at one moment. */
export interface UsageProvider {
  readonly provider: string;
  readonly name: string;
  /** False once none of its accounts has a current read: no rows, and the detail says to tap. */
  readonly fresh: boolean;
  /** When the oldest of the numbers it shows was read, epoch ms; 0 when it shows none. */
  readonly observedAt: number;
  /** The hub accounts' pool, and each direct account on its own. */
  readonly pooled: UsageView;
  /** Every account on its own, its tightest window of each kind. */
  readonly accounts: UsageView;
}

/** An account with windows of its own on the widget: a hub account or a direct account. */
export interface UsageAccount {
  readonly name: string;
  readonly plan: string | undefined;
  readonly rows: readonly UsageRow[];
  readonly observedAt: number;
  /**
   * When it leaves the widget: {@link SUBSCRIPTION_USAGE_MAX_AGE_MS} after its read, or at the
   * soonest of its resets if that comes first (past a reset the numbers describe a window that is
   * over). Each account goes on its own, so one idle machine never hides the others.
   */
  readonly expiresAt: number;
}

export interface UsageHubAccount extends UsageAccount {
  /** What it adds to its hubs' pool. */
  readonly windows: readonly LabelledLimitWindow[];
}

/** One provider's accounts, before a moment decides which of them are still current. */
export interface UsageSource {
  readonly provider: string;
  readonly name: string;
  readonly hubAccounts: readonly UsageHubAccount[];
  readonly directAccounts: readonly UsageAccount[];
}

export interface SubscriptionUsageSnapshot {
  /** What a tap opens: the Limits tab. */
  readonly url: string;
  readonly providers: readonly UsageSource[];
}

/** One entry's content: the snapshot as it reads from the entry's time on. */
export interface SubscriptionUsageContent {
  readonly url: string;
  readonly providers: readonly UsageProvider[];
  /** When the oldest number still shown was read, epoch ms; 0 when none is. */
  readonly observedAt: number;
}

/** The period filter's bucket for a window of this length (`describeRateLimitWindow`). */
function windowKind(windowDurationMins: number | undefined): UsageWindowKind {
  const window: ServerProviderRateLimitWindow =
    windowDurationMins === undefined ? { usedPercent: 0 } : { usedPercent: 0, windowDurationMins };
  const { bucket } = describeRateLimitWindow(window);
  return bucket === "short" ? "session" : bucket === "week" ? "weekly" : "other";
}

function resetMs(resetsAt: number | undefined): number | null {
  const ms = (resetsAt ?? NaN) * 1000;
  return Number.isFinite(ms) ? ms : null;
}

function rowOf({ label, window }: LabelledLimitWindow): UsageRow | null {
  const remaining = availablePercent(window.usedPercent);
  if (remaining === null) return null;
  return {
    label,
    kind: windowKind(window.windowDurationMins),
    remaining: Math.round(remaining),
    resetsAt: resetMs(window.resetsAt),
  };
}

function pooledRowOf(window: PooledLimitWindow): UsageRow {
  return {
    label: window.label,
    kind: windowKind(window.windowDurationMins),
    remaining: Math.round(100 - window.usedPercent),
    resetsAt: resetMs(window.nextResetsAt),
  };
}

/** Text that may reach the Lock Screen: never anything with an `@`. */
function publicText(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 && !value.includes("@") ? value : undefined;
}

function parsedMs(value: string | undefined): number {
  const ms = value === undefined ? NaN : Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function expiry(rows: readonly UsageRow[], observedAt: number): number {
  const resets = rows.flatMap((row) => (row.resetsAt === null ? [] : [row.resetsAt]));
  const deadline = Math.min(observedAt + SUBSCRIPTION_USAGE_MAX_AGE_MS, ...resets);
  return Math.floor(deadline / DEADLINE_STEP_MS) * DEADLINE_STEP_MS;
}

function directAccount(account: DirectProviderAccount, providerName: string): UsageAccount {
  const rows = account.windows.flatMap((window) => rowOf(window) ?? []);
  const observedAt = parsedMs(rateLimitsObservedAt(account.snapshot));
  return {
    name: publicText(account.snapshot.displayName) ?? publicText(account.plan) ?? providerName,
    plan: publicText(account.plan),
    rows,
    observedAt,
    expiresAt: expiry(rows, observedAt),
  };
}

function hubAccount(
  entry: CliProxyHubAccountEntry,
  position: number,
  hubCheckedAt: ReadonlyMap<string, string>,
): UsageHubAccount {
  const { account } = entry;
  const windows = cliProxyPoolableWindows(account);
  const rows = windows.flatMap((window) => rowOf(window) ?? []);
  const observedAt = parsedMs(account.quota.checkedAt ?? hubCheckedAt.get(entry.hubKey));
  return {
    // Numbered by its place among all of the provider's hub accounts, as in the Limits tab.
    name: cliProxyAccountPublicName(account, position),
    plan: publicText(formatCliProxyPlan(account.quota.planType)),
    rows,
    observedAt,
    expiresAt: expiry(rows, observedAt),
    windows,
  };
}

function source(
  group: SubscriptionLimitGroup,
  hubCheckedAt: ReadonlyMap<string, string>,
): UsageSource | null {
  const hubAccounts = group.hubAccounts
    .map((entry, index) => hubAccount(entry, index + 1, hubCheckedAt))
    .filter((account) => account.rows.length > 0);
  const directAccounts = group.directAccounts
    .map((account) => directAccount(account, group.label))
    .filter((account) => account.rows.length > 0);
  if (hubAccounts.length === 0 && directAccounts.length === 0) return null;
  return { provider: group.provider, name: group.label, hubAccounts, directAccounts };
}

const byRemaining = (left: UsageRow, right: UsageRow) => left.remaining - right.remaining;

/**
 * Tightest first, at most {@link SUBSCRIPTION_USAGE_MAX_WINDOWS}, always keeping the tightest
 * session and weekly window, so every period the widget can be set to has a row.
 */
function selectRows(rows: readonly UsageRow[]): UsageRow[] {
  const sorted = rows.toSorted(byRemaining);
  const kept = new Set([
    sorted.find((row) => row.kind === "session"),
    sorted.find((row) => row.kind === "weekly"),
  ]);
  kept.delete(undefined);
  for (const row of sorted) {
    if (kept.size >= SUBSCRIPTION_USAGE_MAX_WINDOWS) break;
    kept.add(row);
  }
  return [...kept].filter((row) => row !== undefined).toSorted(byRemaining);
}

/** An account's tightest window of each kind, labelled with the account when it has company. */
function tightestPerKind(unit: UsageAccount, labelled: boolean): UsageRow[] {
  const tightest = new Map<UsageWindowKind, UsageRow>();
  for (const row of unit.rows) {
    const current = tightest.get(row.kind);
    if (current === undefined || row.remaining < current.remaining) tightest.set(row.kind, row);
  }
  return [...tightest.values()].map((row) => (labelled ? { ...row, account: unit.name } : row));
}

function count(amount: number, noun: string): string {
  return `${amount} ${noun}${amount === 1 ? "" : "s"}`;
}

const EXPIRED_VIEW: UsageView = { detail: TAP_TO_REFRESH, rows: [], total: 0 };

/** A provider at `atMs`, from its accounts whose reads are still current then. */
function providerAt(entry: UsageSource, atMs: number): UsageProvider {
  const current = (account: UsageAccount) => account.expiresAt > atMs;
  const hubUnits = entry.hubAccounts.filter(current);
  const directUnits = entry.directAccounts.filter(current);
  const accountUnits: UsageAccount[] = [...hubUnits, ...directUnits];
  if (accountUnits.length === 0) {
    return {
      provider: entry.provider,
      name: entry.name,
      fresh: false,
      observedAt: 0,
      pooled: EXPIRED_VIEW,
      accounts: EXPIRED_VIEW,
    };
  }

  // The pool averages the current hub accounts only; a single hub account is its own unit.
  const pool: UsageAccount | null =
    hubUnits.length > 1
      ? {
          name: "Pooled",
          plan: undefined,
          rows: poolLimitWindows(hubUnits.map((unit) => unit.windows)).map(pooledRowOf),
          observedAt: Math.min(...hubUnits.map((unit) => unit.observedAt)),
          expiresAt: Math.min(...hubUnits.map((unit) => unit.expiresAt)),
        }
      : (hubUnits[0] ?? null);
  const pooledUnits = pool === null ? directUnits : [pool, ...directUnits];
  const pooledRows = pooledUnits.flatMap((unit) =>
    pooledUnits.length > 1 ? unit.rows.map((row) => ({ ...row, account: unit.name })) : unit.rows,
  );
  const pooledDetail =
    pooledUnits.length > 1
      ? [
          hubUnits.length > 1 ? `${hubUnits.length} pooled` : null,
          hubUnits.length === 1 ? "1 hub account" : null,
          directUnits.length > 0 ? `${directUnits.length} direct` : null,
        ]
          .filter((part) => part !== null)
          .join(" · ")
      : hubUnits.length > 1
        ? `${hubUnits.length} accounts · pooled`
        : (accountUnits[0]!.plan ?? "Subscription remaining");

  const accountRows = accountUnits.flatMap((unit) =>
    tightestPerKind(unit, accountUnits.length > 1),
  );
  return {
    provider: entry.provider,
    name: entry.name,
    fresh: true,
    observedAt: Math.min(...accountUnits.map((unit) => unit.observedAt)),
    pooled: { detail: pooledDetail, rows: selectRows(pooledRows), total: pooledRows.length },
    accounts: {
      detail: accountUnits.length === 1 ? pooledDetail : count(accountUnits.length, "account"),
      rows: selectRows(accountRows),
      total: accountRows.length,
    },
  };
}

/**
 * The widget's providers across the environments it may show: Claude and Codex first, then other
 * providers with limits, at most {@link SUBSCRIPTION_USAGE_MAX_PROVIDERS}. It does not depend on
 * the time, so it changes only when the numbers do; {@link subscriptionUsageAt} decides which
 * accounts are still current.
 */
export function buildSubscriptionUsageSnapshot(
  environments: ReadonlyArray<SubscriptionLimitsEnvironment>,
  url: string,
): SubscriptionUsageSnapshot {
  const hubs: CliProxyEnvironmentHub[] = environments.flatMap((environment) =>
    environment.hubs.map((hub) => ({ environmentId: environment.environmentId, hub })),
  );
  const hubCheckedAt = new Map(
    hubs.map((entry) => [cliProxyHubIdentity(entry), entry.hub.checkedAt]),
  );
  const { accounts, routed } = listDirectProviderAccounts(environments);
  const providers = groupSubscriptionLimits({ hubs, direct: accounts, routed })
    .flatMap((group) => source(group, hubCheckedAt) ?? [])
    .slice(0, SUBSCRIPTION_USAGE_MAX_PROVIDERS);
  return { url, providers };
}

/**
 * What the widget shows at `atMs`: each provider from its accounts still current then. An
 * account past its deadline leaves its provider's rows, pool and counts; a provider says to tap
 * only once none of its accounts is current.
 */
export function subscriptionUsageAt(
  snapshot: SubscriptionUsageSnapshot,
  atMs: number,
): SubscriptionUsageContent {
  const providers = snapshot.providers.map((entry) => providerAt(entry, atMs));
  const shown = providers.filter((entry) => entry.fresh).map((entry) => entry.observedAt);
  return {
    url: snapshot.url,
    providers,
    observedAt: shown.length > 0 ? Math.min(...shown) : 0,
  };
}

/**
 * The widget's timeline: the snapshot now, then again at each later account deadline. The
 * extension switches entries by itself, also while the app is not running.
 */
export function buildSubscriptionUsageTimeline(
  snapshot: SubscriptionUsageSnapshot,
  nowMs: number,
): Array<WidgetTimelineEntry<SubscriptionUsageContent>> {
  const deadlines = [
    ...new Set(
      snapshot.providers.flatMap((entry) =>
        [...entry.hubAccounts, ...entry.directAccounts].map((account) => account.expiresAt),
      ),
    ),
  ]
    .filter((deadline) => deadline > nowMs)
    .toSorted((left, right) => left - right);
  return [nowMs, ...deadlines].map((at) => ({ at, content: subscriptionUsageAt(snapshot, at) }));
}
