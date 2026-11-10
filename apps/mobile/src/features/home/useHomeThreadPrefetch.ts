import { useEffect, useState, useSyncExternalStore } from "react";

import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  selectEnvironmentShellLive,
  selectThreadLiveDetailLoaded,
} from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@ryco/contracts";

import { retainSpeculativeThreadDetailSubscription } from "../../connection/threadDetail";
import { mobileAppLifecycle } from "../../platform/appLifecycle";
import { readEnvironmentMutationReady } from "../../state/environmentMutationReady";
import { useStore } from "../../state/threadsRuntime";
import {
  createHomeThreadPrefetch,
  HOME_PREFETCH_TOP_ROWS,
  type HomeThreadPrefetch,
} from "./homeThreadPrefetchModel";

function createPrefetch(): HomeThreadPrefetch {
  return createHomeThreadPrefetch({
    retain: (ref) => retainSpeculativeThreadDetailSubscription(ref.environmentId, ref.threadId),
    // A body the snapshot cache gave back still warms: the open then shows current content.
    isDetailLoaded: (ref) => selectThreadLiveDetailLoaded(useStore.getState(), ref),
    // Only a machine that is live already: a prefetch never asks for a connection.
    canRetain: (ref) => readEnvironmentMutationReady(ref.environmentId),
    keyOf: scopedThreadKey,
  });
}

/**
 * Warms the threads at the top of Home while it is focused and in the foreground, and the row a
 * finger goes down on. Returns the press-in handler for the rows.
 */
export function useHomeThreadPrefetch(input: {
  readonly rows: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  }>;
  readonly focused: boolean;
  /** Changes when a machine's readiness changes, so a machine that just went live is warmed. */
  readonly readinessKey: string;
}): (ref: ScopedThreadRef) => void {
  const [prefetch] = useState(createPrefetch);
  const foreground = useSyncExternalStore(
    mobileAppLifecycle.subscribe,
    mobileAppLifecycle.isForeground,
  );
  // The top rows as a value: Home rebuilds its rows on every store change, and a new array with
  // the same threads must not restart the stillness wait.
  const topKey = JSON.stringify(
    input.rows
      .slice(0, HOME_PREFETCH_TOP_ROWS)
      .map((row) => [row.environmentId, row.threadId] as const),
  );
  // A machine whose live shell snapshot just landed: its rows can be warmed now.
  const shellLiveKey = useStore((state) =>
    [...new Set(input.rows.slice(0, HOME_PREFETCH_TOP_ROWS).map((row) => row.environmentId))]
      .map((environmentId) => (selectEnvironmentShellLive(state, environmentId) ? "1" : "0"))
      .join(""),
  );
  const readiness = `${input.readinessKey}|${shellLiveKey}`;

  useEffect(() => () => prefetch.dispose(), [prefetch]);
  useEffect(() => {
    if (!foreground) {
      prefetch.background();
      return;
    }
    if (!input.focused) {
      prefetch.blur();
      return;
    }
    const top = JSON.parse(topKey) as ReadonlyArray<readonly [EnvironmentId, ThreadId]>;
    prefetch.show(
      top.map(([environmentId, threadId]) => scopeThreadRef(environmentId, threadId)),
      readiness,
    );
  }, [foreground, input.focused, prefetch, readiness, topKey]);

  return prefetch.pressIn;
}
