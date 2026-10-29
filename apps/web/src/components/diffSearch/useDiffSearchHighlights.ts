import { type RefObject, useEffect, useRef } from "react";

import { cssHighlightRegistry } from "~/lib/cssHighlights";
import type { DiffSearchMatch, DiffSearchRenderMode } from "~/lib/diffSearch";

import { diffSearchHighlightNames, findDiffSearchRanges, isNearViewport } from "./diffSearchDom";

/** Batches the refreshes a scroll or a render burst would trigger. */
const DIFF_SEARCH_HIGHLIGHT_REFRESH_DELAY_MS = 80;

/**
 * Paints a find surface's matches with the CSS Custom Highlight API over the
 * rows rendered near the viewport, and repaints as the virtualized diff
 * scrolls, re-renders or resizes. The current match gets its own highlight.
 */
export function useDiffSearchHighlights(input: {
  /** Holds the `[data-diff-file-index]` files and the `.diff-render-surface` scroller. */
  readonly rootRef: RefObject<HTMLElement | null>;
  readonly name: string;
  readonly matchesByFileIndex: ReadonlyMap<number, readonly DiffSearchMatch[]>;
  readonly current: DiffSearchMatch | null;
  readonly renderMode: DiffSearchRenderMode;
  readonly enabled: boolean;
  /** Paint the current match apart; off, it is painted like the others. */
  readonly paintCurrent: boolean;
}): void {
  const { rootRef, name, matchesByFileIndex, renderMode, enabled } = input;
  const current = input.paintCurrent ? input.current : null;
  const currentRef = useRef<DiffSearchMatch | null>(null);
  const scheduleRefreshRef = useRef<(() => void) | null>(null);

  // Moving to another match repaints without re-observing the diff. Declared
  // first, so the observer effect below reads the current match on mount too.
  useEffect(() => {
    currentRef.current = current;
    scheduleRefreshRef.current?.();
  }, [current]);

  useEffect(() => {
    const cssHighlights = cssHighlightRegistry();
    if (!cssHighlights) return;
    const names = diffSearchHighlightNames(name);
    const clear = () => {
      cssHighlights.delete(names.match);
      cssHighlights.delete(names.current);
    };
    const root = rootRef.current;
    if (!root || !enabled || matchesByFileIndex.size === 0) {
      clear();
      return;
    }

    let frameId = 0;
    let refreshTimeoutId = 0;
    const lineMaps = new Map<number, ReadonlyMap<number, readonly DiffSearchMatch[]>>();
    const shadowObservers = new Map<ShadowRoot, MutationObserver>();
    const viewport =
      root.querySelector<HTMLElement>(".diff-render-surface") ??
      root.querySelector<HTMLElement>("[data-virtualizer]") ??
      root;
    const refreshHighlights = () => {
      frameId = 0;
      observeNewShadowRoots();
      const ranges = findDiffSearchRanges({
        rootElement: root,
        viewportElement: viewport,
        matchesByFileIndex,
        renderMode,
        current: currentRef.current,
        lineMaps,
      });
      if (ranges.match.length === 0) {
        cssHighlights.delete(names.match);
      } else {
        cssHighlights.set(names.match, new Highlight(...ranges.match));
      }
      if (ranges.current.length === 0) {
        cssHighlights.delete(names.current);
      } else {
        const current = new Highlight(...ranges.current);
        current.priority = 1;
        cssHighlights.set(names.current, current);
      }
    };
    const scheduleRefresh = () => {
      if (frameId !== 0 || refreshTimeoutId !== 0) return;
      refreshTimeoutId = window.setTimeout(() => {
        refreshTimeoutId = 0;
        frameId = window.requestAnimationFrame(refreshHighlights);
      }, DIFF_SEARCH_HIGHLIGHT_REFRESH_DELAY_MS);
    };
    const observeNewShadowRoots = () => {
      const viewportRect = viewport.getBoundingClientRect();
      const fileElements = root.querySelectorAll<HTMLElement>("[data-diff-file-index]");
      for (const fileElement of fileElements) {
        if (!isNearViewport(fileElement, viewportRect)) continue;
        const containers = fileElement.querySelectorAll<HTMLElement>("diffs-container");
        for (const container of containers) {
          const shadow = container.shadowRoot;
          if (!shadow || shadowObservers.has(shadow)) continue;
          const observer = new MutationObserver(scheduleRefresh);
          observer.observe(shadow, { childList: true, subtree: true });
          shadowObservers.set(shadow, observer);
        }
      }
    };

    const lightObserver = new MutationObserver(scheduleRefresh);
    lightObserver.observe(root, { childList: true, subtree: true });
    viewport.addEventListener("scroll", scheduleRefresh, { passive: true });
    const resizeObserver = new ResizeObserver(scheduleRefresh);
    resizeObserver.observe(viewport);
    scheduleRefreshRef.current = scheduleRefresh;
    scheduleRefresh();

    return () => {
      scheduleRefreshRef.current = null;
      lightObserver.disconnect();
      viewport.removeEventListener("scroll", scheduleRefresh);
      resizeObserver.disconnect();
      for (const observer of shadowObservers.values()) {
        observer.disconnect();
      }
      shadowObservers.clear();
      if (refreshTimeoutId !== 0) window.clearTimeout(refreshTimeoutId);
      if (frameId !== 0) window.cancelAnimationFrame(frameId);
      clear();
    };
  }, [enabled, matchesByFileIndex, name, renderMode, rootRef]);
}
