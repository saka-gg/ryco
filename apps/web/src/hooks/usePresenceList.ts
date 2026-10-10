import { useEffect, useRef, useState } from "react";

import {
  dropExited,
  reconcilePresence,
  settlePresence,
  type PresenceEntry,
} from "~/lib/presenceList.logic";

export type { PresenceEntry, PresencePhase } from "~/lib/presenceList.logic";

export interface UsePresenceListOptions {
  /** How long a removed item stays rendered in its `exit` phase. */
  readonly exitMs: number;
  /** False (reduced motion): items appear and disappear at once. */
  readonly animate: boolean;
}

interface PresenceState<T> {
  readonly source: ReadonlyArray<T>;
  readonly entries: ReadonlyArray<PresenceEntry<T>>;
}

/**
 * Keyed enter / exit presence for a list (see presenceList.logic). New items
 * render one painted frame in `enter` before turning `present`, so a CSS
 * transition from the enter state runs; removed items stay in `exit` for
 * `exitMs`. Items on the first render start `present` (nothing grows in on
 * mount). Pass a stable `getKey`.
 */
export function usePresenceList<T>(
  items: ReadonlyArray<T>,
  getKey: (item: T) => string,
  options: UsePresenceListOptions,
): ReadonlyArray<PresenceEntry<T>> {
  const { animate, exitMs } = options;
  const keepExiting = animate && exitMs > 0;
  const [state, setState] = useState<PresenceState<T>>(() => ({
    source: items,
    entries: reconcilePresence([], items, getKey, { animateEnter: false, keepExiting }),
  }));

  // Derived during render (React's "adjust state on prop change"), so a new
  // list never paints a frame without its exiting rows.
  let entries = state.entries;
  if (state.source !== items) {
    entries = reconcilePresence(state.entries, items, getKey, {
      animateEnter: animate,
      keepExiting,
    });
    setState({ source: items, entries });
  }

  useEffect(() => {
    if (!entries.some((entry) => entry.phase === "enter")) return;
    // Two frames: the enter state must be painted before it is released
    // (restarted when the list changes again, so a later arrival paints too).
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() =>
        setState((current) => ({ ...current, entries: settlePresence(current.entries) })),
      );
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [entries]);

  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timers = timersRef.current;
    const exiting = new Set(
      entries.filter((entry) => entry.phase === "exit").map((entry) => entry.key),
    );
    for (const [key, timer] of timers) {
      if (exiting.has(key)) continue;
      clearTimeout(timer);
      timers.delete(key);
    }
    for (const key of exiting) {
      if (timers.has(key)) continue;
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          setState((current) => ({ ...current, entries: dropExited(current.entries, key) }));
        }, exitMs),
      );
    }
  }, [entries, exitMs]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  return entries;
}
