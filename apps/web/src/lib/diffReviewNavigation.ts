import type { FileDiffMetadata } from "@pierre/diffs";
import type { DiffAnnotationSide } from "@ryco/client-runtime/state/pull-request-review";

/**
 * Pure helpers of the diff panel's review tools: the hunk list that previous/next hunk,
 * Alt+Up/Down and the scrollbar markers step through, the patch totals, and collapse-all.
 * The panel reads the DOM; everything here is layout-free.
 */

export type DiffHunkKind = "added" | "removed" | "modified";

export interface DiffHunkAnchor {
  /** `data-diff-file-index` of the file's section. */
  readonly fileIndex: number;
  readonly hunkIndex: number;
  /** The hunk's first changed row: its deleted lines come first, else its first added line. */
  readonly side: DiffAnnotationSide;
  readonly line: number;
  readonly kind: DiffHunkKind;
  /** Where the hunk starts among the file's rows (0 to 1), for scrollbar markers. */
  readonly offset: number;
}

type HunkSource = Pick<FileDiffMetadata, "hunks" | "unifiedLineCount" | "splitLineCount">;

/** Every hunk of the listed files, in reading order. Folded files are skipped. */
export function buildDiffHunkAnchors(
  files: ReadonlyArray<{ readonly fileIndex: number; readonly fileDiff: HunkSource }>,
  diffStyle: "unified" | "split",
  isFolded: (fileIndex: number) => boolean = () => false,
): DiffHunkAnchor[] {
  const anchors: DiffHunkAnchor[] = [];
  for (const { fileIndex, fileDiff } of files) {
    if (isFolded(fileIndex)) continue;
    const rows = diffStyle === "split" ? fileDiff.splitLineCount : fileDiff.unifiedLineCount;
    fileDiff.hunks.forEach((hunk, hunkIndex) => {
      const change = hunk.hunkContent.find((block) => block.type === "change");
      if (!change || change.type !== "change") return;
      const removes = change.deletions > 0;
      const start = diffStyle === "split" ? hunk.splitLineStart : hunk.unifiedLineStart;
      anchors.push({
        fileIndex,
        hunkIndex,
        side: removes ? "deletions" : "additions",
        line: removes
          ? hunk.deletionStart + (change.deletionLineIndex - hunk.deletionLineIndex)
          : hunk.additionStart + (change.additionLineIndex - hunk.additionLineIndex),
        kind:
          hunk.additionLines > 0 && hunk.deletionLines > 0
            ? "modified"
            : hunk.additionLines > 0
              ? "added"
              : "removed",
        offset: rows > 0 ? Math.min(1, Math.max(0, start / rows)) : 0,
      });
    });
  }
  return anchors;
}

/**
 * The hunk previous/next hunk reveals. `isBelow(index)` says whether a hunk starts below the
 * reading line; hunks are in document order, so it is false and then true. The current hunk is
 * the last one at or above the line, so next is the first below it and previous the one before
 * the current (like previous/next changed file). `cursor` is the hunk the last jump revealed,
 * while the reader has not scrolled since: stepping from it never stalls on the last screen of
 * the diff, whose hunks cannot scroll up to the reading line.
 */
export function adjacentDiffHunkIndex(input: {
  readonly count: number;
  readonly direction: 1 | -1;
  readonly cursor: number | null;
  readonly isBelow: (index: number) => boolean;
}): number | null {
  const { count, direction, cursor } = input;
  if (count === 0) return null;
  const from =
    cursor !== null && cursor >= 0 && cursor < count
      ? cursor
      : firstBelow(count, input.isBelow) - 1;
  const target = direction === 1 ? from + 1 : from - 1;
  return target >= 0 && target < count ? target : null;
}

/** The first index whose hunk starts below the reading line, in logarithmic layout reads. */
export function firstBelow(count: number, isBelow: (index: number) => boolean): number {
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (isBelow(middle)) high = middle;
    else low = middle + 1;
  }
  return low;
}

export const DIFF_CHANGE_MARKER_HEIGHT_PX = 3;

export interface DiffChangeMarker {
  /** The first hunk the marker stands for. */
  readonly index: number;
  readonly kind: DiffHunkKind;
  readonly top: number;
}

/**
 * Scrollbar markers: each hunk's place in the scrolled content, scaled to the track. Hunks
 * that would overlap share the first one's marker, so a long diff never draws thousands.
 * `contentTop(index)` is the hunk's offset in the content, null when its file is not laid out.
 */
export function layoutDiffChangeMarkers(input: {
  readonly anchors: ReadonlyArray<Pick<DiffHunkAnchor, "kind">>;
  readonly contentTop: (index: number) => number | null;
  readonly scrollHeight: number;
  readonly trackHeight: number;
}): DiffChangeMarker[] {
  const { scrollHeight, trackHeight } = input;
  if (scrollHeight <= 0 || trackHeight <= 0) return [];
  const maxTop = Math.max(0, trackHeight - DIFF_CHANGE_MARKER_HEIGHT_PX);
  const markers: DiffChangeMarker[] = [];
  input.anchors.forEach((anchor, index) => {
    const offset = input.contentTop(index);
    if (offset === null) return;
    const top = Math.min(maxTop, Math.max(0, (offset / scrollHeight) * trackHeight));
    const previous = markers.at(-1);
    if (previous && top - previous.top < DIFF_CHANGE_MARKER_HEIGHT_PX) return;
    markers.push({ index, kind: anchor.kind, top });
  });
  return markers;
}

/** The patch's file count and line totals (not the working tree's status totals). */
export function diffPatchTotals(files: ReadonlyArray<Pick<FileDiffMetadata, "hunks">>): {
  readonly files: number;
  readonly additions: number;
  readonly deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      additions += hunk.additionLines;
      deletions += hunk.deletionLines;
    }
  }
  return { files: files.length, additions, deletions };
}

export function areAllDiffFilesCollapsed(
  fileKeys: ReadonlyArray<string>,
  collapsedFileKeys: ReadonlySet<string>,
): boolean {
  return fileKeys.length > 0 && fileKeys.every((fileKey) => collapsedFileKeys.has(fileKey));
}

/** Collapse every listed file, or expand them all when every one is already collapsed. */
export function toggleAllDiffFiles(
  fileKeys: ReadonlyArray<string>,
  collapsedFileKeys: ReadonlySet<string>,
): ReadonlySet<string> {
  if (areAllDiffFilesCollapsed(fileKeys, collapsedFileKeys)) {
    const next = new Set(collapsedFileKeys);
    for (const fileKey of fileKeys) next.delete(fileKey);
    return next;
  }
  return new Set([...collapsedFileKeys, ...fileKeys]);
}
