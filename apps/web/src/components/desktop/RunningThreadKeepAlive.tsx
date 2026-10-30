import { parseScopedThreadKey, scopedThreadKey } from "@ryco/client-runtime/scoped";
import { selectThreadLiveDetailLoaded } from "@ryco/client-runtime/state/threads";
import { listRunningThreadKeys } from "@ryco/client-runtime/state/threads/runningThreads";
import { useParams } from "@tanstack/react-router";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { useStore } from "../../store";
import { resolveThreadRouteRef } from "../../threadRoutes";
import { useSidebarThreadPrewarm } from "../sidebar/hooks/useSidebarThreadPrewarm";

/**
 * The most running threads kept subscribed. Retained subscriptions do not count against the
 * detail cache's 32-entry, 12 MiB budget, so this bounds what a fleet of running agents can
 * hold; past it, the most recently updated threads stay warm.
 */
export const RUNNING_THREAD_KEEP_ALIVE_LIMIT = 16;

/**
 * Desktop only (T3 Code #13554): keeps the detail streams of threads with a turn in progress
 * subscribed, in every environment the app holds, so opening a running thread shows its live
 * state at once instead of loading its window and catching up. Threads start one at a time,
 * after the routed thread's own window, like the sidebar prewarm. A thread that stops is
 * released into the detail cache, whose stream keeps delivering (the stop included) until idle
 * eviction. Web and the phone keep nothing alive.
 */
export function RunningThreadKeepAlive() {
  const runningKeys = useStore(
    useShallow((state) => listRunningThreadKeys(state, RUNNING_THREAD_KEEP_ALIVE_LIMIT)),
  );
  const runningRefs = useMemo(
    () =>
      runningKeys.flatMap((key) => {
        const ref = parseScopedThreadKey(key);
        return ref ? [ref] : [];
      }),
    [runningKeys],
  );
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const routeThreadLiveDetailLoaded = useStore((store) =>
    routeThreadRef ? selectThreadLiveDetailLoaded(store, routeThreadRef) : true,
  );
  useSidebarThreadPrewarm(
    true,
    runningRefs,
    routeThreadLiveDetailLoaded,
    routeThreadRef ? scopedThreadKey(routeThreadRef) : null,
    { keepAfterRelease: true },
  );
  return null;
}
