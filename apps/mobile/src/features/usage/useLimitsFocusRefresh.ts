import { useEffect, useRef } from "react";

import { subscribeAppInFront } from "../../platform/appInFront";
import { limitsFocusRefresh } from "./usageTabModel";

/**
 * Ask the providers for their limits again when Limits come back into view:
 * the Usage tab in front, the view switched to Limits, or the app back in the
 * foreground. Within `LIMITS_AUTO_REFRESH_INTERVAL_MS` of the last ask the
 * numbers on screen stay; a first visit loads on its own. No polling.
 */
export function useLimitsFocusRefresh(active: boolean, reload: () => void) {
  const lastAskedAt = useRef<number | null>(null);
  useEffect(() => {
    if (!active) return;
    const check = () => {
      const now = Date.now();
      const next = limitsFocusRefresh(lastAskedAt.current, now);
      if (next === "skip") return;
      lastAskedAt.current = now;
      if (next === "reload") reload();
    };
    check();
    // A Notification Center pull is no return (`subscribeAppInFront`).
    return subscribeAppInFront((inFront) => {
      if (inFront) check();
    });
  }, [active, reload]);
  return {
    /** A person refreshed the limits; the interval starts again from now. */
    asked: () => {
      lastAskedAt.current = Date.now();
    },
  };
}
