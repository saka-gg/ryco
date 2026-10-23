import { normalizeWorkspaceRelativePath, workspaceFileBasename } from "../files/relativePath.ts";
import { formatTerminalContextRange } from "./terminalContext.ts";

/**
 * Which version of a changed file the lines belong to (a diff's base or its
 * result). Absent when the lines come from the file as it is now.
 */
export type FileReferenceSide = "old" | "new";

/**
 * Lines of a workspace file handed to the agent: where they are, a bounded
 * excerpt of them, and an optional note. A captured excerpt, not a live view
 * of a file that keeps changing.
 */
export interface FileReference {
  /** Workspace-relative, in the canonical `a/b/c` form. */
  readonly path: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly side?: FileReferenceSide;
  /** The range's first lines, from `lineStart`, within the snippet bounds. */
  readonly snippet: string;
  /** The range holds more than `snippet` shows (a long range, or text that was unavailable). */
  readonly truncated: boolean;
  /** What the user wrote about these lines. */
  readonly comment?: string;
}

export interface FileReferenceInput {
  readonly path: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly side?: FileReferenceSide | undefined;
  /**
   * The range's text in order from `lineStart`. It may stop early (an
   * unloaded stretch of a diff): the reference is then marked truncated.
   */
  readonly lines: ReadonlyArray<string>;
  readonly comment?: string | undefined;
}

export const FILE_REFERENCE_SNIPPET_MAX_LINES = 40;
export const FILE_REFERENCE_SNIPPET_MAX_LENGTH = 4_000;
export const FILE_REFERENCE_COMMENT_MAX_LENGTH = 2_000;
/** How many references one prompt carries; the composer refuses more. */
export const FILE_REFERENCE_PROMPT_MAX_COUNT = 20;

/** The tags around the block a prompt carries its references in. */
export const FILE_CONTEXT_OPEN_TAG = "<file_context>";
export const FILE_CONTEXT_CLOSE_TAG = "</file_context>";
/** Ends an entry whose excerpt does not hold the whole range. */
export const FILE_REFERENCE_TRUNCATION_MARKER = "… (truncated)";
const SIDE_LABEL: Record<FileReferenceSide, string> = {
  old: "old version",
  new: "new version",
};

function splitLines(text: string): string[] {
  return text.replace(/\r\n?/gu, "\n").split("\n");
}

/** C1 controls, NEL (U+0085) among them. */
function isC1Control(code: number): boolean {
  return code >= 0x80 && code <= 0x9f;
}

/**
 * Control characters, and the line and paragraph separators some readers
 * treat as line breaks: in a path, any of them could fake a block boundary.
 */
function hasBreakingCharacter(path: string): boolean {
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || isC1Control(code) || code === 0x2028 || code === 0x2029) {
      return true;
    }
  }
  return false;
}

/**
 * What some readers take for a line break though this block does not: vertical
 * tab, form feed, the information separators, C1 controls and the line and
 * paragraph separators.
 */
function isReaderLineBreak(code: number): boolean {
  return (
    code === 0x0b ||
    code === 0x0c ||
    (code >= 0x1c && code <= 0x1e) ||
    isC1Control(code) ||
    code === 0x2028 ||
    code === 0x2029
  );
}

/**
 * Excerpt and note text with every `isReaderLineBreak` character replaced by
 * U+FFFD, so no reader sees a line of it end early (and, say, close the block).
 */
function neutralizeReaderLineBreaks(text: string): string {
  let result = "";
  let copied = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (!isReaderLineBreak(text.charCodeAt(index))) continue;
    result += `${text.slice(copied, index)}\uFFFD`;
    copied = index + 1;
  }
  return copied === 0 ? text : result + text.slice(copied);
}

function normalizeReferencePath(path: string): string | null {
  if (hasBreakingCharacter(path)) return null;
  return normalizeWorkspaceRelativePath(path.trim());
}

/**
 * The canonical path a reference to `path` would carry, or null when no
 * reference can name it (outside the workspace, too long, or with a
 * character that could break the block). A surface checks it before offering
 * to add lines of the file.
 */
export function normalizeFileReferencePath(path: string): string | null {
  return normalizeReferencePath(path);
}

function normalizeLineNumber(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const line = Math.floor(value);
  return line >= 1 && Number.isSafeInteger(line) ? line : null;
}

/** Cuts at `length`, never between the halves of a surrogate pair. */
function sliceCodeUnits(text: string, length: number): string {
  const cut = text.slice(0, length);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function boundSnippet(
  lines: ReadonlyArray<string>,
  rangeLineCount: number,
): { readonly snippet: string; readonly truncated: boolean } {
  const kept: string[] = [];
  let length = 0;
  for (const line of lines.slice(0, Math.min(rangeLineCount, FILE_REFERENCE_SNIPPET_MAX_LINES))) {
    const room = FILE_REFERENCE_SNIPPET_MAX_LENGTH - length - (kept.length > 0 ? 1 : 0);
    if (line.length > room) {
      if (room > 0) kept.push(sliceCodeUnits(line, room));
      return { snippet: kept.join("\n"), truncated: true };
    }
    kept.push(line);
    length += line.length + (kept.length > 1 ? 1 : 0);
  }
  return { snippet: kept.join("\n"), truncated: kept.length < rangeLineCount };
}

function normalizeComment(comment: string | undefined): string | undefined {
  if (comment === undefined) return undefined;
  const normalized = neutralizeReaderLineBreaks(splitLines(comment).join("\n")).trim();
  if (normalized.length === 0) return undefined;
  return normalized.length > FILE_REFERENCE_COMMENT_MAX_LENGTH
    ? `${sliceCodeUnits(normalized, FILE_REFERENCE_COMMENT_MAX_LENGTH - 1)}…`
    : normalized;
}

/**
 * A reference from what a surface captured, or null when it names no workspace
 * file or no line. The path is canonicalized, the range ordered, the snippet
 * bounded to `FILE_REFERENCE_SNIPPET_MAX_LINES` lines and
 * `FILE_REFERENCE_SNIPPET_MAX_LENGTH` characters, and the comment trimmed.
 * Characters some readers take for a line break become U+FFFD in both.
 */
export function createFileReference(input: FileReferenceInput): FileReference | null {
  const path = normalizeReferencePath(input.path);
  const first = normalizeLineNumber(input.lineStart);
  const last = normalizeLineNumber(input.lineEnd);
  if (path === null || first === null || last === null) return null;
  const lineStart = Math.min(first, last);
  const lineEnd = Math.max(first, last);
  const { snippet, truncated } = boundSnippet(
    input.lines.length > 0 ? splitLines(neutralizeReaderLineBreaks(input.lines.join("\n"))) : [],
    lineEnd - lineStart + 1,
  );
  const comment = normalizeComment(input.comment);
  return {
    path,
    lineStart,
    lineEnd,
    ...(input.side ? { side: input.side } : {}),
    snippet,
    truncated,
    ...(comment ? { comment } : {}),
  };
}

/**
 * A reference read back from storage or another window, re-checked the way
 * `createFileReference` checks a fresh one; null when it does not hold up.
 */
export function decodeFileReference(value: unknown): FileReference | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const side = record.side;
  if (
    typeof record.path !== "string" ||
    typeof record.lineStart !== "number" ||
    typeof record.lineEnd !== "number" ||
    typeof record.snippet !== "string" ||
    (side !== undefined && side !== "old" && side !== "new") ||
    (record.comment !== undefined && typeof record.comment !== "string")
  ) {
    return null;
  }
  const reference = createFileReference({
    path: record.path,
    lineStart: record.lineStart,
    lineEnd: record.lineEnd,
    side,
    // An empty snippet is one blank line, unless nothing of the range was there.
    lines: record.snippet.length > 0 || record.truncated !== true ? [record.snippet] : [],
    comment: record.comment,
  });
  if (!reference) return null;
  // A cut inside the range's last kept line is not visible from the text alone.
  return record.truncated === true && !reference.truncated
    ? { ...reference, truncated: true }
    : reference;
}

/** Identity for de-duplicating references in one prompt. */
export function fileReferenceKey(reference: FileReference): string {
  return JSON.stringify([
    reference.side ?? null,
    reference.path,
    reference.lineStart,
    reference.lineEnd,
  ]);
}

/** A reference waiting in a composer draft, shown there as a chip until it is sent. */
export interface FileReferenceDraft extends FileReference {
  readonly id: string;
  readonly createdAt: string;
}

/**
 * A draft reference read back from storage, re-checked like a fresh one;
 * null when it does not hold up.
 */
export function decodeFileReferenceDraft(value: unknown): FileReferenceDraft | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    record.id.length === 0 ||
    typeof record.createdAt !== "string" ||
    record.createdAt.length === 0
  ) {
    return null;
  }
  const reference = decodeFileReference(record);
  return reference ? { ...reference, id: record.id, createdAt: record.createdAt } : null;
}

/**
 * The references one draft keeps, in order: the first of any repeated id or
 * range, and no more than `FILE_REFERENCE_PROMPT_MAX_COUNT`.
 */
export function normalizeFileReferenceDrafts(
  references: ReadonlyArray<FileReferenceDraft>,
): FileReferenceDraft[] {
  const ids = new Set<string>();
  const keys = new Set<string>();
  const kept: FileReferenceDraft[] = [];
  for (const reference of references) {
    if (kept.length >= FILE_REFERENCE_PROMPT_MAX_COUNT) break;
    const key = fileReferenceKey(reference);
    if (ids.has(reference.id) || keys.has(key)) continue;
    ids.add(reference.id);
    keys.add(key);
    kept.push(reference);
  }
  return kept;
}

/**
 * How adding a reference to a draft went: `updated` when the draft already
 * held those lines (the new excerpt and note replace the old), `full` at
 * `FILE_REFERENCE_PROMPT_MAX_COUNT`.
 */
export type FileReferenceDraftAddOutcome = "added" | "updated" | "full";

/** `references` with `reference` added, or the outcome that kept it out. */
export function addFileReferenceDraft(
  references: ReadonlyArray<FileReferenceDraft>,
  reference: FileReferenceDraft,
): { readonly outcome: FileReferenceDraftAddOutcome; readonly references: FileReferenceDraft[] } {
  const key = fileReferenceKey(reference);
  const index = references.findIndex((entry) => fileReferenceKey(entry) === key);
  if (index >= 0) {
    const next = [...references];
    // The chip keeps its place and identity; what it carries is the latest pick.
    next[index] = { ...reference, id: references[index]!.id };
    return { outcome: "updated", references: next };
  }
  if (references.length >= FILE_REFERENCE_PROMPT_MAX_COUNT) {
    return { outcome: "full", references: [...references] };
  }
  return { outcome: "added", references: [...references, reference] };
}

/** "line 12" / "lines 12-18", the same wording terminal contexts use. */
export function formatFileReferenceRange(reference: {
  readonly lineStart: number;
  readonly lineEnd: number;
}): string {
  return formatTerminalContextRange(reference);
}

/** "src/app.ts lines 12-18 (new version)": the block header, also fit for a tooltip. */
export function formatFileReferenceTitle(
  reference: Pick<FileReference, "path" | "lineStart" | "lineEnd" | "side">,
): string {
  const side = reference.side ? ` (${SIDE_LABEL[reference.side]})` : "";
  return `${reference.path} ${formatFileReferenceRange(reference)}${side}`;
}

/** "app.ts:12-18": a chip's label. */
export function formatFileReferenceLabel(
  reference: Pick<FileReference, "path" | "lineStart" | "lineEnd">,
): string {
  const range =
    reference.lineStart === reference.lineEnd
      ? `${reference.lineStart}`
      : `${reference.lineStart}-${reference.lineEnd}`;
  return `${workspaceFileBasename(reference.path)}:${range}`;
}

/**
 * The excerpt's first `maxLines` lines numbered for a preview (" 9 | code"),
 * the numbers right-aligned so the code keeps one column from 9 to 10, and
 * "…" after them when the preview does not show the whole range.
 */
export function formatFileReferencePreview(
  reference: Pick<FileReference, "lineStart" | "snippet" | "truncated">,
  maxLines: number,
): string[] {
  const lines = reference.snippet.length > 0 ? reference.snippet.split("\n") : [];
  const shown = lines.slice(0, Math.max(0, maxLines));
  const width = String(reference.lineStart + Math.max(0, shown.length - 1)).length;
  const preview = shown.map(
    (line, index) => `${String(reference.lineStart + index).padStart(width)} | ${line}`,
  );
  if (lines.length > shown.length || reference.truncated) preview.push("…");
  return preview;
}

function buildEntryLines(reference: FileReference): string[] {
  const lines = [`- ${formatFileReferenceTitle(reference)}:`];
  if (reference.comment) {
    for (const line of splitLines(neutralizeReaderLineBreaks(reference.comment))) {
      lines.push(line.length > 0 ? `  comment: ${line}` : "  comment:");
    }
  }
  if (reference.snippet.length > 0 || !reference.truncated) {
    splitLines(neutralizeReaderLineBreaks(reference.snippet)).forEach((line, index) => {
      lines.push(`  ${reference.lineStart + index} | ${line}`);
    });
  }
  if (reference.truncated) lines.push(`  ${FILE_REFERENCE_TRUNCATION_MARKER}`);
  return lines;
}

/**
 * The `<file_context>` block a prompt carries its references in, or "" for
 * none. Every line inside it is indented and every excerpt line numbered, so
 * file contents, paths and comments cannot fake an entry or close the block.
 * A prompt takes it through `composeOutgoingPrompt`, which places it.
 */
export function buildFileReferenceBlock(references: ReadonlyArray<FileReference>): string {
  if (references.length === 0) return "";
  const lines: string[] = [];
  references.forEach((reference, index) => {
    if (index > 0) lines.push("");
    lines.push(...buildEntryLines(reference));
  });
  return [FILE_CONTEXT_OPEN_TAG, ...lines, FILE_CONTEXT_CLOSE_TAG].join("\n");
}
