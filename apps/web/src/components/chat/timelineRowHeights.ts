/**
 * Measured timeline row heights that outlive the timeline.
 *
 * The timeline remounts per thread, and its virtual list forgets every
 * measurement with it: reopening a thread laid it out again from estimates,
 * rendered several times as many rows as fit, and converged only after
 * measuring each one. Remembering what rows measured lets a revisited thread
 * lay out from real heights on its first pass. A remembered height is only a
 * starting point: the list still measures each row it renders and corrects any
 * row whose content or expansion changed since.
 *
 * Heights depend on the width rows wrap at, so each one is kept with the list
 * width it was measured at and only reused at that same width.
 */

/** Roughly 40 long threads' worth of rows; each entry is two numbers and a short key. */
export const TIMELINE_ROW_HEIGHT_CACHE_MAX_ENTRIES = 4_000;
const MAX_REMEMBERED_WIDTHS = 64;

interface RememberedHeight {
  readonly height: number;
  readonly width: number;
}

// Insertion-ordered maps double as LRUs: a hit is re-inserted at the end.
const heights = new Map<string, RememberedHeight>();
const widthsByThread = new Map<string, number>();
let heightWrites = 0;
let heightRewrites = 0;

const entryKey = (threadKey: string, rowKey: string) => `${threadKey}\u0000${rowKey}`;

function touch<V>(map: Map<string, V>, key: string, value: V, maxEntries: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size <= maxEntries) return;
  const oldest = map.keys().next();
  if (!oldest.done) map.delete(oldest.value);
}

/** The width a thread's timeline last laid out at, the best guess before it measures again. */
export function readTimelineWidth(threadKey: string): number | undefined {
  return widthsByThread.get(threadKey);
}

export function rememberTimelineWidth(threadKey: string, width: number): void {
  if (!(width > 0)) return;
  touch(widthsByThread, threadKey, Math.round(width), MAX_REMEMBERED_WIDTHS);
}

export function readTimelineRowHeight(
  threadKey: string,
  rowKey: string,
  width: number | undefined,
): number | undefined {
  if (width === undefined) return undefined;
  const key = entryKey(threadKey, rowKey);
  const remembered = heights.get(key);
  if (remembered === undefined || remembered.width !== Math.round(width)) return undefined;
  touch(heights, key, remembered, TIMELINE_ROW_HEIGHT_CACHE_MAX_ENTRIES);
  return remembered.height;
}

export function rememberTimelineRowHeight(
  threadKey: string,
  rowKey: string,
  width: number | undefined,
  height: number,
): void {
  if (width === undefined || !(width > 0) || !(height > 0)) return;
  const key = entryKey(threadKey, rowKey);
  const roundedWidth = Math.round(width);
  heightWrites += 1;
  if (heights.get(key)?.width === roundedWidth) heightRewrites += 1;
  touch(heights, key, { height, width: roundedWidth }, TIMELINE_ROW_HEIGHT_CACHE_MAX_ENTRIES);
}

/**
 * For diagnostics: remembered heights, measurements the list reported as a size
 * change, and those among them for a row whose height was already remembered at
 * that width (a reopened thread whose rows were laid out from memory has none
 * unless a row's content changed).
 */
export function timelineRowHeightStats(): {
  readonly entries: number;
  readonly writes: number;
  readonly rewrites: number;
} {
  return { entries: heights.size, writes: heightWrites, rewrites: heightRewrites };
}

export function resetTimelineRowHeightsForTests(): void {
  heights.clear();
  widthsByThread.clear();
  heightWrites = 0;
  heightRewrites = 0;
}
