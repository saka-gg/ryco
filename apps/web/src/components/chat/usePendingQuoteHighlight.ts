import { parseScopedThreadKey, scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { collectQuoteCitationTokens } from "@ryco/shared/quoteCitations";
import { useCallback, useEffect, useSyncExternalStore } from "react";

import { cssHighlightRegistry } from "~/lib/cssHighlights";
import { resolveTextQuoteRange } from "~/lib/textQuoteDom";
import { useComposerDraftStore } from "../../composerDraftStore";

/** Styled by `::highlight(ryco-quote-pending)` in index.css. */
export const PENDING_QUOTE_HIGHLIGHT_NAME = "ryco-quote-pending";

/**
 * The tokens of `prompt` that quote `threadKey`'s own messages, as one string
 * (the store selector's result, so the timeline renders again only when the
 * set of quotes changes, not on every keystroke).
 */
function pendingQuoteTokens(prompt: string | undefined, threadKey: string): string {
  if (!prompt) return "";
  return collectQuoteCitationTokens(prompt)
    .filter(
      ({ citation }) =>
        scopedThreadKey(scopeThreadRef(citation.environmentId, citation.threadId)) === threadKey,
    )
    .map((token) => token.source)
    .join("\n");
}

/**
 * Marks the passages the thread's unsent prompt quotes, in the transcript
 * they were quoted from, with the CSS Custom Highlight API: what the draft
 * points at stays visible while the user writes about it. The mark follows
 * the transcript as rows mount, unmount and re-render, and goes once the
 * quote leaves the prompt (removed or sent).
 */
export function usePendingQuoteHighlight(threadKey: string, root: HTMLElement | null): void {
  const readTokens = useCallback(() => {
    const thread = parseScopedThreadKey(threadKey);
    const draft = thread ? useComposerDraftStore.getState().getComposerDraft(thread) : null;
    return pendingQuoteTokens(draft?.prompt, threadKey);
  }, [threadKey]);
  // A server render has no draft to mark.
  const tokens = useSyncExternalStore(useComposerDraftStore.subscribe, readTokens, () => "");

  useEffect(() => {
    const registry = cssHighlightRegistry();
    if (!registry || !root || tokens.length === 0) return;
    const citations = collectQuoteCitationTokens(tokens).map((token) => token.citation);
    const highlight = new Highlight();
    // Under the jump's highlight where both mark the same passage.
    highlight.priority = -1;
    registry.set(PENDING_QUOTE_HIGHLIGHT_NAME, highlight);
    let frameId = 0;
    const paint = () => {
      frameId = 0;
      highlight.clear();
      for (const citation of citations) {
        const message = root.querySelector<HTMLElement>(
          `[data-selection-message-id="${CSS.escape(citation.messageId)}"]`,
        );
        const range = message ? resolveTextQuoteRange(message, citation.selector) : null;
        if (range) highlight.add(range);
      }
    };
    paint();
    // Rows mount as the transcript scrolls, and code blocks re-render their
    // text: paint again, at most once a frame.
    const observer = new MutationObserver(() => {
      if (frameId === 0) frameId = window.requestAnimationFrame(paint);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frameId !== 0) window.cancelAnimationFrame(frameId);
      if (registry.get(PENDING_QUOTE_HIGHLIGHT_NAME) === highlight) {
        registry.delete(PENDING_QUOTE_HIGHLIGHT_NAME);
      }
    };
  }, [root, tokens]);
}
