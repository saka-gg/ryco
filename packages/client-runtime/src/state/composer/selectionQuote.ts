import type { MessageId, ScopedThreadRef } from "@ryco/contracts";
import { serializeQuoteCitation, type QuoteCitation } from "@ryco/shared/quoteCitations";

/**
 * Adds a quote to a prompt as its draft token, after the text already there,
 * with a space after it so typing goes on behind the chip. The send expands
 * the token into the quote and its comment (`composeOutgoingPrompt`).
 */
export function appendQuoteCitation(prompt: string, citation: QuoteCitation): string {
  const separator = prompt.length === 0 || /\s$/u.test(prompt) ? "" : " ";
  return `${prompt}${separator}${serializeQuoteCitation(citation)} `;
}

/**
 * A captured excerpt as plain text, for inputs that cannot show a quote chip
 * (Side's question). Older messages carry quotes in this form too.
 */
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

const QUOTE_HEADER_PREFIX = "Quoted assistant text (";
const QUOTE_HEADER_SUFFIX = "):";
const QUOTE_LINE_PREFIX = ">";

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
    .map((line) => `${QUOTE_LINE_PREFIX} ${line}`)
    .join("\n");
  return `${prompt}${prompt ? "\n\n" : ""}${QUOTE_HEADER_PREFIX}${source}${QUOTE_HEADER_SUFFIX}\n${quoted}\n\n`;
}

function isSelectionQuoteHeader(line: string): boolean {
  if (!line.startsWith(QUOTE_HEADER_PREFIX) || !line.endsWith(QUOTE_HEADER_SUFFIX)) return false;
  try {
    const source: unknown = JSON.parse(
      line.slice(QUOTE_HEADER_PREFIX.length, line.length - QUOTE_HEADER_SUFFIX.length),
    );
    return (
      typeof source === "object" &&
      source !== null &&
      typeof (source as Record<string, unknown>).environmentId === "string" &&
      typeof (source as Record<string, unknown>).threadId === "string" &&
      typeof (source as Record<string, unknown>).messageId === "string"
    );
  } catch {
    return false;
  }
}

/**
 * The text around the quotes `appendSelectionQuote` added: each attributed header and its
 * quoted lines go, and the text on either side stays one blank line apart.
 */
export function stripSelectionQuotes(prompt: string): string {
  const lines = prompt.split("\n");
  const kept: string[] = [];
  let stripped = false;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!isSelectionQuoteHeader(line)) {
      kept.push(line);
      index += 1;
      continue;
    }
    stripped = true;
    index += 1;
    while (index < lines.length && lines[index]!.startsWith(QUOTE_LINE_PREFIX)) index += 1;
    while (index < lines.length && lines[index] === "") index += 1;
    while (kept.at(-1) === "") kept.pop();
    if (kept.length > 0 && index < lines.length) kept.push("");
  }
  return stripped ? kept.join("\n").trim() : prompt;
}
