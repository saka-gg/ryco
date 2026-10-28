import type { LegendListRef } from "@legendapp/list/react";
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { getWebPerfReporter, isWebPerfProfileEnabled, readWebPerfNow } from "./perfInstrumentation";

export const TAB_SWITCH_MARK_PREFIX = "ryco:tab-switch:";
export const TAB_SWITCH_REVEAL_MEASURE_PREFIX = "ryco:tab-switch-reveal:";
export const TIMELINE_REVEAL_MARK_PREFIX = "ryco:timeline-reveal:";
export const SIDEBAR_EXPAND_MARK_PREFIX = "ryco:sidebar-expand:";
export const COMPONENT_RENDER_MARK_PREFIX = "ryco:render:";

export type TabSwitchPhase = "click" | "first-paint";
export type SidebarExpandPhase = "click" | "first-paint";

export function makeTabSwitchMarkName(phase: TabSwitchPhase, key: string): string {
  if (!key) {
    throw new Error("tab-switch mark name requires a non-empty key");
  }
  return `${TAB_SWITCH_MARK_PREFIX}${phase}:${key}`;
}

export function markTabSwitchClick(key: string): void {
  if (!isWebPerfProfileEnabled() || typeof performance === "undefined") return;
  performance.mark(makeTabSwitchMarkName("click", key));
  tabSwitchClicks.note(key);
}

export function markTabSwitchFirstPaint(key: string): void {
  if (!isWebPerfProfileEnabled() || typeof performance === "undefined") return;
  const name = makeTabSwitchMarkName("first-paint", key);
  if (performance.getEntriesByName(name).length > 0) return;
  performance.mark(name);
  try {
    performance.measure(`ryco:tab-switch:${key}`, makeTabSwitchMarkName("click", key), name);
  } catch {
    // No matching click mark — initial mount, ignore.
  }
}

export type TimelineRevealPhase = "mount" | "visible" | "rehidden";

export function makeTimelineRevealMarkName(
  phase: TimelineRevealPhase,
  key: string,
  sequence: number,
): string {
  if (!key) {
    throw new Error("timeline-reveal mark name requires a non-empty key");
  }
  return `${TIMELINE_REVEAL_MARK_PREFIX}${phase}:${key}:${sequence}`;
}

/** Measure from a timeline mount to the first frame its transcript is visible. */
export function makeTimelineRevealMeasureName(key: string, sequence: number): string {
  if (!key) {
    throw new Error("timeline-reveal measure name requires a non-empty key");
  }
  return `${TIMELINE_REVEAL_MARK_PREFIX}${key}:${sequence}`;
}

/** Measure from a session-tab click to the first frame its transcript is visible. */
export function makeTabSwitchRevealMeasureName(key: string): string {
  if (!key) {
    throw new Error("tab-switch reveal measure name requires a non-empty key");
  }
  return `${TAB_SWITCH_REVEAL_MEASURE_PREFIX}${key}`;
}

export interface TabSwitchClick {
  readonly key: string;
  /** When the click was noted, on the ledger's clock. */
  readonly at: number;
}

/**
 * How long a click waits for its timeline. A click that none claimed by then led to a route
 * without one (the user went elsewhere before the thread opened); generous enough for a slow
 * history load.
 */
export const TAB_SWITCH_CLICK_MAX_AGE_MS = 30_000;

/**
 * Which timeline mount a session-tab click belongs to: the next one. The mount of the clicked
 * thread claims the click and a mount of any other thread drops it, so a click is measured at
 * most once. A click that opens no list is dropped as well: one on the thread already open, one
 * on an empty thread (its timeline mounts without a list), and one that no mount claimed within
 * `TAB_SWITCH_CLICK_MAX_AGE_MS`. So a later open of the same thread without a click is not
 * measured against an old click, short of a reopen within that age of a click whose navigation
 * was left before the thread opened.
 */
export interface TabSwitchClickLedger {
  /**
   * A click on `key`'s tab; replaces a click that no mount claimed yet. A click on a thread whose
   * timeline is open remounts nothing, so it is not kept.
   */
  readonly note: (key: string) => void;
  /**
   * A timeline for `key` committed, with or without its list; it counts as open until `close`.
   * Takes the pending click and returns it if it was on `key`'s tab and the timeline shows its
   * list: an empty thread has nothing to reveal, so the click that opened it is spent here.
   */
  readonly claim: (key: string, listMounted: boolean) => TabSwitchClick | null;
  /** The timeline that claimed for `key` unmounted, or its effect is about to claim again. */
  readonly close: (key: string) => void;
  /**
   * Hands back a claim whose mount ended before its reveal. StrictMode runs a mount's layout
   * effect again right after its cleanup, so the click stays claimable until `defer` runs.
   */
  readonly release: (click: TabSwitchClick) => void;
}

export function createTabSwitchClickLedger(timing: {
  readonly defer: (callback: () => void) => void;
  readonly now: () => number;
}): TabSwitchClickLedger {
  let pending: TabSwitchClick | null = null;
  const openTimelines = new Map<string, number>();
  return {
    note: (key) => {
      pending = openTimelines.has(key) ? null : { key, at: timing.now() };
    },
    claim: (key, listMounted) => {
      const click = pending;
      pending = null;
      openTimelines.set(key, (openTimelines.get(key) ?? 0) + 1);
      return listMounted &&
        click !== null &&
        click.key === key &&
        timing.now() - click.at <= TAB_SWITCH_CLICK_MAX_AGE_MS
        ? click
        : null;
    },
    close: (key) => {
      const open = openTimelines.get(key) ?? 0;
      if (open > 1) openTimelines.set(key, open - 1);
      else openTimelines.delete(key);
    },
    release: (click) => {
      if (pending !== null) return;
      pending = click;
      timing.defer(() => {
        if (pending === click) pending = null;
      });
    },
  };
}

const tabSwitchClicks = createTabSwitchClickLedger({
  defer: (callback) => queueMicrotask(callback),
  now: readWebPerfNow,
});

let timelineRevealSequence = 0;
let timelineRevealObserver: Promise<typeof import("./timelineRevealObserver")> | null = null;

// The observer is profiling-only code, so it stays out of the app shell's static graph. A failed
// load is forgotten so the next mount retries it.
function loadTimelineRevealObserver(): Promise<typeof import("./timelineRevealObserver")> {
  if (timelineRevealObserver === null) {
    const loading = import("./timelineRevealObserver");
    timelineRevealObserver = loading;
    loading.catch(() => {
      if (timelineRevealObserver === loading) timelineRevealObserver = null;
    });
  }
  return timelineRevealObserver;
}

// Start loading as soon as this module evaluates with profiling on, so the observer is ready
// before the first timeline mounts.
if (isWebPerfProfileEnabled() && typeof window !== "undefined") {
  void loadTimelineRevealObserver();
}

/**
 * Opt-in (`VITE_RYCO_PERF_PROFILE=1`) reveal marks for a timeline's LegendList; see
 * `observeTimelineReveal` in `timelineRevealObserver.ts`. `listMounted` is false while the timeline
 * renders no list, so a list that mounts later starts its own observation (without the click that
 * opened the timeline).
 */
export function useTimelineRevealMark(
  listRef: RefObject<LegendListRef | null>,
  key: string,
  listMounted: boolean,
): void {
  useLayoutEffect(() => {
    if (
      !key ||
      !isWebPerfProfileEnabled() ||
      typeof performance === "undefined" ||
      typeof requestAnimationFrame !== "function"
    ) {
      return;
    }
    // Claimed on every run, with or without the list, so the ledger knows which threads are open
    // and an empty thread spends the click that opened it.
    const click = tabSwitchClicks.claim(key, listMounted);
    if (!listMounted) {
      return () => tabSwitchClicks.close(key);
    }
    timelineRevealSequence += 1;
    const sequence = timelineRevealSequence;
    // Marked here, synchronously in the mount's layout effect; the rest observes from frames.
    const mountName = makeTimelineRevealMarkName("mount", key, sequence);
    performance.mark(mountName);
    const mountedAt = readWebPerfNow();
    let disposed = false;
    let revealed = false;
    let stop: (() => void) | undefined;
    loadTimelineRevealObserver().then(
      ({ observeLegendListReveal }) => {
        if (disposed) return;
        stop = observeLegendListReveal({
          listRef,
          key,
          sequence,
          mountName,
          mountedAt,
          measureTabSwitchClick: click !== null,
          onVisible: () => {
            revealed = true;
          },
        });
      },
      () => {
        // Profiling only: a failed chunk load leaves the mount mark without a reveal.
      },
    );
    return () => {
      disposed = true;
      stop?.();
      tabSwitchClicks.close(key);
      if (click !== null && !revealed) tabSwitchClicks.release(click);
    };
  }, [key, listMounted, listRef]);
}

export function makeSidebarExpandMarkName(phase: SidebarExpandPhase, key: string): string {
  if (!key) {
    throw new Error("sidebar-expand mark name requires a non-empty key");
  }
  return `${SIDEBAR_EXPAND_MARK_PREFIX}${phase}:${key}`;
}

export function markSidebarExpandClick(key: string): void {
  if (!isWebPerfProfileEnabled() || typeof performance === "undefined") return;
  performance.mark(makeSidebarExpandMarkName("click", key));
}

export function markSidebarExpandFirstPaint(key: string): void {
  if (!isWebPerfProfileEnabled() || typeof performance === "undefined") return;
  const name = makeSidebarExpandMarkName("first-paint", key);
  if (performance.getEntriesByName(name).length > 0) return;
  performance.mark(name);
  try {
    performance.measure(
      `ryco:sidebar-expand:${key}`,
      makeSidebarExpandMarkName("click", key),
      name,
    );
  } catch {
    // No matching click mark — initial mount, ignore.
  }
}

export function useRenderCounter(label: string): void {
  const count = useRef(0);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    count.current += 1;
    console.debug(`[render] ${label} #${count.current}`);
  });
}

/**
 * Dev-only: log which prop changed between renders. Use to figure out
 * why a memoized component is re-rendering. Logs `[memo:<label>] <key>
 * changed` for each prop whose identity differs from the previous
 * render. Add at the top of a component's body.
 */
export function useDevPropDiff<T extends Record<string, unknown>>(props: T, label: string): void {
  const prevRef = useRef<T | null>(null);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (prevRef.current !== null) {
      const prev = prevRef.current;
      const keys = new Set([...Object.keys(prev), ...Object.keys(props)]);
      for (const key of keys) {
        if (!Object.is(prev[key as keyof T], props[key as keyof T])) {
          console.debug(`[memo:${label}] ${String(key)} changed`);
        }
      }
    }
    prevRef.current = props;
  });
}

/**
 * Opt-in render-duration mark. Sets a `<prefix><label>:start:N` mark in the
 * render body and a matching `:end:N` in useLayoutEffect (runs synchronously
 * after commit, before paint) when `VITE_RYCO_PERF_PROFILE=1`. The N-suffix
 * avoids the "latest-mark wins" problem when a component re-renders multiple
 * times during a single interaction. Inspect via:
 *
 *   performance.getEntriesByType("measure")
 *     .filter(m => m.name.startsWith("ryco:render:"))
 */
export function usePerfMark(label: string): void {
  const seq = useRef(0);
  const startedAtRef = useRef(0);
  const perfEnabled = isWebPerfProfileEnabled();
  if (perfEnabled) {
    seq.current += 1;
    startedAtRef.current = readWebPerfNow();
    if (typeof performance !== "undefined") {
      performance.mark(`${COMPONENT_RENDER_MARK_PREFIX}${label}:start:${seq.current}`);
    }
  }
  useLayoutEffect(() => {
    if (!perfEnabled) return;
    getWebPerfReporter(`web.render.${label}`).record({
      durationMs: Math.max(0, readWebPerfNow() - startedAtRef.current),
    });
    if (typeof performance === "undefined") return;
    const i = seq.current;
    const startName = `${COMPONENT_RENDER_MARK_PREFIX}${label}:start:${i}`;
    const endName = `${COMPONENT_RENDER_MARK_PREFIX}${label}:end:${i}`;
    performance.mark(endName);
    try {
      performance.measure(`${COMPONENT_RENDER_MARK_PREFIX}${label}#${i}`, startName, endName);
    } catch {
      // Ignore — start mark may have been cleared.
    }
  });
}
