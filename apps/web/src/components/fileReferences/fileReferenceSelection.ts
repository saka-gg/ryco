import type { FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import {
  createFileReference,
  type FileReference,
  type FileReferenceSide,
} from "@ryco/client-runtime/state/composer";
import {
  diffSideToAnnotationSide,
  type DiffAnnotationSide,
} from "@ryco/client-runtime/state/pull-request-review";

import { diffLineText, lineCommentTarget } from "../pullRequests/files/pullRequestFiles.logic";

/**
 * Turning a gutter selection (the `+`, dragged for a range) in a diff or a
 * file view into a file reference for the composer. Diff ranges are
 * normalized by the pull request Files tab's own line targeting.
 */

type DiffLineSource = Pick<
  FileDiffMetadata,
  "hunks" | "isPartial" | "additionLines" | "deletionLines"
>;

/** Lines picked in one file, on one side when it is a diff. */
export interface FileLineSelection {
  readonly path: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly side?: FileReferenceSide;
}

const SIDE_BY_ANNOTATION_SIDE: Record<DiffAnnotationSide, FileReferenceSide> = {
  deletions: "old",
  additions: "new",
};

/**
 * Where `line` of one side sits on the other: the same row of an unchanged
 * stretch, or, inside a change, the other side's first line at that point.
 */
export function mapDiffLineAcrossSides(
  fileDiff: Pick<FileDiffMetadata, "hunks">,
  from: DiffAnnotationSide,
  line: number,
): number {
  const fromDeletions = from === "deletions";
  // Outside hunks both sides advance together, offset by the changes above.
  let offset = 0;
  for (const hunk of fileDiff.hunks) {
    let oldLine = hunk.deletionStart + (hunk.deletionCount === 0 ? 1 : 0);
    let newLine = hunk.additionStart + (hunk.additionCount === 0 ? 1 : 0);
    if (line < (fromDeletions ? oldLine : newLine)) break;
    for (const content of hunk.hunkContent) {
      const source = fromDeletions ? oldLine : newLine;
      const target = fromDeletions ? newLine : oldLine;
      if (content.type === "context") {
        if (line < source + content.lines) return target + (line - source);
        oldLine += content.lines;
        newLine += content.lines;
        continue;
      }
      if (line < source + (fromDeletions ? content.deletions : content.additions)) return target;
      oldLine += content.deletions;
      newLine += content.additions;
    }
    offset = newLine - oldLine;
  }
  return fromDeletions ? line + offset : Math.max(1, line - offset);
}

/**
 * A diff gutter range as lines of one side. A range crossing from removed to
 * added lines (unified view) becomes a range of the new version, the one the
 * agent can open.
 */
export function diffLineSelection(
  fileDiff: Pick<FileDiffMetadata, "hunks">,
  path: string,
  range: SelectedLineRange,
): FileLineSelection {
  const target = lineCommentTarget(path, range);
  const endSide = diffSideToAnnotationSide(target.side);
  const startSide = diffSideToAnnotationSide(target.startSide ?? target.side);
  const startLine = target.startLine ?? target.line;
  if (startSide === endSide) {
    return {
      path,
      lineStart: Math.min(startLine, target.line),
      lineEnd: Math.max(startLine, target.line),
      side: SIDE_BY_ANNOTATION_SIDE[endSide],
    };
  }
  const startOnNew =
    startSide === "additions"
      ? startLine
      : mapDiffLineAcrossSides(fileDiff, "deletions", startLine);
  const endOnNew =
    endSide === "additions"
      ? target.line
      : mapDiffLineAcrossSides(fileDiff, "deletions", target.line);
  return {
    path,
    lineStart: Math.min(startOnNew, endOnNew),
    lineEnd: Math.max(startOnNew, endOnNew),
    side: "new",
  };
}

/**
 * A diff selection with its text. The excerpt stops at the first line the
 * patch does not hold (a collapsed stretch), and the reference says so.
 */
export function diffFileReference(input: {
  readonly fileDiff: DiffLineSource;
  readonly selection: FileLineSelection;
  readonly comment?: string | undefined;
}): FileReference | null {
  const { fileDiff, selection } = input;
  const side = fileLineSelectionSide(selection);
  const lines: string[] = [];
  for (let line = selection.lineStart; line <= selection.lineEnd; line += 1) {
    const text = diffLineText(fileDiff, side, line);
    if (text === null) break;
    lines.push(text);
  }
  return createFileReference({ ...selection, lines, comment: input.comment });
}

/** A file view's gutter range (no sides) as ordered lines. */
export function fileLineSelection(path: string, range: SelectedLineRange): FileLineSelection {
  return {
    path,
    lineStart: Math.max(1, Math.min(range.start, range.end)),
    lineEnd: Math.max(1, range.start, range.end),
  };
}

/** A file view selection with its text, from the contents the view shows. */
export function fileContentsReference(input: {
  readonly contents: string;
  readonly selection: FileLineSelection;
  readonly comment?: string | undefined;
}): FileReference | null {
  const { selection } = input;
  const lines = input.contents
    .split(/\r\n|\r|\n/u)
    .slice(selection.lineStart - 1, selection.lineEnd);
  return createFileReference({ ...selection, lines, comment: input.comment });
}

/** The diff side a selection's lines are numbered on. */
export function fileLineSelectionSide(selection: FileLineSelection): DiffAnnotationSide {
  return selection.side === "old" ? "deletions" : "additions";
}

/** The pierre selection that keeps a picked range highlighted while its note is open. */
export function fileLineSelectionRange(selection: FileLineSelection): SelectedLineRange {
  if (!selection.side) return { start: selection.lineStart, end: selection.lineEnd };
  const side = fileLineSelectionSide(selection);
  return { start: selection.lineStart, end: selection.lineEnd, side, endSide: side };
}
