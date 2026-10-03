const FENCED_CODE_BLOCK = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;
const INLINE_CODE = /(`[^`\n]+`)/g;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const NEWLINE = 10;

interface Range {
  start: number;
  end: number;
}

/** Splits `text[start, end)` around `pattern`'s matches, with source offsets. */
function* splitAround(
  text: string,
  start: number,
  end: number,
  pattern: RegExp,
): Generator<{ readonly matched: boolean; readonly start: number; readonly end: number }> {
  let cursor = start;
  for (const match of text.slice(start, end).matchAll(pattern)) {
    const matchStart = start + (match.index ?? 0);
    if (matchStart > cursor) yield { matched: false, start: cursor, end: matchStart };
    cursor = matchStart + match[0].length;
    yield { matched: true, start: matchStart, end: cursor };
  }
  if (cursor < end) yield { matched: false, start: cursor, end };
}

/** HTML comments outside fenced blocks and inline code spans, in order. */
function commentRanges(text: string): Range[] {
  const ranges: Range[] = [];
  for (const block of splitAround(text, 0, text.length, FENCED_CODE_BLOCK)) {
    if (block.matched) continue;
    for (const span of splitAround(text, block.start, block.end, INLINE_CODE)) {
      if (span.matched) continue;
      for (const comment of splitAround(text, span.start, span.end, HTML_COMMENT)) {
        if (comment.matched) ranges.push({ start: comment.start, end: comment.end });
      }
    }
  }
  return ranges;
}

/**
 * Every source range `stripHtmlComments` drops, in order: the comments, then
 * each newline beyond the second of a run that remains once they are gone.
 */
function removedRanges(text: string): Range[] {
  const comments = commentRanges(text);
  const removed: Range[] = [];
  const drop = (start: number, end: number) => {
    const last = removed.at(-1);
    if (last && last.end === start) last.end = end;
    else removed.push({ start, end });
  };
  let nextComment = 0;
  let newlines = 0;
  for (let index = 0; index < text.length;) {
    const comment = comments[nextComment];
    if (comment && comment.start === index) {
      drop(comment.start, comment.end);
      index = comment.end;
      nextComment += 1;
      continue;
    }
    if (text.charCodeAt(index) === NEWLINE) {
      newlines += 1;
      if (newlines > 2) drop(index, index + 1);
    } else {
      newlines = 0;
    }
    index += 1;
  }
  return removed;
}

export interface StrippedMarkdown {
  readonly text: string;
  /** The offset in the original text of the character at `offset` in `text`. */
  readonly toSourceOffset: (offset: number) => number;
}

/** `stripHtmlComments`, plus a map from the stripped text back to the original. */
export function stripHtmlCommentsWithSourceMap(text: string): StrippedMarkdown {
  // Kept runs, ascending: where each starts in the stripped text and in the source.
  const strippedStarts: number[] = [];
  const sourceStarts: number[] = [];
  const parts: string[] = [];
  let cursor = 0;
  let length = 0;
  const keep = (end: number) => {
    if (end <= cursor) return;
    strippedStarts.push(length);
    sourceStarts.push(cursor);
    parts.push(text.slice(cursor, end));
    length += end - cursor;
  };
  for (const range of removedRanges(text)) {
    keep(range.start);
    cursor = range.end;
  }
  keep(text.length);

  return {
    text: parts.join(""),
    toSourceOffset: (offset) => {
      // The last run starting at or before `offset`.
      let low = 0;
      let high = strippedStarts.length - 1;
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if ((strippedStarts[middle] ?? 0) <= offset) low = middle;
        else high = middle - 1;
      }
      return (sourceStarts[low] ?? 0) + offset - (strippedStarts[low] ?? 0);
    },
  };
}

export function stripHtmlComments(text: string): string {
  const removed = removedRanges(text);
  if (removed.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const range of removed) {
    out += text.slice(cursor, range.start);
    cursor = range.end;
  }
  return out + text.slice(cursor);
}
