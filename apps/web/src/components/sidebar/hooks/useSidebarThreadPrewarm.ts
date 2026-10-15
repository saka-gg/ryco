import type { ScopedThreadRef } from "@ryco/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { retainThreadDetailSubscription } from "../../../environments/runtime/service";
import { startStaggeredThreadPrefetch } from "../../../lib/staggeredThreadPrefetch";

/** How long new retains wait for one foreground thread before they start anyway. */
export const SIDEBAR_PREWARM_FOREGROUND_WAIT_MS = 5_000;

function refKey(ref: ScopedThreadRef): string {
  return JSON.stringify([ref.environmentId, ref.threadId]);
}

/**
 * `ready`, or true once `foregroundKey` has stayed not ready for
 * {@link SIDEBAR_PREWARM_FOREGROUND_WAIT_MS}: a foreground thread that never
 * loads (deleted, offline, failing) must not stall prewarming indefinitely.
 */
function useBoundedForegroundGate(ready: boolean, foregroundKey: string | null): boolean {
  const [elapsedKey, setElapsedKey] = useState<{ readonly key: string | null } | null>(null);
  useEffect(() => {
    if (ready) return;
    const timeoutId = setTimeout(
      () => setElapsedKey({ key: foregroundKey }),
      SIDEBAR_PREWARM_FOREGROUND_WAIT_MS,
    );
    return () => clearTimeout(timeoutId);
  }, [ready, foregroundKey]);
  return ready || (elapsedKey !== null && elapsedKey.key === foregroundKey);
}

/**
 * Keeps the detail subscriptions of `threadRefs` warm while `enabled`.
 *
 * New retains wait for `foregroundReady` (the routed thread's own live window
 * is in, or no thread is routed) and then start one at a time, so prewarmed
 * windows never queue ahead of or arrive in a burst with the thread being
 * opened. Retains already held stay while the foreground loads. The wait for
 * one foreground (`foregroundKey`) is bounded, so a thread that never loads
 * does not stop prewarming.
 */
export function useSidebarThreadPrewarm(
  enabled: boolean,
  threadRefs: ReadonlyArray<ScopedThreadRef>,
  foregroundLiveDetailLoaded = true,
  foregroundKey: string | null = null,
): void {
  const foregroundReady = useBoundedForegroundGate(foregroundLiveDetailLoaded, foregroundKey);
  const readThreadRefs = useEffectEvent(() => threadRefs);
  const retained = useRef(new Map<string, ReturnType<typeof retainThreadDetailSubscription>>());
  const threadRefKey = JSON.stringify([...new Set(threadRefs.map(refKey))].toSorted());

  useEffect(() => {
    const releases = retained.current;
    return () => {
      for (const release of releases.values()) release({ immediately: true });
      releases.clear();
    };
  }, []);

  useEffect(() => {
    const wanted = new Map(enabled ? readThreadRefs().map((ref) => [refKey(ref), ref]) : []);
    const releases = retained.current;
    for (const [key, release] of releases) {
      if (!wanted.has(key)) {
        release({ immediately: true });
        releases.delete(key);
      }
    }
    if (!foregroundReady) return;
    const additions = [...wanted.keys()].filter((key) => !releases.has(key));
    if (additions.length === 0) return;

    // The map owns started retains (released above when no longer wanted), so
    // stopping only cancels the ones that have not started yet.
    return startStaggeredThreadPrefetch(additions, (key) => {
      const ref = wanted.get(key);
      if (ref !== undefined && !releases.has(key)) {
        releases.set(key, retainThreadDetailSubscription(ref.environmentId, ref.threadId));
      }
      return null;
    });
    // React to the canonical set, not array identity or ordering.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [enabled, foregroundReady, threadRefKey]);
}
