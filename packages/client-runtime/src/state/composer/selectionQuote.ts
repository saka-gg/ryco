import type { MessageId, ScopedThreadRef } from "@ryco/contracts";

/** A captured excerpt, not a live reference to a changing transcript or DOM range. */
export interface SelectionQuote {
  readonly source: ScopedThreadRef;
  readonly messageId: MessageId;
  readonly text: string;
}

export const MAX_SELECTION_QUOTE_LENGTH = 4_000;

export function validateSelectionQuote(quote: SelectionQuote): void {
  if (!quote.text.trim() || quote.text.length > MAX_SELECTION_QUOTE_LENGTH) {
    throw new Error(
      `Select between 1 and ${MAX_SELECTION_QUOTE_LENGTH.toLocaleString("en-US")} characters.`,
    );
  }
}

/** Uses the ordinary text payload, so all providers, queues and draft recovery agree. */
export function appendSelectionQuote(prompt: string, quote: SelectionQuote): string {
  validateSelectionQuote(quote);
  const source = JSON.stringify({
    environmentId: quote.source.environmentId,
    threadId: quote.source.threadId,
    messageId: quote.messageId,
  });
  const quoted = quote.text
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
  return `${prompt}${prompt ? "\n\n" : ""}Quoted assistant text (${source}):\n${quoted}\n\n`;
}
