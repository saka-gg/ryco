/**
 * Text-quote anchoring over a plain text stream, after the Web Annotation
 * TextQuote and TextPosition selectors: the quoted text, a little context on
 * each side, and its offsets as a hint. Whitespace is collapsed before any
 * comparison, so a passage still anchors after its rendering reflows (a list
 * re-wrapped, a code block re-highlighted). Pure, so web and mobile agree.
 *
 * @module textQuoteSelector
 */

/** The context kept on each side of a quote, in collapsed UTF-16 units. */
export const TEXT_QUOTE_CONTEXT_LENGTH = 32;

export interface TextQuoteSelector {
  /** The quoted text as captured. Never starts or ends with whitespace. */
  readonly exact: string;
  /** Up to {@link TEXT_QUOTE_CONTEXT_LENGTH} collapsed units right before the quote. */
  readonly prefix: string;
  /** Up to {@link TEXT_QUOTE_CONTEXT_LENGTH} collapsed units right after the quote. */
  readonly suffix: string;
  /**
   * The quote's offsets in the collapsed stream. Only a hint: the stream can
   * drift, so the text and its context decide.
   */
  readonly start: number;
  readonly end: number;
}

/** A whitespace run counts as one space, the stream every offset refers to. */
export function collapseTextQuoteWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

function isWhitespace(character: string | undefined): boolean {
  return character !== undefined && /\s/.test(character);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Whether `offset` falls between the two halves of one astral character. */
function splitsSurrogatePair(text: string, offset: number): boolean {
  return isHighSurrogate(text.charCodeAt(offset - 1)) && isLowSurrogate(text.charCodeAt(offset));
}

/**
 * The selector for `text.slice(rawStart, rawEnd)`, trimmed to its first and
 * last visible character, or null when nothing visible is selected.
 */
export function createTextQuoteSelector(
  text: string,
  rawStart: number,
  rawEnd: number,
): TextQuoteSelector | null {
  let start = Math.max(0, Math.min(text.length, Math.floor(rawStart)));
  let end = Math.max(start, Math.min(text.length, Math.floor(rawEnd)));
  while (start < end && isWhitespace(text[start])) start += 1;
  while (end > start && isWhitespace(text[end - 1])) end -= 1;
  if (start === end) return null;

  const collapsed = collapseTextQuoteWhitespace(text);
  // The quote starts and ends on visible characters, so collapsing what lies
  // before each boundary gives that boundary's collapsed offset exactly.
  const collapsedStart = collapseTextQuoteWhitespace(text.slice(0, start)).length;
  const collapsedEnd = collapseTextQuoteWhitespace(text.slice(0, end)).length;
  let prefixStart = Math.max(0, collapsedStart - TEXT_QUOTE_CONTEXT_LENGTH);
  let suffixEnd = Math.min(collapsed.length, collapsedEnd + TEXT_QUOTE_CONTEXT_LENGTH);
  // Half a character would not survive encoding; keep context whole.
  if (splitsSurrogatePair(collapsed, prefixStart)) prefixStart += 1;
  if (splitsSurrogatePair(collapsed, suffixEnd)) suffixEnd -= 1;
  return {
    exact: text.slice(start, end),
    prefix: collapsed.slice(prefixStart, collapsedStart),
    suffix: collapsed.slice(collapsedEnd, suffixEnd),
    start: collapsedStart,
    end: collapsedEnd,
  };
}

/**
 * Where the quote sits in `text`, as collapsed offsets, or null when the text
 * no longer contains it. Among several occurrences, the one whose context
 * matches on both sides wins over one side, over none; the offset hint only
 * breaks the remaining ties.
 */
export function findTextQuote(
  text: string,
  selector: TextQuoteSelector,
): { start: number; end: number } | null {
  const quote = collapseTextQuoteWhitespace(selector.exact).trim();
  if (quote.length === 0) return null;
  const stream = collapseTextQuoteWhitespace(text);
  const prefix = collapseTextQuoteWhitespace(selector.prefix);
  const suffix = collapseTextQuoteWhitespace(selector.suffix);
  const hint = Number.isSafeInteger(selector.start) ? selector.start : 0;

  let best: { start: number; score: number; distance: number } | null = null;
  for (let start = stream.indexOf(quote); start !== -1; start = stream.indexOf(quote, start + 1)) {
    const end = start + quote.length;
    const score =
      (stream.slice(Math.max(0, start - prefix.length), start) === prefix ? 1 : 0) +
      (stream.slice(end, end + suffix.length) === suffix ? 1 : 0);
    const distance = Math.abs(start - hint);
    if (best === null || score > best.score || (score === best.score && distance < best.distance)) {
      best = { start, score, distance };
    }
  }
  return best === null ? null : { start: best.start, end: best.start + quote.length };
}

/** The offset in `text` of a collapsed offset (a collapsed space maps to its whole run). */
export function textQuoteRawOffset(text: string, collapsedOffset: number): number {
  let collapsed = 0;
  for (const match of text.matchAll(/\s+|\S+/g)) {
    const run = match[0];
    const whitespace = isWhitespace(run[0]);
    const length = whitespace ? 1 : run.length;
    if (collapsedOffset <= collapsed + length) {
      if (!whitespace) return match.index + (collapsedOffset - collapsed);
      return match.index + (collapsedOffset > collapsed ? run.length : 0);
    }
    collapsed += length;
  }
  return text.length;
}

/** {@link findTextQuote}, as offsets into `text` itself. */
export function findTextQuoteRange(
  text: string,
  selector: TextQuoteSelector,
): { start: number; end: number } | null {
  const match = findTextQuote(text, selector);
  if (match === null) return null;
  return {
    start: textQuoteRawOffset(text, match.start),
    end: textQuoteRawOffset(text, match.end),
  };
}
