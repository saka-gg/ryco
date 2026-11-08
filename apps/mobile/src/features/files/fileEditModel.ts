import type {
  ProjectContentMatchRange,
  ProjectReadFileResult,
  ProjectWriteFileInput,
} from "@ryco/contracts";

/**
 * The phone's minimal editor and find-in-files, without React: which files it
 * edits, what a failed save means, and how a search match's preview splits
 * into plain and highlighted runs.
 */

/**
 * Longest file the phone edits. A native multiline text field re-lays out the
 * whole document per keystroke, so past this a phone stutters; such files stay
 * read-only here and the desktop edits them.
 */
export const FILE_EDIT_MAX_CHARACTERS = 200_000;

/** Why `file` cannot be edited on the phone, or null when it can. */
export function fileEditProblem(
  file: Pick<ProjectReadFileResult, "contents"> | null,
): string | null {
  if (!file) return "The file has not been read yet.";
  if (file.contents.length > FILE_EDIT_MAX_CHARACTERS)
    return "This file is too large to edit on the phone. Open it on the desktop to edit it.";
  if (file.contents.includes("\0")) return "This file is not text.";
  return null;
}

/**
 * What the editor was opened from: the text it started with and the version,
 * encoding and line ending of that read. A save is judged against this
 * version, never a later re-read's, so a change made on the machine after the
 * editor opened is reported as a conflict instead of being overwritten.
 */
export interface FileEditBase {
  readonly contents: string;
  readonly version: string;
  readonly encoding: ProjectReadFileResult["encoding"];
  readonly lineEnding: ProjectReadFileResult["lineEnding"];
}

export function fileEditBase(read: ProjectReadFileResult): FileEditBase {
  return {
    contents: read.contents,
    version: read.version,
    encoding: read.encoding,
    lineEnding: read.lineEnding,
  };
}

/** The write a save sends, guarded by the version the editor was opened from. */
export function fileWriteInput(input: {
  readonly cwd: string;
  readonly relativePath: string;
  readonly contents: string;
  readonly base: FileEditBase;
}): ProjectWriteFileInput {
  return {
    cwd: input.cwd,
    relativePath: input.relativePath,
    contents: input.contents,
    expectedVersion: input.base.version,
    encoding: input.base.encoding,
    lineEnding: input.base.lineEnding,
  };
}

/** The machine's copy changed since the editor opened (a later read has another version). */
export function fileChangedSinceOpened(
  base: Pick<FileEditBase, "version"> | null,
  latest: Pick<ProjectReadFileResult, "version"> | null,
): boolean {
  return base !== null && latest !== null && latest.version !== base.version;
}

export interface FileEditState {
  readonly dirty: boolean;
  readonly lineCount: number;
}

export function fileEditState(original: string, draft: string): FileEditState {
  // A final newline ends the last line rather than starting another.
  const counted = draft.endsWith("\n") ? draft.slice(0, -1) : draft;
  let lines = 1;
  for (let index = 0; index < counted.length; index += 1) if (counted[index] === "\n") lines += 1;
  return { dirty: original !== draft, lineCount: lines };
}

function errorReason(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const reason = (error as { readonly reason?: unknown }).reason;
  return typeof reason === "string" ? reason : null;
}

/** What a failed `projects.writeFile` tells the person editing. */
export function fileSaveFailureMessage(error: unknown): string {
  switch (errorReason(error)) {
    case "conflict":
      return "The file changed on the machine since you opened it. Copy your edits, reload, and apply them again.";
    case "deleted":
      return "The file was deleted on the machine.";
    case "unsupported":
      return "This file cannot be written from the phone.";
    default:
      return error instanceof Error && error.message.trim().length > 0
        ? error.message
        : "The file could not be saved.";
  }
}

export interface PreviewRun {
  readonly text: string;
  readonly match: boolean;
}

/**
 * A match preview split at its highlighted ranges. Ranges are UTF-16 offsets;
 * overlapping, out-of-order or out-of-bounds ones are clamped and merged so a
 * malformed answer never drops or repeats text.
 */
export function previewRuns(
  preview: string,
  ranges: ReadonlyArray<ProjectContentMatchRange>,
): PreviewRun[] {
  const sorted = ranges
    .map((range) => ({
      start: Math.max(0, Math.min(range.start, preview.length)),
      end: Math.max(0, Math.min(range.end, preview.length)),
    }))
    .filter((range) => range.end > range.start)
    .toSorted((left, right) => left.start - right.start);
  const runs: PreviewRun[] = [];
  let cursor = 0;
  for (const range of sorted) {
    const start = Math.max(range.start, cursor);
    if (range.end <= start) continue;
    if (start > cursor) runs.push({ text: preview.slice(cursor, start), match: false });
    runs.push({ text: preview.slice(start, range.end), match: true });
    cursor = range.end;
  }
  if (cursor < preview.length) runs.push({ text: preview.slice(cursor), match: false });
  return runs;
}
