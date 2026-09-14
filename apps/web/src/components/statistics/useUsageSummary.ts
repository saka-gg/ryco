// @effect-diagnostics globalDate:off
import {
  mergeUsageEnvironmentResults,
  UsageRequestGeneration,
  type MergedUsageSummary,
  type UsageEnvironmentResult,
} from "@ryco/client-runtime/usage";
import { EnvironmentId, USAGE_CONTRACT_VERSION } from "@ryco/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  listEnvironmentConnections,
  subscribeEnvironmentConnections,
} from "~/environments/runtime";

import type { StatisticsRange } from "./statisticsSearch";

export { usageRequestForRange } from "@ryco/client-runtime/usage";
import { usageRequestForRange } from "@ryco/client-runtime/usage";

function useConnectedEnvironments() {
  const [revision, setRevision] = useState(0);
  useEffect(() => subscribeEnvironmentConnections(() => setRevision((value) => value + 1)), []);
  return useMemo(() => {
    void revision;
    return listEnvironmentConnections();
  }, [revision]);
}

export interface UseUsageSummaryResult {
  readonly merged: MergedUsageSummary | null;
  readonly environments: readonly UsageEnvironmentResult[];
  readonly availableEnvironments: readonly {
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }[];
  readonly loading: boolean;
  readonly refreshing: boolean;
  readonly refresh: () => void;
}

export function useUsageSummary(input: {
  readonly range: StatisticsRange;
  readonly environmentIds?: readonly string[] | undefined;
}): UseUsageSummaryResult {
  const connections = useConnectedEnvironments();
  const availableEnvironments = useMemo(
    () =>
      connections
        .map((connection) => ({
          environmentId: connection.environmentId,
          label: connection.knownEnvironment.label,
        }))
        .toSorted((left, right) => left.label.localeCompare(right.label)),
    [connections],
  );
  const selectedConnections = useMemo(() => {
    if (input.environmentIds === undefined || input.environmentIds.length === 0) {
      return connections;
    }
    const selected = new Set(input.environmentIds);
    return connections.filter((connection) => selected.has(connection.environmentId));
  }, [connections, input.environmentIds]);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const [refreshKey, setRefreshKey] = useState(0);
  const [merged, setMerged] = useState<MergedUsageSummary | null>(null);
  const [environments, setEnvironments] = useState<readonly UsageEnvironmentResult[]>([]);
  const [loading, setLoading] = useState(true);
  const generations = useRef(new UsageRequestGeneration());
  const selectionKey = selectedConnections
    .map((connection) => connection.environmentId)
    .toSorted()
    .join("\0");

  useEffect(() => {
    const generation = generations.current.next();
    const request = usageRequestForRange(input.range, timeZone);
    setLoading(true);
    void Promise.all(
      selectedConnections.map(async (connection): Promise<UsageEnvironmentResult> => {
        try {
          const summary = await connection.client.server.getUsageSummary(request);
          if (summary.contractVersion !== USAGE_CONTRACT_VERSION) {
            return {
              environmentId: connection.environmentId,
              label: connection.knownEnvironment.label,
              status: "stale-contract",
              message: "This environment uses an incompatible usage contract.",
            };
          }
          const partial = summary.sources.some(
            (source) => source.status === "partial" || source.status === "failed",
          );
          return {
            environmentId: connection.environmentId,
            label: connection.knownEnvironment.label,
            status: partial ? "partial" : "complete",
            summary,
          };
        } catch (cause) {
          return {
            environmentId: connection.environmentId,
            label: connection.knownEnvironment.label,
            status: "failed",
            message: cause instanceof Error ? cause.message : String(cause),
          };
        }
      }),
    ).then((results) => {
      if (!generations.current.isCurrent(generation)) return;
      setEnvironments(results);
      setMerged(mergeUsageEnvironmentResults(results));
      setLoading(false);
    });
  }, [input.range, refreshKey, selectedConnections, selectionKey, timeZone]);

  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);
  return {
    merged,
    environments,
    availableEnvironments,
    loading,
    refreshing: loading && merged !== null,
    refresh,
  };
}
