// Profiling-only: loaded by `useTimelineRevealMark` (tabSwitchInstrumentation.ts) when
// `VITE_RYCO_PERF_PROFILE=1`, so none of this ships in the app shell's static graph.
import type { LegendListRef } from "@legendapp/list/react";
import type { RefObject } from "react";

import { getWebPerfReporter, readWebPerfNow } from "./perfInstrumentation";
import {
  makeTabSwitchMarkName,
  makeTabSwitchRevealMeasureName,
  makeTimelineRevealMarkName,
  makeTimelineRevealMeasureName,
} from "./tabSwitchInstrumentation";

/** What the reveal observer reads from a mounted list. */
export interface TimelineRevealTarget {
  /** Subscribes to the list's ready-to-render signal; returns the unsubscribe. */
  readonly listen: (callback: (ready: boolean) => void) => () => void;
  /** Whether the transcript rows are visible on screen right now. */
  readonly isVisible: () => boolean;
}

export interface TimelineRevealObserverOptions {
  readonly key: string;
  readonly sequence: number;
  /** The `mount` mark the caller set when the list mounted, and when that was. */
  readonly mountName: string;
  readonly mountedAt: number;
  /** Returns the list once it is attached; retried on the next frames until then. */
  readonly resolveTarget: () => TimelineRevealTarget | null;
  /** This mount claimed a session-tab click (`TabSwitchClickLedger`): measure click to visible. */
  readonly measureTabSwitchClick?: boolean;
  readonly performance: Pick<Performance, "mark" | "measure">;
  readonly requestFrame: (callback: () => void) => number;
  readonly cancelFrame: (handle: number) => void;
  readonly now: () => number;
  readonly onVisible?: (durationMs: number) => void;
}

// Frames to wait for the list ref (it attaches in the same commit, so a few frames suffice).
const ATTACH_FRAMES = 12;
// Frames to keep checking visibility after a ready-to-render change: LegendList fades its items
// in a commit after the signal, and an early flip can precede the subscription.
const CHECK_FRAMES = 120;

/**
 * Marks the first animation frame a timeline mount's transcript is visible
 * (`ryco:timeline-reveal:visible:<key>:<n>`, measure `ryco:timeline-reveal:<key>:<n>` from the
 * mount mark), and, when the mount claimed a session-tab click, measures
 * `ryco:tab-switch-reveal:<key>` from it. A transcript that hides again after its reveal is
 * marked once (`ryco:timeline-reveal:rehidden:<key>:<n>`). Returns the cleanup.
 */
export function observeTimelineReveal(options: TimelineRevealObserverOptions): () => void {
  const { key, sequence, mountName, performance: perf, requestFrame, cancelFrame } = options;
  let disposed = false;
  let frame: number | null = null;
  let unsubscribe: (() => void) | null = null;
  let target: TimelineRevealTarget | null = null;
  let attachFramesLeft = ATTACH_FRAMES;
  let checkFramesLeft = 0;
  let revealed = false;
  let rehidden = false;

  const markVisible = () => {
    revealed = true;
    const visibleName = makeTimelineRevealMarkName("visible", key, sequence);
    perf.mark(visibleName);
    try {
      perf.measure(makeTimelineRevealMeasureName(key, sequence), mountName, visibleName);
    } catch {
      // The mount mark was cleared.
    }
    if (options.measureTabSwitchClick) {
      try {
        perf.measure(
          makeTabSwitchRevealMeasureName(key),
          makeTabSwitchMarkName("click", key),
          visibleName,
        );
      } catch {
        // The click mark was cleared.
      }
    }
    options.onVisible?.(Math.max(0, options.now() - options.mountedAt));
  };

  const check = () => {
    if (!target) return;
    const visible = target.isVisible();
    if (!revealed && visible) {
      markVisible();
      checkFramesLeft = 0;
    } else if (revealed && !rehidden && !visible) {
      rehidden = true;
      perf.mark(makeTimelineRevealMarkName("rehidden", key, sequence));
      checkFramesLeft = 0;
    }
  };

  const schedule = () => {
    if (disposed || frame !== null) return;
    frame = requestFrame(() => {
      frame = null;
      if (disposed) return;
      if (!target) {
        target = options.resolveTarget();
        if (!target) {
          attachFramesLeft -= 1;
          if (attachFramesLeft > 0) schedule();
          return;
        }
        unsubscribe = target.listen(() => {
          checkFramesLeft = CHECK_FRAMES;
          schedule();
        });
        checkFramesLeft = CHECK_FRAMES;
      }
      check();
      if (checkFramesLeft > 0 && !rehidden) {
        checkFramesLeft -= 1;
        schedule();
      }
    });
  };

  schedule();
  return () => {
    disposed = true;
    if (frame !== null) cancelFrame(frame);
    frame = null;
    unsubscribe?.();
    unsubscribe = null;
  };
}

/**
 * LegendList's web DOM is scroller > content > [header, item container, footer]; the item
 * container carries the `opacity` that hides the rows until the list is ready to render.
 */
export function findLegendListItemContainer(scrollNode: Element): HTMLElement | undefined {
  const content = scrollNode.firstElementChild;
  if (!content) return undefined;
  for (const child of content.children) {
    if (child instanceof HTMLElement && child.style.opacity !== "") return child;
  }
  return undefined;
}

function isLegendListContentVisible(list: LegendListRef): boolean {
  const scrollNode = list.getScrollableNode?.();
  if (!(scrollNode instanceof HTMLElement)) return false;
  const container = findLegendListItemContainer(scrollNode);
  return container !== undefined && container.style.opacity !== "0";
}

/** `observeTimelineReveal` for a LegendList ref, on the page's performance timeline. */
export function observeLegendListReveal(input: {
  readonly listRef: RefObject<LegendListRef | null>;
  readonly key: string;
  readonly sequence: number;
  readonly mountName: string;
  readonly mountedAt: number;
  readonly measureTabSwitchClick: boolean;
  readonly onVisible?: () => void;
}): () => void {
  const reporter = getWebPerfReporter("web.timeline.reveal");
  return observeTimelineReveal({
    key: input.key,
    sequence: input.sequence,
    mountName: input.mountName,
    mountedAt: input.mountedAt,
    measureTabSwitchClick: input.measureTabSwitchClick,
    resolveTarget: () => {
      const list = input.listRef.current;
      // The browser-test mocks of LegendList have no getState or listen.
      const listen = list?.getState?.()?.listen;
      if (!list || typeof listen !== "function") return null;
      return {
        listen: (callback) => listen("readyToRender", callback),
        isVisible: () => isLegendListContentVisible(list),
      };
    },
    performance,
    requestFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (handle) => cancelAnimationFrame(handle),
    now: readWebPerfNow,
    onVisible: (durationMs) => {
      reporter.record({ durationMs });
      input.onVisible?.();
    },
  });
}
