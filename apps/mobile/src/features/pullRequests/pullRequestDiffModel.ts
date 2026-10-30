import {
  buildReviewFileTree,
  LARGE_FILE_CHANGED_LINES,
  orderChangeRequestFiles,
  reviewFileTreePaths,
  type PullRequestFileStatus,
} from "@ryco/client-runtime/state/pull-request-review";
import { gitDiffPaths } from "@ryco/shared/gitDiffPaths";

/**
 * The phone's reading of a pull request's patch: one entry per file (status,
 * stats and its own patch text) in the web's reading order, and, for the one
 * file on screen, its rows with line numbers and the two sides the
 * highlighter colours. Everything here is bounded: the per-file rows are
 * parsed only for the file being read, and a very large file is shown as a
 * plain excerpt instead of being highlighted.
 */

export interface PullRequestPatchFile {
  /** The file's path after the change (its old path when it was deleted). */
  readonly path: string;
  /** The old path of a renamed or moved file. */
  readonly previousPath: string | null;
  readonly status: PullRequestFileStatus;
  readonly binary: boolean;
  readonly additions: number;
  readonly deletions: number;
  /** The file's own patch, from its `diff --git` line through its last hunk. */
  readonly patch: string;
}

export type PullRequestDiffRowKind = "hunk" | "context" | "addition" | "deletion" | "notice";

export interface PullRequestDiffRow {
  readonly kind: PullRequestDiffRowKind;
  /** The line without its `+`/`-`/space prefix; the header for a hunk row. */
  readonly text: string;
  readonly oldLine: number | null;
  readonly newLine: number | null;
}

export interface PullRequestDiffRows {
  readonly rows: ReadonlyArray<PullRequestDiffRow>;
  /** Rows the file's patch has in all; more than `rows.length` when cut off. */
  readonly totalRows: number;
  readonly truncated: boolean;
  /** The longest row text, for the code surface's width. */
  readonly maxLineLength: number;
}

/**
 * How a file is shown. `highlighted`: every row, coloured. `excerpt`: a very
 * large change (past the web's collapse threshold) shows its first rows as
 * plain text and sends the reader to the host for the rest. `binary`: no rows.
 */
export type PullRequestDiffPresentation =
  | { readonly kind: "highlighted" }
  | { readonly kind: "excerpt"; readonly maxRows: number }
  | { readonly kind: "binary" };

/** Rows an excerpt shows: enough to see what the change is, cheap to render. */
export const PULL_REQUEST_DIFF_EXCERPT_ROWS = 400;

const DIFF_GIT_HEADER = /^diff --git /mu;

function segmentStarts(patch: string): number[] {
  const starts: number[] = [];
  const pattern = /^diff --git /gmu;
  for (let match = pattern.exec(patch); match !== null; match = pattern.exec(patch)) {
    starts.push(match.index);
  }
  return starts;
}

/** The `diff --git a/x b/y` remainder, shown as-is when the paths cannot be resolved. */
function rawHeaderPath(segment: string): string {
  const firstLine = segment.slice(
    0,
    segment.indexOf("\n") === -1 ? undefined : segment.indexOf("\n"),
  );
  return firstLine.replace(DIFF_GIT_HEADER, "").trim() || "(unknown file)";
}

function readPatchFile(segment: string): PullRequestPatchFile {
  const paths = gitDiffPaths(segment);
  const hunkStart = segment.search(/^@@ /mu);
  const header = hunkStart === -1 ? segment : segment.slice(0, hunkStart);
  const binary = /^(?:Binary files .* differ|GIT binary patch)$/mu.test(header);
  let additions = 0;
  let deletions = 0;
  if (hunkStart !== -1) {
    for (const line of segment.slice(hunkStart).split("\n")) {
      if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) deletions += 1;
    }
  }
  const previousPath = paths?.prevName ?? null;
  const status: PullRequestFileStatus = /^new file mode /mu.test(header)
    ? "added"
    : /^deleted file mode /mu.test(header)
      ? "deleted"
      : previousPath !== null
        ? "renamed"
        : "modified";
  return {
    path: paths?.name ?? rawHeaderPath(segment),
    previousPath,
    status,
    binary,
    additions,
    deletions,
    patch: segment,
  };
}

/**
 * The patch's files in reading order: `orderChangeRequestFiles` decides what
 * comes first and each directory groups where its first file appears, exactly
 * like the web's Files tab and its tree.
 */
export function splitPullRequestPatch(patch: string): ReadonlyArray<PullRequestPatchFile> {
  const normalized = patch.replace(/\r\n/gu, "\n");
  const starts = segmentStarts(normalized);
  const files = starts.map((start, index) =>
    readPatchFile(normalized.slice(start, starts[index + 1]).replace(/\n+$/u, "")),
  );
  const byPath = new Map<string, PullRequestPatchFile>();
  for (const file of files) if (!byPath.has(file.path)) byPath.set(file.path, file);
  const tree = buildReviewFileTree(
    orderChangeRequestFiles([...byPath.values()]).map((file) => file.path),
  );
  return reviewFileTreePaths(tree).flatMap((path) => byPath.get(path) ?? []);
}

export function describePullRequestDiffPresentation(
  file: Pick<PullRequestPatchFile, "binary" | "additions" | "deletions">,
): PullRequestDiffPresentation {
  if (file.binary) return { kind: "binary" };
  return file.additions + file.deletions > LARGE_FILE_CHANGED_LINES
    ? { kind: "excerpt", maxRows: PULL_REQUEST_DIFF_EXCERPT_ROWS }
    : { kind: "highlighted" };
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;

/**
 * The file's rows, oldest line numbers on the left. Header lines before the
 * first hunk are skipped; `maxRows` cuts the list (the total is still counted).
 */
export function parsePullRequestDiffRows(
  patch: string,
  options?: { readonly maxRows?: number | undefined },
): PullRequestDiffRows {
  const maxRows = options?.maxRows ?? Number.POSITIVE_INFINITY;
  const rows: PullRequestDiffRow[] = [];
  let totalRows = 0;
  let maxLineLength = 0;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  const push = (row: PullRequestDiffRow) => {
    totalRows += 1;
    if (rows.length >= maxRows) return;
    rows.push(row);
    if (row.text.length > maxLineLength) maxLineLength = row.text.length;
  };
  for (const line of patch.split("\n")) {
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      push({ kind: "hunk", text: line, oldLine: null, newLine: null });
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      push({ kind: "addition", text: line.slice(1), oldLine: null, newLine });
      newLine += 1;
    } else if (line.startsWith("-")) {
      push({ kind: "deletion", text: line.slice(1), oldLine, newLine: null });
      oldLine += 1;
    } else if (line.startsWith("\\")) {
      push({ kind: "notice", text: line.slice(1).trim(), oldLine: null, newLine: null });
    } else {
      // A context line; an empty one lost its leading space in transit.
      push({ kind: "context", text: line.slice(line.startsWith(" ") ? 1 : 0), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  return { rows, totalRows, truncated: rows.length < totalRows, maxLineLength };
}

/** Where a row's colours come from: a line of the old side, of the new side, or none. */
export type PullRequestDiffTokenSource = {
  readonly side: "old" | "new";
  readonly index: number;
} | null;

export interface PullRequestDiffSides {
  /** Context and deleted lines in order: the old file's text, as far as the patch shows it. */
  readonly oldLines: ReadonlyArray<string>;
  /** Context and added lines in order. */
  readonly newLines: ReadonlyArray<string>;
  /** Per row, the side line that colours it. */
  readonly sources: ReadonlyArray<PullRequestDiffTokenSource>;
}

/**
 * Splits the rows into the two sides the highlighter reads, so every line is
 * coloured with the grammar state of its own side: a deleted line never
 * continues an added string.
 */
export function pullRequestDiffSides(
  rows: ReadonlyArray<PullRequestDiffRow>,
): PullRequestDiffSides {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const sources: PullRequestDiffTokenSource[] = [];
  for (const row of rows) {
    switch (row.kind) {
      case "addition":
        sources.push({ side: "new", index: newLines.length });
        newLines.push(row.text);
        break;
      case "deletion":
        sources.push({ side: "old", index: oldLines.length });
        oldLines.push(row.text);
        break;
      case "context":
        sources.push({ side: "new", index: newLines.length });
        oldLines.push(row.text);
        newLines.push(row.text);
        break;
      case "hunk":
      case "notice":
        sources.push(null);
        break;
    }
  }
  return { oldLines, newLines, sources };
}

/** The highlighted tokens for one row, or null while (or when) there are none. */
export function pullRequestDiffRowTokens<T>(
  source: PullRequestDiffTokenSource | undefined,
  oldTokens: ReadonlyArray<T> | null,
  newTokens: ReadonlyArray<T> | null,
): T | null {
  if (!source) return null;
  return (source.side === "old" ? oldTokens : newTokens)?.[source.index] ?? null;
}

/** "+12 −3" for a file or the whole change; empty sides are left out. */
export function formatPullRequestDiffStat(additions: number, deletions: number): string {
  const parts: string[] = [];
  if (additions > 0) parts.push(`+${additions}`);
  if (deletions > 0) parts.push(`−${deletions}`);
  return parts.join(" ");
}

export interface PullRequestFileView {
  readonly presentation: PullRequestDiffPresentation;
  readonly rows: PullRequestDiffRows;
  /** The two sides to highlight; null when the file is shown plain (excerpt, binary). */
  readonly sides: PullRequestDiffSides | null;
}

/** Everything the file screen renders for one file, derived once per file. */
export function buildPullRequestFileView(file: PullRequestPatchFile): PullRequestFileView {
  const presentation = describePullRequestDiffPresentation(file);
  const rows = parsePullRequestDiffRows(file.patch, {
    maxRows: presentation.kind === "excerpt" ? presentation.maxRows : undefined,
  });
  return {
    presentation,
    rows,
    sides: presentation.kind === "highlighted" ? pullRequestDiffSides(rows.rows) : null,
  };
}

/** Shiki's font style bits. */
const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;

export interface PullRequestTokenSpan {
  /** The span's character offset in its line: stable when a line is re-tokenized differently. */
  readonly key: number;
  readonly content: string;
  readonly color: string | null;
  readonly italic: boolean;
  readonly bold: boolean;
}

/** One row's highlighted tokens as keyed spans for the code surface. */
export function pullRequestTokenSpans(
  tokens: ReadonlyArray<{
    readonly content: string;
    readonly color: string | null;
    readonly fontStyle: number | null;
  }>,
): ReadonlyArray<PullRequestTokenSpan> {
  const spans: PullRequestTokenSpan[] = [];
  let offset = 0;
  for (const token of tokens) {
    const style = token.fontStyle ?? 0;
    spans.push({
      key: offset,
      content: token.content,
      color: token.color,
      italic: (style & FONT_STYLE_ITALIC) !== 0,
      bold: (style & FONT_STYLE_BOLD) !== 0,
    });
    offset += token.content.length;
  }
  return spans;
}

/** The `+`/`−`/space marker a row shows before its text. */
export function pullRequestDiffRowMarker(kind: PullRequestDiffRowKind): string {
  switch (kind) {
    case "addition":
      return "+";
    case "deletion":
      return "−";
    default:
      return " ";
  }
}
