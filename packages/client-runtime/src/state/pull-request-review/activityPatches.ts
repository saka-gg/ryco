/**
 * Pure patches for cached change request reads, used for optimistic updates
 * and for applying mutation results before the next refetch. Every function
 * returns its input unchanged (same reference) when it has nothing to do, so
 * callers can skip no-op cache writes.
 */
import type {
  ChangeRequestActivity,
  ChangeRequestReviewThread,
  ChangeRequestUpdateAction,
  ChangeRequestUpdateActionKind,
  SourceControlChangeRequestDetail,
  SourceControlChangeRequestReviewer,
  SourceControlLabel,
} from "@ryco/contracts";

// ── Review threads ──────────────────────────────────────────────────────

export interface ReviewThreadResolution {
  readonly isResolved: boolean;
  readonly resolvedBy?: string | undefined;
}

export function readReviewThreadResolution(
  activity: ChangeRequestActivity | null | undefined,
  threadId: string,
): ReviewThreadResolution | null {
  const thread = activity?.reviewThreads.find((candidate) => candidate.id === threadId);
  return thread
    ? {
        isResolved: thread.isResolved,
        ...(thread.resolvedBy !== undefined ? { resolvedBy: thread.resolvedBy } : {}),
      }
    : null;
}

function mapThread(
  activity: ChangeRequestActivity,
  threadId: string,
  update: (thread: ChangeRequestReviewThread) => ChangeRequestReviewThread,
): ChangeRequestActivity {
  let changed = false;
  const reviewThreads = activity.reviewThreads.map((thread) => {
    if (thread.id !== threadId) return thread;
    const next = update(thread);
    if (next !== thread) changed = true;
    return next;
  });
  return changed ? { ...activity, reviewThreads } : activity;
}

export function setReviewThreadResolvedInActivity(
  activity: ChangeRequestActivity,
  threadId: string,
  resolution: ReviewThreadResolution,
): ChangeRequestActivity {
  return mapThread(activity, threadId, (thread) => {
    if (
      thread.isResolved === resolution.isResolved &&
      thread.resolvedBy === resolution.resolvedBy
    ) {
      return thread;
    }
    const { resolvedBy: _previous, ...rest } = thread;
    return {
      ...rest,
      isResolved: resolution.isResolved,
      ...(resolution.isResolved && resolution.resolvedBy !== undefined
        ? { resolvedBy: resolution.resolvedBy }
        : {}),
    };
  });
}

/**
 * Exact rollback of an optimistic resolve/unresolve: restores `previous` only
 * while the thread still shows the optimistic value, so a newer read or a
 * newer toggle is never clobbered.
 */
export function rollbackReviewThreadResolved(
  activity: ChangeRequestActivity,
  threadId: string,
  previous: ReviewThreadResolution,
  optimisticIsResolved: boolean,
): ChangeRequestActivity {
  const current = readReviewThreadResolution(activity, threadId);
  if (current === null || current.isResolved !== optimisticIsResolved) return activity;
  return setReviewThreadResolvedInActivity(activity, threadId, previous);
}

/** Replaces the thread with the same id (e.g. a reply's returned thread), or appends it. */
export function replaceReviewThreadInActivity(
  activity: ChangeRequestActivity,
  thread: ChangeRequestReviewThread,
): ChangeRequestActivity {
  const index = activity.reviewThreads.findIndex((candidate) => candidate.id === thread.id);
  if (index === -1) return { ...activity, reviewThreads: [...activity.reviewThreads, thread] };
  if (activity.reviewThreads[index] === thread) return activity;
  const reviewThreads = [...activity.reviewThreads];
  reviewThreads[index] = thread;
  return { ...activity, reviewThreads };
}

// ── Comment edits and deletes ───────────────────────────────────────────

export type ChangeRequestCommentUpdate =
  | { readonly commentId: string; readonly action: "edit"; readonly body: string }
  | { readonly commentId: string; readonly action: "delete" };

export function applyCommentUpdateToActivity(
  activity: ChangeRequestActivity,
  update: ChangeRequestCommentUpdate,
): ChangeRequestActivity {
  let changed = false;
  const timeline =
    update.action === "delete"
      ? activity.timeline.filter((item) => {
          const remove = item.kind === "comment" && item.id === update.commentId;
          if (remove) changed = true;
          return !remove;
        })
      : activity.timeline.map((item) => {
          if ((item.kind !== "comment" && item.kind !== "review") || item.id !== update.commentId) {
            return item;
          }
          if (item.body === update.body) return item;
          changed = true;
          return { ...item, body: update.body };
        });

  const reviewThreads = activity.reviewThreads.flatMap((thread) => {
    if (!thread.comments.some((comment) => comment.id === update.commentId)) return [thread];
    changed = true;
    if (update.action === "edit") {
      return [
        {
          ...thread,
          comments: thread.comments.map((comment) =>
            comment.id === update.commentId ? { ...comment, body: update.body } : comment,
          ),
        },
      ];
    }
    const comments = thread.comments.filter((comment) => comment.id !== update.commentId);
    const totalComments = Math.max(comments.length, thread.totalComments - 1);
    // Deleting a thread's only comment deletes the thread on the host.
    return totalComments === 0 ? [] : [{ ...thread, comments, totalComments }];
  });

  return changed ? { ...activity, timeline, reviewThreads } : activity;
}

export function applyCommentUpdateToDetail(
  detail: SourceControlChangeRequestDetail,
  update: ChangeRequestCommentUpdate,
): SourceControlChangeRequestDetail {
  if (!detail.comments.some((comment) => comment.id === update.commentId)) return detail;
  return {
    ...detail,
    comments:
      update.action === "delete"
        ? detail.comments.filter((comment) => comment.id !== update.commentId)
        : detail.comments.map((comment) =>
            comment.id === update.commentId ? { ...comment, body: update.body } : comment,
          ),
  };
}

// ── Lifecycle updates ───────────────────────────────────────────────────

type DetailField = keyof SourceControlChangeRequestDetail;

const OPTIMISTIC_FIELDS: Partial<
  Record<ChangeRequestUpdateActionKind, ReadonlyArray<DetailField>>
> = {
  "set-draft": ["isDraft", "mergeStateStatus"],
  labels: ["labels"],
  reviewers: ["reviewers", "reviewerStates"],
  assignees: ["assignees"],
  edit: ["title", "body", "baseRefName"],
};

/** Detail fields an optimistic update of this kind touches (empty: not applied optimistically). */
export function optimisticFieldsForUpdate(
  kind: ChangeRequestUpdateActionKind,
): ReadonlyArray<DetailField> {
  return OPTIMISTIC_FIELDS[kind] ?? [];
}

function lower(value: string): string {
  return value.toLowerCase();
}

function editNames(
  current: ReadonlyArray<string>,
  add: ReadonlyArray<string>,
  remove: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const removed = new Set(remove.map(lower));
  const kept = current.filter((name) => !removed.has(lower(name)));
  const present = new Set(kept.map(lower));
  return [...kept, ...add.filter((name) => !present.has(lower(name)) && !removed.has(lower(name)))];
}

function editLabels(
  current: ReadonlyArray<SourceControlLabel>,
  add: ReadonlyArray<string>,
  remove: ReadonlyArray<string>,
): ReadonlyArray<SourceControlLabel> {
  const removed = new Set(remove.map(lower));
  const kept = current.filter((label) => !removed.has(lower(label.name)));
  const present = new Set(kept.map((label) => lower(label.name)));
  return [
    ...kept,
    ...add
      .filter((name) => !present.has(lower(name)) && !removed.has(lower(name)))
      .map((name) => ({ name })),
  ];
}

function editReviewerStates(
  current: ReadonlyArray<SourceControlChangeRequestReviewer>,
  add: ReadonlyArray<string>,
  remove: ReadonlyArray<string>,
): ReadonlyArray<SourceControlChangeRequestReviewer> {
  const removed = new Set(remove.map(lower));
  const added = new Set(add.map(lower));
  // Withdrawing a request leaves any review already submitted in place.
  const kept = current
    .filter((reviewer) => !(removed.has(lower(reviewer.login)) && reviewer.state === "requested"))
    .map((reviewer) =>
      added.has(lower(reviewer.login)) && reviewer.state !== "requested"
        ? { ...reviewer, state: "requested" as const }
        : reviewer,
    );
  const present = new Set(kept.map((reviewer) => lower(reviewer.login)));
  return [
    ...kept,
    ...add
      .filter((login) => !present.has(lower(login)) && !removed.has(lower(login)))
      .map((login): SourceControlChangeRequestReviewer => ({
        login,
        kind: login.includes("/") ? "team" : "user",
        state: "requested",
      })),
  ];
}

/**
 * The detail as it will look once the host applies `action`, for the actions
 * that can be predicted locally (draft state, labels, reviewers, assignees,
 * title/body/base edits). Other actions return `detail` unchanged.
 */
export function applyOptimisticChangeRequestUpdate(
  detail: SourceControlChangeRequestDetail,
  action: ChangeRequestUpdateAction,
): SourceControlChangeRequestDetail {
  switch (action.kind) {
    case "set-draft": {
      if ((detail.isDraft ?? false) === action.draft) return detail;
      const mergeStateStatus = action.draft
        ? "draft"
        : detail.mergeStateStatus === "draft"
          ? "unknown"
          : detail.mergeStateStatus;
      return {
        ...detail,
        isDraft: action.draft,
        ...(mergeStateStatus !== undefined ? { mergeStateStatus } : {}),
      };
    }
    case "labels":
      return { ...detail, labels: editLabels(detail.labels ?? [], action.add, action.remove) };
    case "reviewers":
      return {
        ...detail,
        reviewers: editNames(detail.reviewers ?? [], action.add, action.remove),
        reviewerStates: editReviewerStates(detail.reviewerStates ?? [], action.add, action.remove),
      };
    case "assignees":
      return { ...detail, assignees: editNames(detail.assignees ?? [], action.add, action.remove) };
    case "edit":
      return {
        ...detail,
        ...(action.title !== undefined ? { title: action.title } : {}),
        ...(action.body !== undefined ? { body: action.body } : {}),
        ...(action.baseRefName !== undefined ? { baseRefName: action.baseRefName } : {}),
      };
    default:
      return detail;
  }
}

/**
 * Exact rollback of `applyOptimisticChangeRequestUpdate`: each touched field
 * returns to `previous` only while it still holds the optimistic value, so a
 * newer read or a newer edit of the same field is never reverted.
 */
export function rollbackOptimisticChangeRequestUpdate(
  current: SourceControlChangeRequestDetail,
  previous: SourceControlChangeRequestDetail,
  optimistic: SourceControlChangeRequestDetail,
  kind: ChangeRequestUpdateActionKind,
): SourceControlChangeRequestDetail {
  let next: Record<string, unknown> | null = null;
  for (const field of optimisticFieldsForUpdate(kind)) {
    if (current[field] !== optimistic[field] || current[field] === previous[field]) continue;
    next ??= { ...current };
    if (field in previous) next[field] = previous[field];
    else delete next[field];
  }
  return next === null ? current : (next as SourceControlChangeRequestDetail);
}
