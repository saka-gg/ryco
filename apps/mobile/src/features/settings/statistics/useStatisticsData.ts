import { useEffect, useState } from "react";
import {
  USAGE_CONTRACT_VERSION,
  type ServerProvider,
  type StatisticsSnapshot,
} from "@ryco/contracts";
import {
  mergeUsageEnvironmentResults,
  usageRequestForRange,
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

export async function loadNodeStatistics(
  environment: InboxEnvironment,
  tab: StatisticsTab,
  range: StatRange,
): Promise<NodeStatistics> {
  try {
    if (
      environment.connectionState !== "connected" &&
      environment.connectionState !== "read-only"
    ) {
      throw new Error("Connect this device to load current data.");
    }
    if (environment.role === "viewer" || environment.role === "operator")
      throw new Error("Statistics and provider limits require owner access on this device.");
    const api = readRpcClient(environment.environmentId);
    if (!api) throw new Error("This device is reconnecting. Try again when it is connected.");
    if (tab === "activity") return { environment, activity: await api.server.getStatistics() };
    if (tab === "limits") {
      const refreshed = await api.server.refreshProviders();
      return { environment, providers: refreshed.providers };
    }
    const summary = await api.server.getUsageSummary(
      usageRequestForRange(range, Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"),
    );
    if (summary.contractVersion !== USAGE_CONTRACT_VERSION)
      throw new Error("Update Ryco on this device to use the current usage format.");
    return {
      environment,
      usage: {
        environmentId: environment.environmentId,
        label: environment.label,
        summary,
        status: summary.sources.some(
          (source) => source.status === "partial" || source.status === "failed",
        )
          ? "partial"
          : "complete",
      },
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
  const nodes = sameScope ? result.nodes : [];
  return {
    nodes,
    loading: result?.key !== requestKey,
    refreshing:
      result !== null &&
      result.key !== requestKey &&
      result.key.startsWith(`${tab}:${range}:${key}:`),
    refresh: () => setRevision((value) => value + 1),
    usage: mergeUsageEnvironmentResults(nodes.flatMap((node) => (node.usage ? [node.usage] : []))),
  };
}
