import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { GIT_REF_NAME_PATTERN } from "./settings.ts";
import {
  ChangeRequest,
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

// ── Repository templates for new change requests ──────────────────────

/** A template body is cut to this many bytes of UTF-8, never inside a character. */
export const CHANGE_REQUEST_TEMPLATE_MAX_BYTES = 8_000;
/** Templates read and listed per repository tree, default files first. */
export const CHANGE_REQUEST_TEMPLATE_LIST_MAX = 16;

/** A change request template from the repository's base tree (untrusted repository text). */
export const ChangeRequestTemplate = Schema.Struct({
  /** Repository-relative path, e.g. `.github/PULL_REQUEST_TEMPLATE/bug.md`. */
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
  /** File name without extension; "Default" for the template the host applies on its own. */
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  /** The host applies it on its own (GitHub's default file, GitLab's `default.md`). */
  isDefault: Schema.Boolean,
  /** Byte-bounded below, so this character cap never rejects a read template. */
  body: Schema.String.check(Schema.isMaxLength(CHANGE_REQUEST_TEMPLATE_MAX_BYTES)),
  /** The file was longer than CHANGE_REQUEST_TEMPLATE_MAX_BYTES. */
  truncated: Schema.Boolean,
});
export type ChangeRequestTemplate = typeof ChangeRequestTemplate.Type;

export const ChangeRequestTemplateListInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  /**
   * The branch the change request would target; templates come from its tree (the remote's
   * branch, else the local one, else none). Without it, the remote's default branch, else
   * HEAD. A branch name only: no revision syntax.
   */
  baseRefName: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(256), Schema.isPattern(GIT_REF_NAME_PATTERN)),
  ),
});
export type ChangeRequestTemplateListInput = typeof ChangeRequestTemplateListInput.Type;

export const ChangeRequestTemplateListResult = Schema.Struct({
  templates: Schema.Array(ChangeRequestTemplate).check(
    Schema.isMaxLength(CHANGE_REQUEST_TEMPLATE_LIST_MAX),
  ),
  /**
   * The listed template a generated description follows, which a new description starts from
   * too; null when the server's rule picks none (it never guesses between templates).
   */
  generationTemplatePath: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(1024))),
});
export type ChangeRequestTemplateListResult = typeof ChangeRequestTemplateListResult.Type;

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

// ── Involvement across repositories ───────────────────────────────────

/** Most checkouts one `sourceControl.listInvolvedChangeRequests` call reads through. */
export const INVOLVED_CHANGE_REQUESTS_MAX_CWDS = 64;
/** Rows per involvement and source: one GitHub search page, the lists' superset size. */
export const INVOLVED_CHANGE_REQUESTS_MAX_LIMIT = 100;

export const SourceControlListInvolvedChangeRequestsInput = Schema.Struct({
  /**
   * Checkouts on this node, one per repository. Hosts that search across repositories
   * (GitHub) are read once per host through any one of them.
   */
  cwds: Schema.Array(TrimmedNonEmptyString).check(
    Schema.isMaxLength(INVOLVED_CHANGE_REQUESTS_MAX_CWDS),
  ),
  state: Schema.Literals(["open", "closed", "merged", "all"]),
  involvements: Schema.Array(ChangeRequestInvolvement).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(5),
  ),
  /** Rows per involvement and source; default and maximum 100. */
  limit: Schema.optional(PositiveInt),
  /**
   * Only the host searches (`hosts`, one request per host) or only the per-repository lists
   * (`repositories`, one request per repository); both when absent. Asked apart, a few slow
   * repository lists do not hold back every host's rows.
   */
  sources: Schema.optional(Schema.Literals(["hosts", "repositories"])),
  /**
   * Someone is waiting for this answer (nothing shown yet): reads skip the background queue.
   * Asking again for sources still `loading` should leave it out.
   */
  interactive: Schema.optional(Schema.Boolean),
  /** Someone asked to refresh: interactive, and cached reads older than a few seconds are read again. */
  refresh: Schema.optional(Schema.Boolean),
});
export type SourceControlListInvolvedChangeRequestsInput =
  typeof SourceControlListInvolvedChangeRequestsInput.Type;

export const SourceControlInvolvedChangeRequest = Schema.Struct({
  changeRequest: ChangeRequest,
  /** `changeRequestRepositoryKey` of its URL (`github.com/acme/app`, `azure:org/project/repo`). */
  repositoryKey: TrimmedNonEmptyString,
  /** `acme/app`. */
  repositoryLabel: TrimmedNonEmptyString,
  /** The viewer's involvements this row matched. */
  involvements: Schema.Array(ChangeRequestInvolvement),
});
export type SourceControlInvolvedChangeRequest = typeof SourceControlInvolvedChangeRequest.Type;

export const SourceControlInvolvedChangeRequestsSource = Schema.Struct({
  /** `host`: one search across every repository on the host; `repository`: one checkout's lists. */
  scope: Schema.Literals(["host", "repository"]),
  provider: SourceControlProviderKind,
  /** The host (`github.com`) or the repository label (`acme/tools`). */
  name: TrimmedNonEmptyString,
  /**
   * A host source read through checkouts whose remotes name another host: the SSH host
   * alias (`github.com-work` in `git@github.com-work:acme/app.git`) that `name` resolved
   * from. Its rows' keys use `name`; the checkouts' remotes use this.
   */
  checkoutHost: Schema.optional(TrimmedNonEmptyString),
  /**
   * `loading`: a read was still running when the answer was due; it keeps running and fills
   * the server's cache, so asking again (without `refresh`) a few seconds later returns it.
   * `paused`: the host is rate limited until `retryAt`. A closed set: a status added later
   * must map to `failed`, since an older client cannot decode a literal it does not know.
   */
  status: Schema.Literals(["ok", "failed", "loading", "paused"]),
  /** The account the host answered for, where it says (GitHub `viewer.login`). */
  viewerLogin: Schema.optional(TrimmedNonEmptyString),
  /** More rows matched than were returned. */
  truncated: Schema.Boolean,
  /**
   * Rows the host matched but would not show this account, such as pull requests in
   * organizations that enforce SAML single sign-on or restrict OAuth apps.
   */
  skippedRows: Schema.optional(NonNegativeInt),
  /** One sentence for a failed or paused read, without the command line. */
  message: Schema.optional(TrimmedNonEmptyString),
  /** Epoch ms when a paused host accepts requests again. */
  retryAt: Schema.optional(NonNegativeInt),
});
export type SourceControlInvolvedChangeRequestsSource =
  typeof SourceControlInvolvedChangeRequestsSource.Type;

export const SourceControlInvolvedChangeRequestsResult = Schema.Struct({
  /** Newest activity first. */
  entries: Schema.Array(SourceControlInvolvedChangeRequest),
  sources: Schema.Array(SourceControlInvolvedChangeRequestsSource),
  /** Checkouts with no host that lists change requests (no remote, unknown host). */
  skippedCwds: Schema.Array(TrimmedNonEmptyString),
  /** Rows past the response cap were dropped (the least recently updated). */
  truncated: Schema.Boolean,
});
export type SourceControlInvolvedChangeRequestsResult =
  typeof SourceControlInvolvedChangeRequestsResult.Type;
