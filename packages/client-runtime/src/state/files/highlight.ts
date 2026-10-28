/** A half-open `[start, end)` range of UTF-16 offsets. */
export interface TextRange {
  readonly start: number;
  readonly end: number;
}

export interface HighlightSegment {
  readonly text: string;
  readonly highlighted: boolean;
}

/**
 * Splits `text` into plain and highlighted runs. `ranges` index a longer string
 * that `text` starts at `offset` in (0: `text` itself), so one set of ranges
 * over a path highlights its name and its parent separately. Ranges are
 * clamped to `text`, sorted and merged, so a malformed node payload never
 * breaks rendering.
 */
export function splitHighlightSegments(
  text: string,
  ranges: ReadonlyArray<TextRange>,
  offset = 0,
): readonly HighlightSegment[] {
  const clamp = (value: number) => Math.min(Math.max(value - offset, 0), text.length);
  const spans = ranges
    .map((range) => ({ start: clamp(range.start), end: clamp(range.end) }))
    // Also drops NaN offsets: every comparison with NaN is false.
    .filter((range) => range.end > range.start)
    .toSorted((left, right) => left.start - right.start);

  const merged: Array<{ start: number; end: number }> = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last !== undefined && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push(span);
  }

  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const { start, end } of merged) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), highlighted: false });
    segments.push({ text: text.slice(start, end), highlighted: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), highlighted: false });
  return segments;
}
