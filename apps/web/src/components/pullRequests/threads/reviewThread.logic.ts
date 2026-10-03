import type { ChangeRequestReviewThread } from "@ryco/contracts";

/**
 * Pure helpers for review threads: splitting a comment into prose and host
 * suggestion blocks, the lines a suggestion replaces, the short `diffHunk`
 * excerpt shown above a thread outside the diff, and a one-line snippet for
 * collapsed (resolved) threads.
 */

export type ReviewCommentSegment =
  | { readonly kind: "markdown"; readonly text: string }
  | { readonly kind: "suggestion"; readonly lines: ReadonlyArray<string> };

const SUGGESTION_FENCE = /^(`{3,}|~{3,})\s*suggestion\s*$/u;

/**
 * A comment body as prose and ` ```suggestion ` blocks, in order. An
 * unterminated block runs to the end of the body, as the host renders it.
 */
export function splitSuggestionBlocks(body: string): ReadonlyArray<ReviewCommentSegment> {
  const lines = body.split(/\r?\n/u);
  const segments: ReviewCommentSegment[] = [];
  let prose: string[] = [];
  const flushProse = () => {
    const text = prose.join("\n");
    if (text.trim().length > 0) segments.push({ kind: "markdown", text });
    prose = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const open = SUGGESTION_FENCE.exec(line.trim());
    if (!open) {
      prose.push(line);
      continue;
    }
    const fence = open[1] ?? "```";
    const suggestion: string[] = [];
    index += 1;
    while (index < lines.length && (lines[index] ?? "").trim() !== fence) {
      suggestion.push(lines[index] ?? "");
      index += 1;
    }
    flushProse();
    segments.push({ kind: "suggestion", lines: suggestion });
  }
  flushProse();
  return segments;
}

export function hasSuggestion(body: string): boolean {
  return splitSuggestionBlocks(body).some((segment) => segment.kind === "suggestion");
}

export interface DiffHunkLine {
  readonly kind: "add" | "del" | "ctx";
  readonly text: string;
}

/** Hunk body lines (the `@@` header and "\ No newline" markers dropped). */
export function parseDiffHunk(diffHunk: string | undefined): ReadonlyArray<DiffHunkLine> {
  if (!diffHunk) return [];
  const lines: DiffHunkLine[] = [];
  for (const raw of diffHunk.split(/\r?\n/u)) {
    if (raw.startsWith("@@") || raw.startsWith("\\")) continue;
    const sign = raw.charAt(0);
    const text = raw.slice(1);
    if (sign === "+") lines.push({ kind: "add", text });
    else if (sign === "-") lines.push({ kind: "del", text });
    else lines.push({ kind: "ctx", text: sign === " " ? text : raw });
  }
  return lines;
}

/** The last `max` lines of the hunk, ending at the commented line (the host's convention). */
export function diffHunkExcerpt(
  diffHunk: string | undefined,
  max = 4,
): ReadonlyArray<DiffHunkLine> {
  const lines = parseDiffHunk(diffHunk);
  return lines.slice(Math.max(0, lines.length - max));
}

/**
 * The head-side lines a suggestion on this thread replaces: the commented
 * range read back from the end of its `diffHunk`. Null when it cannot be
 * recovered (no hunk, or a comment on deleted lines).
 */
export function suggestionBaseLines(
  thread: Pick<
    ChangeRequestReviewThread,
    "diffHunk" | "side" | "line" | "startLine" | "originalLine" | "originalStartLine"
  >,
): ReadonlyArray<string> | null {
  if (thread.side !== "right") return null;
  const head = parseDiffHunk(thread.diffHunk).filter((line) => line.kind !== "del");
  if (head.length === 0) return null;
  const end = thread.line ?? thread.originalLine ?? null;
  const start = thread.startLine ?? thread.originalStartLine ?? end;
  const count = end !== null && start !== null && end >= start ? end - start + 1 : 1;
  return head.slice(Math.max(0, head.length - count)).map((line) => line.text);
}

const MARKDOWN_NOISE =
  /(```[\s\S]*?```|`([^`]*)`|!\[[^\]]*\]\([^)]*\)|\[([^\]]*)\]\([^)]*\)|[*_~>#]+)/gu;

/** One line of plain text for a collapsed thread ("Resolved · mvogt · nit: can the…"). */
export function commentSnippet(body: string, maxLength = 140): string {
  const plain = body
    .replace(
      MARKDOWN_NOISE,
      (_match, _block, code: string | undefined, link: string | undefined) =>
        code !== undefined ? code : link !== undefined ? link : " ",
    )
    .replace(/\s+/gu, " ")
    .trim();
  return plain.length > maxLength ? `${plain.slice(0, maxLength - 1).trimEnd()}…` : plain;
}

/** `path:line` (or `path:12–18`, or just the path for file-level threads). */
export function threadLocationLabel(
  thread: Pick<
    ChangeRequestReviewThread,
    "path" | "subjectType" | "line" | "startLine" | "originalLine" | "originalStartLine"
  >,
): string {
  if (thread.subjectType === "file") return thread.path;
  const end = thread.line ?? thread.originalLine ?? null;
  if (end === null) return thread.path;
  const start = thread.line !== null ? thread.startLine : thread.originalStartLine;
  return start != null && start !== end
    ? `${thread.path}:${start}–${end}`
    : `${thread.path}:${end}`;
}
