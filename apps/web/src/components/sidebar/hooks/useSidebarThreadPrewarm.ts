import type { ScopedThreadRef } from "@ryco/contracts";
import { useEffect, useEffectEvent, useRef } from "react";

import { retainThreadDetailSubscription } from "../../../environments/runtime/service";
import { scheduleIdleTask } from "../../../lib/idleTask";

function refKey(ref: ScopedThreadRef): string {
  return JSON.stringify([ref.environmentId, ref.threadId]);
}

export function useSidebarThreadPrewarm(
  enabled: boolean,
  threadRefs: ReadonlyArray<ScopedThreadRef>,
): void {
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
    const additions = [...wanted].filter(([key]) => !releases.has(key));
    if (additions.length === 0) return;

    return scheduleIdleTask(() => {
      for (const [key, ref] of additions) {
        releases.set(key, retainThreadDetailSubscription(ref.environmentId, ref.threadId));
      }
    });
    // React to the canonical set, not array identity or ordering.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [enabled, threadRefKey]);
}
