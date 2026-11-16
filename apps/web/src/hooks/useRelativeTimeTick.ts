import { useEffect, useRef, useState } from "react";

import { createVisibilityAwarePoller } from "../lib/visibilityPolling";
import { webAppLifecycle } from "../platform/appLifecycle";
import { relativeLabelRefreshDelayMs } from "../timestampFormat";

/*
 * The clocks behind relative time labels ("2 min ago"). Kept out of the
 * settings layout so the chat route's context meter can tick without loading
 * the settings chrome.
 */

/** Re-render while visible; refresh once after returning from the background. */
export function useRelativeTimeTick(intervalMs = 1_000) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const poller = createVisibilityAwarePoller({
      lifecycle: webAppLifecycle,
      run: () => {
        setNowMs(Date.now());
        return Promise.resolve();
      },
      resolveDelayMs: () => intervalMs,
      runImmediately: false,
    });
    return poller.stop;
  }, [intervalMs]);
  return nowMs;
}

/**
 * The current time, refreshed only when a relative label for one of `instantsMs`
 * would change (`relativeLabelRefreshDelayMs`), at least once a minute, and when
 * the instants themselves change (new data is labelled against the time it
 * arrived), instead of every second. Visibility-aware like `useRelativeTimeTick`.
 */
export function useRelativeLabelTick(instantsMs: ReadonlyArray<number | undefined>) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  // By value: callers may rebuild the list on every render.
  const instantsKey = instantsMs.join(",");
  const startedRef = useRef(false);
  useEffect(() => {
    const instants = instantsKey
      .split(",")
      .map((value) => (value === "" ? undefined : Number(value)));
    const restarted = startedRef.current;
    startedRef.current = true;
    const poller = createVisibilityAwarePoller({
      lifecycle: webAppLifecycle,
      run: () => {
        setNowMs(Date.now());
        return Promise.resolve();
      },
      resolveDelayMs: () => relativeLabelRefreshDelayMs(instants, Date.now()),
      runImmediately: restarted,
    });
    return poller.stop;
  }, [instantsKey]);
  return nowMs;
}
