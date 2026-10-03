import type { DiffLineAnnotation, FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import type { ChangeRequestDiffSide, ChangeRequestReviewThread } from "@ryco/contracts";
import {
  annotationSideToDiffSide,
  diffSideToAnnotationSide,
  reviewDraftAnchor,
  reviewThreadAnchor,
  reviewThreadLineAnnotations,
  type DiffAnnotationSide,
  type ReviewDraftComment,
  type ReviewThreadAnchorMode,
} from "@ryco/client-runtime/state/pull-request-review";

/**
 * Pure helpers for the Files tab: file status and stats from a parsed patch,
 * turning a gutter/line selection into a review comment anchor, the text of
 * selected lines (for suggestions), the annotations each file renders under
 * its lines, viewed progress, and unresolved-thread navigation order.
 */

// ── Files ─────────────────────────────────────────────────────────────

export type PullRequestFileStatus = "added" | "deleted" | "modified" | "renamed";

export function fileStatusOf(fileDiff: Pick<FileDiffMetadata, "type">): PullRequestFileStatus {
  switch (fileDiff.type) {
    case "new":
      return "added";
    case "deleted":
      return "deleted";
    case "rename-pure":
    case "rename-changed":
      return "renamed";
    case "change":
      return "modified";
  }
}

export const FILE_STATUS_LETTER: Record<PullRequestFileStatus, string> = {
  added: "A",
  deleted: "D",
  modified: "M",
  renamed: "R",
};

export const FILE_STATUS_LABEL: Record<PullRequestFileStatus, string> = {
  added: "Added",
  deleted: "Deleted",
  modified: "Modified",
  renamed: "Renamed",
};

export function fileDiffStat(fileDiff: Pick<FileDiffMetadata, "hunks">): {
  readonly additions: number;
  readonly deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const hunk of fileDiff.hunks) {
    additions += hunk.additionLines;
    deletions += hunk.deletionLines;
  }
  return { additions, deletions };
}

/** `apps/web/src/` + `index.css`: the directory keeps its trailing slash. */
export function splitFilePath(path: string): { readonly directory: string; readonly name: string } {
  const slash = path.lastIndexOf("/");
  return slash === -1
    ? { directory: "", name: path }
    : { directory: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

/** The file at the head commit on the host (`…/blob/<sha>/<path>`), from the PR URL. */
export function fileAtHeadUrl(
  pullRequestUrl: string | null | undefined,
  headSha: string | null | undefined,
  path: string,
): string | null {
  if (!pullRequestUrl || !headSha) return null;
  const match = /^(https?:\/\/[^?#]+?)\/pull\/\d+/u.exec(pullRequestUrl);
  if (!match) return null;
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `${match[1]}/blob/${headSha}/${encodedPath}`;
}

// ── Comment anchors ───────────────────────────────────────────────────

/** Where a new review comment attaches: one line, or a range ending at `line`. */
export interface LineCommentTarget {
  readonly path: string;
  readonly line: number;
  readonly side: ChangeRequestDiffSide;
  readonly startLine?: number;
  readonly startSide?: ChangeRequestDiffSide;
}

/**
 * A gutter drag or line-number selection as a comment target. Ranges are
 * normalized so the comment anchors to the last line (as on the host) and a
 * same-side range always reads top to bottom.
 */
export function lineCommentTarget(path: string, range: SelectedLineRange): LineCommentTarget {
  const startSide: DiffAnnotationSide = range.side ?? "additions";
  const endSide: DiffAnnotationSide = range.endSide ?? startSide;
  let start = range.start;
  let end = range.end;
  if (startSide === endSide && start > end) [start, end] = [end, start];
  const side = annotationSideToDiffSide(endSide);
  if (start === end && startSide === endSide) return { path, line: end, side };
  return {
    path,
    line: end,
    side,
    startLine: start,
    startSide: annotationSideToDiffSide(startSide),
  };
}

/** The pierre selection that highlights a comment target's lines. */
export function lineCommentTargetRange(target: LineCommentTarget): SelectedLineRange {
  const side = diffSideToAnnotationSide(target.side);
  return target.startLine === undefined
    ? { start: target.line, end: target.line, side }
    : {
        start: target.startLine,
        side: diffSideToAnnotationSide(target.startSide ?? target.side),
        end: target.line,
        endSide: side,
      };
}

/** "line 12" / "lines 12–18" (deleted lines prefixed with L, as on the host). */
export function lineCommentTargetLabel(target: LineCommentTarget): string {
  const format = (line: number, side: ChangeRequestDiffSide) =>
    side === "left" ? `L${line}` : String(line);
  if (target.startLine === undefined) return `line ${format(target.line, target.side)}`;
  return `lines ${format(target.startLine, target.startSide ?? target.side)}–${format(target.line, target.side)}`;
}

// ── Line text ─────────────────────────────────────────────────────────

type LineSource = Pick<FileDiffMetadata, "hunks" | "isPartial" | "additionLines" | "deletionLines">;

function stripLineEnding(text: string): string {
  return text.replace(/\r?\n$/u, "");
}

/**
 * Text of one line on a side. A patch-parsed (partial) file only holds the
 * lines inside its hunks, indexed through each hunk's line index; a hydrated
 * file holds the whole file.
 */
export function diffLineText(
  fileDiff: LineSource,
  side: DiffAnnotationSide,
  lineNumber: number,
): string | null {
  const lines = side === "additions" ? fileDiff.additionLines : fileDiff.deletionLines;
  if (!fileDiff.isPartial) {
    const text = lines[lineNumber - 1];
    return text === undefined ? null : stripLineEnding(text);
  }
  for (const hunk of fileDiff.hunks) {
    const start = side === "additions" ? hunk.additionStart : hunk.deletionStart;
    const count = side === "additions" ? hunk.additionCount : hunk.deletionCount;
    const index = side === "additions" ? hunk.additionLineIndex : hunk.deletionLineIndex;
    if (lineNumber >= start && lineNumber < start + count) {
      const text = lines[index + (lineNumber - start)];
      return text === undefined ? null : stripLineEnding(text);
    }
  }
  return null;
}

/** The head-side text a suggestion replaces, or null when the target is not on the head side. */
export function suggestionSourceLines(
  fileDiff: LineSource,
  target: LineCommentTarget,
): ReadonlyArray<string> | null {
  if (target.side !== "right") return null;
  if (target.startLine !== undefined && (target.startSide ?? "right") !== "right") return null;
  const lines: string[] = [];
  for (let line = target.startLine ?? target.line; line <= target.line; line += 1) {
    const text = diffLineText(fileDiff, "additions", line);
    if (text === null) return null;
    lines.push(text);
  }
  return lines;
}

/** The text of a target's lines on their own side (context for an agent hand-off). */
export function lineCommentTargetTexts(
  fileDiff: LineSource,
  target: LineCommentTarget,
): ReadonlyArray<string> {
  const lines: string[] = [];
  const start = target.startLine ?? target.line;
  const startSide = diffSideToAnnotationSide(target.startSide ?? target.side);
  const endSide = diffSideToAnnotationSide(target.side);
  // A cross-side range (deleted → added) reads each side's own numbers.
  if (startSide !== endSide) {
    const first = diffLineText(fileDiff, startSide, start);
    const last = diffLineText(fileDiff, endSide, target.line);
    return [first, last].filter((text): text is string => text !== null);
  }
  for (let line = start; line <= target.line; line += 1) {
    const text = diffLineText(fileDiff, endSide, line);
    if (text !== null) lines.push(text);
  }
  return lines;
}

/** A host suggestion block that replaces the commented lines with `lines`. */
export function buildSuggestionBlock(lines: ReadonlyArray<string>): string {
  return ["```suggestion", ...lines, "```"].join("\n");
}

/** Insert a suggestion into a comment body, after what is already written. */
export function appendSuggestionBlock(body: string, lines: ReadonlyArray<string>): string {
  const trimmed = body.replace(/\s+$/u, "");
  return `${trimmed.length > 0 ? `${trimmed}\n\n` : ""}${buildSuggestionBlock(lines)}\n`;
}

// ── Annotations ───────────────────────────────────────────────────────

export type FileAnnotationItem =
  | { readonly kind: "thread"; readonly thread: ChangeRequestReviewThread }
  | {
      readonly kind: "draft";
      readonly draft: ReviewDraftComment;
      /** Written against an older head; kept, never re-anchored. */
      readonly outdated: boolean;
    }
  | { readonly kind: "composer"; readonly target: LineCommentTarget };

export interface FileAnnotationMeta {
  /** `side:line`; stable across renders so React keeps thread state. */
  readonly key: string;
  readonly items: ReadonlyArray<FileAnnotationItem>;
}

const ITEM_ORDER: Record<FileAnnotationItem["kind"], number> = {
  thread: 0,
  draft: 1,
  composer: 2,
};

/**
 * Everything one file renders under its lines, grouped per line so several
 * threads (plus drafts and the open composer) share one annotation slot.
 * Threads anchor with `mode` (current head, or the original commit when a
 * commit scope is active); drafts with their own anchor. File-level threads
 * and drafts (line 0) are left out: the file renders them above its diff.
 */
export function buildFileLineAnnotations(input: {
  readonly threads: ReadonlyArray<ChangeRequestReviewThread>;
  readonly drafts?: ReadonlyArray<ReviewDraftComment>;
  readonly headSha?: string | null;
  readonly composer?: LineCommentTarget | null;
  readonly mode?: ReviewThreadAnchorMode;
}): DiffLineAnnotation<FileAnnotationMeta>[] {
  const groups = new Map<
    string,
    { side: DiffAnnotationSide; lineNumber: number; items: FileAnnotationItem[] }
  >();
  const add = (side: DiffAnnotationSide, lineNumber: number, item: FileAnnotationItem) => {
    if (lineNumber < 1) return;
    const key = `${side}:${lineNumber}`;
    const group = groups.get(key);
    if (group) group.items.push(item);
    else groups.set(key, { side, lineNumber, items: [item] });
  };

  for (const annotation of reviewThreadLineAnnotations(
    input.threads,
    (thread) => thread,
    input.mode,
  )) {
    add(annotation.side, annotation.lineNumber, { kind: "thread", thread: annotation.metadata });
  }
  for (const draft of input.drafts ?? []) {
    const anchor = reviewDraftAnchor(draft);
    if (!anchor) continue;
    add(anchor.side, anchor.lineNumber, {
      kind: "draft",
      draft,
      outdated: input.headSha != null && draft.headSha !== input.headSha,
    });
  }
  if (input.composer) {
    add(diffSideToAnnotationSide(input.composer.side), input.composer.line, {
      kind: "composer",
      target: input.composer,
    });
  }

  return [...groups.entries()]
    .toSorted(
      ([, left], [, right]) =>
        left.lineNumber - right.lineNumber ||
        (left.side === right.side ? 0 : left.side === "deletions" ? -1 : 1),
    )
    .map(([key, group]) => ({
      side: group.side,
      lineNumber: group.lineNumber,
      metadata: {
        key,
        items: group.items.toSorted(
          (left, right) => ITEM_ORDER[left.kind] - ITEM_ORDER[right.kind],
        ),
      },
    }));
}

// ── Commit scope ──────────────────────────────────────────────────────

/** Whether two commit ids name the same commit (a URL may carry an abbreviated one). */
export function isSameCommit(oid: string, other: string): boolean {
  const left = oid.toLowerCase();
  const right = other.toLowerCase();
  if (left === right) return true;
  const [short, long] = left.length < right.length ? [left, right] : [right, left];
  return short.length >= 7 && long.startsWith(short);
}

/**
 * The conversations one commit's diff can show: those whose first comment was
 * written on that commit, on a line that commit's diff contains (file-level
 * ones always). A thread written on another commit carries that commit's line
 * numbers, so it would land on unrelated code here; it stays in the whole
 * change request's diff instead, and is not counted for this commit.
 */
export function commitScopedReviewThreads(
  threads: ReadonlyArray<ChangeRequestReviewThread>,
  commitSha: string,
  fileDiffFor: (path: string) => LineSource | undefined,
): ReadonlyArray<ChangeRequestReviewThread> {
  return threads.filter((thread) => {
    if (!thread.originalCommitOid || !isSameCommit(thread.originalCommitOid, commitSha)) {
      return false;
    }
    const fileDiff = fileDiffFor(thread.path);
    if (!fileDiff) return false;
    const anchor = reviewThreadAnchor(thread, "original");
    if (!anchor) return false;
    return (
      anchor.lineNumber === 0 || diffLineText(fileDiff, anchor.side, anchor.lineNumber) !== null
    );
  });
}

// ── Viewed and navigation ─────────────────────────────────────────────

export type FileViewedState = "viewed" | "unviewed" | "stale";

export function viewedProgress(
  paths: ReadonlyArray<string>,
  states: ReadonlyMap<string, FileViewedState>,
): { readonly viewed: number; readonly total: number } {
  let viewed = 0;
  for (const path of paths) if (states.get(path) === "viewed") viewed += 1;
  return { viewed, total: paths.length };
}

/** The next file after `path` that is not viewed (wrapping), or null when all are. */
export function nextUnviewedPath(
  paths: ReadonlyArray<string>,
  states: ReadonlyMap<string, FileViewedState>,
  path: string | null,
): string | null {
  const start = path === null ? -1 : paths.indexOf(path);
  for (let offset = 1; offset <= paths.length; offset += 1) {
    const candidate = paths[(start + offset + paths.length) % paths.length];
    if (candidate !== undefined && candidate !== path && states.get(candidate) !== "viewed") {
      return candidate;
    }
  }
  return null;
}

export interface ThreadStop {
  readonly threadId: string;
  readonly path: string;
}

/** Unresolved, anchorable threads in reading order (file order, then line). */
export function unresolvedThreadStops(
  paths: ReadonlyArray<string>,
  anchoredByPath: ReadonlyMap<
    string,
    ReadonlyArray<{ readonly thread: ChangeRequestReviewThread }>
  >,
): ReadonlyArray<ThreadStop> {
  const stops: ThreadStop[] = [];
  for (const path of paths) {
    for (const { thread } of anchoredByPath.get(path) ?? []) {
      if (!thread.isResolved) stops.push({ threadId: thread.id, path });
    }
  }
  return stops;
}

/**
 * The stop after (or before) the current one. Without a current thread, the
 * first stop at or after the visible file (or the last one before it, going
 * back) so N/P start from where the reader is.
 */
export function adjacentThreadStop(
  stops: ReadonlyArray<ThreadStop>,
  paths: ReadonlyArray<string>,
  current: { readonly threadId: string | null; readonly path: string | null },
  direction: 1 | -1,
): ThreadStop | null {
  if (stops.length === 0) return null;
  const index =
    current.threadId === null ? -1 : stops.findIndex((stop) => stop.threadId === current.threadId);
  if (index !== -1) {
    return stops[(index + direction + stops.length) % stops.length] ?? null;
  }
  const fileIndex = current.path === null ? 0 : Math.max(0, paths.indexOf(current.path));
  const position = (stop: ThreadStop) => paths.indexOf(stop.path);
  if (direction === 1) {
    return stops.find((stop) => position(stop) >= fileIndex) ?? stops[0] ?? null;
  }
  return stops.findLast((stop) => position(stop) < fileIndex) ?? stops.at(-1) ?? null;
}

// ── Reading order and the tree ────────────────────────────────────────

export interface ReviewFileTreeFile {
  readonly kind: "file";
  readonly path: string;
  readonly name: string;
  readonly depth: number;
}

export interface ReviewFileTreeDirectory {
  readonly kind: "directory";
  readonly path: string;
  /** Compacted: single-child directory chains read as one row (`apps/web/src`). */
  readonly name: string;
  readonly depth: number;
  readonly children: ReadonlyArray<ReviewFileTreeNode>;
}

export type ReviewFileTreeNode = ReviewFileTreeFile | ReviewFileTreeDirectory;

interface MutableDirectory {
  readonly path: string;
  readonly name: string;
  /** Insertion order: directories and files interleaved as first seen. */
  readonly entries: Array<MutableDirectory | string>;
  readonly directories: Map<string, MutableDirectory>;
}

/**
 * The file tree in reading order: entries appear where their first file does
 * (paths are expected in `orderChangeRequestFiles` order), so the tree and the
 * diff below it read the same way top to bottom and the scroll-spy plate only
 * ever moves down as you read. Single-child directory chains are compacted.
 */
export function buildReviewFileTree(
  paths: ReadonlyArray<string>,
): ReadonlyArray<ReviewFileTreeNode> {
  const root: MutableDirectory = { path: "", name: "", entries: [], directories: new Map() };
  for (const path of paths) {
    const segments = path.split("/").filter((segment) => segment.length > 0);
    if (segments.length === 0) continue;
    let directory = root;
    for (const segment of segments.slice(0, -1)) {
      let next = directory.directories.get(segment);
      if (!next) {
        next = {
          path: directory.path ? `${directory.path}/${segment}` : segment,
          name: segment,
          entries: [],
          directories: new Map(),
        };
        directory.directories.set(segment, next);
        directory.entries.push(next);
      }
      directory = next;
    }
    directory.entries.push(path);
  }

  const toNodes = (directory: MutableDirectory, depth: number): ReviewFileTreeNode[] =>
    directory.entries.map((entry): ReviewFileTreeNode => {
      if (typeof entry === "string") {
        return { kind: "file", path: entry, name: splitFilePath(entry).name, depth };
      }
      let compacted = entry;
      let name = entry.name;
      while (compacted.entries.length === 1 && typeof compacted.entries[0] !== "string") {
        compacted = compacted.entries[0] as MutableDirectory;
        name = `${name}/${compacted.name}`;
      }
      return {
        kind: "directory",
        path: compacted.path,
        name,
        depth,
        children: toNodes(compacted, depth + 1),
      };
    });
  return toNodes(root, 0);
}

/** Files of a tree, top to bottom. */
export function reviewFileTreePaths(nodes: ReadonlyArray<ReviewFileTreeNode>): string[] {
  const paths: string[] = [];
  const visit = (list: ReadonlyArray<ReviewFileTreeNode>) => {
    for (const node of list) {
      if (node.kind === "file") paths.push(node.path);
      else visit(node.children);
    }
  };
  visit(nodes);
  return paths;
}

/** The tree flattened into rows (directories, then their files), as the tree pane renders it. */
export function flattenReviewFileTree(
  nodes: ReadonlyArray<ReviewFileTreeNode>,
): ReadonlyArray<ReviewFileTreeNode> {
  const rows: ReviewFileTreeNode[] = [];
  const visit = (list: ReadonlyArray<ReviewFileTreeNode>) => {
    for (const node of list) {
      rows.push(node);
      if (node.kind === "directory") visit(node.children);
    }
  };
  visit(nodes);
  return rows;
}

/**
 * Case-insensitive filter over paths. Every whitespace-separated term must
 * appear in the path, so `rail tsx` finds `…/PullRequestStackRail.tsx`.
 */
export function filterFilePaths(
  paths: ReadonlyArray<string>,
  query: string,
): ReadonlyArray<string> {
  const terms = query
    .toLowerCase()
    .split(/\s+/u)
    .filter((term) => term.length > 0);
  if (terms.length === 0) return paths;
  return paths.filter((path) => {
    const haystack = path.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/** J/K: the file before or after `path` in reading order (clamped, no wrap). */
export function adjacentFilePath(
  paths: ReadonlyArray<string>,
  path: string | null,
  direction: 1 | -1,
): string | null {
  if (paths.length === 0) return null;
  const index = path === null ? -1 : paths.indexOf(path);
  if (index === -1) return direction === 1 ? (paths[0] ?? null) : (paths.at(-1) ?? null);
  const next = index + direction;
  return next >= 0 && next < paths.length ? (paths[next] ?? null) : null;
}

// ── Diff load failures ────────────────────────────────────────────────

const OVERSIZED_DIFF_PATTERN =
  /too large|too_large|exceed(?:s|ed)? the maximum|maximum number of (?:lines|files)|\b406\b|diff is taking too long/iu;

/**
 * The host refuses diffs past its size limits (GitHub: 20k lines / 300
 * files, HTTP 406). That is not a failure to retry: the reader is sent to the
 * host instead.
 */
export function isOversizedDiffError(message: string | null | undefined): boolean {
  return message != null && OVERSIZED_DIFF_PATTERN.test(message);
}

/** Lines past which a single file starts collapsed (it is still one click away). */
export const LARGE_FILE_CHANGED_LINES = 1500;

// ── Pending review ────────────────────────────────────────────────────

/** The Review button badge: local draft comments plus comments in a review started on the host. */
export function pendingReviewCount(
  drafts: ReadonlyArray<unknown>,
  hostPendingReview: { readonly commentsCount: number } | null | undefined,
): number {
  return drafts.length + (hostPendingReview?.commentsCount ?? 0);
}
