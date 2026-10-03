import type { ChangeRequestDiffSide, ChangeRequestReviewThread } from "@ryco/contracts";

/**
 * Structural mirror of `@pierre/diffs`' `AnnotationSide` / `DiffLineAnnotation`
 * so this module stays renderer-agnostic (no pierre import in client-runtime).
 */
export type DiffAnnotationSide = "deletions" | "additions";

export interface DiffLineAnnotationLike<TMetadata> {
  readonly side: DiffAnnotationSide;
  /** `0` renders above the first hunk (file-level annotation). */
  readonly lineNumber: number;
  readonly metadata: TMetadata;
}

/**
 * Which line a thread anchors to:
 * - `current` (default): the thread's position on the latest diff. Outdated
 *   threads and threads whose `line` is null are off-diff.
 * - `original`: the position on the commit the thread was written against
 *   (`originalLine`, falling back to `line`). Use it for commit-scoped diffs.
 */
export type ReviewThreadAnchorMode = "current" | "original";

export interface ReviewThreadAnchor {
  readonly side: DiffAnnotationSide;
  readonly lineNumber: number;
  /** Start of a multi-line range on the same anchor, when the host reports one. */
  readonly startLineNumber: number | null;
  readonly startSide: DiffAnnotationSide | null;
}

export function diffSideToAnnotationSide(side: ChangeRequestDiffSide): DiffAnnotationSide {
  return side === "left" ? "deletions" : "additions";
}

export function annotationSideToDiffSide(side: DiffAnnotationSide): ChangeRequestDiffSide {
  return side === "deletions" ? "left" : "right";
}

/**
 * Where a thread sits in the rendered diff, or null when it no longer maps
 * onto it. File-level threads anchor at line 0 (above the first hunk).
 */
export function reviewThreadAnchor(
  thread: Pick<
    ChangeRequestReviewThread,
    | "subjectType"
    | "side"
    | "startSide"
    | "line"
    | "startLine"
    | "originalLine"
    | "originalStartLine"
    | "isOutdated"
  >,
  mode: ReviewThreadAnchorMode = "current",
): ReviewThreadAnchor | null {
  const side = diffSideToAnnotationSide(thread.side);
  if (thread.subjectType === "file") {
    return { side, lineNumber: 0, startLineNumber: null, startSide: null };
  }
  const line =
    mode === "original"
      ? (thread.originalLine ?? thread.line)
      : thread.isOutdated
        ? null
        : thread.line;
  if (line === null || line === undefined) return null;
  const startLine =
    mode === "original"
      ? (thread.originalStartLine ?? thread.startLine ?? null)
      : (thread.startLine ?? null);
  return {
    side,
    lineNumber: line,
    startLineNumber: startLine !== null && startLine !== line ? startLine : null,
    startSide:
      startLine !== null && startLine !== line
        ? diffSideToAnnotationSide(thread.startSide ?? thread.side)
        : null,
  };
}

export interface AnchoredReviewThread {
  readonly thread: ChangeRequestReviewThread;
  readonly anchor: ReviewThreadAnchor;
}

export interface ReviewThreadIndex {
  /** Every thread, by path, in host order. */
  readonly byPath: ReadonlyMap<string, ReadonlyArray<ChangeRequestReviewThread>>;
  /** Threads that map onto the diff, by path, ordered by line. */
  readonly anchoredByPath: ReadonlyMap<string, ReadonlyArray<AnchoredReviewThread>>;
  /** Outdated or unanchored threads (all paths), for an "off-diff" list. */
  readonly offDiff: ReadonlyArray<ChangeRequestReviewThread>;
  readonly offDiffByPath: ReadonlyMap<string, ReadonlyArray<ChangeRequestReviewThread>>;
  readonly unresolvedCountByPath: ReadonlyMap<string, number>;
  readonly unresolvedCount: number;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function compareAnchors(left: ReviewThreadAnchor, right: ReviewThreadAnchor): number {
  return (
    left.lineNumber - right.lineNumber ||
    (left.side === right.side ? 0 : left.side === "deletions" ? -1 : 1)
  );
}

export function indexReviewThreads(
  threads: ReadonlyArray<ChangeRequestReviewThread>,
  mode: ReviewThreadAnchorMode = "current",
): ReviewThreadIndex {
  const byPath = new Map<string, ChangeRequestReviewThread[]>();
  const anchoredByPath = new Map<string, AnchoredReviewThread[]>();
  const offDiffByPath = new Map<string, ChangeRequestReviewThread[]>();
  const offDiff: ChangeRequestReviewThread[] = [];
  const unresolvedCountByPath = new Map<string, number>();
  let unresolvedCount = 0;

  for (const thread of threads) {
    push(byPath, thread.path, thread);
    const anchor = reviewThreadAnchor(thread, mode);
    if (anchor) {
      push(anchoredByPath, thread.path, { thread, anchor });
    } else {
      offDiff.push(thread);
      push(offDiffByPath, thread.path, thread);
    }
    if (!thread.isResolved) {
      unresolvedCount += 1;
      unresolvedCountByPath.set(thread.path, (unresolvedCountByPath.get(thread.path) ?? 0) + 1);
    }
  }
  for (const [path, list] of anchoredByPath) {
    anchoredByPath.set(
      path,
      list.toSorted((left, right) => compareAnchors(left.anchor, right.anchor)),
    );
  }

  return { byPath, anchoredByPath, offDiff, offDiffByPath, unresolvedCountByPath, unresolvedCount };
}

/**
 * Line annotations for one file's anchorable threads, ready for a diff
 * renderer's `lineAnnotations` (structurally `DiffLineAnnotation<M>[]`).
 */
export function reviewThreadLineAnnotations<TMetadata>(
  threads: ReadonlyArray<ChangeRequestReviewThread>,
  toMetadata: (thread: ChangeRequestReviewThread, anchor: ReviewThreadAnchor) => TMetadata,
  mode: ReviewThreadAnchorMode = "current",
): ReadonlyArray<DiffLineAnnotationLike<TMetadata>> {
  const annotations: Array<DiffLineAnnotationLike<TMetadata> & { anchor: ReviewThreadAnchor }> = [];
  for (const thread of threads) {
    const anchor = reviewThreadAnchor(thread, mode);
    if (!anchor) continue;
    annotations.push({
      side: anchor.side,
      lineNumber: anchor.lineNumber,
      metadata: toMetadata(thread, anchor),
      anchor,
    });
  }
  return annotations
    .toSorted((left, right) => compareAnchors(left.anchor, right.anchor))
    .map(({ side, lineNumber, metadata }) => ({ side, lineNumber, metadata }));
}

/** Anchor of a pending draft comment (see `reviewDraftStore`), same rules as threads. */
export function reviewDraftAnchor(draft: {
  readonly subjectType: "line" | "file";
  readonly side?: ChangeRequestDiffSide | undefined;
  readonly line?: number | undefined;
  readonly startLine?: number | undefined;
  readonly startSide?: ChangeRequestDiffSide | undefined;
}): ReviewThreadAnchor | null {
  const side = diffSideToAnnotationSide(draft.side ?? "right");
  if (draft.subjectType === "file") {
    return { side, lineNumber: 0, startLineNumber: null, startSide: null };
  }
  if (draft.line === undefined) return null;
  const ranged = draft.startLine !== undefined && draft.startLine !== draft.line;
  return {
    side,
    lineNumber: draft.line,
    startLineNumber: ranged ? (draft.startLine ?? null) : null,
    startSide: ranged ? diffSideToAnnotationSide(draft.startSide ?? draft.side ?? "right") : null,
  };
}
