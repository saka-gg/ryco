import { useEffect, useMemo, useState } from "react";
import type { ServerProvider, StatisticsSnapshot } from "@ryco/contracts";
import {
  mergeUsageEnvironmentResults,
  USAGE_UPDATE_MESSAGE,
  usageSummaryCache,
  type UsageEnvironmentResult,
  type StatRange,
} from "@ryco/client-runtime/usage";
import { readRpcClient } from "../../../connection/environmentApi";
import type { InboxEnvironment } from "../../inbox/inboxModel";

export type StatisticsTab = "usage" | "activity" | "limits";
export interface NodeStatistics {
  readonly environment: InboxEnvironment;
  readonly activity?: StatisticsSnapshot;
  readonly usage?: UsageEnvironmentResult;
  readonly providers?: readonly ServerProvider[];
  readonly error?: string;
}

/** Why this device is not asked for statistics right now, or `null` when it is. */
function statisticsUnavailableReason(environment: InboxEnvironment): string | null {
  if (environment.connectionState !== "connected" && environment.connectionState !== "read-only")
    return "Connect this device to load current data.";
  if (environment.role === "viewer" || environment.role === "operator")
    return "Statistics and provider limits require owner access on this device.";
  return null;
}

export async function loadNodeStatistics(
  environment: InboxEnvironment,
  tab: StatisticsTab,
  range: StatRange,
): Promise<NodeStatistics> {
  try {
    const unavailable = statisticsUnavailableReason(environment);
    if (unavailable !== null) throw new Error(unavailable);
    const api = readRpcClient(environment.environmentId);
    if (!api) throw new Error("This device is reconnecting. Try again when it is connected.");
    if (tab === "activity") return { environment, activity: await api.server.getStatistics() };
    if (tab === "limits") {
      const refreshed = await api.server.refreshProviders();
      return { environment, providers: refreshed.providers };
    }
    // The shared cache classifies the answer, joins an identical request already
    // in flight, and keeps the last usable summary for the next visit.
    const usage = await usageSummaryCache.load(
      {
        environmentId: environment.environmentId,
        label: environment.label,
        getUsageSummary: (request) => api.server.getUsageSummary(request),
      },
      range,
      usageTimeZone(),
    );
    if (usage.status === "complete" || usage.status === "partial") return { environment, usage };
    return {
      environment,
      usage,
      error:
        usage.status === "stale-contract"
          ? USAGE_UPDATE_MESSAGE
          : (usage.message ?? "Usage could not be loaded from this device."),
    };
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    return {
      environment,
      error,
      ...(tab === "usage"
        ? {
            usage: {
              environmentId: environment.environmentId,
              label: environment.label,
              status: "failed" as const,
              message: error,
            },
          }
        : {}),
    };
  }
}

const NO_NODES: readonly NodeStatistics[] = [];

/**
 * Each device's last usable usage summary for this range, under its current
 * label. A device that will not be asked (offline, or without owner access)
 * shows none: its answer is about to be that error, not the old summary.
 */
export function cachedNodeUsage(
  environments: readonly InboxEnvironment[],
  range: StatRange,
  timeZone = usageTimeZone(),
): UsageEnvironmentResult[] {
  return environments.flatMap((environment) => {
    if (statisticsUnavailableReason(environment) !== null) return [];
    const cached = usageSummaryCache.peek(environment.environmentId, range, timeZone);
    return cached === undefined ? [] : [{ ...cached, label: environment.label }];
  });
}

function usageTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function useStatisticsData(
  environments: readonly InboxEnvironment[],
  tab: StatisticsTab,
  range: StatRange,
) {
  const [revision, setRevision] = useState(0);
  // Only connection/selection changes invalidate a request, not unrelated live config pushes.
  const key = JSON.stringify(
    environments.map(({ environmentId, label, connectionState, role }) => ({
      environmentId,
      label,
      connectionState,
      role,
    })),
  );
  const requestKey = `${tab}:${range}:${key}:${revision}`;
  const [result, setResult] = useState<{ key: string; nodes: readonly NodeStatistics[] } | null>(
    null,
  );
  useEffect(() => {
    let cancelled = false;
    const selected = JSON.parse(key) as InboxEnvironment[];
    void Promise.all(
      selected.map((environment) => loadNodeStatistics(environment, tab, range)),
    ).then((nodes) => {
      if (!cancelled) setResult({ key: requestKey, nodes });
    });
    return () => {
      cancelled = true;
    };
  }, [key, tab, range, requestKey]);
  const sameScope = result?.key.startsWith(`${tab}:${range}:${key}:`) === true;
  const nodes = sameScope ? result.nodes : NO_NODES;
  const usage = useMemo(() => {
    if (tab !== "usage") return null;
    if (sameScope) {
      return mergeUsageEnvironmentResults(
        nodes.flatMap((node) => (node.usage ? [node.usage] : [])),
      );
    }
    // Until this range answers, show the last usable summaries for it (stale
    // while revalidating) instead of an empty screen.
    return mergeUsageEnvironmentResults(
      cachedNodeUsage(JSON.parse(key) as InboxEnvironment[], range),
    );
  }, [key, nodes, range, sameScope, tab]);
  return {
    nodes,
    loading: result?.key !== requestKey,
    refreshing:
      result !== null &&
      result.key !== requestKey &&
      result.key.startsWith(`${tab}:${range}:${key}:`),
    refresh: () => setRevision((value) => value + 1),
    usage,
  };
}
