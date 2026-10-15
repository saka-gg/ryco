import {
  mergeUsageEnvironmentResults,
  SupersedingLoads,
  usageSummaryCache,
  type MergedUsageSummary,
  type UsageEnvironmentResult,
  type UsageSummaryTarget,
} from "@ryco/client-runtime/usage";
import type { EnvironmentId } from "@ryco/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { usePrimaryEnvironmentId } from "~/environments/primary";
import { listEnvironmentConnections } from "~/environments/runtime";

import type { StatisticsRange } from "./statisticsSearch";
import { selectConnections, useConnectedEnvironments } from "./useConnectedEnvironments";

export { usageRequestForRange } from "@ryco/client-runtime/usage";

type EnvironmentConnections = ReturnType<typeof listEnvironmentConnections>;

type EnvironmentConnection = EnvironmentConnections[number];

function usageTarget(connection: EnvironmentConnection): UsageSummaryTarget {
  return {
    environmentId: connection.environmentId,
    label: connection.knownEnvironment.label,
    getUsageSummary: (request, options) =>
      connection.client.server.getUsageSummary(request, options),
  };
}

function currentTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * Start the usage requests a Statistics view of `range` will make (e.g. from a
 * route loader or link hover). The view joins them while they run, or takes
 * their answers if they settled just before it mounted.
 */
export function prefetchUsageSummary(
  range: StatisticsRange,
  environmentIds?: readonly string[] | undefined,
): void {
  const timeZone = currentTimeZone();
  for (const connection of selectConnections(listEnvironmentConnections(), environmentIds)) {
    usageSummaryCache.prefetch(usageTarget(connection), range, timeZone);
  }
}

export interface UseUsageSummaryResult {
  readonly merged: MergedUsageSummary | null;
  readonly environments: readonly UsageEnvironmentResult[];
  readonly availableEnvironments: readonly {
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }[];
  /** Environments whose current request has not answered yet. */
  readonly pendingEnvironmentIds: readonly EnvironmentId[];
  /** No environment is registered yet, but this app's own node is about to connect. */
  readonly connecting: boolean;
  readonly loading: boolean;
  readonly refreshing: boolean;
  readonly refresh: () => void;
}

export function useUsageSummary(input: {
  readonly range: StatisticsRange;
  readonly environmentIds?: readonly string[] | undefined;
}): UseUsageSummaryResult {
  const connections = useConnectedEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
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
  const selectedConnections = useMemo(
    () => selectConnections(connections, input.environmentIds),
    [connections, input.environmentIds],
  );
  const timeZone = currentTimeZone();
  const [refreshKey, setRefreshKey] = useState(0);
  const viewKey = `${input.range}\0${timeZone}\0${refreshKey}`;
  // The latest answer per environment, tagged with the view it answered.
  const [answers, setAnswers] = useState<
    ReadonlyMap<
      EnvironmentId,
      { readonly viewKey: string; readonly result: UsageEnvironmentResult }
    >
  >(() => new Map());
  // The view each environment last answered, for the effect (state stays the render source).
  const answeredViews = useRef(new Map<EnvironmentId, string>());
  // Settled environments merge one by one (a slow node never hides a fast
  // one), and each run withdraws only the requests it superseded.
  const loads = useRef(new SupersedingLoads());
  // The refresh the effect last handled: only the run it triggers skips prefetched answers.
  const handledRefreshKey = useRef(refreshKey);

  useEffect(() => {
    const fresh = refreshKey !== handledRefreshKey.current;
    handledRefreshKey.current = refreshKey;
    loads.current.run(
      // A connection joining the selection must not re-ask the ones that answered.
      selectedConnections.filter(
        (connection) => answeredViews.current.get(connection.environmentId) !== viewKey,
      ),
      (connection, signal) =>
        usageSummaryCache.load(usageTarget(connection), input.range, timeZone, { signal, fresh }),
      (connection, result) => {
        answeredViews.current.set(connection.environmentId, viewKey);
        setAnswers((previous) =>
          new Map(previous).set(connection.environmentId, { viewKey, result }),
        );
      },
    );
  }, [input.range, refreshKey, selectedConnections, timeZone, viewKey]);

  const environments = useMemo(
    () =>
      selectedConnections.flatMap((connection): UsageEnvironmentResult[] => {
        const answer = answers.get(connection.environmentId);
        if (answer?.viewKey === viewKey) return [answer.result];
        // Until this view answers, show its last usable result (stale while revalidating).
        const cached = usageSummaryCache.peek(connection.environmentId, input.range, timeZone);
        return cached === undefined
          ? []
          : [{ ...cached, label: connection.knownEnvironment.label }];
      }),
    [answers, input.range, selectedConnections, timeZone, viewKey],
  );
  const pendingEnvironmentIds = useMemo(
    () =>
      selectedConnections
        .filter((connection) => answers.get(connection.environmentId)?.viewKey !== viewKey)
        .map((connection) => connection.environmentId),
    [answers, selectedConnections, viewKey],
  );
  const merged = useMemo(() => mergeUsageEnvironmentResults(environments), [environments]);
  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);
  const loading = pendingEnvironmentIds.length > 0;
  return {
    merged,
    environments,
    availableEnvironments,
    pendingEnvironmentIds,
    connecting: connections.length === 0 && primaryEnvironmentId !== null,
    loading,
    refreshing: loading && merged !== null,
    refresh,
  };
}
