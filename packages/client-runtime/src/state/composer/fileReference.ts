import { normalizeWorkspaceRelativePath, workspaceFileBasename } from "../files/paths.ts";
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

const FILE_CONTEXT_OPEN_TAG = "<file_context>";
const FILE_CONTEXT_CLOSE_TAG = "</file_context>";
const TRUNCATION_MARKER = "… (truncated)";
const SIDE_LABEL: Record<FileReferenceSide, string> = {
  old: "old version",
  new: "new version",
};
const ENTRY_HEADER_PATTERN =
  /^- (.+) (?:line (\d+)|lines (\d+)-(\d+))(?: \((old|new) version\))?:$/u;
const COMMENT_LINE_PATTERN = /^ {2}comment:(?: (.*))?$/u;
const SNIPPET_LINE_PATTERN = /^ {2}(\d+) \|(?: (.*))?$/u;
const OPEN_TAG_LINE_PATTERN = /(?:^|\n)<file_context>\n/gu;

function splitLines(text: string): string[] {
  return text.replace(/\r\n?/gu, "\n").split("\n");
}

/**
 * Control characters, and the line and paragraph separators some readers
 * treat as line breaks: in a path, any of them could fake a block boundary.
 */
function hasBreakingCharacter(path: string): boolean {
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

function normalizeReferencePath(path: string): string | null {
  if (hasBreakingCharacter(path)) return null;
  return normalizeWorkspaceRelativePath(path.trim());
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
  const normalized = splitLines(comment).join("\n").trim();
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
 */
export function createFileReference(input: FileReferenceInput): FileReference | null {
  const path = normalizeReferencePath(input.path);
  const first = normalizeLineNumber(input.lineStart);
  const last = normalizeLineNumber(input.lineEnd);
  if (path === null || first === null || last === null) return null;
  const lineStart = Math.min(first, last);
  const lineEnd = Math.max(first, last);
  const { snippet, truncated } = boundSnippet(
    input.lines.length > 0 ? splitLines(input.lines.join("\n")) : [],
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

function buildEntryLines(reference: FileReference): string[] {
  const lines = [`- ${formatFileReferenceTitle(reference)}:`];
  if (reference.comment) {
    for (const line of splitLines(reference.comment)) {
      lines.push(line.length > 0 ? `  comment: ${line}` : "  comment:");
    }
  }
  if (reference.snippet.length > 0 || !reference.truncated) {
    splitLines(reference.snippet).forEach((line, index) => {
      lines.push(`  ${reference.lineStart + index} | ${line}`);
    });
  }
  if (reference.truncated) lines.push(`  ${TRUNCATION_MARKER}`);
  return lines;
}

/**
 * The `<file_context>` block a prompt carries its references in, or "" for
 * none. Every line inside it is indented and every excerpt line numbered, so
 * file contents, paths and comments cannot fake an entry or close the block.
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

/**
 * The prompt with its references appended as one block, in the ordinary text
 * payload, so every provider, queue and retry sees the same context. Append
 * before `appendTerminalContextsToPrompt`, whose block has to stay last.
 */
export function appendFileReferencesToPrompt(
  prompt: string,
  references: ReadonlyArray<FileReference>,
): string {
  const text = prompt.replace(/\s+$/u, "");
  const block = buildFileReferenceBlock(references);
  if (block.length === 0) return text;
  return text.length > 0 ? `${text}\n\n${block}` : block;
}

export interface ExtractedFileReferences {
  readonly promptText: string;
  readonly references: ReadonlyArray<FileReference>;
}

function parseEntry(lines: ReadonlyArray<string>): FileReference | null {
  const header = ENTRY_HEADER_PATTERN.exec(lines[0] ?? "");
  if (!header) return null;
  const path = header[1]!;
  const lineStart = Number(header[2] ?? header[3]);
  const lineEnd = Number(header[2] ?? header[4]);
  const side = header[5] as FileReferenceSide | undefined;
  if (lineEnd < lineStart) return null;
  const comment: string[] = [];
  const snippet: string[] = [];
  let truncated = false;
  for (const line of lines.slice(1)) {
    if (truncated) return null;
    const commentLine = snippet.length === 0 ? COMMENT_LINE_PATTERN.exec(line) : null;
    if (commentLine) {
      comment.push(commentLine[1] ?? "");
      continue;
    }
    const snippetLine = SNIPPET_LINE_PATTERN.exec(line);
    if (snippetLine) {
      if (Number(snippetLine[1]) !== lineStart + snippet.length) return null;
      snippet.push(snippetLine[2] ?? "");
      continue;
    }
    if (line === `  ${TRUNCATION_MARKER}`) {
      truncated = true;
      continue;
    }
    return null;
  }
  if (snippet.length > lineEnd - lineStart + 1 || (snippet.length === 0 && !truncated)) {
    return null;
  }
  const reference = createFileReference({
    path,
    lineStart,
    lineEnd,
    side,
    lines: snippet,
    comment: comment.length > 0 ? comment.join("\n") : undefined,
  });
  // Only the canonical form round-trips: anything else was not written by us.
  if (!reference || reference.path !== path) return null;
  return truncated && !reference.truncated ? { ...reference, truncated } : reference;
}

/**
 * Reads a trailing `<file_context>` block back into references, so a sent or
 * restored prompt can show them as chips again. All or nothing: a block that
 * does not parse exactly (typed by hand, say) stays part of the text. Read it
 * from the text `extractTrailingTerminalContexts` leaves.
 */
export function extractTrailingFileReferences(prompt: string): ExtractedFileReferences {
  const none = { promptText: prompt, references: [] };
  const text = prompt.replace(/\s+$/u, "");
  if (!text.endsWith(`\n${FILE_CONTEXT_CLOSE_TAG}`)) return none;
  // Entry lines are always indented, so the last opening tag at a line start
  // is the block's own.
  let open: { readonly index: number; readonly length: number } | null = null;
  for (const match of text.matchAll(OPEN_TAG_LINE_PATTERN)) {
    open = { index: match.index, length: match[0].length };
  }
  if (!open) return none;
  const body = text.slice(
    open.index + open.length,
    text.length - FILE_CONTEXT_CLOSE_TAG.length - 1,
  );
  // Entries are separated by one blank line; no entry line is ever blank.
  const entries: string[][] = [[]];
  for (const line of body.split("\n")) {
    const current = entries.at(-1)!;
    if (line.length > 0) current.push(line);
    else if (current.length > 0) entries.push([]);
    else return none;
  }
  const references: FileReference[] = [];
  for (const entry of entries) {
    const reference = parseEntry(entry);
    if (!reference) return none;
    references.push(reference);
  }
  return {
    promptText: text.slice(0, open.index).replace(/\n+$/u, ""),
    references,
  };
}
