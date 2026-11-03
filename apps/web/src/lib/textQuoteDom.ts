/**
 * Text-quote selectors over rendered messages. A message reads as one text
 * stream: its text nodes in order, with a line break between blocks, and
 * without controls or hidden text. Capturing a selection and finding it
 * again later read the same stream, so a quote re-anchors after a remount.
 */
import {
  createTextQuoteSelector,
  findTextQuoteRange,
  type TextQuoteSelector,
} from "@ryco/shared/textQuoteSelector";

const EXCLUDED_SELECTOR =
  "button, input, textarea, select, [role=button], [contenteditable], [hidden], [aria-hidden=true], script, style, template, noscript, svg";
const BLOCK_SELECTOR =
  "address, article, aside, blockquote, dd, div, dl, dt, figcaption, figure, footer, h1, h2, h3, h4, h5, h6, header, hr, li, main, nav, ol, p, pre, section, table, td, th, tr, ul";

interface TextQuoteChunk {
  readonly node: Text;
  readonly start: number;
  readonly end: number;
}

interface TextQuoteStream {
  readonly text: string;
  readonly chunks: ReadonlyArray<TextQuoteChunk>;
}

function readTextQuoteStream(root: HTMLElement): TextQuoteStream {
  const parts: string[] = [];
  const chunks: TextQuoteChunk[] = [];
  let length = 0;
  let pendingBreak = false;

  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node as Text;
      if (text.length === 0) return;
      if (pendingBreak && length > 0) {
        parts.push("\n");
        length += 1;
      }
      pendingBreak = false;
      chunks.push({ node: text, start: length, end: length + text.length });
      parts.push(text.data);
      length += text.length;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    if (element !== root && element.matches(EXCLUDED_SELECTOR)) return;
    const block = element.matches(BLOCK_SELECTOR);
    if (block || element.tagName === "BR") pendingBreak = true;
    for (const child of element.childNodes) visit(child);
    if (block) pendingBreak = true;
  };

  visit(root);
  return { text: parts.join(""), chunks };
}

/** The selector for the part of `range` inside `root`, or null when none of it is text. */
export function captureTextQuoteSelector(
  root: HTMLElement,
  range: Range,
): TextQuoteSelector | null {
  if (range.collapsed) return null;
  const stream = readTextQuoteStream(root);
  let rawStart: number | null = null;
  let rawEnd = 0;
  for (const chunk of stream.chunks) {
    if (!range.intersectsNode(chunk.node)) continue;
    const start = chunk.node === range.startContainer ? range.startOffset : 0;
    const end = chunk.node === range.endContainer ? range.endOffset : chunk.node.length;
    if (start >= end) continue;
    rawStart ??= chunk.start + start;
    rawEnd = chunk.start + end;
  }
  if (rawStart === null) return null;
  return createTextQuoteSelector(stream.text, rawStart, rawEnd);
}

/** The range the quote covers inside `root` now, or null when it is gone. */
export function resolveTextQuoteRange(
  root: HTMLElement,
  selector: TextQuoteSelector,
): Range | null {
  const stream = readTextQuoteStream(root);
  const match = findTextQuoteRange(stream.text, selector);
  if (match === null) return null;
  const first = stream.chunks.find((chunk) => chunk.end > match.start);
  const last = stream.chunks.findLast((chunk) => chunk.start < match.end);
  if (first === undefined || last === undefined) return null;
  const range = root.ownerDocument.createRange();
  range.setStart(first.node, Math.max(0, match.start - first.start));
  range.setEnd(last.node, Math.min(last.node.length, match.end - last.start));
  return range.collapsed ? null : range;
}
