import type {
  ReviewDraftComment,
  ViewedFileState,
} from "@ryco/client-runtime/state/pull-request-review";
import type {
  ChangeRequestDiffSide,
  ChangeRequestReviewThread,
  SourceControlChangeRequestFilesViewed,
} from "@ryco/contracts";

import type { PullRequestDiffRow } from "./pullRequestDiffModel";

/**
 * Reviewing a pull request file by file on the phone: how far the viewer is
 * (files marked viewed on the host), which file comes next, and where line
 * comments (the viewer's drafts and the host's published threads) sit in a
 * file's diff.
 */

export interface PullRequestReviewProgress {
  readonly total: number;
  readonly viewed: number;
  /** Viewed state by path; files the host has not reported read as unviewed. */
  readonly stateByPath: ReadonlyMap<string, ViewedFileState>;
  /** The first file in reading order not yet viewed; null when every file is. */
  readonly firstUnviewed: string | null;
  /** The host keeps viewed state for this pull request. */
  readonly supported: boolean;
}

export function derivePullRequestReviewProgress(
  paths: ReadonlyArray<string>,
  viewed: SourceControlChangeRequestFilesViewed | null,
): PullRequestReviewProgress {
  const reported = new Map(viewed?.files.map((file) => [file.path, file.state]));
  const stateByPath = new Map<string, ViewedFileState>();
  for (const path of paths) stateByPath.set(path, reported.get(path) ?? "unviewed");
  const viewedCount = paths.filter((path) => stateByPath.get(path) === "viewed").length;
  return {
    total: paths.length,
    viewed: viewedCount,
    stateByPath,
    firstUnviewed: paths.find((path) => stateByPath.get(path) !== "viewed") ?? null,
    supported: viewed !== null && viewed.capability.storage !== "unsupported",
  };
}

/** The next file to review after `current`: the next one not viewed, else none. */
export function nextUnviewedPath(
  paths: ReadonlyArray<string>,
  stateByPath: ReadonlyMap<string, ViewedFileState>,
  current: string,
): string | null {
  const start = paths.indexOf(current);
  for (let offset = 1; offset < paths.length; offset += 1) {
    const candidate = paths[(start + offset) % paths.length];
    if (candidate !== undefined && candidate !== current && stateByPath.get(candidate) !== "viewed")
      return candidate;
  }
  return null;
}

export interface PullRequestDiffAnchor {
  readonly line: number;
  readonly side: ChangeRequestDiffSide;
}

/** Where a comment on this row anchors: the new side for added and unchanged lines. */
export function pullRequestDiffRowAnchor(row: PullRequestDiffRow): PullRequestDiffAnchor | null {
  switch (row.kind) {
    case "addition":
    case "context":
      return row.newLine === null ? null : { line: row.newLine, side: "right" };
    case "deletion":
      return row.oldLine === null ? null : { line: row.oldLine, side: "left" };
    case "hunk":
    case "notice":
      return null;
  }
}

export type PullRequestFileDiffItem =
  | { readonly kind: "row"; readonly key: string; readonly index: number }
  | { readonly kind: "draft"; readonly key: string; readonly comment: ReviewDraftComment }
  | { readonly kind: "thread"; readonly key: string; readonly thread: ChangeRequestReviewThread };

function anchorKey(side: ChangeRequestDiffSide, line: number): string {
  return `${side}:${line}`;
}

/**
 * The diff's rows with comments placed under the line they belong to: the
 * host's threads first, then the viewer's drafts. Comments whose line is not
 * in the rows shown (outdated, or past a cut-off excerpt) come at the end.
 */
export function interleavePullRequestFileComments(input: {
  readonly path: string;
  readonly rows: ReadonlyArray<PullRequestDiffRow>;
  readonly drafts: ReadonlyArray<ReviewDraftComment>;
  readonly threads: ReadonlyArray<ChangeRequestReviewThread>;
}): ReadonlyArray<PullRequestFileDiffItem> {
  const byAnchor = new Map<string, PullRequestFileDiffItem[]>();
  const unplaced: PullRequestFileDiffItem[] = [];
  const shown = new Set<string>();
  for (const row of input.rows) {
    const anchor = pullRequestDiffRowAnchor(row);
    if (anchor) shown.add(anchorKey(anchor.side, anchor.line));
  }
  const place = (
    side: ChangeRequestDiffSide,
    line: number | null,
    item: PullRequestFileDiffItem,
  ) => {
    const key = line === null ? null : anchorKey(side, line);
    if (key === null || !shown.has(key)) {
      unplaced.push(item);
      return;
    }
    const list = byAnchor.get(key) ?? [];
    list.push(item);
    byAnchor.set(key, list);
  };
  for (const thread of input.threads) {
    if (thread.path !== input.path) continue;
    place(thread.side, thread.subjectType === "file" ? null : thread.line, {
      kind: "thread",
      key: `thread:${thread.id}`,
      thread,
    });
  }
  for (const comment of input.drafts) {
    if (comment.path !== input.path) continue;
    place(comment.side ?? "right", comment.subjectType === "file" ? null : (comment.line ?? null), {
      kind: "draft",
      key: `draft:${comment.id}`,
      comment,
    });
  }
  const items: PullRequestFileDiffItem[] = [];
  input.rows.forEach((row, index) => {
    items.push({ kind: "row", key: `row:${index}`, index });
    const anchor = pullRequestDiffRowAnchor(row);
    if (anchor === null) return;
    const key = anchorKey(anchor.side, anchor.line);
    const attached = byAnchor.get(key);
    if (attached) {
      items.push(...attached);
      byAnchor.delete(key);
    }
  });
  items.push(...unplaced);
  return items;
}
