import { useCallback, useEffect, useState } from "react";
import { statisticsSnapshotCache } from "@ryco/client-runtime/usage";
import type { EnvironmentId, StatisticsSnapshot } from "@ryco/contracts";

import { readPrimaryEnvironmentDescriptor, usePrimaryEnvironmentId } from "~/environments/primary";
import { ensureLocalApi } from "~/localApi";

export interface UseStatisticsResult {
  readonly snapshot: StatisticsSnapshot | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
  readonly refreshing: boolean;
}

/*
 * Snapshots live in the shared per-environment cache, so a reopened view
 * paints the last one for the same environment at once and refreshes in the
 * background, and concurrent mounts (the page and the settings panel ask the
 * same question) and the route's prefetch share one request. The hosted
 * teardown catalog clears it on a node switch and on account teardown.
 */
function fetchStatistics(environmentId: EnvironmentId | null) {
  return async (): Promise<StatisticsSnapshot> => {
    // The local API follows the primary environment. Never file one
    // environment's answer under another that was primary when asked.
    if ((readPrimaryEnvironmentDescriptor()?.environmentId ?? null) !== environmentId) {
      throw new Error("The environment changed while statistics were loading.");
    }
    return ensureLocalApi().server.getStatistics();
  };
}

/**
 * Start the request an Activity view will make (e.g. from a route loader or
 * link hover). The view joins it, or takes its answer if it settled just
 * before the view mounted. Best effort: the view reports failures itself.
 */
export function prefetchStatistics(): void {
  const environmentId = readPrimaryEnvironmentDescriptor()?.environmentId ?? null;
  statisticsSnapshotCache.prefetch(environmentId, fetchStatistics(environmentId));
}

interface StatisticsAnswer {
  readonly environmentId: EnvironmentId | null;
  readonly snapshot: StatisticsSnapshot | null;
  readonly error: string | null;
}

/**
 * Fetch the statistics snapshot on mount, with a manual refresh. Unlike the
 * diagnostics panel we avoid tight polling — stats change slowly and the query
 * scans projection tables, so an explicit refresh is friendlier.
 *
 * `snapshot` may be an earlier answer from the same environment while a
 * request runs or after it failed; `error` reports that failure either way.
 */
export function useStatistics(): UseStatisticsResult {
  const environmentId = usePrimaryEnvironmentId();
  const [answer, setAnswer] = useState<StatisticsAnswer | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // Set loading on every run (initial + manual refresh) so `refreshing`
    // reflects in-flight refreshes. The skeleton is gated on `!snapshot`, so
    // existing content stays visible during a refresh.
    setLoading(true);
    void statisticsSnapshotCache
      .load(environmentId, fetchStatistics(environmentId), { fresh: refreshKey > 0 })
      .then((next) => {
        if (!cancelled) {
          setAnswer({ environmentId, snapshot: next, error: null });
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setAnswer((previous) => ({
            environmentId,
            snapshot: previous?.environmentId === environmentId ? previous.snapshot : null,
            error: cause instanceof Error ? cause.message : String(cause),
          }));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [environmentId, refreshKey]);

  const refresh = useCallback(() => {
    setRefreshKey((key) => key + 1);
  }, []);

  // Only ever this environment's data: an answer for the previous primary
  // environment is dropped as soon as the primary changes.
  const answered = answer?.environmentId === environmentId ? answer : null;
  const snapshot = answered?.snapshot ?? statisticsSnapshotCache.peek(environmentId) ?? null;
  // Until this environment answers, its request is still loading.
  const pending = loading || answered === null;
  return {
    snapshot,
    loading: pending,
    error: answered?.error ?? null,
    refresh,
    refreshing: pending && snapshot !== null,
  };
}
