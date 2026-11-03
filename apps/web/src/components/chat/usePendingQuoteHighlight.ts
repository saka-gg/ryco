import { parseScopedThreadKey, scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { collectQuoteCitationTokens } from "@ryco/shared/quoteCitations";
import { useCallback, useEffect, useSyncExternalStore } from "react";

import { cssHighlightRegistry } from "~/lib/cssHighlights";
import { resolveTextQuoteRange } from "~/lib/textQuoteDom";
import { useComposerDraftStore } from "../../composerDraftStore";

/** Styled by `::highlight(ryco-quote-pending)` in index.css. */
export const PENDING_QUOTE_HIGHLIGHT_NAME = "ryco-quote-pending";

/**
 * The one pending highlight, shared by every timeline on screen (split panes
 * show several): each adds and removes only its own ranges, and the last one
 * to go takes the highlight out of the registry.
 */
let sharedPendingHighlight: { readonly highlight: Highlight; users: number } | null = null;

function acquirePendingHighlight(registry: Map<string, Highlight>): Highlight {
  if (sharedPendingHighlight === null) {
    const highlight = new Highlight();
    // Under the jump's highlight where both mark the same passage.
    highlight.priority = -1;
    sharedPendingHighlight = { highlight, users: 0 };
  }
  sharedPendingHighlight.users += 1;
  registry.set(PENDING_QUOTE_HIGHLIGHT_NAME, sharedPendingHighlight.highlight);
  return sharedPendingHighlight.highlight;
}

function releasePendingHighlight(registry: Map<string, Highlight>): void {
  if (sharedPendingHighlight === null) return;
  sharedPendingHighlight.users -= 1;
  if (sharedPendingHighlight.users > 0) return;
  if (registry.get(PENDING_QUOTE_HIGHLIGHT_NAME) === sharedPendingHighlight.highlight) {
    registry.delete(PENDING_QUOTE_HIGHLIGHT_NAME);
  }
  sharedPendingHighlight = null;
}

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

/** Whether a mutation could have moved or changed text inside a quoted message. */
function touchesQuotedMessage(record: MutationRecord, quotedMessages: string): boolean {
  const target =
    record.target.nodeType === Node.ELEMENT_NODE
      ? (record.target as Element)
      : record.target.parentElement;
  if (target?.closest(quotedMessages)) return true;
  if (record.type !== "childList") return false;
  // A row mounted or unmounted around the message: the message itself came or went.
  const containsQuotedMessage = (node: Node) =>
    node.nodeType === Node.ELEMENT_NODE &&
    ((node as Element).matches(quotedMessages) ||
      (node as Element).querySelector(quotedMessages) !== null);
  return (
    Array.prototype.some.call(record.addedNodes, containsQuotedMessage) ||
    Array.prototype.some.call(record.removedNodes, containsQuotedMessage)
  );
}

/**
 * Marks the passages the thread's unsent prompt quotes, in the transcript
 * they were quoted from, with the CSS Custom Highlight API: what the draft
 * points at stays visible while the user writes about it. The mark follows
 * the quoted messages as their rows mount, unmount and re-render, and goes
 * once the quote leaves the prompt (removed or sent). Changes elsewhere in
 * the transcript, such as a reply streaming in, leave it as it is.
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
    const quotedMessages = [...new Set(citations.map((citation) => citation.messageId))]
      .map((messageId) => `[data-selection-message-id="${CSS.escape(messageId)}"]`)
      .join(", ");
    const highlight = acquirePendingHighlight(registry);
    let ranges: Range[] = [];
    let frameId = 0;
    const paint = () => {
      frameId = 0;
      for (const range of ranges) highlight.delete(range);
      ranges = [];
      for (const citation of citations) {
        const message = root.querySelector<HTMLElement>(
          `[data-selection-message-id="${CSS.escape(citation.messageId)}"]`,
        );
        const range = message ? resolveTextQuoteRange(message, citation.selector) : null;
        if (range) ranges.push(range);
      }
      for (const range of ranges) highlight.add(range);
    };
    paint();
    // Rows mount as the transcript scrolls, and code blocks re-render their
    // text: paint again, at most once a frame, when a quoted message changed.
    const observer = new MutationObserver((records) => {
      if (frameId !== 0) return;
      if (records.some((record) => touchesQuotedMessage(record, quotedMessages))) {
        frameId = window.requestAnimationFrame(paint);
      }
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frameId !== 0) window.cancelAnimationFrame(frameId);
      for (const range of ranges) highlight.delete(range);
      releasePendingHighlight(registry);
    };
  }, [root, tokens]);
}
