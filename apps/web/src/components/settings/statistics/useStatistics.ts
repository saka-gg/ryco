import { useCallback, useEffect, useState } from "react";
import { statisticsSnapshotCache } from "@ryco/client-runtime/usage";
import type { EnvironmentId, StatisticsScope, StatisticsSnapshot } from "@ryco/contracts";

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
function fetchStatistics(environmentId: EnvironmentId | null, scope: StatisticsScope) {
  return async (): Promise<StatisticsSnapshot> => {
    // The local API follows the primary environment. Never file one
    // environment's answer under another that was primary when asked.
    if ((readPrimaryEnvironmentDescriptor()?.environmentId ?? null) !== environmentId) {
      throw new Error("The environment changed while statistics were loading.");
    }
    // Ryco's own scope asks exactly what it always asked, so older nodes see no change.
    return scope === "machine"
      ? ensureLocalApi().server.getStatistics({ scope })
      : ensureLocalApi().server.getStatistics();
  };
}

/** How often a machine snapshot whose session files are still being read asks again. */
export const MACHINE_READ_POLL_MS = 1_500;

/**
 * Start the request an Activity view will make (e.g. from a route loader or
 * link hover). The view joins it, or takes its answer if it settled just
 * before the view mounted. Best effort: the view reports failures itself.
 */
export function prefetchStatistics(scope: StatisticsScope = "ryco"): void {
  const environmentId = readPrimaryEnvironmentDescriptor()?.environmentId ?? null;
  statisticsSnapshotCache.prefetch(environmentId, fetchStatistics(environmentId, scope), scope);
}

interface StatisticsAnswer {
  readonly environmentId: EnvironmentId | null;
  readonly scope: StatisticsScope;
  readonly snapshot: StatisticsSnapshot | null;
  readonly error: string | null;
}

/**
 * Fetch the statistics snapshot on mount, with a manual refresh. Unlike the
 * diagnostics panel we avoid tight polling — stats change slowly and the query
 * scans projection tables, so an explicit refresh is friendlier.
 *
 * `snapshot` may be an earlier answer from the same environment and scope
 * while a request runs or after it failed; `error` reports that failure
 * either way. A `machine` snapshot whose session files the node is still
 * reading asks again every {@link MACHINE_READ_POLL_MS} until the read ends.
 */
export function useStatistics(scope: StatisticsScope = "ryco"): UseStatisticsResult {
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
      .load(environmentId, fetchStatistics(environmentId, scope), {
        fresh: refreshKey > 0,
        scope,
      })
      .then((next) => {
        if (!cancelled) {
          setAnswer({ environmentId, scope, snapshot: next, error: null });
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setAnswer((previous) => failedAnswer(previous, environmentId, scope, cause));
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
  }, [environmentId, scope, refreshKey]);

  // Only ever this environment's and this scope's data: an answer for the
  // previous primary environment or scope is dropped as soon as either changes.
  const answered =
    answer?.environmentId === environmentId && answer.scope === scope ? answer : null;

  // While the node reads the machine's session files, ask again (fresh) until
  // it is done. Each answer re-arms the timer; a failed poll stops it (the
  // view reports the error, and Refresh starts over).
  const reading =
    answered !== null && answered.error === null && answered.snapshot?.machine?.state === "reading";
  useEffect(() => {
    if (!reading || answered === null) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void statisticsSnapshotCache
        .load(environmentId, fetchStatistics(environmentId, scope), { fresh: true, scope })
        .then((next) => {
          if (!cancelled) setAnswer({ environmentId, scope, snapshot: next, error: null });
        })
        .catch((cause: unknown) => {
          if (!cancelled) {
            setAnswer((previous) => failedAnswer(previous, environmentId, scope, cause));
          }
        });
    }, MACHINE_READ_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [answered, environmentId, reading, scope]);

  const refresh = useCallback(() => {
    setRefreshKey((key) => key + 1);
  }, []);

  const snapshot = answered?.snapshot ?? statisticsSnapshotCache.peek(environmentId, scope) ?? null;
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

function failedAnswer(
  previous: StatisticsAnswer | null,
  environmentId: EnvironmentId | null,
  scope: StatisticsScope,
  cause: unknown,
): StatisticsAnswer {
  return {
    environmentId,
    scope,
    snapshot:
      previous?.environmentId === environmentId && previous.scope === scope
        ? previous.snapshot
        : null,
    error: cause instanceof Error ? cause.message : String(cause),
  };
}
