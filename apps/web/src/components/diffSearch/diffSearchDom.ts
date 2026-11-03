import {
  doesDiffSearchMatchRenderedLine,
  doesDiffSearchMatchRenderedLineType,
  getDiffSearchMatchRenderedLineIndex,
  isSameDiffSearchMatch,
  parseDiffRenderedLineIndexes,
  type DiffSearchMatch,
  type DiffSearchReadingPosition,
  type DiffSearchRenderMode,
} from "~/lib/diffSearch";

import { waitForDiffFrames } from "../pullRequests/files/diffReveal";

/** Rows this far outside the viewport are painted too, so a short scroll shows highlights at once. */
export const DIFF_SEARCH_HIGHLIGHT_VIEWPORT_MARGIN_PX = 1600;

/** Highlight registry names of one find surface; two mounted surfaces must not share them. */
export function diffSearchHighlightNames(name: string): {
  readonly match: string;
  readonly current: string;
} {
  return { match: `${name}-match`, current: `${name}-current` };
}

/**
 * The highlight rules of a find surface. Pierre renders lines in shadow roots,
 * and a `::highlight()` rule only styles text in its own tree, so this goes
 * into each root through `unsafeCSS`.
 */
export function diffSearchHighlightCss(
  name: string,
  options: { readonly current: boolean } = { current: true },
): string {
  const names = diffSearchHighlightNames(name);
  const match = `
::highlight(${names.match}) {
  background-color: color-mix(in srgb, var(--warning) 60%, transparent);
  color: var(--foreground);
}
`;
  if (!options.current) return match;
  // Dark text on the strong amber in both themes: pierre sets the host's
  // color-scheme from its theme type, which `light-dark()` follows.
  return `${match}
::highlight(${names.current}) {
  background-color: color-mix(in srgb, var(--warning) 95%, transparent);
  color: light-dark(var(--foreground), var(--background));
}
`;
}

/** Whether `element` is within the highlight margin of the viewport's rect (read once per pass). */
export function isNearViewport(
  element: Element,
  viewportRect: DOMRectReadOnly,
  margin = DIFF_SEARCH_HIGHLIGHT_VIEWPORT_MARGIN_PX,
): boolean {
  const elementRect = element.getBoundingClientRect();
  return (
    elementRect.bottom >= viewportRect.top - margin &&
    elementRect.top <= viewportRect.bottom + margin &&
    elementRect.right >= viewportRect.left - margin &&
    elementRect.left <= viewportRect.right + margin
  );
}

interface TextOffset {
  readonly node: Text;
  readonly start: number;
  readonly end: number;
}

function collectDiffLineTextOffsets(lineElement: HTMLElement): {
  readonly textLength: number;
  readonly offsets: readonly TextOffset[];
} {
  const offsets: TextOffset[] = [];
  const walker = document.createTreeWalker(lineElement, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (parent && parent.closest("[data-line-number-content]")) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let current = walker.nextNode();
  let textLength = 0;
  while (current) {
    const textNode = current as Text;
    const nextTextLength = textLength + textNode.data.length;
    offsets.push({ node: textNode, start: textLength, end: nextTextLength });
    textLength = nextTextLength;
    current = walker.nextNode();
  }
  return { offsets, textLength };
}

function findTextOffsetPosition(
  offsets: readonly TextOffset[],
  offset: number,
  edge: "start" | "end",
): { readonly node: Text; readonly offset: number } | null {
  for (const info of offsets) {
    if (offset < info.start || offset > info.end) {
      continue;
    }
    if (offset === info.end && edge === "start") {
      continue;
    }
    return { node: info.node, offset: offset - info.start };
  }
  return null;
}

function createDiffLineSearchRange(
  lineElement: HTMLElement,
  textOffsets: ReturnType<typeof collectDiffLineTextOffsets>,
  match: DiffSearchMatch,
): Range | null {
  const { offsets, textLength } = textOffsets;
  if (
    offsets.length === 0 ||
    match.start < 0 ||
    match.end > textLength ||
    match.start >= match.end
  ) {
    return null;
  }
  const start = findTextOffsetPosition(offsets, match.start, "start");
  const end = findTextOffsetPosition(offsets, match.end, "end");
  if (!start || !end) return null;
  const range = lineElement.ownerDocument.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

/**
 * One file's line matches keyed by the rendered row index of `renderMode`, so
 * a highlight pass looks a row up instead of filtering every match per row.
 */
export function indexMatchesByRenderedLine(
  matches: readonly DiffSearchMatch[],
  renderMode: DiffSearchRenderMode,
): ReadonlyMap<number, readonly DiffSearchMatch[]> {
  const byLine = new Map<number, DiffSearchMatch[]>();
  for (const match of matches) {
    const lineIndex = getDiffSearchMatchRenderedLineIndex(match, renderMode);
    if (lineIndex === null) continue;
    const group = byLine.get(lineIndex);
    if (group) {
      group.push(match);
    } else {
      byLine.set(lineIndex, [match]);
    }
  }
  return byLine;
}

function renderedLineIndexOf(
  lineElement: HTMLElement,
  renderMode: DiffSearchRenderMode,
): number | null {
  const lineIndexes = parseDiffRenderedLineIndexes(lineElement.getAttribute("data-line-index"));
  if (!lineIndexes) return null;
  return renderMode === "split" ? lineIndexes.split : lineIndexes.stacked;
}

function renderedLineElements(fileElement: HTMLElement): HTMLElement[] {
  const lines: HTMLElement[] = [];
  for (const container of fileElement.querySelectorAll<HTMLElement>("diffs-container")) {
    const candidates = container.shadowRoot?.querySelectorAll<HTMLElement>(
      "[data-line][data-line-index]",
    );
    if (candidates) lines.push(...candidates);
  }
  return lines;
}

export function findRenderedDiffLineElement(input: {
  readonly fileElement: HTMLElement;
  readonly match: DiffSearchMatch;
  readonly renderMode: DiffSearchRenderMode;
}): HTMLElement | null {
  if (getDiffSearchMatchRenderedLineIndex(input.match, input.renderMode) === null) {
    return null;
  }
  for (const candidate of renderedLineElements(input.fileElement)) {
    const lineIndexes = parseDiffRenderedLineIndexes(candidate.getAttribute("data-line-index"));
    if (!lineIndexes) continue;
    if (
      doesDiffSearchMatchRenderedLine(input.match, {
        renderMode: input.renderMode,
        lineIndexes,
        lineType: candidate.getAttribute("data-line-type"),
      })
    ) {
      return candidate;
    }
  }
  return null;
}

export interface DiffSearchRanges {
  readonly match: Range[];
  /** The current match's range, when its row is rendered. */
  readonly current: Range[];
}

/**
 * Ranges of the matches on rendered rows near the viewport, the current match
 * apart. File elements carry `data-diff-file-index`; rows are pierre's
 * `[data-line][data-line-index]` inside each file's shadow root.
 */
export function findDiffSearchRanges(input: {
  readonly rootElement: HTMLElement;
  readonly viewportElement: HTMLElement;
  readonly matchesByFileIndex: ReadonlyMap<number, readonly DiffSearchMatch[]>;
  readonly renderMode: DiffSearchRenderMode;
  readonly current: DiffSearchMatch | null;
  /** Row maps per file, kept by the caller while the matches and layout stay the same. */
  readonly lineMaps?: Map<number, ReadonlyMap<number, readonly DiffSearchMatch[]>>;
}): DiffSearchRanges {
  const ranges: DiffSearchRanges = { match: [], current: [] };
  const lineMaps =
    input.lineMaps ?? new Map<number, ReadonlyMap<number, readonly DiffSearchMatch[]>>();
  const viewportRect = input.viewportElement.getBoundingClientRect();
  const fileElements = input.rootElement.querySelectorAll<HTMLElement>("[data-diff-file-index]");
  for (const fileElement of fileElements) {
    if (!isNearViewport(fileElement, viewportRect)) continue;
    const rawFileIndex = fileElement.dataset.diffFileIndex;
    const fileIndex = rawFileIndex ? Number.parseInt(rawFileIndex, 10) : Number.NaN;
    if (!Number.isFinite(fileIndex)) continue;
    const matches = input.matchesByFileIndex.get(fileIndex);
    if (!matches || matches.length === 0) continue;
    let byLine = lineMaps.get(fileIndex);
    if (!byLine) {
      byLine = indexMatchesByRenderedLine(matches, input.renderMode);
      lineMaps.set(fileIndex, byLine);
    }

    for (const lineElement of renderedLineElements(fileElement)) {
      const lineIndex = renderedLineIndexOf(lineElement, input.renderMode);
      if (lineIndex === null) continue;
      const lineMatches = byLine.get(lineIndex);
      if (!lineMatches) continue;
      if (!isNearViewport(lineElement, viewportRect)) continue;
      const lineType = lineElement.getAttribute("data-line-type");
      let textOffsets: ReturnType<typeof collectDiffLineTextOffsets> | null = null;
      for (const match of lineMatches) {
        if (!doesDiffSearchMatchRenderedLineType(match, lineType)) continue;
        textOffsets ??= collectDiffLineTextOffsets(lineElement);
        const range = createDiffLineSearchRange(lineElement, textOffsets, match);
        if (!range) continue;
        const isCurrent = input.current !== null && isSameDiffSearchMatch(match, input.current);
        (isCurrent ? ranges.current : ranges.match).push(range);
      }
    }
  }
  return ranges;
}

/** Whether `node` sits in `root`, also from inside a shadow root (pierre draws rows in one). */
function containsComposed(root: Node, node: Node | null): boolean {
  let current = node;
  while (current) {
    if (root.contains(current)) return true;
    const tree = current.getRootNode();
    current = tree instanceof ShadowRoot ? tree.host : null;
  }
  return false;
}

/**
 * The selected text when it is one line inside `root` (the searched view), else
 * null: the find key seeds its query from it, not from a selection elsewhere.
 */
export function readDiffSearchSeedSelection(root: HTMLElement | null): string | null {
  const selection = document.getSelection();
  if (!root || !selection || selection.rangeCount === 0) return null;
  if (!containsComposed(root, selection.anchorNode) || !containsComposed(root, selection.focusNode))
    return null;
  const text = selection.toString();
  return text.length > 0 && !text.includes("\n") ? text : null;
}

/** First index whose element's bottom edge is below `top` (elements stacked top to bottom). */
function firstIndexBelow(count: number, bottomAt: (index: number) => number, top: number): number {
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (bottomAt(middle) > top) high = middle;
    else low = middle + 1;
  }
  return low;
}

/**
 * The first row of a file at or below `top`: the highest across its columns.
 * The split layout pads a column with rowless buffers opposite the other
 * side's lines, so one column alone can start below rows already on screen.
 */
function firstRowBelow(fileElement: HTMLElement, top: number): HTMLElement | null {
  let first: HTMLElement | null = null;
  let firstTop = Number.POSITIVE_INFINITY;
  for (const container of fileElement.querySelectorAll<HTMLElement>("diffs-container")) {
    for (const column of container.shadowRoot?.querySelectorAll("code") ?? []) {
      const rows = column.querySelectorAll<HTMLElement>("[data-line][data-line-index]");
      if (rows.length === 0) continue;
      const row =
        rows[firstIndexBelow(rows.length, (at) => rows[at]!.getBoundingClientRect().bottom, top)];
      if (!row) continue;
      const rowTop = row.getBoundingClientRect().top;
      if (rowTop < firstTop) {
        first = row;
        firstTop = rowTop;
      }
    }
  }
  return first;
}

/**
 * Where the reader is in a diff surface: the first file whose bottom is below
 * the top of the scroller and, when that file's top is scrolled past, its
 * first row below the file's sticky header. Null without a rendered diff.
 * Read when a search starts, so it can start there (see
 * `firstDiffSearchMatchIndexFrom`).
 */
export function readDiffSearchReadingPosition(
  root: HTMLElement | null,
): DiffSearchReadingPosition | null {
  const scroller = root?.querySelector<HTMLElement>(".diff-render-surface");
  if (!root || !scroller) return null;
  const top = scroller.getBoundingClientRect().top;
  const fileElements = root.querySelectorAll<HTMLElement>("[data-diff-file-index]");
  const fileElement =
    fileElements[
      firstIndexBelow(
        fileElements.length,
        (at) => fileElements[at]!.getBoundingClientRect().bottom,
        top,
      )
    ];
  if (!fileElement) return null;
  const fileIndex = Number.parseInt(fileElement.dataset.diffFileIndex ?? "", 10);
  if (!Number.isFinite(fileIndex)) return null;
  if (fileElement.getBoundingClientRect().top >= top) return { fileIndex, line: null };
  // A sticky file header covers the rows scrolled under it.
  const header = fileElement.querySelector<HTMLElement>(":scope > header");
  const visibleTop = Math.max(top, header?.getBoundingClientRect().bottom ?? top);
  const row = firstRowBelow(fileElement, visibleTop);
  // Every row of it is scrolled past (only its header, threads or margin show): read on from the next file.
  if (!row) return { fileIndex: fileIndex + 1, line: null };
  return { fileIndex, line: parseDiffRenderedLineIndexes(row.getAttribute("data-line-index")) };
}

/** Whether pierre has rendered code rows for a file (a folded or unhighlighted file has none). */
export function hasRenderedDiffRows(fileElement: HTMLElement): boolean {
  for (const container of fileElement.querySelectorAll<HTMLElement>("diffs-container")) {
    if (container.shadowRoot?.querySelector("[data-line]")) return true;
  }
  return false;
}

/**
 * Wait until a file shows code rows: after it is unfolded, pierre renders them
 * once its highlighter answers. Resolves false when the wait is cancelled or
 * runs out; the caller then reveals what it can.
 */
export function waitForRenderedDiffRows(
  fileElement: HTMLElement,
  signal: AbortSignal,
): Promise<boolean> {
  return waitForDiffFrames(() => hasRenderedDiffRows(fileElement), signal);
}
