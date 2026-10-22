import { useCallback, useEffect, useRef } from "react";

import { cssHighlightRegistry } from "~/lib/cssHighlights";
import { resolveTextQuoteRange } from "~/lib/textQuoteDom";
import { useQuoteSourceJumpStore } from "../../quoteSourceJumpStore";
import { useTimelineRevealStore } from "../../timelineRevealStore";

/** Styled by `::highlight(ryco-quote-source)` in index.css. */
export const QUOTE_SOURCE_HIGHLIGHT_NAME = "ryco-quote-source";
/** How long the passage stays painted. */
export const QUOTE_SOURCE_HIGHLIGHT_MS = 2_400;
/**
 * A jump whose reveal is still loading by then gives up, without saying the
 * source is gone: a slow connection proves nothing.
 */
export const QUOTE_SOURCE_JUMP_TIMEOUT_MS = 30_000;
/** After the reveal settles (shown or failed), how long the message may take to render. */
const QUOTE_SOURCE_SETTLED_GRACE_MS = 600;
const QUOTE_SOURCE_POLL_MS = 100;

/**
 * Finishes this thread's quote jumps: once the timeline reveal has rendered
 * the quoted message, re-anchors the passage with its text-quote selector,
 * paints it with the CSS Custom Highlight API and scrolls it into view. Only
 * evidence makes a passage unavailable: its message rendered without it, or
 * the reveal settled without rendering the message. A reveal that is still
 * loading at the timeout, or that another one replaced, abandons the jump.
 */
export function useQuoteSourceHighlight(threadKey: string, root: HTMLElement | null): void {
  const jump = useQuoteSourceJumpStore((store) =>
    store.active?.threadKey === threadKey ? store.active : null,
  );
  // Outlives the jump, which finishes as soon as the passage is painted.
  const paintedRef = useRef<{
    highlight: Highlight | null;
    timeoutId: number;
    frameId: number;
  } | null>(null);

  const clearPainted = useCallback(() => {
    const painted = paintedRef.current;
    if (!painted) return;
    paintedRef.current = null;
    window.clearTimeout(painted.timeoutId);
    window.cancelAnimationFrame(painted.frameId);
    const registry = cssHighlightRegistry();
    if (painted.highlight && registry?.get(QUOTE_SOURCE_HIGHLIGHT_NAME) === painted.highlight) {
      registry.delete(QUOTE_SOURCE_HIGHLIGHT_NAME);
    }
  }, []);
  useEffect(() => clearPainted, [clearPainted]);

  const paint = useCallback(
    (range: Range) => {
      clearPainted();
      const registry = cssHighlightRegistry();
      const highlight = registry ? new Highlight(range) : null;
      if (registry && highlight) registry.set(QUOTE_SOURCE_HIGHLIGHT_NAME, highlight);
      const painted = {
        highlight,
        timeoutId: window.setTimeout(clearPainted, QUOTE_SOURCE_HIGHLIGHT_MS),
        frameId: 0,
      };
      paintedRef.current = painted;
      // Two frames: after the reveal has scrolled the message's row into view,
      // so this lands on the passage within it.
      painted.frameId = window.requestAnimationFrame(() => {
        painted.frameId = window.requestAnimationFrame(() => {
          const target = range.startContainer.parentElement;
          if (paintedRef.current !== painted || !target?.isConnected) return;
          const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          target.scrollIntoView({ block: "center", behavior: reducedMotion ? "auto" : "smooth" });
        });
      });
    },
    [clearPainted],
  );

  useEffect(() => {
    if (!jump || !root) return;
    const { finish } = useQuoteSourceJumpStore.getState();
    // A jump left behind when its thread was closed is not this visit's.
    if (Date.now() - jump.startedAt >= QUOTE_SOURCE_JUMP_TIMEOUT_MS) {
      finish(jump.id, "abandoned");
      return;
    }
    let pollId = 0;
    let settledAt: number | null = null;

    const attempt = () => {
      pollId = 0;
      const now = Date.now();
      const message = root.querySelector<HTMLElement>(
        `[data-selection-message-id="${CSS.escape(jump.messageId)}"]`,
      );
      if (message) {
        const range = resolveTextQuoteRange(message, jump.selector);
        if (range) paint(range);
        finish(jump.id, range ? "shown" : "unavailable");
        return;
      }
      const reveal = useTimelineRevealStore.getState().requestsByThreadKey[jump.threadKey];
      if (reveal === undefined || jump.revealRequestId === null) {
        settledAt ??= now;
      } else if (reveal.requestId !== jump.revealRequestId) {
        finish(jump.id, "abandoned");
        return;
      }
      if (settledAt !== null) {
        if (now - settledAt >= QUOTE_SOURCE_SETTLED_GRACE_MS) {
          finish(jump.id, "unavailable");
          return;
        }
      } else if (now - jump.startedAt >= QUOTE_SOURCE_JUMP_TIMEOUT_MS) {
        finish(jump.id, "abandoned");
        return;
      }
      pollId = window.setTimeout(attempt, QUOTE_SOURCE_POLL_MS);
    };

    attempt();
    return () => {
      if (pollId !== 0) window.clearTimeout(pollId);
    };
  }, [jump, paint, root]);
}
