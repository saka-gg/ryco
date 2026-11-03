/**
 * `ryco_usage_limits`: the usage limits the server last read for each enabled provider instance
 * and each CLIProxyAPI hub's accounts, so an agent can send work to an instance or account with
 * headroom or stop before a limit hits.
 *
 * It reads what the server already holds and never asks a provider or a hub for a new reading:
 * the provider registry's current snapshots, the source of the Limits page, and the hub accounts
 * earlier hub reads left in `CliProxyService`'s cache. Windows, labels and pace come from the
 * shared limit presentation (`@ryco/client-runtime/usage/limits`), so they read as on the Limits
 * page. Only instances, numbered hub accounts, their windows and read times leave: never an
 * account's email, name, ids, credential index or file, plan or credentials.
 *
 * An instance a hub serves lists no windows of its own, as on the Limits page: its snapshot
 * describes no account the hub uses. Its note points at the hub's entry instead.
 *
 * Loaded through `import()` on the first call, never at boot. Callers hand in the snapshots, the
 * cached hubs and the caps: a value imported from a module the boot graph also loads (contracts
 * included) would split that module out of the boot chunk.
 *
 * @module agentControl/Mcp/usageLimits
 */
import type {
  AgentControlMcpHubAccountUsageLimits,
  AgentControlMcpHubUsageLimits,
  AgentControlMcpInstanceUsageLimits,
  AgentControlMcpUsageLimitWindow,
  AgentControlMcpUsageLimitsResult,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderRateLimits,
} from "@ryco/contracts";
import {
  clampUsedPercent,
  describeRateLimitPace,
  isRateLimitSnapshotAvailable,
  rateLimitPace,
  rateLimitWindowList,
  rateLimitsObservedAt,
  staleRateLimitsReason,
} from "@ryco/client-runtime/usage/limits";

import type { CliProxyCachedHub } from "../../cliProxy/CliProxyService.ts";

/** Drivers that read usage limits (`ServerProvider.rateLimits`); the others never report any. */
const LIMIT_REPORTING_DRIVERS: ReadonlySet<string> = new Set(["codex", "claudeAgent", "opencode"]);

export const USAGE_LIMITS_NOTES = {
  hubRouted: (hubLabel: string) =>
    `Served by the CLIProxyAPI hub "${hubLabel}": its own limits describe no account the hub uses. See that hub's accounts under hubs.`,
  unsupported: "This provider does not report usage limits.",
  noReading: "No usage reading yet.",
  limitReached: "The provider reports that a usage limit is reached.",
  notReady: "The instance is not ready; these are the last numbers it reported.",
  noHubReading: "No hub reading yet; open the Limits page to read the hub.",
  hubUnreadable: "The hub could not be read; the Limits page shows why.",
  hubWithoutAccounts: "The hub lists no accounts.",
  moreHubAccounts: (count: number) => `${count} more accounts are not listed.`,
  hubQuota: {
    ok: "No usage windows reported.",
    unsupported: "Ryco reads no quota for this provider; the hub reports request counts only.",
    skipped: "Disabled on the hub, so its quota is not read.",
    failed: "The last quota read failed.",
  },
} as const;

const HUB_STALE_REASON = "the latest hub read failed";

export interface AgentControlUsageLimitsInput {
  readonly providers: ReadonlyArray<ServerProvider>;
  /** Enabled hubs as `CliProxyService.cachedQuotas` holds them. */
  readonly hubs: ReadonlyArray<CliProxyCachedHub>;
  readonly instanceId?: ProviderInstanceId | undefined;
  readonly nowMs: number;
  /** `AGENT_CONTROL_MCP_USAGE_LIMITS_MAX`. */
  readonly max: {
    readonly instances: number;
    readonly windows: number;
    readonly hubs: number;
    readonly hubAccounts: number;
  };
}

const isoFromEpochSeconds = (seconds: number | undefined): string | null => {
  const ms = (seconds ?? NaN) * 1000;
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null;
};

/** Labelled windows with pace judged at `observedAt`, as the Limits page's window rows do. */
function limitWindows(
  limits: ServerProviderRateLimits,
  observedAt: string | undefined,
  available: boolean,
  input: AgentControlUsageLimitsInput,
): AgentControlMcpUsageLimitWindow[] {
  return rateLimitWindowList(limits)
    .flatMap(({ label, window }): AgentControlMcpUsageLimitWindow[] => {
      const usedPercent = clampUsedPercent(window.usedPercent);
      if (usedPercent === null) return [];
      const pace = describeRateLimitPace(rateLimitPace(window, observedAt, input.nowMs, available));
      return [
        {
          label,
          usedPercent,
          resetsAt: isoFromEpochSeconds(window.resetsAt),
          ...(pace === null ? {} : { pace }),
        },
      ];
    })
    .slice(0, input.max.windows);
}

function instanceUsageLimits(
  provider: ServerProvider,
  routedBy: string | undefined,
  input: AgentControlUsageLimitsInput,
): AgentControlMcpInstanceUsageLimits {
  const instance = {
    instanceId: provider.instanceId,
    driver: provider.driver,
    displayName: provider.displayName ?? null,
  };
  if (routedBy !== undefined) {
    return {
      ...instance,
      windows: [],
      observedAt: null,
      note: USAGE_LIMITS_NOTES.hubRouted(routedBy),
    };
  }
  const observedAt = rateLimitsObservedAt(provider);
  // Pace only for a live, signed-in instance, as on the Limits page.
  const available = isRateLimitSnapshotAvailable(provider, true);
  const windows = provider.rateLimits
    ? limitWindows(provider.rateLimits, observedAt, available, input)
    : [];
  if (windows.length === 0) {
    return {
      ...instance,
      windows,
      observedAt: null,
      note: LIMIT_REPORTING_DRIVERS.has(provider.driver)
        ? USAGE_LIMITS_NOTES.noReading
        : USAGE_LIMITS_NOTES.unsupported,
    };
  }
  const staleReason = staleRateLimitsReason(provider.rateLimits);
  const note = [
    provider.rateLimits?.rateLimitReachedType === undefined
      ? null
      : USAGE_LIMITS_NOTES.limitReached,
    available ? null : USAGE_LIMITS_NOTES.notReady,
  ]
    .filter((part) => part !== null)
    .join(" ");
  return {
    ...instance,
    windows,
    observedAt,
    ...(staleReason === null ? {} : { stale: true as const, staleReason }),
    ...(note.length === 0 ? {} : { note }),
  };
}

type CachedHubAccount = NonNullable<CliProxyCachedHub["listed"]>["accounts"][number];

/** As the hub cards on the Limits page show it, numbered instead of named. */
function hubAccountUsageLimits(
  account: CachedHubAccount,
  index: number,
  input: AgentControlUsageLimitsInput,
): AgentControlMcpHubAccountUsageLimits {
  const { quota } = account;
  const windows =
    quota.status === "ok"
      ? limitWindows({ windows: quota.windows }, quota.checkedAt, !account.disabled, input)
      : [];
  return {
    label: `Account ${index + 1}`,
    provider: account.provider,
    windows,
    observedAt: windows.length > 0 ? (quota.checkedAt ?? null) : null,
    ...(windows.length > 0 ? {} : { note: USAGE_LIMITS_NOTES.hubQuota[quota.status] }),
  };
}

function hubUsageLimits(
  hub: CliProxyCachedHub,
  input: AgentControlUsageLimitsInput,
): AgentControlMcpHubUsageLimits {
  const entry = {
    hubLabel: hub.label,
    routedInstanceIds: hub.routedInstanceIds.slice(0, input.max.instances),
  };
  if (hub.listed === undefined) {
    return {
      ...entry,
      accounts: [],
      observedAt: null,
      note: hub.failed ? USAGE_LIMITS_NOTES.hubUnreadable : USAGE_LIMITS_NOTES.noHubReading,
    };
  }
  const listed = hub.listed.accounts;
  const accounts = listed
    .slice(0, input.max.hubAccounts)
    .map((account, index) => hubAccountUsageLimits(account, index, input));
  const note =
    listed.length === 0
      ? USAGE_LIMITS_NOTES.hubWithoutAccounts
      : listed.length > accounts.length
        ? USAGE_LIMITS_NOTES.moreHubAccounts(listed.length - accounts.length)
        : null;
  return {
    ...entry,
    accounts,
    observedAt: new Date(hub.listed.fetchedAtMs).toISOString(),
    ...(hub.failed ? { stale: true as const, staleReason: HUB_STALE_REASON } : {}),
    ...(note === null ? {} : { note }),
  };
}

/**
 * One entry per enabled instance, in the registry's order (disabled instances are left out), and
 * one per enabled hub. With `instanceId`, only that instance and the hub that serves it.
 */
export function agentControlUsageLimits(
  input: AgentControlUsageLimitsInput,
): AgentControlMcpUsageLimitsResult {
  const hubs = input.hubs.filter(
    (hub) => input.instanceId === undefined || hub.routedInstanceIds.includes(input.instanceId),
  );
  const routedBy = new Map<string, string>();
  for (const hub of hubs) {
    for (const instanceId of hub.routedInstanceIds) {
      if (!routedBy.has(instanceId)) routedBy.set(instanceId, hub.label);
    }
  }
  return {
    checkedAt: new Date(input.nowMs).toISOString(),
    instances: input.providers
      .filter(
        (provider) =>
          provider.enabled &&
          (input.instanceId === undefined || provider.instanceId === input.instanceId),
      )
      .slice(0, input.max.instances)
      .map((provider) => instanceUsageLimits(provider, routedBy.get(provider.instanceId), input)),
    hubs: hubs.slice(0, input.max.hubs).map((hub) => hubUsageLimits(hub, input)),
  };
}
