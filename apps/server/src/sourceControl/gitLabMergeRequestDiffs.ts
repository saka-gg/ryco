import { createHash } from "node:crypto";

import { Result, Schema } from "effect";
import type { ChangeRequestDiffSide, ChangeRequestDraftReviewComment } from "@ryco/contracts";

/**
 * GitLab file diffs (merge request `/diffs`, commit `/diff`) and the line
 * arithmetic GitLab positions need. Pure and side-effect free.
 *
 * Docs:
 * - https://docs.gitlab.com/api/merge_requests/#list-merge-request-diffs
 * - https://docs.gitlab.com/api/commits/#retrieve-commit-diff
 * - https://docs.gitlab.com/api/discussions/#create-a-new-thread-in-the-merge-request-diff
 *   (unchanged lines need both `old_line` and `new_line`; line codes are
 *   `<sha1(path)>_<old>_<new>`)
 */

export const GitLabDiffEntrySchema = Schema.Struct({
  old_path: Schema.String,
  new_path: Schema.String,
  a_mode: Schema.optional(Schema.NullOr(Schema.String)),
  b_mode: Schema.optional(Schema.NullOr(Schema.String)),
  diff: Schema.optional(Schema.NullOr(Schema.String)),
  new_file: Schema.optional(Schema.NullOr(Schema.Boolean)),
  renamed_file: Schema.optional(Schema.NullOr(Schema.Boolean)),
  deleted_file: Schema.optional(Schema.NullOr(Schema.Boolean)),
  collapsed: Schema.optional(Schema.NullOr(Schema.Boolean)),
  too_large: Schema.optional(Schema.NullOr(Schema.Boolean)),
});
export type GitLabDiffEntry = typeof GitLabDiffEntrySchema.Type;

/** GitLab's `DiffFile#file_path`: the new path, or the old one when there is none. */
export function gitLabDiffFilePath(entry: GitLabDiffEntry): string {
  return entry.new_path || entry.old_path;
}

export function findGitLabDiffEntry(
  entries: ReadonlyArray<GitLabDiffEntry>,
  path: string,
): GitLabDiffEntry | undefined {
  return (
    entries.find((entry) => entry.new_path === path) ??
    entries.find((entry) => entry.old_path === path)
  );
}

/**
 * Rebuild a git-style unified diff from GitLab's per-file JSON. GitLab sends
 * only the hunks, so the `diff --git` / mode / rename / `---` `+++` headers are
 * restored here; a file without hunk text (binary, too large, pure rename or
 * mode change) keeps only its extended headers, as `git diff` prints them.
 */
export function buildGitLabUnifiedDiff(entries: ReadonlyArray<GitLabDiffEntry>): string {
  const out: string[] = [];
  for (const entry of entries) {
    const oldPath = entry.old_path || entry.new_path;
    const newPath = entry.new_path || entry.old_path;
    out.push(`diff --git a/${oldPath} b/${newPath}`);
    if (entry.new_file === true) {
      out.push(`new file mode ${entry.b_mode || "100644"}`);
    } else if (entry.deleted_file === true) {
      out.push(`deleted file mode ${entry.a_mode || "100644"}`);
    } else if (entry.a_mode && entry.b_mode && entry.a_mode !== entry.b_mode) {
      out.push(`old mode ${entry.a_mode}`, `new mode ${entry.b_mode}`);
    }
    if (entry.renamed_file === true && oldPath !== newPath) {
      out.push(`rename from ${oldPath}`, `rename to ${newPath}`);
    }
    const body = entry.diff ?? "";
    if (body.trim().length === 0) continue;
    out.push(entry.new_file === true ? "--- /dev/null" : `--- a/${oldPath}`);
    out.push(entry.deleted_file === true ? "+++ /dev/null" : `+++ b/${newPath}`);
    out.push(body.endsWith("\n") ? body.slice(0, -1) : body);
  }
  return out.length === 0 ? "" : `${out.join("\n")}\n`;
}

// ── Hunks ─────────────────────────────────────────────────────────────

export type GitLabDiffLineKind = "context" | "added" | "removed";

/**
 * One hunk line with GitLab's positions (`Gitlab::Diff::Parser`): an added
 * line keeps the old counter it sits at, a removed line the new counter.
 */
export interface GitLabDiffLine {
  readonly kind: GitLabDiffLineKind;
  readonly oldPos: number;
  readonly newPos: number;
  /** Index into the hunk's raw lines (after the header). */
  readonly rawIndex: number;
}

export interface GitLabDiffHunk {
  readonly header: string;
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly rawLines: ReadonlyArray<string>;
  readonly lines: ReadonlyArray<GitLabDiffLine>;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u;

export function parseGitLabDiffHunks(diff: string): ReadonlyArray<GitLabDiffHunk> {
  const hunks: GitLabDiffHunk[] = [];
  const rows = diff.split("\n");
  if (rows.at(-1) === "") rows.pop();
  let current: {
    header: string;
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    rawLines: string[];
    lines: GitLabDiffLine[];
    oldPos: number;
    newPos: number;
  } | null = null;
  const flush = () => {
    if (current) {
      const { oldPos: _oldPos, newPos: _newPos, ...hunk } = current;
      hunks.push(hunk);
    }
  };
  for (const row of rows) {
    const header = HUNK_HEADER.exec(row);
    if (header) {
      flush();
      const oldStart = Number(header[1]);
      const newStart = Number(header[3]);
      current = {
        header: row,
        oldStart,
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart,
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        rawLines: [],
        lines: [],
        oldPos: oldStart,
        newPos: newStart,
      };
      continue;
    }
    if (!current) continue;
    const rawIndex = current.rawLines.length;
    current.rawLines.push(row);
    const marker = row[0];
    if (marker === "\\") continue;
    if (marker === "+") {
      current.lines.push({
        kind: "added",
        oldPos: current.oldPos,
        newPos: current.newPos,
        rawIndex,
      });
      current.newPos += 1;
    } else if (marker === "-") {
      current.lines.push({
        kind: "removed",
        oldPos: current.oldPos,
        newPos: current.newPos,
        rawIndex,
      });
      current.oldPos += 1;
    } else {
      current.lines.push({
        kind: "context",
        oldPos: current.oldPos,
        newPos: current.newPos,
        rawIndex,
      });
      current.oldPos += 1;
      current.newPos += 1;
    }
  }
  flush();
  return hunks;
}

function lineMatches(line: GitLabDiffLine, side: ChangeRequestDiffSide, number: number): boolean {
  return side === "left"
    ? line.kind !== "added" && line.oldPos === number
    : line.kind !== "removed" && line.newPos === number;
}

/** Where a commented line sits, in GitLab's terms. */
export interface GitLabLineAnchor {
  readonly kind: GitLabDiffLineKind;
  /** `position[old_line]`; null for an added line. */
  readonly oldLine: number | null;
  /** `position[new_line]`; null for a removed line. */
  readonly newLine: number | null;
  /** `<sha1(file path)>_<old position>_<new position>`. */
  readonly lineCode: string;
}

export function gitLabLineCode(filePath: string, oldPos: number, newPos: number): string {
  return `${createHash("sha1").update(filePath).digest("hex")}_${oldPos}_${newPos}`;
}

/**
 * Anchor `line` on `side` of a file's diff. Lines inside a hunk take their
 * hunk position; unchanged lines between hunks (expanded context) are
 * shifted by the hunks before them. Null when the line is not in the file.
 */
export function resolveGitLabLineAnchor(
  entry: GitLabDiffEntry,
  side: ChangeRequestDiffSide,
  line: number,
): GitLabLineAnchor | null {
  const filePath = gitLabDiffFilePath(entry);
  const hunks = parseGitLabDiffHunks(entry.diff ?? "");
  let delta = 0;
  for (const hunk of hunks) {
    const start = side === "left" ? hunk.oldStart : hunk.newStart;
    const count = side === "left" ? hunk.oldCount : hunk.newCount;
    // An empty side (`+4,0`) sits after line `start`, so it covers no line.
    const first = count === 0 ? start + 1 : start;
    if (line < first) break;
    if (line < first + count) {
      const found = hunk.lines.find((candidate) => lineMatches(candidate, side, line));
      return found
        ? {
            kind: found.kind,
            oldLine: found.kind === "added" ? null : found.oldPos,
            newLine: found.kind === "removed" ? null : found.newPos,
            lineCode: gitLabLineCode(filePath, found.oldPos, found.newPos),
          }
        : null;
    }
    delta += hunk.newCount - hunk.oldCount;
  }
  // Unchanged line outside every hunk. A new or deleted file has no such lines.
  if (entry.new_file === true || entry.deleted_file === true) return null;
  const oldLine = side === "left" ? line : line - delta;
  const newLine = side === "left" ? line + delta : line;
  if (oldLine < 1 || newLine < 1) return null;
  return {
    kind: "context",
    oldLine,
    newLine,
    lineCode: gitLabLineCode(filePath, oldLine, newLine),
  };
}

/**
 * The hunk excerpt a thread was written against (as GitHub's `diffHunk`):
 * the hunk header and its lines up to and including the commented line.
 */
export function gitLabDiffHunkExcerpt(
  entry: GitLabDiffEntry,
  side: ChangeRequestDiffSide,
  line: number,
): string | null {
  for (const hunk of parseGitLabDiffHunks(entry.diff ?? "")) {
    const found = hunk.lines.find((candidate) => lineMatches(candidate, side, line));
    if (found) return [hunk.header, ...hunk.rawLines.slice(0, found.rawIndex + 1)].join("\n");
  }
  return null;
}

// ── Draft note positions ──────────────────────────────────────────────

export interface GitLabDiffRefs {
  readonly base_sha: string;
  readonly start_sha: string;
  readonly head_sha: string;
}

function rangePoint(anchor: GitLabLineAnchor): Record<string, unknown> {
  return {
    line_code: anchor.lineCode,
    // Docs: "Use `new` for lines added by this commit, otherwise `old`."
    type: anchor.kind === "added" ? "new" : "old",
    ...(anchor.oldLine !== null ? { old_line: anchor.oldLine } : {}),
    ...(anchor.newLine !== null ? { new_line: anchor.newLine } : {}),
  };
}

/**
 * `POST .../draft_notes` body for one review comment, anchored to the diff
 * the reviewer saw (`diffRefs` must be the head they reviewed).
 * Docs: https://docs.gitlab.com/api/draft_notes/#create-a-draft-note
 */
export function buildGitLabDraftNoteBody(input: {
  readonly comment: ChangeRequestDraftReviewComment;
  readonly diffRefs: GitLabDiffRefs;
  readonly entries: ReadonlyArray<GitLabDiffEntry>;
}): Result.Result<Record<string, unknown>, string> {
  const { comment, diffRefs } = input;
  const entry = findGitLabDiffEntry(input.entries, comment.path);
  if (!entry) {
    return Result.fail(`${comment.path} is not part of this merge request's diff.`);
  }
  const shas = {
    base_sha: diffRefs.base_sha,
    start_sha: diffRefs.start_sha,
    head_sha: diffRefs.head_sha,
    old_path: entry.old_path,
    new_path: entry.new_path,
  };
  if (comment.subjectType === "file") {
    return Result.succeed({ note: comment.body, position: { position_type: "file", ...shas } });
  }
  if (comment.line === undefined) {
    return Result.fail(`The line comment on ${comment.path} is missing its line number.`);
  }
  const side = comment.side ?? "right";
  const anchor = resolveGitLabLineAnchor(entry, side, comment.line);
  if (!anchor) {
    return Result.fail(
      `Line ${comment.line} of ${comment.path} is not part of this merge request's diff.`,
    );
  }
  const startSide = comment.startSide ?? side;
  const isRange =
    comment.startLine !== undefined && (comment.startLine !== comment.line || startSide !== side);
  let lineRange: Record<string, unknown> | undefined;
  if (isRange && comment.startLine !== undefined) {
    const start = resolveGitLabLineAnchor(entry, startSide, comment.startLine);
    if (!start) {
      return Result.fail(
        `Line ${comment.startLine} of ${comment.path} is not part of this merge request's diff.`,
      );
    }
    lineRange = { start: rangePoint(start), end: rangePoint(anchor) };
  }
  return Result.succeed({
    note: comment.body,
    position: {
      position_type: "text",
      ...shas,
      ...(anchor.oldLine !== null ? { old_line: anchor.oldLine } : {}),
      ...(anchor.newLine !== null ? { new_line: anchor.newLine } : {}),
      ...(lineRange ? { line_range: lineRange } : {}),
    },
  });
}
