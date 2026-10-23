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
}

/**
 * Which timeline mount a session-tab click belongs to: the next one. The mount of the clicked
 * thread claims the click and a mount of any other thread drops it, so a click is measured at
 * most once and never against a later open of the same thread that had no click.
 */
export interface TabSwitchClickLedger {
  /** A click on `key`'s tab; replaces a click that no mount claimed yet. */
  readonly note: (key: string) => void;
  /** A timeline for `key` mounted: returns the pending click if it was on `key`'s tab. */
  readonly claim: (key: string) => TabSwitchClick | null;
  /**
   * Hands back a claim whose mount ended before its reveal. StrictMode runs a mount's layout
   * effect again right after its cleanup, so the click stays claimable until `defer` runs.
   */
  readonly release: (click: TabSwitchClick) => void;
}

export function createTabSwitchClickLedger(
  defer: (callback: () => void) => void,
): TabSwitchClickLedger {
  let pending: TabSwitchClick | null = null;
  return {
    note: (key) => {
      pending = { key };
    },
    claim: (key) => {
      const click = pending;
      pending = null;
      return click !== null && click.key === key ? click : null;
    },
    release: (click) => {
      if (pending !== null) return;
      pending = click;
      defer(() => {
        if (pending === click) pending = null;
      });
    },
  };
}

const tabSwitchClicks = createTabSwitchClickLedger((callback) => queueMicrotask(callback));

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
 * renders no list, so a list that mounts later starts its own observation.
 */
export function useTimelineRevealMark(
  listRef: RefObject<LegendListRef | null>,
  key: string,
  listMounted: boolean,
): void {
  useLayoutEffect(() => {
    if (
      !listMounted ||
      !key ||
      !isWebPerfProfileEnabled() ||
      typeof performance === "undefined" ||
      typeof requestAnimationFrame !== "function"
    ) {
      return;
    }
    timelineRevealSequence += 1;
    const sequence = timelineRevealSequence;
    // Marked here, synchronously in the mount's layout effect; the rest observes from frames.
    const mountName = makeTimelineRevealMarkName("mount", key, sequence);
    performance.mark(mountName);
    const mountedAt = readWebPerfNow();
    const click = tabSwitchClicks.claim(key);
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
