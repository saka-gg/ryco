/**
 * Quotes in a sent user message, next to its context blocks. A send expands
 * quote tokens into a quote block before it appends the context blocks, so a
 * message ends `…[Quote 1]…`, the `<assistant_quotes>` block, then any
 * `<file_context>` and `<terminal_context>` blocks. Every surface reads that
 * order through these helpers: the context blocks come off first, then the
 * quote block.
 *
 * @module userMessageQuotes
 */
import {
  expandQuoteCitations,
  extractQuoteCitationBlock,
  QUOTE_CITATION_HREF_PREFIX,
  type NumberedQuoteCitation,
} from "@ryco/shared/quoteCitations";

import {
  deriveDisplayedUserMessageContext,
  extractTrailingPromptContexts,
  type DisplayedUserMessageContext,
} from "./promptContext.ts";

export interface DisplayedUserMessage extends DisplayedUserMessageContext {
  /** The quotes of the message's quote block; its `[Quote N]` markers show them as chips. */
  readonly quotes: ReadonlyArray<NumberedQuoteCitation>;
}

/**
 * What a sent user message shows: its text without the trailing context and
 * quote blocks, which render as chips instead. Copying keeps the text as
 * sent.
 */
export function deriveDisplayedUserMessage(text: string): DisplayedUserMessage {
  const state = deriveDisplayedUserMessageContext(text);
  const quoted = extractQuoteCitationBlock(state.visibleText);
  return { ...state, visibleText: quoted.text, quotes: quoted.quotes };
}

/**
 * The user text a send dispatches: quote tokens expanded into the quote
 * block, which stays ahead of any context blocks already appended. Text
 * already expanded comes back unchanged, so every send path can apply it.
 */
export function expandOutgoingQuoteCitations(text: string): string {
  if (!text.includes(QUOTE_CITATION_HREF_PREFIX)) return text;
  const prompt = extractTrailingPromptContexts(text).promptText;
  const expanded = expandQuoteCitations(prompt);
  return expanded === prompt ? text : `${expanded}${text.slice(prompt.length)}`;
}
