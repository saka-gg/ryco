import { parseScopedThreadKey, scopedThreadKey } from "@ryco/client-runtime/scoped";
import { selectThreadLiveDetailLoaded } from "@ryco/client-runtime/state/threads";
import {
  keepRunningThreadKeys,
  listRunningThreadKeys,
} from "@ryco/client-runtime/state/threads/runningThreads";
import { useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { useStore } from "../../store";
import { resolveThreadRouteRef } from "../../threadRoutes";
import { useSidebarThreadPrewarm } from "../sidebar/hooks/useSidebarThreadPrewarm";

/**
 * The most running threads kept subscribed. Retained subscriptions do not count against the
 * detail cache's 32-entry, 12 MiB budget, so this bounds what a fleet of running agents can
 * hold. The choice is sticky (`keepRunningThreadKeys`): a kept thread stays until it stops, and
 * freed places go to the most recently updated others.
 */
export const RUNNING_THREAD_KEEP_ALIVE_LIMIT = 16;
/** How many running threads the selection looks at, newest first. */
const RUNNING_THREADS_CONSIDERED = 256;

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
    useShallow((state) => listRunningThreadKeys(state, RUNNING_THREADS_CONSIDERED)),
  );
  const [keptKeys, setKeptKeys] = useState<ReadonlyArray<string>>([]);
  useEffect(() => {
    setKeptKeys((previous) =>
      keepRunningThreadKeys(previous, runningKeys, RUNNING_THREAD_KEEP_ALIVE_LIMIT),
    );
  }, [runningKeys]);
  const runningRefs = useMemo(
    () =>
      keptKeys.flatMap((key) => {
        const ref = parseScopedThreadKey(key);
        return ref ? [ref] : [];
      }),
    [keptKeys],
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
