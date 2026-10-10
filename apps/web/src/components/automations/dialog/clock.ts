/**
 * The Automations dialog's clock: one subscription to the shared visible
 * second ticker, read two ways.
 *
 * - `useMinuteNow()` re-renders once a minute. Rows, sentences and every
 *   minute-stable word derive from it, so a tick never re-renders the list,
 *   the detail or anything that may hold focus.
 * - `useTickingText(compute)` is for leaf text that moves every second
 *   (countdowns, "in 1h 58m", the drain line). Only the leaf re-renders, and
 *   only when its text actually changes.
 */
import { MINUTE_MS } from "@ryco/shared/automationSchedule";
import { useSyncExternalStore } from "react";

import { visibleSecondTicker } from "../../../lib/perf/ticker";

let secondNow = Date.now();
const listeners = new Set<() => void>();
let stopTicker: (() => void) | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!stopTicker) {
    stopTicker = visibleSecondTicker.subscribe((nowMs) => {
      secondNow = nowMs;
      for (const notify of listeners) notify();
    });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && stopTicker) {
      stopTicker();
      stopTicker = null;
    }
  };
}

/* Before anything subscribes (a first render) the last reading may be old:
   read the wall clock, to the second, so repeated reads agree. */
const readSecond = () => (stopTicker ? secondNow : Math.floor(Date.now() / 1000) * 1000);
const readMinute = () => Math.floor(readSecond() / MINUTE_MS) * MINUTE_MS;

/** Now, to the minute: changes once a minute. */
export function useMinuteNow(): number {
  return useSyncExternalStore(subscribe, readMinute, readMinute);
}

/**
 * A value computed from the second clock (a string or number). The caller
 * re-renders only when the computed value changes.
 */
export function useTickingText<T extends string | number | boolean>(
  compute: (nowMs: number) => T,
): T {
  const read = () => compute(readSecond());
  return useSyncExternalStore(subscribe, read, read);
}
