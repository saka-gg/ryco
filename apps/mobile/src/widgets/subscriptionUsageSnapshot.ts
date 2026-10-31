import {
  availablePercent,
  cliProxyAccountPublicName,
  cliProxyHubIdentity,
  cliProxyPoolableWindows,
  describeRateLimitWindow,
  formatCliProxyPlan,
  groupSubscriptionLimits,
  listDirectProviderAccounts,
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
export const SUBSCRIPTION_USAGE_WIDGET_KIND = "subscription-usage";
/** How long a read stays on the widget, past which it asks to open Ryco. */
export const SUBSCRIPTION_USAGE_MAX_AGE_MS = 15 * 60_000;
/** Windows kept per provider and view: the largest widget shows six. */
export const SUBSCRIPTION_USAGE_MAX_WINDOWS = 6;
/** Provider columns kept: the largest widget shows three. */
export const SUBSCRIPTION_USAGE_MAX_PROVIDERS = 3;
export const OPEN_RYCO_TO_REFRESH = "Open Ryco to refresh";

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

export interface UsageProvider {
  readonly provider: string;
  readonly name: string;
  /** False once {@link expiresAt} passed: no rows, and the detail asks to open Ryco. */
  readonly fresh: boolean;
  /** The oldest of its reads plus {@link SUBSCRIPTION_USAGE_MAX_AGE_MS}, or a reset that comes sooner. */
  readonly expiresAt: number;
  /** When the oldest of its numbers was read, epoch ms. */
  readonly observedAt: number;
  /** The hub accounts' pool, and each direct account on its own. */
  readonly pooled: UsageView;
  /** Every account on its own, its tightest window of each kind. */
  readonly accounts: UsageView;
}

export interface SubscriptionUsageSnapshot {
  /** What a tap opens: the Limits tab. */
  readonly url: string;
  readonly providers: readonly UsageProvider[];
}

/** One entry's content: the snapshot as it reads from the entry's time on. */
export interface SubscriptionUsageContent extends SubscriptionUsageSnapshot {
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

/** Something that has windows of its own on the widget: a hub pool, a hub account, a direct account. */
interface UsageUnit {
  readonly name: string;
  readonly plan: string | undefined;
  readonly rows: readonly UsageRow[];
  readonly observedAt: number;
}

function directUnit(account: DirectProviderAccount, providerName: string): UsageUnit {
  return {
    name: publicText(account.snapshot.displayName) ?? publicText(account.plan) ?? providerName,
    plan: publicText(account.plan),
    rows: account.windows.flatMap((window) => rowOf(window) ?? []),
    observedAt: parsedMs(rateLimitsObservedAt(account.snapshot)),
  };
}

function hubAccountUnit(
  entry: CliProxyHubAccountEntry,
  position: number,
  hubCheckedAt: ReadonlyMap<string, string>,
): UsageUnit {
  const { account } = entry;
  return {
    name: cliProxyAccountPublicName(account, position),
    plan: publicText(formatCliProxyPlan(account.quota.planType)),
    rows: cliProxyPoolableWindows(account).flatMap((window) => rowOf(window) ?? []),
    observedAt: parsedMs(account.quota.checkedAt ?? hubCheckedAt.get(entry.hubKey)),
  };
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
function tightestPerKind(unit: UsageUnit, labelled: boolean): UsageRow[] {
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

function provider(
  group: SubscriptionLimitGroup,
  hubCheckedAt: ReadonlyMap<string, string>,
): UsageProvider | null {
  const hubUnits = group.hubAccounts
    .map((entry, index) => hubAccountUnit(entry, index + 1, hubCheckedAt))
    .filter((unit) => unit.rows.length > 0);
  const directUnits = group.directAccounts
    .map((account) => directUnit(account, group.label))
    .filter((unit) => unit.rows.length > 0);
  const accountUnits = [...hubUnits, ...directUnits];
  if (accountUnits.length === 0) return null;

  // The pool averages hub accounts only; a single hub account is its own unit.
  const pool: UsageUnit | null =
    hubUnits.length > 1
      ? {
          name: "Pooled",
          plan: undefined,
          rows: group.pooled.map(pooledRowOf),
          observedAt: Math.min(...hubUnits.map((unit) => unit.observedAt)),
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
  const shownPooled = selectRows(pooledRows);
  const shownAccounts = selectRows(accountRows);
  const observedAt = Math.min(...accountUnits.map((unit) => unit.observedAt));
  // Past a reset the numbers describe a window that is over.
  const resets = [...pooledRows, ...accountRows].flatMap((row) =>
    row.resetsAt === null ? [] : [row.resetsAt],
  );
  return {
    provider: group.provider,
    name: group.label,
    fresh: true,
    expiresAt: Math.min(observedAt + SUBSCRIPTION_USAGE_MAX_AGE_MS, ...resets),
    observedAt,
    pooled: { detail: pooledDetail, rows: shownPooled, total: pooledRows.length },
    accounts: {
      detail: accountUnits.length === 1 ? pooledDetail : count(accountUnits.length, "account"),
      rows: shownAccounts,
      total: accountRows.length,
    },
  };
}

/**
 * The widget's providers across every environment the app has a config for: Claude and Codex
 * first, then other providers with limits, at most {@link SUBSCRIPTION_USAGE_MAX_PROVIDERS}.
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
    .flatMap((group) => provider(group, hubCheckedAt) ?? [])
    .slice(0, SUBSCRIPTION_USAGE_MAX_PROVIDERS);
  return { url, providers };
}

const EXPIRED_VIEW: UsageView = { detail: OPEN_RYCO_TO_REFRESH, rows: [], total: 0 };

function contentAt(snapshot: SubscriptionUsageSnapshot, atMs: number): SubscriptionUsageContent {
  const providers = snapshot.providers.map((entry) =>
    entry.expiresAt > atMs
      ? entry
      : { ...entry, fresh: false, pooled: EXPIRED_VIEW, accounts: EXPIRED_VIEW },
  );
  const shown = providers.filter((entry) => entry.fresh).map((entry) => entry.observedAt);
  return { ...snapshot, providers, observedAt: shown.length > 0 ? Math.min(...shown) : 0 };
}

/**
 * The widget's timeline: the snapshot now, then again at each later deadline, where the
 * providers that expired by then ask to open Ryco. The extension switches entries by itself,
 * also while the app is not running.
 */
export function buildSubscriptionUsageTimeline(
  snapshot: SubscriptionUsageSnapshot,
  nowMs: number,
): Array<WidgetTimelineEntry<SubscriptionUsageContent>> {
  const deadlines = [...new Set(snapshot.providers.map((entry) => entry.expiresAt))]
    .filter((deadline) => deadline > nowMs)
    .toSorted((left, right) => left - right);
  return [nowMs, ...deadlines].map((at) => ({ at, content: contentAt(snapshot, at) }));
}
