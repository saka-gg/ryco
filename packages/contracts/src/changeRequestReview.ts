import { Schema } from "effect";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  SourceControlChangeRequestDetail,
  SourceControlChangeRequestMergeMethod,
  SourceControlCommentReaction,
  SourceControlLabel,
  SourceControlProviderKind,
  SourceControlReviewState,
} from "./sourceControl.ts";

/**
 * Review conversation, timeline, and lifecycle contracts for the dedicated
 * pull request page. Unlike `SourceControlChangeRequestDetail`, these payloads
 * are never attached to agent prompts, so they are bounded by page size
 * rather than by the composer token budget.
 */

const NonBlankMarkdownBody = Schema.String.check(
  Schema.makeFilter((body: string) =>
    body.trim().length > 0 ? undefined : "Expected a non-blank Markdown body",
  ),
);

/** `left` is the base (deleted) side of a diff, `right` the head (added) side. */
export const ChangeRequestDiffSide = Schema.Literals(["left", "right"]);
export type ChangeRequestDiffSide = typeof ChangeRequestDiffSide.Type;

export const ChangeRequestActor = Schema.Struct({
  login: TrimmedNonEmptyString,
  avatarUrl: Schema.optional(Schema.String),
  isBot: Schema.optional(Schema.Boolean),
});
export type ChangeRequestActor = typeof ChangeRequestActor.Type;

// ── Review threads ────────────────────────────────────────────────────

export const ChangeRequestReviewComment = Schema.Struct({
  /** Host node id; used for replies, reactions, edits, and deletes. */
  id: TrimmedNonEmptyString,
  author: ChangeRequestActor,
  authorAssociation: Schema.optional(Schema.String),
  body: Schema.String,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.optional(Schema.DateTimeUtc),
  url: Schema.optional(Schema.String),
  reactions: Schema.optional(Schema.Array(SourceControlCommentReaction)),
  /** `pending` comments belong to the viewer's unsubmitted host-side review. */
  state: Schema.optional(Schema.Literals(["pending", "submitted"])),
  viewerCanUpdate: Schema.optional(Schema.Boolean),
  viewerCanDelete: Schema.optional(Schema.Boolean),
  isMinimized: Schema.optional(Schema.Boolean),
});
export type ChangeRequestReviewComment = typeof ChangeRequestReviewComment.Type;

export const ChangeRequestReviewThread = Schema.Struct({
  id: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  subjectType: Schema.Literals(["line", "file"]),
  side: ChangeRequestDiffSide,
  startSide: Schema.optional(ChangeRequestDiffSide),
  /** Current anchor line; null when the thread is outdated and no longer maps onto the diff. */
  line: Schema.NullOr(PositiveInt),
  startLine: Schema.optional(Schema.NullOr(PositiveInt)),
  originalLine: Schema.optional(Schema.NullOr(PositiveInt)),
  originalStartLine: Schema.optional(Schema.NullOr(PositiveInt)),
  /** Commit the first comment was written on; `originalLine` refers to that commit. */
  originalCommitOid: Schema.optional(TrimmedNonEmptyString),
  /** Unified diff excerpt the first comment was written against. */
  diffHunk: Schema.optional(Schema.String),
  isResolved: Schema.Boolean,
  isOutdated: Schema.Boolean,
  resolvedBy: Schema.optional(TrimmedNonEmptyString),
  viewerCanReply: Schema.Boolean,
  viewerCanResolve: Schema.Boolean,
  viewerCanUnresolve: Schema.Boolean,
  comments: Schema.Array(ChangeRequestReviewComment),
  /** Total comments on the host; larger than `comments.length` when paged. */
  totalComments: NonNegativeInt,
});
export type ChangeRequestReviewThread = typeof ChangeRequestReviewThread.Type;

// ── Timeline ──────────────────────────────────────────────────────────

const TimelineBase = {
  id: TrimmedNonEmptyString,
  createdAt: Schema.DateTimeUtc,
  actor: Schema.optional(ChangeRequestActor),
} as const;

export const ChangeRequestTimelineComment = Schema.Struct({
  ...TimelineBase,
  kind: Schema.Literal("comment"),
  body: Schema.String,
  authorAssociation: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.DateTimeUtc),
  url: Schema.optional(Schema.String),
  reactions: Schema.optional(Schema.Array(SourceControlCommentReaction)),
  viewerCanUpdate: Schema.optional(Schema.Boolean),
  viewerCanDelete: Schema.optional(Schema.Boolean),
  isMinimized: Schema.optional(Schema.Boolean),
});

export const ChangeRequestTimelineReview = Schema.Struct({
  ...TimelineBase,
  kind: Schema.Literal("review"),
  state: SourceControlReviewState,
  body: Schema.String,
  authorAssociation: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  reactions: Schema.optional(Schema.Array(SourceControlCommentReaction)),
  /** Review threads opened by this review, so the timeline can nest them. */
  threadIds: Schema.Array(TrimmedNonEmptyString),
  viewerCanUpdate: Schema.optional(Schema.Boolean),
});

export const ChangeRequestTimelineCommit = Schema.Struct({
  ...TimelineBase,
  kind: Schema.Literal("commit"),
  oid: TrimmedNonEmptyString,
  shortOid: TrimmedNonEmptyString,
  messageHeadline: Schema.String,
  messageBody: Schema.optional(Schema.String),
  /** Rollup of the commit's checks, when the host reports one. */
  checkState: Schema.optional(Schema.Literals(["success", "failure", "pending", "neutral"])),
});

export const ChangeRequestTimelineForcePush = Schema.Struct({
  ...TimelineBase,
  kind: Schema.Literal("force-pushed"),
  beforeOid: Schema.optional(TrimmedNonEmptyString),
  afterOid: Schema.optional(TrimmedNonEmptyString),
});

export const ChangeRequestTimelineReviewRequest = Schema.Struct({
  ...TimelineBase,
  kind: Schema.Literals(["review-requested", "review-request-removed"]),
  reviewer: TrimmedNonEmptyString,
  reviewerKind: Schema.Literals(["user", "team", "bot"]),
});

export const ChangeRequestTimelineLabel = Schema.Struct({
  ...TimelineBase,
  kind: Schema.Literals(["labeled", "unlabeled"]),
  label: SourceControlLabel,
});

export const ChangeRequestTimelineAssignment = Schema.Struct({
  ...TimelineBase,
  kind: Schema.Literals(["assigned", "unassigned"]),
  assignee: TrimmedNonEmptyString,
});

export const ChangeRequestTimelineRename = Schema.Struct({
  ...TimelineBase,
  kind: Schema.Literal("renamed"),
  previousTitle: Schema.String,
  currentTitle: Schema.String,
});

export const ChangeRequestTimelineMerged = Schema.Struct({
  ...TimelineBase,
  kind: Schema.Literal("merged"),
  commitOid: Schema.optional(TrimmedNonEmptyString),
  baseRefName: Schema.optional(TrimmedNonEmptyString),
});

export const ChangeRequestTimelineLifecycle = Schema.Struct({
  ...TimelineBase,
  kind: Schema.Literals([
    "closed",
    "reopened",
    "ready-for-review",
    "converted-to-draft",
    "head-ref-deleted",
    "head-ref-restored",
  ]),
});

export const ChangeRequestTimelineBaseChanged = Schema.Struct({
  ...TimelineBase,
  kind: Schema.Literal("base-ref-changed"),
  previousRefName: Schema.optional(TrimmedNonEmptyString),
  currentRefName: Schema.optional(TrimmedNonEmptyString),
});

export const ChangeRequestTimelineCrossReference = Schema.Struct({
  ...TimelineBase,
  kind: Schema.Literal("cross-referenced"),
  source: Schema.Struct({
    kind: Schema.Literals(["issue", "change-request"]),
    number: PositiveInt,
    title: Schema.String,
    url: Schema.String,
    repository: Schema.optional(TrimmedNonEmptyString),
    state: Schema.optional(Schema.Literals(["open", "closed", "merged"])),
  }),
  willCloseTarget: Schema.optional(Schema.Boolean),
});

export const ChangeRequestTimelineAutoMerge = Schema.Struct({
  ...TimelineBase,
  kind: Schema.Literals(["auto-merge-enabled", "auto-merge-disabled"]),
  mergeMethod: Schema.optional(SourceControlChangeRequestMergeMethod),
});

export const ChangeRequestTimelineReviewDismissed = Schema.Struct({
  ...TimelineBase,
  kind: Schema.Literal("review-dismissed"),
  reviewAuthor: Schema.optional(TrimmedNonEmptyString),
  message: Schema.optional(Schema.String),
});

export const ChangeRequestTimelineItem = Schema.Union([
  ChangeRequestTimelineComment,
  ChangeRequestTimelineReview,
  ChangeRequestTimelineCommit,
  ChangeRequestTimelineForcePush,
  ChangeRequestTimelineReviewRequest,
  ChangeRequestTimelineLabel,
  ChangeRequestTimelineAssignment,
  ChangeRequestTimelineRename,
  ChangeRequestTimelineMerged,
  ChangeRequestTimelineLifecycle,
  ChangeRequestTimelineBaseChanged,
  ChangeRequestTimelineCrossReference,
  ChangeRequestTimelineAutoMerge,
  ChangeRequestTimelineReviewDismissed,
]);
export type ChangeRequestTimelineItem = typeof ChangeRequestTimelineItem.Type;
export type ChangeRequestTimelineItemKind = ChangeRequestTimelineItem["kind"];

// ── Activity (timeline + threads + viewer capabilities) ────────────────

export const ChangeRequestViewerCapabilities = Schema.Struct({
  login: TrimmedNonEmptyString,
  isAuthor: Schema.Boolean,
  /** Edit title/body/base, labels, assignees, reviewers, draft state, close/reopen. */
  canUpdate: Schema.Boolean,
  canMerge: Schema.Boolean,
  canReview: Schema.Boolean,
  canUpdateBranch: Schema.Boolean,
  canEnableAutoMerge: Schema.Boolean,
  canDisableAutoMerge: Schema.Boolean,
});
export type ChangeRequestViewerCapabilities = typeof ChangeRequestViewerCapabilities.Type;

export const ChangeRequestActivityInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  reference: TrimmedNonEmptyString,
});
export type ChangeRequestActivityInput = typeof ChangeRequestActivityInput.Type;

export const ChangeRequestActivity = Schema.Struct({
  provider: SourceControlProviderKind,
  number: PositiveInt,
  headSha: Schema.NullOr(TrimmedNonEmptyString),
  viewer: Schema.NullOr(ChangeRequestViewerCapabilities),
  /** Chronological (oldest first). */
  timeline: Schema.Array(ChangeRequestTimelineItem),
  /** True when older timeline items were dropped to stay within the page budget. */
  timelineTruncated: Schema.Boolean,
  reviewThreads: Schema.Array(ChangeRequestReviewThread),
  reviewThreadsTruncated: Schema.Boolean,
  /** The viewer's unsubmitted host-side review (e.g. started on the web), if any. */
  pendingReview: Schema.NullOr(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      commentsCount: NonNegativeInt,
    }),
  ),
});
export type ChangeRequestActivity = typeof ChangeRequestActivity.Type;

// ── Review mutations ──────────────────────────────────────────────────

export const ChangeRequestReviewEvent = Schema.Literals(["comment", "approve", "request_changes"]);
export type ChangeRequestReviewEvent = typeof ChangeRequestReviewEvent.Type;

export const ChangeRequestDraftReviewComment = Schema.Struct({
  path: TrimmedNonEmptyString,
  body: NonBlankMarkdownBody,
  /** `file` comments attach to the whole file and ignore line/side. */
  subjectType: Schema.optional(Schema.Literals(["line", "file"])),
  line: Schema.optional(PositiveInt),
  side: Schema.optional(ChangeRequestDiffSide),
  startLine: Schema.optional(PositiveInt),
  startSide: Schema.optional(ChangeRequestDiffSide),
});
export type ChangeRequestDraftReviewComment = typeof ChangeRequestDraftReviewComment.Type;

export const ChangeRequestSubmitReviewInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  reference: TrimmedNonEmptyString,
  event: ChangeRequestReviewEvent,
  body: Schema.optional(Schema.String),
  comments: Schema.Array(ChangeRequestDraftReviewComment),
  /** The head the comments were written against; the host anchors lines to it. */
  expectedHeadSha: TrimmedNonEmptyString,
});
export type ChangeRequestSubmitReviewInput = typeof ChangeRequestSubmitReviewInput.Type;

export const ChangeRequestSubmitReviewResult = Schema.Struct({
  reviewId: TrimmedNonEmptyString,
  state: SourceControlReviewState,
  url: Schema.optional(Schema.String),
});
export type ChangeRequestSubmitReviewResult = typeof ChangeRequestSubmitReviewResult.Type;

export const ChangeRequestReplyToThreadInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  reference: TrimmedNonEmptyString,
  threadId: TrimmedNonEmptyString,
  body: NonBlankMarkdownBody,
  clientMutationId: Schema.optional(TrimmedNonEmptyString),
});
export type ChangeRequestReplyToThreadInput = typeof ChangeRequestReplyToThreadInput.Type;

export const ChangeRequestReplyToThreadResult = Schema.Struct({
  thread: ChangeRequestReviewThread,
});
export type ChangeRequestReplyToThreadResult = typeof ChangeRequestReplyToThreadResult.Type;

export const ChangeRequestSetThreadResolvedInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  reference: TrimmedNonEmptyString,
  threadId: TrimmedNonEmptyString,
  resolved: Schema.Boolean,
});
export type ChangeRequestSetThreadResolvedInput = typeof ChangeRequestSetThreadResolvedInput.Type;

export const ChangeRequestSetThreadResolvedResult = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  isResolved: Schema.Boolean,
  resolvedBy: Schema.optional(TrimmedNonEmptyString),
});
export type ChangeRequestSetThreadResolvedResult = typeof ChangeRequestSetThreadResolvedResult.Type;

export const ChangeRequestCommentKind = Schema.Literals([
  "issue-comment",
  "review-comment",
  "review",
]);
export type ChangeRequestCommentKind = typeof ChangeRequestCommentKind.Type;

export const ChangeRequestUpdateCommentInput = Schema.Union([
  Schema.Struct({
    cwd: TrimmedNonEmptyString,
    reference: TrimmedNonEmptyString,
    commentId: TrimmedNonEmptyString,
    commentKind: ChangeRequestCommentKind,
    action: Schema.Literal("edit"),
    body: NonBlankMarkdownBody,
  }),
  Schema.Struct({
    cwd: TrimmedNonEmptyString,
    reference: TrimmedNonEmptyString,
    commentId: TrimmedNonEmptyString,
    commentKind: Schema.Literals(["issue-comment", "review-comment"]),
    action: Schema.Literal("delete"),
  }),
]);
export type ChangeRequestUpdateCommentInput = typeof ChangeRequestUpdateCommentInput.Type;

export const ChangeRequestUpdateCommentResult = Schema.Struct({
  commentId: TrimmedNonEmptyString,
  deleted: Schema.Boolean,
});
export type ChangeRequestUpdateCommentResult = typeof ChangeRequestUpdateCommentResult.Type;

// ── Lifecycle mutations ───────────────────────────────────────────────

const ListEdit = {
  add: Schema.Array(TrimmedNonEmptyString),
  remove: Schema.Array(TrimmedNonEmptyString),
} as const;

export const ChangeRequestUpdateAction = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("edit"),
    title: Schema.optional(TrimmedNonEmptyString),
    body: Schema.optional(Schema.String),
    baseRefName: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({ kind: Schema.Literal("set-draft"), draft: Schema.Boolean }),
  Schema.Struct({
    kind: Schema.Literal("close"),
    deleteBranch: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ kind: Schema.Literal("reopen") }),
  Schema.Struct({ kind: Schema.Literal("reviewers"), ...ListEdit }),
  Schema.Struct({ kind: Schema.Literal("labels"), ...ListEdit }),
  Schema.Struct({ kind: Schema.Literal("assignees"), ...ListEdit }),
  Schema.Struct({
    kind: Schema.Literal("update-branch"),
    method: Schema.Literals(["merge", "rebase"]),
    expectedHeadSha: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("auto-merge"),
    enabled: Schema.Boolean,
    mergeMethod: Schema.optional(SourceControlChangeRequestMergeMethod),
    /** When enabling: refuse if the head moved since the user looked (as for merges). */
    expectedHeadSha: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({ kind: Schema.Literal("delete-branch") }),
]);
export type ChangeRequestUpdateAction = typeof ChangeRequestUpdateAction.Type;
export type ChangeRequestUpdateActionKind = ChangeRequestUpdateAction["kind"];

export const ChangeRequestUpdateInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  reference: TrimmedNonEmptyString,
  action: ChangeRequestUpdateAction,
});
export type ChangeRequestUpdateInput = typeof ChangeRequestUpdateInput.Type;

export const ChangeRequestUpdateResult = Schema.Struct({
  /** Fresh, uncapped (`fullContent`) detail after the action. */
  detail: SourceControlChangeRequestDetail,
});
export type ChangeRequestUpdateResult = typeof ChangeRequestUpdateResult.Type;

export const ChangeRequestCreateInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  baseRefName: TrimmedNonEmptyString,
  /** Branch name, or `owner:branch` for a fork head. */
  headRefName: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  body: Schema.String,
  draft: Schema.optional(Schema.Boolean),
});
export type ChangeRequestCreateInput = typeof ChangeRequestCreateInput.Type;

// ── Diff file contents (hunk expansion) ───────────────────────────────

export const CHANGE_REQUEST_FILE_CONTENTS_MAX_BYTES = 1024 * 1024; // 1 MB per side

export const ChangeRequestFileContentsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  reference: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  /** Pre-rename path on the base side, when the file moved. */
  previousPath: Schema.optional(TrimmedNonEmptyString),
  /**
   * Old-side revision. Omit for the whole change request: the server resolves
   * the merge base of the base branch and `headSha`, matching the PR diff.
   * Pass the parent commit when the diff is scoped to a single commit.
   */
  baseSha: Schema.optional(TrimmedNonEmptyString),
  headSha: TrimmedNonEmptyString,
});
export type ChangeRequestFileContentsInput = typeof ChangeRequestFileContentsInput.Type;

export const ChangeRequestFileContents = Schema.Struct({
  path: TrimmedNonEmptyString,
  /** Null when the file does not exist on that side (added/deleted) or is binary. */
  oldContents: Schema.NullOr(Schema.String),
  newContents: Schema.NullOr(Schema.String),
  truncated: Schema.Boolean,
});
export type ChangeRequestFileContents = typeof ChangeRequestFileContents.Type;

// ── List involvement ──────────────────────────────────────────────────

/** Server-side involvement filter for change request lists (relative to the viewer). */
export const ChangeRequestInvolvement = Schema.Literals([
  "authored",
  "review-requested",
  "assigned",
  "mentioned",
  "involved",
]);
export type ChangeRequestInvolvement = typeof ChangeRequestInvolvement.Type;
