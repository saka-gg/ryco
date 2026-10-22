import { extractQuoteCitationBlock, type NumberedQuoteCitation } from "@ryco/shared/quoteCitations";

import {
  deriveDisplayedUserMessageContext,
  type DisplayedUserMessageContext,
} from "./terminalContext";

export interface DisplayedUserMessage extends DisplayedUserMessageContext {
  /** The quotes of the message's trailing quote block; its markers show them as chips. */
  readonly quotes: ReadonlyArray<NumberedQuoteCitation>;
}

/**
 * What a sent user message shows: its text without the trailing context and
 * quote blocks, which render as chips instead. Copying keeps the
 * text as sent.
 */
export function deriveDisplayedUserMessage(text: string): DisplayedUserMessage {
  const state = deriveDisplayedUserMessageContext(text);
  const quoted = extractQuoteCitationBlock(state.visibleText);
  return { ...state, visibleText: quoted.text, quotes: quoted.quotes };
}
