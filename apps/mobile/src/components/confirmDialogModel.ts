// What the app's own confirm dialog decides, kept free of React Native so node
// tests can check it: when its Confirm counts, and how an answer closes it.

import { isHtmlRenderMessageScrolledToEnd } from "@ryco/client-runtime/state/session";

/** How far a quote box has scrolled, as its scroll view reports it; null until measured. */
export interface ConfirmQuoteScroll {
  readonly offset: number;
  readonly viewport: number | null;
  readonly content: number | null;
}

export const UNMEASURED_CONFIRM_QUOTE_SCROLL: ConfirmQuoteScroll = {
  offset: 0,
  viewport: null,
  content: null,
};

/**
 * Whether the reader has seen the end of a dialog's quote: both sizes are in
 * and the box shows its last line (at once, when the quote fits).
 */
export function isConfirmQuoteReadToEnd(scroll: ConfirmQuoteScroll): boolean {
  return (
    scroll.viewport !== null &&
    scroll.content !== null &&
    isHtmlRenderMessageScrolledToEnd({
      scrollTop: scroll.offset,
      clientHeight: scroll.viewport,
      scrollHeight: scroll.content,
    })
  );
}

/**
 * Closes the dialog, then runs the answer's action. In this order an action
 * that asks again (a page's Send pressed too early) shows its new dialog,
 * instead of having it closed right after it opened and never answered.
 */
export function settleConfirmDialog(close: () => void, action: (() => void) | undefined): void {
  close();
  action?.();
}
