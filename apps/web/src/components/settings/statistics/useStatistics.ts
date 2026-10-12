import { useCallback, useEffect, useState } from "react";
import { SharedRequests } from "@ryco/client-runtime/usage";
import type { StatisticsSnapshot } from "@ryco/contracts";

import { ensureLocalApi } from "~/localApi";

export interface UseStatisticsResult {
  readonly snapshot: StatisticsSnapshot | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
  readonly refreshing: boolean;
}

/*
 * The last snapshot this page received, so a reopened view paints it at once
 * and refreshes in the background, and the in-flight request shared by
 * concurrent mounts (the page and the settings panel ask the same question)
 * and by the route's prefetch.
 */
let lastSnapshot: StatisticsSnapshot | null = null;
const snapshotRequests = new SharedRequests<StatisticsSnapshot>();
const SNAPSHOT_KEY = "statistics";

async function fetchStatistics(): Promise<StatisticsSnapshot> {
  const snapshot = await ensureLocalApi().server.getStatistics();
  lastSnapshot = snapshot;
  return snapshot;
}

/**
 * Start the request an Activity view will make (e.g. from a route loader or
 * link hover). The view joins it, or takes its answer if it settled just
 * before the view mounted. Best effort: the view reports failures itself.
 */
export function prefetchStatistics(): void {
  snapshotRequests.prefetch(SNAPSHOT_KEY, fetchStatistics);
}

/**
 * Fetch the statistics snapshot on mount, with a manual refresh. Unlike the
 * diagnostics panel we avoid tight polling — stats change slowly and the query
 * scans projection tables, so an explicit refresh is friendlier.
 */
export function useStatistics(): UseStatisticsResult {
  const [snapshot, setSnapshot] = useState<StatisticsSnapshot | null>(() => lastSnapshot);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // Set loading on every run (initial + manual refresh) so `refreshing`
    // reflects in-flight refreshes. The skeleton is gated on `!snapshot`, so
    // existing content stays visible during a refresh.
    setLoading(true);
    void snapshotRequests
      .request(SNAPSHOT_KEY, fetchStatistics, { fresh: refreshKey > 0 })
      .then((next) => {
        if (!cancelled) {
          setSnapshot(next);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
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
  }, [refreshKey]);

  const refresh = useCallback(() => {
    setRefreshKey((key) => key + 1);
  }, []);

  return {
    snapshot,
    loading,
    error,
    refresh,
    refreshing: loading && snapshot !== null,
  };
}
