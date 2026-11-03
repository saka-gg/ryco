import { describe, expect, it, vi } from "vite-plus/test";

import {
  isConfirmQuoteReadToEnd,
  settleConfirmDialog,
  UNMEASURED_CONFIRM_QUOTE_SCROLL,
} from "./confirmDialogModel";

describe("isConfirmQuoteReadToEnd", () => {
  it("waits for both sizes, then for the box to show its last line", () => {
    expect(isConfirmQuoteReadToEnd(UNMEASURED_CONFIRM_QUOTE_SCROLL)).toBe(false);
    expect(isConfirmQuoteReadToEnd({ offset: 0, viewport: 240, content: null })).toBe(false);
    expect(isConfirmQuoteReadToEnd({ offset: 0, viewport: null, content: 100 })).toBe(false);
    // A quote that fits is read as soon as it is laid out.
    expect(isConfirmQuoteReadToEnd({ offset: 0, viewport: 240, content: 100 })).toBe(true);
    expect(isConfirmQuoteReadToEnd({ offset: 0, viewport: 240, content: 400 })).toBe(false);
    expect(isConfirmQuoteReadToEnd({ offset: 160, viewport: 240, content: 400 })).toBe(true);
  });
});

describe("settleConfirmDialog", () => {
  it("closes before it answers, so an answer that asks again keeps its dialog", () => {
    let shown: string | null = "first";
    settleConfirmDialog(
      () => {
        shown = null;
      },
      () => {
        shown = "second";
      },
    );
    expect(shown).toBe("second");
    const close = vi.fn();
    settleConfirmDialog(close, undefined);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
