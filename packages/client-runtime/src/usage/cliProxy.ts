/**
 * Presentation-agnostic selectors for CLIProxyAPI hub snapshots, shared by every client.
 *
 * @module usage/cliProxy
 */
import type {
  CliProxyAccount,
  CliProxyApiKeyUsage,
  CliProxyHubSnapshot,
  CliProxyQuotaWindow,
  CliProxyRequestCounts,
  ProviderInstanceId,
} from "@ryco/contracts";
import { isLoopbackHost } from "@ryco/shared/cliProxyHubUrl";

import { clampUsedPercent, describeRateLimitWindow } from "./limits.ts";

const PROVIDER_ORDER = ["claude", "codex", "antigravity"];
const RECENT_USE_WINDOW_MS = 10 * 60_000;
const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  aistudio: "AI Studio",
  antigravity: "Antigravity",
  claude: "Claude",
  codex: "Codex",
  devin: "Devin",
  gemini: "Gemini",
  iflow: "iFlow",
  kimi: "Kimi",
  meta: "Meta",
  openrouter: "OpenRouter",
  qwen: "Qwen",
  vertex: "Vertex",
  xai: "xAI",
};

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter((word) => word.length > 0)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

export function cliProxyProviderLabel(provider: string): string {
  return PROVIDER_LABELS[provider.toLowerCase()] ?? titleCase(provider);
}

/** `Max`, `Pro`, `Plus`, `Team`… from the plan slug the hub or provider reported. */
export function formatCliProxyPlan(planType: string | undefined): string | undefined {
  return planType ? titleCase(planType) : undefined;
}

/** `5h`, `Weekly`, `Weekly · Opus`, or just the scope for windows without a duration. */
export function cliProxyWindowLabel(window: CliProxyQuotaWindow): string {
  if (window.windowDurationMins === undefined) return window.scope ?? "Window";
  const cadence = describeRateLimitWindow(window).label;
  return window.scope ? `${cadence} · ${window.scope}` : cadence;
}

export type CliProxyAccountHealth =
  | { readonly kind: "ready" }
  | { readonly kind: "limited" }
  | { readonly kind: "cooling"; readonly until: string | undefined }
  | { readonly kind: "error"; readonly message: string | undefined }
  | { readonly kind: "disabled" };

function isDisabled(account: CliProxyAccount): boolean {
  return account.disabled || account.status === "disabled";
}

/** Routing health as the hub sees it, folded with any exhausted quota window. */
export function cliProxyAccountHealth(
  account: CliProxyAccount,
  nowMs: number,
): CliProxyAccountHealth {
  if (isDisabled(account)) return { kind: "disabled" };
  if (account.status === "error") return { kind: "error", message: account.statusMessage };
  const retryTimes = [
    ...account.cooldowns.flatMap((cooldown) => (cooldown.retryAt ? [cooldown.retryAt] : [])),
    ...(account.unavailable && account.nextRetryAt ? [account.nextRetryAt] : []),
  ].filter((retryAt) => Date.parse(retryAt) > nowMs);
  if (retryTimes.length > 0 || account.unavailable) {
    const until = retryTimes.toSorted((left, right) => Date.parse(left) - Date.parse(right)).at(-1);
    return { kind: "cooling", until };
  }
  const exhausted = account.quota.windows.some(
    (window) => (clampUsedPercent(window.usedPercent) ?? 0) >= 100,
  );
  return exhausted ? { kind: "limited" } : { kind: "ready" };
}

export function cliProxyRequestTotal(counts: CliProxyRequestCounts): number {
  return counts.success + counts.failed;
}

/** Requests in the recent buckets (the hub keeps the last 200 minutes). */
export function cliProxyRecentRequestTotal(counts: CliProxyRequestCounts): number {
  return counts.recent.reduce((total, bucket) => total + bucket.success + bucket.failed, 0);
}

/** The hub a provider instance sends its requests to, if any. */
export function findCliProxyRouteForInstance(
  hubs: ReadonlyArray<CliProxyHubSnapshot>,
  instanceId: ProviderInstanceId,
): CliProxyHubSnapshot | undefined {
  return hubs.find((hub) => hub.routedInstanceIds.includes(instanceId));
}

export interface CliProxyCurrentAccount {
  readonly account: CliProxyAccount;
  /** Accounts of the provider the hub used in the last ten minutes, this one included. */
  readonly recentAccountCount: number;
}

/**
 * The account of `provider` the hub used last, by its newest quota observation. The hub
 * observes every client it serves, so this approximates the account behind one session. A
 * provider with a single usable account answers with it even before the hub observed a request.
 */
export function cliProxyCurrentAccount(
  hub: CliProxyHubSnapshot,
  provider: string,
  nowMs: number,
): CliProxyCurrentAccount | null {
  const usable = hub.accounts.filter(
    (account) => account.provider === provider && !isDisabled(account),
  );
  const used = usable
    .flatMap((account) =>
      account.lastUsedAt === undefined
        ? []
        : [{ account, lastUsedMs: Date.parse(account.lastUsedAt) }],
    )
    .toSorted((left, right) => right.lastUsedMs - left.lastUsedMs);
  const account = used[0]?.account ?? (usable.length === 1 ? usable[0] : undefined);
  if (!account) return null;
  return {
    account,
    recentAccountCount: used.filter((entry) => nowMs - entry.lastUsedMs <= RECENT_USE_WINDOW_MS)
      .length,
  };
}

const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/;

/**
 * What names a hub account: its email, else its label or credential file name. Hubs name
 * credential files after the account email (`claude-alice@example.com.json`), so a name that
 * contains an email is as sensitive as the email.
 */
export function cliProxyAccountDisplayName(account: CliProxyAccount): {
  readonly value: string;
  readonly sensitive: boolean;
} {
  if (account.email) return { value: account.email, sensitive: true };
  const value = account.label ?? account.name;
  return { value, sensitive: EMAIL_PATTERN.test(value) };
}

/** A hub snapshot as one connected environment reported it. */
export interface CliProxyEnvironmentHub {
  readonly environmentId: string;
  readonly hub: CliProxyHubSnapshot;
}

/**
 * Which hub a snapshot describes. Environments that report the same hub URL share one hub,
 * except at a loopback address, which names a different machine on each node.
 */
export function cliProxyHubIdentity(entry: CliProxyEnvironmentHub): string {
  let loopback = false;
  try {
    loopback = isLoopbackHost(new URL(entry.hub.url).hostname);
  } catch {
    loopback = true;
  }
  return loopback ? `${entry.environmentId}\n${entry.hub.url}` : entry.hub.url;
}

export interface CliProxyHubAccountEntry {
  readonly hubId: string;
  /** `cliProxyHubIdentity` of the hub the account belongs to. */
  readonly hubKey: string;
  readonly hubLabel: string;
  readonly account: CliProxyAccount;
}

export interface CliProxyPooledWindow {
  /** Window id shared by the pooled accounts (`five_hour`, `seven_day`, …). */
  readonly id: string;
  readonly label: string;
  readonly windowDurationMins: number | undefined;
  /** Mean used percent across accounts reporting this window. */
  readonly usedPercent: number;
  readonly accountCount: number;
  /** The soonest reset among the pooled accounts, epoch seconds. */
  readonly nextResetsAt: number | undefined;
}

export interface CliProxyProviderGroup {
  readonly provider: string;
  readonly label: string;
  readonly accounts: ReadonlyArray<CliProxyHubAccountEntry>;
  readonly pooled: ReadonlyArray<CliProxyPooledWindow>;
}

function providerRank(provider: string): number {
  const index = PROVIDER_ORDER.indexOf(provider);
  return index === -1 ? PROVIDER_ORDER.length : index;
}

function accountSortKey(account: CliProxyAccount): string {
  return (account.email ?? account.label ?? account.name).toLowerCase();
}

/** Averages each window over the accounts that can currently serve requests. */
export function poolCliProxyWindows(
  accounts: ReadonlyArray<CliProxyAccount>,
): CliProxyPooledWindow[] {
  const pools = new Map<
    string,
    { window: CliProxyQuotaWindow; used: number[]; resets: number[] }
  >();
  for (const account of accounts) {
    if (account.disabled || account.quota.status !== "ok") continue;
    for (const window of account.quota.windows) {
      const used = clampUsedPercent(window.usedPercent);
      if (used === null) continue;
      const pool = pools.get(window.id) ?? { window, used: [], resets: [] };
      pool.used.push(used);
      if (window.resetsAt !== undefined) pool.resets.push(window.resetsAt);
      pools.set(window.id, pool);
    }
  }
  return [...pools.values()].map(({ window, used, resets }) => ({
    id: window.id,
    label: cliProxyWindowLabel(window),
    windowDurationMins: window.windowDurationMins,
    usedPercent: Math.round((used.reduce((sum, value) => sum + value, 0) / used.length) * 10) / 10,
    accountCount: used.length,
    nextResetsAt: resets.length > 0 ? Math.min(...resets) : undefined,
  }));
}

/**
 * Accounts across hubs grouped by provider (Claude, Codex, Antigravity first). A hub that
 * several connected environments share is counted once, keyed by hub identity and credential
 * index.
 */
export function groupCliProxyAccounts(
  hubs: ReadonlyArray<CliProxyEnvironmentHub>,
): CliProxyProviderGroup[] {
  const seen = new Set<string>();
  const byProvider = new Map<string, CliProxyHubAccountEntry[]>();
  for (const entry of hubs) {
    const { hub } = entry;
    const hubKey = cliProxyHubIdentity(entry);
    for (const account of hub.accounts) {
      const key = `${hubKey}\n${account.authIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const entries = byProvider.get(account.provider) ?? [];
      entries.push({ hubId: hub.hubId, hubKey, hubLabel: hub.label, account });
      byProvider.set(account.provider, entries);
    }
  }
  return [...byProvider.entries()]
    .toSorted(
      ([left], [right]) => providerRank(left) - providerRank(right) || left.localeCompare(right),
    )
    .map(([provider, entries]) => {
      const accounts = entries.toSorted((left, right) =>
        accountSortKey(left.account).localeCompare(accountSortKey(right.account)),
      );
      return {
        provider,
        label: cliProxyProviderLabel(provider),
        accounts,
        pooled: poolCliProxyWindows(accounts.map((entry) => entry.account)),
      };
    });
}

export interface CliProxyApiKeyRow {
  /** Stable row identity: hub, provider, endpoint, masked key, and occurrence. */
  readonly id: string;
  /** `cliProxyHubIdentity` of the hub the key is configured on. */
  readonly hubKey: string;
  readonly hubLabel: string;
  readonly usage: CliProxyApiKeyUsage;
}

/** API-key counters across hubs, counting a hub shared by several environments once. */
export function listCliProxyApiKeys(
  hubs: ReadonlyArray<CliProxyEnvironmentHub>,
): CliProxyApiKeyRow[] {
  const seenHubs = new Set<string>();
  const occurrences = new Map<string, number>();
  const rows: CliProxyApiKeyRow[] = [];
  for (const entry of hubs) {
    const { hub } = entry;
    const hubKey = cliProxyHubIdentity(entry);
    if (seenHubs.has(hubKey)) continue;
    seenHubs.add(hubKey);
    for (const usage of hub.apiKeys) {
      const base = [hubKey, usage.provider, usage.baseUrl ?? "", usage.keyHint].join("\n");
      const occurrence = (occurrences.get(base) ?? 0) + 1;
      occurrences.set(base, occurrence);
      rows.push({ id: `${base}\n${occurrence}`, hubKey, hubLabel: hub.label, usage });
    }
  }
  return rows;
}
