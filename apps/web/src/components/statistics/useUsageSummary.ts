import {
  mergeUsageEnvironmentResults,
  UsageRequestGeneration,
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
  const generations = useRef(new UsageRequestGeneration());
  // Every effect run waits through its own signal; the next run releases it.
  const waiting = useRef<AbortController | null>(null);
  // The refresh the effect last handled: only the run it triggers skips prefetched answers.
  const handledRefreshKey = useRef(refreshKey);

  useEffect(() => {
    const generation = generations.current.next();
    const controller = new AbortController();
    const fresh = refreshKey !== handledRefreshKey.current;
    handledRefreshKey.current = refreshKey;
    for (const connection of selectedConnections) {
      // A connection joining the selection must not re-ask the ones that answered.
      if (answeredViews.current.get(connection.environmentId) === viewKey) continue;
      // Settled environments merge one by one: a slow node never hides a fast one.
      void usageSummaryCache
        .load(usageTarget(connection), input.range, timeZone, {
          signal: controller.signal,
          fresh,
        })
        .then((result) => {
          if (!generations.current.isCurrent(generation)) return;
          answeredViews.current.set(connection.environmentId, viewKey);
          setAnswers((previous) =>
            new Map(previous).set(connection.environmentId, { viewKey, result }),
          );
        });
    }
    // Release the previous run only now: requests this run still wants were
    // joined above, so only superseded ones (another range, a deselected node)
    // are left without a waiter and withdrawn, freeing the node's scan queue.
    // Unmounting releases nothing, so a closed view still fills the cache.
    waiting.current?.abort();
    waiting.current = controller;
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
