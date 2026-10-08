import {
  CROWN_BOUNDS_PADDING_PX,
  CROWN_CARD_CHROME_PX,
  CROWN_CARD_WIDTH_PX,
  CROWN_HEAD_OFFSET_PX,
  CROWN_RAIL_WIDTH_PX,
} from "./crownLayout";

/**
 * Crown island and flyout geometry, from the prototype's `Crown.fitCrown()`
 * and `Flyout.fit()`. The island animates width/height in CSS, so these sizes
 * are written straight onto the element rather than rendered.
 */

export type CrownMode = "dot" | "alert" | "card";

export interface CrownSize {
  readonly width: number;
  readonly height: number;
  /** `--crown-detail-max`: the card's scrollable detail height. */
  readonly detailMax: number;
}

export function computeCrownSize(input: {
  readonly mode: CrownMode;
  /** Measured width of the alert layer's content. */
  readonly alertContentWidth: number;
  /** Room left of the island's right edge in the chat row; the card and alert never exceed it. */
  readonly availableWidth: number;
  readonly railHeight: number;
  /** Measured height of the card's main column (header + detail). */
  readonly cardContentHeight: number;
  /** Tallest the card may grow within its bounds. */
  readonly capHeight: number;
}): CrownSize {
  const face = CROWN_RAIL_WIDTH_PX;
  const detailMax = Math.max(0, input.capHeight - CROWN_CARD_CHROME_PX);
  const fit = (width: number) => Math.max(face, Math.min(width, input.availableWidth));
  if (input.mode === "alert") {
    return { width: fit(input.alertContentWidth + face), height: face, detailMax };
  }
  if (input.mode === "card") {
    const height = Math.min(
      input.capHeight,
      Math.max(CROWN_HEAD_OFFSET_PX + input.railHeight, input.cardContentHeight + 2),
    );
    return { width: fit(CROWN_CARD_WIDTH_PX), height: Math.max(face, height), detailMax };
  }
  return { width: face, height: face, detailMax };
}

export interface FlyoutPlacement {
  /** Top within the bounds. */
  readonly top: number;
  readonly height: number;
  /** `--fly-max`: tallest the content may scroll to. */
  readonly maxHeight: number;
  /** `--oy`: the anchor's centre relative to the flyout top, so it grows out of the icon. */
  readonly originY: number;
}

/** All inputs are relative to the bounds' top edge. */
export function computeFlyoutPlacement(input: {
  readonly anchorTop: number;
  readonly anchorHeight: number;
  readonly contentHeight: number;
  readonly boundsHeight: number;
  /**
   * Band at the top of the bounds the flyout must stay below (the chat
   * header owns it); the crown itself starts there.
   */
  readonly topInset?: number;
  readonly padding?: number;
}): FlyoutPlacement {
  const padding = input.padding ?? CROWN_BOUNDS_PADDING_PX;
  const minTop = Math.max(padding, input.topInset ?? 0);
  const maxHeight = Math.max(0, input.boundsHeight - minTop - padding);
  const height = Math.min(input.contentHeight, maxHeight);
  // Prefer aligning just above the icon; the top limit wins when both limits bind.
  const top = Math.max(
    minTop,
    Math.min(input.anchorTop - 6, input.boundsHeight - height - padding),
  );
  return { top, height, maxHeight, originY: input.anchorTop + input.anchorHeight / 2 - top };
}
