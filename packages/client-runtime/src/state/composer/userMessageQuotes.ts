/**
 * Quotes in a sent user message, next to its context blocks. A send expands
 * quote tokens into a quote block before it appends the context blocks
 * (`composeOutgoingPrompt`), so a message ends `…[Quote 1]…`, the
 * `<assistant_quotes>` block, then any `<file_context>` and
 * `<terminal_context>` blocks. Every surface reads that order here: the
 * context blocks come off first, then the quote block.
 *
 * @module userMessageQuotes
 */
import { extractQuoteCitationBlock, type NumberedQuoteCitation } from "@ryco/shared/quoteCitations";

import {
  deriveDisplayedUserMessageContext,
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
