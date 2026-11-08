import { useEffect, useRef } from "react";
import { AppState } from "react-native";

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
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") check();
    });
    return () => subscription.remove();
  }, [active, reload]);
  return {
    /** A person refreshed the limits; the interval starts again from now. */
    asked: () => {
      lastAskedAt.current = Date.now();
    },
  };
}
