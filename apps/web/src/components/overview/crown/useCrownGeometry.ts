import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";

import { computeCrownSize, type CrownMode } from "./crownGeometry.logic";
import { CROWN_BOUNDS_PADDING_PX } from "./crownLayout";

const CROWN_DETAIL_MAX_PROPERTY = "--crown-detail-max";
/** The card's content column width (island width minus its 1px borders). */
const CROWN_CARD_CONTENT_WIDTH_PROPERTY = "--crown-card-content-w";

export interface CrownGeometryRefs {
  /** The morphing island; receives width, height and `--crown-detail-max`. */
  readonly islandRef: RefObject<HTMLElement | null>;
  /** The alert layer, measured for the alert width. */
  readonly alertLayerRef: RefObject<HTMLElement | null>;
  /** The card's main column, measured for the card height. */
  readonly cardMainRef: RefObject<HTMLElement | null>;
  /** The rail the card swallows; the card is never shorter than it. */
  readonly railRef: RefObject<HTMLElement | null>;
  /**
   * The slot the crown mounts in: it bounds the card's height, and its parent
   * (the chat row) bounds the card's width.
   */
  readonly boundsRef: RefObject<HTMLElement | null>;
}

/**
 * Sizes the crown island like the prototype's `Crown.fitCrown()`: measures the
 * layers with ResizeObservers and writes the size straight onto the island,
 * whose CSS transition animates the morph. No React state, so measuring never
 * re-renders.
 */
export function useCrownGeometry(input: CrownGeometryRefs & { readonly mode: CrownMode }): void {
  const { islandRef, alertLayerRef, cardMainRef, railRef, boundsRef, mode } = input;
  const modeRef = useRef(mode);

  const refit = useCallback(() => {
    const island = islandRef.current;
    if (!island) return;
    const bounds = boundsRef.current;
    const row = bounds?.parentElement ?? null;
    const islandRect = island.getBoundingClientRect();
    const capHeight = bounds
      ? bounds.clientHeight -
        (islandRect.top - bounds.getBoundingClientRect().top) -
        CROWN_BOUNDS_PADDING_PX
      : window.innerHeight - islandRect.top - CROWN_BOUNDS_PADDING_PX;
    const availableWidth =
      islandRect.right - (row?.getBoundingClientRect().left ?? 0) - CROWN_BOUNDS_PADDING_PX;
    const size = computeCrownSize({
      mode: modeRef.current,
      alertContentWidth: alertLayerRef.current?.offsetWidth ?? 0,
      availableWidth,
      railHeight: railRef.current?.offsetHeight ?? 0,
      cardContentHeight: cardMainRef.current?.offsetHeight ?? 0,
      capHeight,
    });
    island.style.width = `${size.width}px`;
    island.style.height = `${size.height}px`;
    island.style.setProperty(CROWN_DETAIL_MAX_PROPERTY, `${size.detailMax}px`);
    // The card's columns reflow inside a narrowed island instead of overflowing it.
    if (modeRef.current === "card") {
      island.style.setProperty(CROWN_CARD_CONTENT_WIDTH_PROPERTY, `${size.width - 2}px`);
    }
  }, [alertLayerRef, boundsRef, cardMainRef, islandRef, railRef]);

  // Before paint, so a mode switch starts its transition from the right size.
  useLayoutEffect(() => {
    modeRef.current = mode;
    refit();
  }, [mode, refit]);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => refit());
    for (const ref of [alertLayerRef, cardMainRef, railRef, boundsRef]) {
      if (ref.current) observer.observe(ref.current);
    }
    const row = boundsRef.current?.parentElement;
    if (row) observer.observe(row);
    return () => observer.disconnect();
  }, [alertLayerRef, boundsRef, cardMainRef, railRef, refit]);
}
