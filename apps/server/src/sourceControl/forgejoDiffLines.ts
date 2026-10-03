import type { ChangeRequestDiffSide } from "@ryco/contracts";

/**
 * Line bookkeeping for Forgejo review comments.
 *
 * Forgejo's review comment API reports `position` / `original_position`
 * (the new- or old-side line) in the coordinates of the commit the comment
 * was blamed to, which is neither the current head nor stable across
 * versions. Its `diff_hunk`, however, is always the excerpt of the change
 * request's diff (merge base to the head the comment was written on) cut so
 * that its last line is the commented line. These helpers read the anchor
 * from that excerpt and check it against the current diff, so a thread is
 * placed on a line only when that line still reads the same.
 */

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u;

export interface ForgejoDiffLine {
  readonly line: number;
  /** The line's text without its `+`/`-`/` ` marker. */
  readonly text: string;
}

/**
 * The commented line of a review comment's `diff_hunk` on `side`: the last
 * line of the excerpt, with its number on that side. Null when the hunk is
 * missing or malformed, or when its last line does not exist on `side`
 * (an added line has no base-side number, a deleted line no head-side one).
 */
export function lastForgejoDiffHunkLine(
  diffHunk: string | null | undefined,
  side: ChangeRequestDiffSide,
): ForgejoDiffLine | null {
  if (!diffHunk) return null;
  const lines = diffHunk.replace(/\r\n/gu, "\n").split("\n");
  const header = HUNK_HEADER.exec(lines[0] ?? "");
  if (!header) return null;
  let oldLine = Number(header[1]);
  let newLine = Number(header[3]);
  let oldRemaining = header[2] === undefined ? 1 : Number(header[2]);
  let newRemaining = header[4] === undefined ? 1 : Number(header[4]);
  let last: {
    readonly kind: "+" | "-" | " ";
    readonly oldLine: number;
    readonly newLine: number;
    readonly text: string;
  } | null = null;
  for (const raw of lines.slice(1)) {
    if (oldRemaining <= 0 && newRemaining <= 0) break;
    const marker = raw[0];
    if (marker === "+") {
      last = { kind: "+", oldLine, newLine, text: raw.slice(1) };
      newLine += 1;
      newRemaining -= 1;
    } else if (marker === "-") {
      last = { kind: "-", oldLine, newLine, text: raw.slice(1) };
      oldLine += 1;
      oldRemaining -= 1;
    } else if (marker === " " || raw.length === 0) {
      // A context line; some tools strip the space of an empty one.
      last = { kind: " ", oldLine, newLine, text: raw.slice(1) };
      oldLine += 1;
      newLine += 1;
      oldRemaining -= 1;
      newRemaining -= 1;
    }
    // `\ No newline at end of file` carries no line.
  }
  if (!last) return null;
  if (side === "right") {
    return last.kind === "-" || last.newLine < 1 ? null : { line: last.newLine, text: last.text };
  }
  return last.kind === "+" || last.oldLine < 1 ? null : { line: last.oldLine, text: last.text };
}

/** Per path, the text of every line the diff shows, by side and line number. */
export interface ForgejoDiffLineIndex {
  readonly lineText: (path: string, side: ChangeRequestDiffSide, line: number) => string | null;
}

interface FileLines {
  readonly left: Map<number, string>;
  readonly right: Map<number, string>;
}

function diffPath(raw: string): string | null {
  let value = raw.trim();
  if (value === "/dev/null") return null;
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    value = value.slice(1, -1).replace(/\\(["\\])/gu, "$1");
  }
  return value.replace(/^[ab]\//u, "");
}

/** Index a unified diff (`git diff` output, as Forgejo's `.diff` endpoints return it). */
export function indexForgejoDiffLines(diff: string): ForgejoDiffLineIndex {
  const files = new Map<string, FileLines>();
  let oldPath: string | null = null;
  let current: FileLines | null = null;
  let oldLine = 0;
  let newLine = 0;
  // Lines the current hunk still owes per side (from its header counts).
  let oldRemaining = 0;
  let newRemaining = 0;

  for (const raw of diff.replace(/\r\n/gu, "\n").split("\n")) {
    if (raw.startsWith("diff --git ")) {
      // A new file always ends the previous one, even after a miscounted hunk.
      current = null;
      oldPath = null;
      oldRemaining = 0;
      newRemaining = 0;
      continue;
    }
    const inHunk = current !== null && (oldRemaining > 0 || newRemaining > 0);
    if (!inHunk) {
      if (raw.startsWith("--- ")) {
        oldPath = diffPath(raw.slice(4));
      } else if (raw.startsWith("+++ ")) {
        const path = diffPath(raw.slice(4)) ?? oldPath;
        current = path ? (files.get(path) ?? { left: new Map(), right: new Map() }) : null;
        if (path && current) files.set(path, current);
      } else {
        const header = HUNK_HEADER.exec(raw);
        if (header && current) {
          oldLine = Number(header[1]);
          oldRemaining = header[2] === undefined ? 1 : Number(header[2]);
          newLine = Number(header[3]);
          newRemaining = header[4] === undefined ? 1 : Number(header[4]);
        }
      }
      continue;
    }
    if (!current) continue;
    const marker = raw[0];
    if (marker === "+") {
      current.right.set(newLine, raw.slice(1));
      newLine += 1;
      newRemaining -= 1;
    } else if (marker === "-") {
      current.left.set(oldLine, raw.slice(1));
      oldLine += 1;
      oldRemaining -= 1;
    } else if (marker === " " || raw.length === 0) {
      // A context line; some tools strip the space of an empty one.
      const text = raw.slice(1);
      current.left.set(oldLine, text);
      current.right.set(newLine, text);
      oldLine += 1;
      newLine += 1;
      oldRemaining -= 1;
      newRemaining -= 1;
    }
    // `\ No newline at end of file` carries no line.
  }

  return {
    lineText: (path, side, line) => {
      const file = files.get(path);
      if (!file) return null;
      return (side === "left" ? file.left : file.right).get(line) ?? null;
    },
  };
}
