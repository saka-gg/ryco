import { DateTime, Effect, Exit, Result, Schema } from "effect";
import {
  ChangeRequestReviewComment,
  ChangeRequestReviewThread,
  ChangeRequestTimelineItem,
  ChangeRequestViewerCapabilities,
  type ChangeRequestActivity,
  type ChangeRequestActor,
  type ChangeRequestDiffSide,
  type ChangeRequestSetThreadResolvedResult,
  type SourceControlChangeRequestMergeMethod,
} from "@ryco/contracts";
import { decodeJsonResult, formatSchemaError } from "@ryco/shared/schemaJson";

import { stripCommentMutationMarker } from "./gitHubCommentMutationMarker.ts";
import { normalizeGitHubReviewState } from "./gitHubPullRequests.ts";
import { normalizeReactionGroups, RawGitHubReactionGroupSchema } from "./gitHubReactions.ts";

/**
 * GitHub review conversation reads for the dedicated pull request page:
 * GraphQL documents, lenient wire schemas, and normalization into the
 * `ChangeRequestActivity` contract.
 *
 * Decoding is deliberately per-node: one malformed (or newly introduced)
 * timeline node or thread is skipped instead of failing the whole read, and
 * every normalized item is re-checked against its contract schema so the RPC
 * encoder can never reject the response.
 */

// ── Bounds ────────────────────────────────────────────────────────────

export const GITHUB_ACTIVITY_PAGE_SIZE = 100;
/** Newest timeline pages walked backwards (500 items); older history is reported as truncated. */
export const GITHUB_ACTIVITY_TIMELINE_MAX_PAGES = 5;
/** Review thread pages walked forwards (500 threads). */
export const GITHUB_ACTIVITY_REVIEW_THREAD_MAX_PAGES = 5;
/** Comments carried per thread in the activity read; `totalComments` reports the rest. */
export const GITHUB_ACTIVITY_THREAD_COMMENTS = 30;
/** Comments carried when one thread is re-read after a reply. */
export const GITHUB_REVIEW_THREAD_COMMENTS_MAX = 100;

// ── GraphQL documents ─────────────────────────────────────────────────

const ACTOR_FIELDS = "{ __typename login avatarUrl }";
const REACTION_GROUP_FIELDS = "reactionGroups { content viewerHasReacted reactors { totalCount } }";

/** Every `PullRequestTimelineItemsItemType` the contract has a kind for. */
export const GITHUB_ACTIVITY_TIMELINE_ITEM_TYPES = [
  "ISSUE_COMMENT",
  "PULL_REQUEST_REVIEW",
  "PULL_REQUEST_COMMIT",
  "HEAD_REF_FORCE_PUSHED_EVENT",
  "REVIEW_REQUESTED_EVENT",
  "REVIEW_REQUEST_REMOVED_EVENT",
  "LABELED_EVENT",
  "UNLABELED_EVENT",
  "ASSIGNED_EVENT",
  "UNASSIGNED_EVENT",
  "RENAMED_TITLE_EVENT",
  "MERGED_EVENT",
  "CLOSED_EVENT",
  "REOPENED_EVENT",
  "READY_FOR_REVIEW_EVENT",
  "CONVERT_TO_DRAFT_EVENT",
  "HEAD_REF_DELETED_EVENT",
  "HEAD_REF_RESTORED_EVENT",
  "BASE_REF_CHANGED_EVENT",
  "CROSS_REFERENCED_EVENT",
  "AUTO_MERGE_ENABLED_EVENT",
  "AUTO_SQUASH_ENABLED_EVENT",
  "AUTO_REBASE_ENABLED_EVENT",
  "AUTO_MERGE_DISABLED_EVENT",
  "REVIEW_DISMISSED_EVENT",
] as const;

const REVIEWER_FIELDS =
  "{ __typename ... on User { login avatarUrl } ... on Bot { login avatarUrl } ... on Mannequin { login avatarUrl } ... on Team { slug organization { login } } }";
const ASSIGNEE_FIELDS =
  "{ __typename ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Organization { login } }";
const EVENT_FIELDS = `id createdAt actor ${ACTOR_FIELDS}`;

const TIMELINE_NODE_FIELDS = `
          __typename
          ... on IssueComment { id createdAt updatedAt lastEditedAt author ${ACTOR_FIELDS} authorAssociation body url isMinimized viewerCanUpdate viewerCanDelete ${REACTION_GROUP_FIELDS} }
          ... on PullRequestReview { id createdAt submittedAt author ${ACTOR_FIELDS} authorAssociation state body url viewerCanUpdate ${REACTION_GROUP_FIELDS} }
          ... on PullRequestCommit { id commit { oid abbreviatedOid messageHeadline messageBody committedDate author { name user ${ACTOR_FIELDS} } statusCheckRollup { state } } }
          ... on HeadRefForcePushedEvent { ${EVENT_FIELDS} beforeCommit { oid } afterCommit { oid } }
          ... on ReviewRequestedEvent { ${EVENT_FIELDS} requestedReviewer ${REVIEWER_FIELDS} }
          ... on ReviewRequestRemovedEvent { ${EVENT_FIELDS} requestedReviewer ${REVIEWER_FIELDS} }
          ... on LabeledEvent { ${EVENT_FIELDS} label { name color description } }
          ... on UnlabeledEvent { ${EVENT_FIELDS} label { name color description } }
          ... on AssignedEvent { ${EVENT_FIELDS} assignee ${ASSIGNEE_FIELDS} }
          ... on UnassignedEvent { ${EVENT_FIELDS} assignee ${ASSIGNEE_FIELDS} }
          ... on RenamedTitleEvent { ${EVENT_FIELDS} previousTitle currentTitle }
          ... on MergedEvent { ${EVENT_FIELDS} commit { oid } mergeRefName }
          ... on ClosedEvent { ${EVENT_FIELDS} }
          ... on ReopenedEvent { ${EVENT_FIELDS} }
          ... on ReadyForReviewEvent { ${EVENT_FIELDS} }
          ... on ConvertToDraftEvent { ${EVENT_FIELDS} }
          ... on HeadRefDeletedEvent { ${EVENT_FIELDS} }
          ... on HeadRefRestoredEvent { ${EVENT_FIELDS} }
          ... on BaseRefChangedEvent { ${EVENT_FIELDS} previousRefName currentRefName }
          ... on CrossReferencedEvent { ${EVENT_FIELDS} willCloseTarget source { __typename ... on Issue { number title url state repository { nameWithOwner } } ... on PullRequest { number title url state repository { nameWithOwner } } } }
          ... on AutoMergeEnabledEvent { ${EVENT_FIELDS} }
          ... on AutoSquashEnabledEvent { ${EVENT_FIELDS} }
          ... on AutoRebaseEnabledEvent { ${EVENT_FIELDS} }
          ... on AutoMergeDisabledEvent { ${EVENT_FIELDS} }
          ... on ReviewDismissedEvent { ${EVENT_FIELDS} dismissalMessage review { author { login } } }`;

const timelineConnection = (cursorArgument: string) =>
  `timelineItems(last: ${GITHUB_ACTIVITY_PAGE_SIZE}${cursorArgument}, itemTypes: [${GITHUB_ACTIVITY_TIMELINE_ITEM_TYPES.join(", ")}]) {
        pageInfo { hasPreviousPage startCursor }
        nodes {${TIMELINE_NODE_FIELDS}
        }
      }`;

const reviewThreadFields = (commentsFirst: number) => `
          id path line startLine originalLine originalStartLine diffSide startDiffSide subjectType
          isResolved isOutdated resolvedBy { login }
          viewerCanReply viewerCanResolve viewerCanUnresolve
          comments(first: ${commentsFirst}) {
            totalCount
            nodes { id author ${ACTOR_FIELDS} authorAssociation body createdAt updatedAt url diffHunk state isMinimized viewerCanUpdate viewerCanDelete pullRequestReview { id } originalCommit { oid } ${REACTION_GROUP_FIELDS} }
          }`;

const reviewThreadConnection = (cursorArgument: string) =>
  `reviewThreads(first: ${GITHUB_ACTIVITY_PAGE_SIZE}${cursorArgument}) {
        pageInfo { hasNextPage endCursor }
        nodes {${reviewThreadFields(GITHUB_ACTIVITY_THREAD_COMMENTS)}
        }
      }`;

/**
 * First activity read: viewer capabilities, the viewer's pending review, the
 * newest timeline page, and the first review thread page in one round trip.
 */
export const GITHUB_PULL_REQUEST_ACTIVITY_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    viewerPermission
    pullRequest(number: $number) {
      id number state locked headRefOid
      author ${ACTOR_FIELDS}
      viewerDidAuthor viewerCanUpdate viewerCanUpdateBranch viewerCanEnableAutoMerge viewerCanDisableAutoMerge
      pendingReviews: reviews(states: [PENDING], first: 1) { nodes { id author { login } comments { totalCount } } }
      ${timelineConnection("")}
      ${reviewThreadConnection("")}
    }
  }
}`;

/** Older timeline history, walked backwards so the newest items always survive the bound. */
export const GITHUB_PULL_REQUEST_TIMELINE_PAGE_QUERY = `query($owner: String!, $name: String!, $number: Int!, $before: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      ${timelineConnection(", before: $before")}
    }
  }
}`;

export const GITHUB_PULL_REQUEST_REVIEW_THREADS_PAGE_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      ${reviewThreadConnection(", after: $after")}
    }
  }
}`;

/** One review thread by node id, with the pull request it belongs to for scope checks. */
export const GITHUB_REVIEW_THREAD_NODE_QUERY = `query($id: ID!) {
  node(id: $id) {
    __typename
    ... on PullRequestReviewThread {
      pullRequest { number repository { nameWithOwner } }
      ${reviewThreadFields(GITHUB_REVIEW_THREAD_COMMENTS_MAX)}
    }
  }
}`;

/**
 * Which pull request a comment, review comment, review, or review thread hangs
 * off. Read before a mutation so a node id from another pull request cannot be
 * mutated through this one's reference.
 */
export const GITHUB_NODE_SCOPE_QUERY = `query($id: ID!) {
  node(id: $id) {
    __typename
    ... on PullRequestReviewThread { id pullRequest { number repository { nameWithOwner } } }
    ... on IssueComment { id pullRequest { number repository { nameWithOwner } } }
    ... on PullRequestReviewComment { id pullRequest { number repository { nameWithOwner } } }
    ... on PullRequestReview { id pullRequest { number repository { nameWithOwner } } }
  }
}`;

// ── Wire schemas ──────────────────────────────────────────────────────

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));
const OptionalBoolean = Schema.optional(Schema.NullOr(Schema.Boolean));
const OptionalNumber = Schema.optional(Schema.NullOr(Schema.Number));

const RawActorSchema = Schema.Struct({
  __typename: OptionalString,
  login: OptionalString,
  avatarUrl: OptionalString,
});
type RawActor = typeof RawActorSchema.Type;

const RawLoginSchema = Schema.Struct({ login: OptionalString });
const RawReactionGroupsSchema = Schema.optional(
  Schema.NullOr(Schema.Array(RawGitHubReactionGroupSchema)),
);
const RawPullRequestScopeSchema = Schema.Struct({
  number: Schema.Number,
  repository: Schema.optional(Schema.NullOr(Schema.Struct({ nameWithOwner: OptionalString }))),
});

const GraphQlErrorsSchema = Schema.optional(
  Schema.NullOr(
    Schema.Array(
      Schema.NullOr(
        Schema.Struct({
          message: OptionalString,
          path: Schema.optional(
            Schema.NullOr(Schema.Array(Schema.Union([Schema.String, Schema.Number]))),
          ),
        }),
      ),
    ),
  ),
);

/**
 * Superset of every timeline node shape. Every field is optional so the
 * struct decode only fails on genuinely mistyped data; `normalizeTimelineNode`
 * then decides per `__typename` whether the node carries what its kind needs.
 */
const RawTimelineNodeSchema = Schema.Struct({
  __typename: Schema.String,
  id: OptionalString,
  createdAt: OptionalString,
  updatedAt: OptionalString,
  lastEditedAt: OptionalString,
  submittedAt: OptionalString,
  actor: Schema.optional(Schema.NullOr(RawActorSchema)),
  author: Schema.optional(Schema.NullOr(RawActorSchema)),
  authorAssociation: OptionalString,
  body: OptionalString,
  url: OptionalString,
  state: OptionalString,
  isMinimized: OptionalBoolean,
  viewerCanUpdate: OptionalBoolean,
  viewerCanDelete: OptionalBoolean,
  reactionGroups: RawReactionGroupsSchema,
  commit: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        oid: OptionalString,
        abbreviatedOid: OptionalString,
        messageHeadline: OptionalString,
        messageBody: OptionalString,
        committedDate: OptionalString,
        author: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              name: OptionalString,
              user: Schema.optional(Schema.NullOr(RawActorSchema)),
            }),
          ),
        ),
        statusCheckRollup: Schema.optional(Schema.NullOr(Schema.Struct({ state: OptionalString }))),
      }),
    ),
  ),
  beforeCommit: Schema.optional(Schema.NullOr(Schema.Struct({ oid: OptionalString }))),
  afterCommit: Schema.optional(Schema.NullOr(Schema.Struct({ oid: OptionalString }))),
  requestedReviewer: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        __typename: OptionalString,
        login: OptionalString,
        avatarUrl: OptionalString,
        slug: OptionalString,
        organization: Schema.optional(Schema.NullOr(RawLoginSchema)),
      }),
    ),
  ),
  label: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ name: OptionalString, color: OptionalString, description: OptionalString }),
    ),
  ),
  assignee: Schema.optional(
    Schema.NullOr(Schema.Struct({ __typename: OptionalString, login: OptionalString })),
  ),
  previousTitle: OptionalString,
  currentTitle: OptionalString,
  mergeRefName: OptionalString,
  previousRefName: OptionalString,
  currentRefName: OptionalString,
  willCloseTarget: OptionalBoolean,
  source: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        __typename: OptionalString,
        number: OptionalNumber,
        title: OptionalString,
        url: OptionalString,
        state: OptionalString,
        repository: Schema.optional(
          Schema.NullOr(Schema.Struct({ nameWithOwner: OptionalString })),
        ),
      }),
    ),
  ),
  dismissalMessage: OptionalString,
  review: Schema.optional(
    Schema.NullOr(Schema.Struct({ author: Schema.optional(Schema.NullOr(RawLoginSchema)) })),
  ),
});
export type RawGitHubTimelineNode = typeof RawTimelineNodeSchema.Type;

const RawThreadCommentSchema = Schema.Struct({
  id: Schema.String,
  author: Schema.optional(Schema.NullOr(RawActorSchema)),
  authorAssociation: OptionalString,
  body: Schema.String,
  createdAt: Schema.String,
  updatedAt: OptionalString,
  url: OptionalString,
  diffHunk: OptionalString,
  state: OptionalString,
  isMinimized: OptionalBoolean,
  viewerCanUpdate: OptionalBoolean,
  viewerCanDelete: OptionalBoolean,
  pullRequestReview: Schema.optional(Schema.NullOr(Schema.Struct({ id: OptionalString }))),
  originalCommit: Schema.optional(Schema.NullOr(Schema.Struct({ oid: OptionalString }))),
  reactionGroups: RawReactionGroupsSchema,
});

const RawReviewThreadSchema = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  line: OptionalNumber,
  startLine: OptionalNumber,
  originalLine: OptionalNumber,
  originalStartLine: OptionalNumber,
  diffSide: OptionalString,
  startDiffSide: OptionalString,
  subjectType: OptionalString,
  isResolved: Schema.Boolean,
  isOutdated: Schema.Boolean,
  resolvedBy: Schema.optional(Schema.NullOr(RawLoginSchema)),
  viewerCanReply: OptionalBoolean,
  viewerCanResolve: OptionalBoolean,
  viewerCanUnresolve: OptionalBoolean,
  comments: Schema.Struct({
    totalCount: Schema.Number,
    nodes: Schema.Array(Schema.Unknown),
  }),
});

const RawTimelineConnectionSchema = Schema.Struct({
  pageInfo: Schema.Struct({ hasPreviousPage: Schema.Boolean, startCursor: OptionalString }),
  nodes: Schema.Array(Schema.Unknown),
});

const RawReviewThreadConnectionSchema = Schema.Struct({
  pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: OptionalString }),
  nodes: Schema.Array(Schema.Unknown),
});

const RawActivityResponseSchema = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        viewer: Schema.optional(Schema.NullOr(RawLoginSchema)),
        repository: Schema.NullOr(
          Schema.Struct({
            viewerPermission: OptionalString,
            pullRequest: Schema.NullOr(
              Schema.Struct({
                id: Schema.String,
                number: Schema.Number,
                state: Schema.String,
                locked: OptionalBoolean,
                headRefOid: OptionalString,
                author: Schema.optional(Schema.NullOr(RawActorSchema)),
                viewerDidAuthor: OptionalBoolean,
                viewerCanUpdate: OptionalBoolean,
                viewerCanUpdateBranch: OptionalBoolean,
                viewerCanEnableAutoMerge: OptionalBoolean,
                viewerCanDisableAutoMerge: OptionalBoolean,
                pendingReviews: Schema.optional(
                  Schema.NullOr(
                    Schema.Struct({
                      nodes: Schema.Array(
                        Schema.NullOr(
                          Schema.Struct({
                            id: Schema.String,
                            author: Schema.optional(Schema.NullOr(RawLoginSchema)),
                            comments: Schema.optional(
                              Schema.NullOr(Schema.Struct({ totalCount: Schema.Number })),
                            ),
                          }),
                        ),
                      ),
                    }),
                  ),
                ),
                timelineItems: RawTimelineConnectionSchema,
                reviewThreads: RawReviewThreadConnectionSchema,
              }),
            ),
          }),
        ),
      }),
    ),
  ),
  errors: GraphQlErrorsSchema,
});

const pullRequestPageSchema = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.Struct({
    data: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          repository: Schema.NullOr(
            Schema.Struct({ pullRequest: Schema.NullOr(Schema.Struct(fields)) }),
          ),
        }),
      ),
    ),
    errors: GraphQlErrorsSchema,
  });

const RawTimelinePageResponseSchema = pullRequestPageSchema({
  timelineItems: RawTimelineConnectionSchema,
});
const RawReviewThreadsPageResponseSchema = pullRequestPageSchema({
  reviewThreads: RawReviewThreadConnectionSchema,
});

const RawReviewThreadNodeResponseSchema = Schema.Struct({
  data: Schema.optional(Schema.NullOr(Schema.Struct({ node: Schema.NullOr(Schema.Unknown) }))),
  errors: GraphQlErrorsSchema,
});

const RawScopedNodeSchema = Schema.Struct({
  __typename: Schema.String,
  pullRequest: Schema.optional(Schema.NullOr(RawPullRequestScopeSchema)),
});

const RawNodeScopeResponseSchema = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        node: Schema.NullOr(
          Schema.Struct({
            __typename: Schema.String,
            pullRequest: Schema.optional(Schema.NullOr(RawPullRequestScopeSchema)),
          }),
        ),
      }),
    ),
  ),
  errors: GraphQlErrorsSchema,
});

const RawResolveThreadResponseSchema = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(
      Schema.Record(
        Schema.String,
        Schema.NullOr(
          Schema.Struct({
            thread: Schema.NullOr(
              Schema.Struct({
                id: Schema.String,
                isResolved: Schema.Boolean,
                resolvedBy: Schema.optional(Schema.NullOr(RawLoginSchema)),
              }),
            ),
          }),
        ),
      ),
    ),
  ),
  errors: GraphQlErrorsSchema,
});

const decodeActivityResponse = decodeJsonResult(RawActivityResponseSchema);
const decodeTimelinePageResponse = decodeJsonResult(RawTimelinePageResponseSchema);
const decodeReviewThreadsPageResponse = decodeJsonResult(RawReviewThreadsPageResponseSchema);
const decodeReviewThreadNodeResponse = decodeJsonResult(RawReviewThreadNodeResponseSchema);
const decodeNodeScopeResponse = decodeJsonResult(RawNodeScopeResponseSchema);
const decodeResolveThreadResponse = decodeJsonResult(RawResolveThreadResponseSchema);
const decodeTimelineNode = Schema.decodeUnknownExit(RawTimelineNodeSchema);
const decodeReviewThreadNode = Schema.decodeUnknownExit(RawReviewThreadSchema);
const decodeThreadCommentNode = Schema.decodeUnknownExit(RawThreadCommentSchema);
const decodeScopedNode = Schema.decodeUnknownExit(RawScopedNodeSchema);

const isTimelineItem = Schema.is(ChangeRequestTimelineItem);
const isReviewThread = Schema.is(ChangeRequestReviewThread);
const isReviewComment = Schema.is(ChangeRequestReviewComment);
const isViewerCapabilities = Schema.is(ChangeRequestViewerCapabilities);

// ── Normalization helpers ─────────────────────────────────────────────

type GraphQlErrors =
  | ReadonlyArray<{
      readonly message?: string | null | undefined;
      readonly path?: ReadonlyArray<string | number> | null | undefined;
    } | null>
  | null
  | undefined;

export function graphQlErrorMessage(errors: GraphQlErrors): string | null {
  if (!errors || errors.length === 0) return null;
  const messages = errors.flatMap((error) => {
    const message = error?.message?.trim();
    return message ? [message] : [];
  });
  return messages.length > 0 ? messages.join("; ") : "GitHub GraphQL returned errors.";
}

/**
 * Commit check rollups are optional enrichment: tokens without checks access
 * (GitHub App installations, fine-grained PATs) get a FORBIDDEN error on that
 * field only. Those errors must not discard the rest of the conversation.
 */
function blockingActivityErrors(errors: GraphQlErrors): string | null {
  return graphQlErrorMessage(
    errors?.filter((error) => !error?.path?.some((segment) => segment === "statusCheckRollup")),
  );
}

function trimmed(value: string | null | undefined): string | null {
  const result = value?.trim() ?? "";
  return result.length > 0 ? result : null;
}

function parseUtc(value: string | null | undefined): DateTime.Utc | null {
  const text = trimmed(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? DateTime.fromDateUnsafe(date) : null;
}

function positiveInt(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function normalizeActor(raw: RawActor | null | undefined): ChangeRequestActor | undefined {
  const login = trimmed(raw?.login);
  if (!login) return undefined;
  const avatarUrl = trimmed(raw?.avatarUrl);
  return {
    login,
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(raw?.__typename === "Bot" ? { isBot: true } : {}),
  };
}

function normalizeDiffSide(value: string | null | undefined): ChangeRequestDiffSide | null {
  switch (value?.trim().toUpperCase()) {
    case "LEFT":
      return "left";
    case "RIGHT":
      return "right";
    default:
      return null;
  }
}

function normalizeCheckState(
  value: string | null | undefined,
): "success" | "failure" | "pending" | "neutral" | null {
  switch (value?.trim().toUpperCase()) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    case "NEUTRAL":
    case "SKIPPED":
      return "neutral";
    default:
      return null;
  }
}

function normalizeReferenceState(
  value: string | null | undefined,
): "open" | "closed" | "merged" | null {
  switch (value?.trim().toUpperCase()) {
    case "OPEN":
      return "open";
    case "CLOSED":
      return "closed";
    case "MERGED":
      return "merged";
    default:
      return null;
  }
}

function reviewerIdentity(
  raw: NonNullable<RawGitHubTimelineNode["requestedReviewer"]>,
): { readonly reviewer: string; readonly reviewerKind: "user" | "team" | "bot" } | null {
  if (raw.__typename === "Team") {
    const slug = trimmed(raw.slug);
    if (!slug) return null;
    const organization = trimmed(raw.organization?.login);
    return { reviewer: organization ? `${organization}/${slug}` : slug, reviewerKind: "team" };
  }
  const login = trimmed(raw.login);
  if (!login) return null;
  return { reviewer: login, reviewerKind: raw.__typename === "Bot" ? "bot" : "user" };
}

function bodyOf(value: string | null | undefined): string {
  return stripCommentMutationMarker(value ?? "");
}

type PresentFields<T> = { [K in keyof T]?: NonNullable<T[K]> };

/** Keep only the fields that carry a value, so optional contract fields stay absent. */
function optionalFields<T extends Record<string, unknown>>(fields: T): PresentFields<T> {
  const result: PresentFields<T> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null && value !== undefined) {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

const AUTO_MERGE_METHODS: Partial<Record<string, SourceControlChangeRequestMergeMethod>> = {
  AutoMergeEnabledEvent: "merge",
  AutoSquashEnabledEvent: "squash",
  AutoRebaseEnabledEvent: "rebase",
};

const LIFECYCLE_KINDS = {
  ClosedEvent: "closed",
  ReopenedEvent: "reopened",
  ReadyForReviewEvent: "ready-for-review",
  ConvertToDraftEvent: "converted-to-draft",
  HeadRefDeletedEvent: "head-ref-deleted",
  HeadRefRestoredEvent: "head-ref-restored",
} as const;

/**
 * Normalize one decoded timeline node. Returns null (skip) for unknown types
 * and for nodes missing what their kind requires.
 */
export function normalizeGitHubTimelineNode(
  node: RawGitHubTimelineNode,
  threadIdsByReviewId: ReadonlyMap<string, ReadonlyArray<string>>,
): ChangeRequestTimelineItem | null {
  const id = trimmed(node.id);
  if (!id) return null;
  const actor = normalizeActor(node.actor ?? node.author);
  const base = (createdAt: DateTime.Utc | null) =>
    createdAt ? { id, createdAt, ...(actor ? { actor } : {}) } : null;

  const item = ((): ChangeRequestTimelineItem | null => {
    switch (node.__typename) {
      case "IssueComment": {
        const head = base(parseUtc(node.createdAt));
        if (!head) return null;
        const reactions = normalizeReactionGroups(node.reactionGroups ?? undefined);
        const updatedAt = parseUtc(node.lastEditedAt) ?? null;
        return {
          ...head,
          kind: "comment",
          body: bodyOf(node.body),
          ...optionalFields({
            authorAssociation: trimmed(node.authorAssociation),
            updatedAt,
            url: trimmed(node.url),
            viewerCanUpdate: node.viewerCanUpdate,
            viewerCanDelete: node.viewerCanDelete,
            isMinimized: node.isMinimized,
          }),
          ...(reactions.length > 0 ? { reactions } : {}),
        };
      }
      case "PullRequestReview": {
        const head = base(parseUtc(node.submittedAt) ?? parseUtc(node.createdAt));
        const state = normalizeGitHubReviewState(node.state);
        if (!head || !state) return null;
        const reactions = normalizeReactionGroups(node.reactionGroups ?? undefined);
        return {
          ...head,
          kind: "review",
          state,
          body: bodyOf(node.body),
          threadIds: threadIdsByReviewId.get(id) ?? [],
          ...optionalFields({
            authorAssociation: trimmed(node.authorAssociation),
            url: trimmed(node.url),
            viewerCanUpdate: node.viewerCanUpdate,
          }),
          ...(reactions.length > 0 ? { reactions } : {}),
        };
      }
      case "PullRequestCommit": {
        const commit = node.commit;
        const oid = trimmed(commit?.oid);
        const createdAt = parseUtc(commit?.committedDate);
        if (!commit || !oid || !createdAt) return null;
        const commitActor =
          normalizeActor(commit.author?.user) ??
          (trimmed(commit.author?.name) ? { login: trimmed(commit.author?.name)! } : undefined);
        const messageBody = trimmed(commit.messageBody);
        return {
          id,
          createdAt,
          ...(commitActor ? { actor: commitActor } : {}),
          kind: "commit",
          oid,
          shortOid: trimmed(commit.abbreviatedOid) ?? oid.slice(0, 7),
          messageHeadline: commit.messageHeadline ?? "",
          ...(messageBody ? { messageBody: commit.messageBody ?? "" } : {}),
          ...optionalFields({ checkState: normalizeCheckState(commit.statusCheckRollup?.state) }),
        };
      }
      case "HeadRefForcePushedEvent": {
        const head = base(parseUtc(node.createdAt));
        if (!head) return null;
        return {
          ...head,
          kind: "force-pushed",
          ...optionalFields({
            beforeOid: trimmed(node.beforeCommit?.oid),
            afterOid: trimmed(node.afterCommit?.oid),
          }),
        };
      }
      case "ReviewRequestedEvent":
      case "ReviewRequestRemovedEvent": {
        const head = base(parseUtc(node.createdAt));
        const reviewer = node.requestedReviewer ? reviewerIdentity(node.requestedReviewer) : null;
        if (!head || !reviewer) return null;
        return {
          ...head,
          kind:
            node.__typename === "ReviewRequestedEvent"
              ? "review-requested"
              : "review-request-removed",
          ...reviewer,
        };
      }
      case "LabeledEvent":
      case "UnlabeledEvent": {
        const head = base(parseUtc(node.createdAt));
        const name = trimmed(node.label?.name);
        if (!head || !name) return null;
        return {
          ...head,
          kind: node.__typename === "LabeledEvent" ? "labeled" : "unlabeled",
          label: {
            name,
            ...optionalFields({
              color: trimmed(node.label?.color),
              description: trimmed(node.label?.description),
            }),
          },
        };
      }
      case "AssignedEvent":
      case "UnassignedEvent": {
        const head = base(parseUtc(node.createdAt));
        const assignee = trimmed(node.assignee?.login);
        if (!head || !assignee) return null;
        return {
          ...head,
          kind: node.__typename === "AssignedEvent" ? "assigned" : "unassigned",
          assignee,
        };
      }
      case "RenamedTitleEvent": {
        const head = base(parseUtc(node.createdAt));
        if (!head) return null;
        return {
          ...head,
          kind: "renamed",
          previousTitle: node.previousTitle ?? "",
          currentTitle: node.currentTitle ?? "",
        };
      }
      case "MergedEvent": {
        const head = base(parseUtc(node.createdAt));
        if (!head) return null;
        return {
          ...head,
          kind: "merged",
          ...optionalFields({
            commitOid: trimmed(node.commit?.oid),
            baseRefName: trimmed(node.mergeRefName),
          }),
        };
      }
      case "ClosedEvent":
      case "ReopenedEvent":
      case "ReadyForReviewEvent":
      case "ConvertToDraftEvent":
      case "HeadRefDeletedEvent":
      case "HeadRefRestoredEvent": {
        const head = base(parseUtc(node.createdAt));
        if (!head) return null;
        return { ...head, kind: LIFECYCLE_KINDS[node.__typename] };
      }
      case "BaseRefChangedEvent": {
        const head = base(parseUtc(node.createdAt));
        if (!head) return null;
        return {
          ...head,
          kind: "base-ref-changed",
          ...optionalFields({
            previousRefName: trimmed(node.previousRefName),
            currentRefName: trimmed(node.currentRefName),
          }),
        };
      }
      case "CrossReferencedEvent": {
        const head = base(parseUtc(node.createdAt));
        const source = node.source;
        const number = positiveInt(source?.number);
        const kind =
          source?.__typename === "PullRequest"
            ? "change-request"
            : source?.__typename === "Issue"
              ? "issue"
              : null;
        if (!head || !source || !number || !kind) return null;
        return {
          ...head,
          kind: "cross-referenced",
          source: {
            kind,
            number,
            title: source.title ?? "",
            url: source.url ?? "",
            ...optionalFields({
              repository: trimmed(source.repository?.nameWithOwner),
              state: normalizeReferenceState(source.state),
            }),
          },
          ...optionalFields({ willCloseTarget: node.willCloseTarget }),
        };
      }
      case "AutoMergeEnabledEvent":
      case "AutoSquashEnabledEvent":
      case "AutoRebaseEnabledEvent":
      case "AutoMergeDisabledEvent": {
        const head = base(parseUtc(node.createdAt));
        if (!head) return null;
        const mergeMethod = AUTO_MERGE_METHODS[node.__typename];
        return {
          ...head,
          kind:
            node.__typename === "AutoMergeDisabledEvent"
              ? "auto-merge-disabled"
              : "auto-merge-enabled",
          ...(mergeMethod ? { mergeMethod } : {}),
        };
      }
      case "ReviewDismissedEvent": {
        const head = base(parseUtc(node.createdAt));
        if (!head) return null;
        return {
          ...head,
          kind: "review-dismissed",
          ...optionalFields({
            reviewAuthor: trimmed(node.review?.author?.login),
            message: trimmed(node.dismissalMessage) ? node.dismissalMessage : null,
          }),
        };
      }
      default:
        return null;
    }
  })();

  return item && isTimelineItem(item) ? item : null;
}

/** Decode raw timeline nodes, dropping any that do not match the wire schema. */
export function decodeGitHubTimelineNodes(
  nodes: ReadonlyArray<unknown>,
): ReadonlyArray<RawGitHubTimelineNode> {
  const decoded: RawGitHubTimelineNode[] = [];
  for (const node of nodes) {
    if (node === null || typeof node !== "object") continue;
    const result = decodeTimelineNode(node);
    if (Exit.isSuccess(result)) decoded.push(result.value);
  }
  return decoded;
}

export interface NormalizedGitHubReviewThread {
  readonly thread: ChangeRequestReviewThread;
  /** The review whose comment opened the thread, for nesting threads under reviews. */
  readonly openerReviewId: string | null;
  /** Comment bodies before marker stripping, for `clientMutationId` idempotency checks. */
  readonly rawCommentBodies: ReadonlyArray<string>;
}

function normalizeThreadComment(raw: unknown): {
  readonly comment: ChangeRequestReviewComment;
  readonly reviewId: string | null;
  readonly diffHunk: string | null;
  readonly originalCommitOid: string | null;
  readonly rawBody: string;
} | null {
  const decoded = decodeThreadCommentNode(raw);
  if (Exit.isFailure(decoded)) return null;
  const node = decoded.value;
  const id = trimmed(node.id);
  const author = normalizeActor(node.author) ?? { login: "ghost" };
  const createdAt = parseUtc(node.createdAt);
  if (!id || !createdAt) return null;
  const reactions = normalizeReactionGroups(node.reactionGroups ?? undefined);
  const state = node.state?.trim().toUpperCase();
  const comment: ChangeRequestReviewComment = {
    id,
    author,
    body: bodyOf(node.body),
    createdAt,
    ...optionalFields({
      authorAssociation: trimmed(node.authorAssociation),
      updatedAt: parseUtc(node.updatedAt),
      url: trimmed(node.url),
      state: state === "PENDING" ? "pending" : state === "SUBMITTED" ? "submitted" : null,
      viewerCanUpdate: node.viewerCanUpdate,
      viewerCanDelete: node.viewerCanDelete,
      isMinimized: node.isMinimized,
    }),
    ...(reactions.length > 0 ? { reactions } : {}),
  };
  if (!isReviewComment(comment)) return null;
  return {
    comment,
    reviewId: trimmed(node.pullRequestReview?.id),
    diffHunk: node.diffHunk ?? null,
    originalCommitOid: trimmed(node.originalCommit?.oid),
    rawBody: node.body,
  };
}

export function normalizeGitHubReviewThread(raw: unknown): NormalizedGitHubReviewThread | null {
  const decoded = decodeReviewThreadNode(raw);
  if (Exit.isFailure(decoded)) return null;
  const node = decoded.value;
  const id = trimmed(node.id);
  const path = trimmed(node.path);
  if (!id || !path) return null;
  const comments = node.comments.nodes.flatMap((comment) => {
    const normalized = normalizeThreadComment(comment);
    return normalized ? [normalized] : [];
  });
  const opener = comments[0] ?? null;
  const side = normalizeDiffSide(node.diffSide) ?? "right";
  const startSide = normalizeDiffSide(node.startDiffSide);
  const thread: ChangeRequestReviewThread = {
    id,
    path,
    subjectType: node.subjectType?.trim().toUpperCase() === "FILE" ? "file" : "line",
    side,
    ...(startSide ? { startSide } : {}),
    line: positiveInt(node.line),
    startLine: positiveInt(node.startLine),
    originalLine: positiveInt(node.originalLine),
    originalStartLine: positiveInt(node.originalStartLine),
    ...(opener?.originalCommitOid ? { originalCommitOid: opener.originalCommitOid } : {}),
    ...(opener?.diffHunk ? { diffHunk: opener.diffHunk } : {}),
    isResolved: node.isResolved,
    isOutdated: node.isOutdated,
    ...optionalFields({ resolvedBy: trimmed(node.resolvedBy?.login) }),
    viewerCanReply: node.viewerCanReply === true,
    viewerCanResolve: node.viewerCanResolve === true,
    viewerCanUnresolve: node.viewerCanUnresolve === true,
    comments: comments.map((entry) => entry.comment),
    totalComments: Math.max(
      comments.length,
      Number.isSafeInteger(node.comments.totalCount) ? node.comments.totalCount : 0,
    ),
  };
  if (!isReviewThread(thread)) return null;
  return {
    thread,
    openerReviewId: opener?.reviewId ?? null,
    rawCommentBodies: comments.map((entry) => entry.rawBody),
  };
}

// ── Page decoding ─────────────────────────────────────────────────────

export interface GitHubTimelinePage {
  readonly nodes: ReadonlyArray<RawGitHubTimelineNode>;
  readonly hasPreviousPage: boolean;
  readonly startCursor: string | null;
}

export interface GitHubReviewThreadsPage {
  readonly threads: ReadonlyArray<NormalizedGitHubReviewThread>;
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

export interface GitHubActivityFirstPage {
  readonly number: number;
  readonly headSha: string | null;
  readonly viewer: ChangeRequestActivity["viewer"];
  readonly pendingReview: ChangeRequestActivity["pendingReview"];
  readonly timeline: GitHubTimelinePage;
  readonly reviewThreads: GitHubReviewThreadsPage;
}

function timelinePage(raw: typeof RawTimelineConnectionSchema.Type): GitHubTimelinePage {
  return {
    nodes: decodeGitHubTimelineNodes(raw.nodes),
    hasPreviousPage: raw.pageInfo.hasPreviousPage,
    startCursor: trimmed(raw.pageInfo.startCursor),
  };
}

function reviewThreadsPage(
  raw: typeof RawReviewThreadConnectionSchema.Type,
): GitHubReviewThreadsPage {
  return {
    threads: raw.nodes.flatMap((node) => {
      const normalized = normalizeGitHubReviewThread(node);
      return normalized ? [normalized] : [];
    }),
    hasNextPage: raw.pageInfo.hasNextPage,
    endCursor: trimmed(raw.pageInfo.endCursor),
  };
}

const WRITE_PERMISSIONS = new Set(["WRITE", "MAINTAIN", "ADMIN"]);

export function decodeGitHubActivityFirstPageJson(
  raw: string,
): Result.Result<GitHubActivityFirstPage, string> {
  const decoded = decodeActivityResponse(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(`Invalid GitHub activity response: ${formatSchemaError(decoded.failure)}`);
  }
  const errors = blockingActivityErrors(decoded.success.errors);
  if (errors) return Result.fail(errors);
  const data = decoded.success.data;
  const repository = data?.repository;
  const pullRequest = repository?.pullRequest;
  if (!repository || !pullRequest) {
    return Result.fail("GitHub returned no pull request for the activity read.");
  }

  const login = trimmed(data?.viewer?.login);
  const permission = repository.viewerPermission?.trim().toUpperCase() ?? "";
  const hasWrite = WRITE_PERMISSIONS.has(permission);
  const isOpen = pullRequest.state.trim().toUpperCase() === "OPEN";
  const candidateViewer = login
    ? {
        login,
        isAuthor:
          pullRequest.viewerDidAuthor ??
          trimmed(pullRequest.author?.login)?.toLowerCase() === login.toLowerCase(),
        canUpdate: pullRequest.viewerCanUpdate === true,
        canMerge: hasWrite && isOpen,
        canReview: pullRequest.locked !== true || hasWrite,
        canUpdateBranch: pullRequest.viewerCanUpdateBranch === true,
        canEnableAutoMerge: pullRequest.viewerCanEnableAutoMerge === true,
        canDisableAutoMerge: pullRequest.viewerCanDisableAutoMerge === true,
      }
    : null;
  const viewer = candidateViewer && isViewerCapabilities(candidateViewer) ? candidateViewer : null;

  const pending = (pullRequest.pendingReviews?.nodes ?? []).find(
    (node) =>
      node !== null &&
      login !== null &&
      trimmed(node.author?.login)?.toLowerCase() === login.toLowerCase(),
  );
  const pendingId = trimmed(pending?.id);

  return Result.succeed({
    number: pullRequest.number,
    headSha: trimmed(pullRequest.headRefOid),
    viewer,
    pendingReview: pendingId
      ? {
          id: pendingId,
          commentsCount: Math.max(0, Math.trunc(pending?.comments?.totalCount ?? 0)),
        }
      : null,
    timeline: timelinePage(pullRequest.timelineItems),
    reviewThreads: reviewThreadsPage(pullRequest.reviewThreads),
  });
}

export function decodeGitHubTimelinePageJson(
  raw: string,
): Result.Result<GitHubTimelinePage, string> {
  const decoded = decodeTimelinePageResponse(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(`Invalid GitHub timeline response: ${formatSchemaError(decoded.failure)}`);
  }
  const errors = blockingActivityErrors(decoded.success.errors);
  if (errors) return Result.fail(errors);
  const pullRequest = decoded.success.data?.repository?.pullRequest;
  if (!pullRequest) return Result.fail("GitHub returned no pull request for the timeline read.");
  return Result.succeed(timelinePage(pullRequest.timelineItems));
}

export function decodeGitHubReviewThreadsPageJson(
  raw: string,
): Result.Result<GitHubReviewThreadsPage, string> {
  const decoded = decodeReviewThreadsPageResponse(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(
      `Invalid GitHub review thread response: ${formatSchemaError(decoded.failure)}`,
    );
  }
  const errors = graphQlErrorMessage(decoded.success.errors);
  if (errors) return Result.fail(errors);
  const pullRequest = decoded.success.data?.repository?.pullRequest;
  if (!pullRequest) {
    return Result.fail("GitHub returned no pull request for the review thread read.");
  }
  return Result.succeed(reviewThreadsPage(pullRequest.reviewThreads));
}

export interface GitHubPullRequestScope {
  readonly number: number;
  readonly repository: string | null;
}

function scopeOf(
  raw: typeof RawPullRequestScopeSchema.Type | null | undefined,
): GitHubPullRequestScope | null {
  if (!raw) return null;
  return { number: raw.number, repository: trimmed(raw.repository?.nameWithOwner) };
}

export function decodeGitHubReviewThreadNodeJson(raw: string): Result.Result<
  {
    readonly scope: GitHubPullRequestScope | null;
    readonly thread: NormalizedGitHubReviewThread;
  },
  string
> {
  const decoded = decodeReviewThreadNodeResponse(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(
      `Invalid GitHub review thread response: ${formatSchemaError(decoded.failure)}`,
    );
  }
  const errors = graphQlErrorMessage(decoded.success.errors);
  if (errors) return Result.fail(errors);
  const rawNode = decoded.success.data?.node;
  const scoped = rawNode ? decodeScopedNode(rawNode) : null;
  if (!scoped || Exit.isFailure(scoped) || scoped.value.__typename !== "PullRequestReviewThread") {
    return Result.fail("Review thread not found.");
  }
  const thread = normalizeGitHubReviewThread(rawNode);
  if (!thread) return Result.fail("GitHub returned a review thread Ryco could not read.");
  return Result.succeed({ scope: scopeOf(scoped.value.pullRequest), thread });
}

export function decodeGitHubNodeScopeJson(raw: string): Result.Result<
  {
    readonly typename: string;
    readonly scope: GitHubPullRequestScope | null;
  } | null,
  string
> {
  const decoded = decodeNodeScopeResponse(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(`Invalid GitHub node response: ${formatSchemaError(decoded.failure)}`);
  }
  const errors = graphQlErrorMessage(decoded.success.errors);
  if (errors) return Result.fail(errors);
  const node = decoded.success.data?.node;
  if (!node) return Result.succeed(null);
  return Result.succeed({ typename: node.__typename, scope: scopeOf(node.pullRequest) });
}

export function decodeGitHubResolveThreadJson(
  raw: string,
): Result.Result<ChangeRequestSetThreadResolvedResult, string> {
  const decoded = decodeResolveThreadResponse(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(
      `Invalid GitHub resolve thread response: ${formatSchemaError(decoded.failure)}`,
    );
  }
  const errors = graphQlErrorMessage(decoded.success.errors);
  if (errors) return Result.fail(errors);
  const payload = Object.values(decoded.success.data ?? {}).find((value) => value?.thread);
  const thread = payload?.thread;
  const threadId = trimmed(thread?.id);
  if (!thread || !threadId) return Result.fail("GitHub returned no review thread.");
  const resolvedBy = trimmed(thread.resolvedBy?.login);
  return Result.succeed({
    threadId,
    isResolved: thread.isResolved,
    ...(resolvedBy ? { resolvedBy } : {}),
  });
}

// ── Assembly ──────────────────────────────────────────────────────────

/**
 * Join the first page with older timeline pages (newest-first as fetched)
 * and later thread pages into the contract payload. Reviews get the threads
 * their comments opened; the timeline is returned oldest first.
 */
export function assembleGitHubChangeRequestActivity(input: {
  readonly first: GitHubActivityFirstPage;
  readonly olderTimelinePages: ReadonlyArray<GitHubTimelinePage>;
  readonly laterThreadPages: ReadonlyArray<GitHubReviewThreadsPage>;
  readonly timelineTruncated: boolean;
  readonly reviewThreadsTruncated: boolean;
}): ChangeRequestActivity {
  const threadEntries: NormalizedGitHubReviewThread[] = [];
  const seenThreads = new Set<string>();
  for (const page of [input.first.reviewThreads, ...input.laterThreadPages]) {
    for (const entry of page.threads) {
      if (seenThreads.has(entry.thread.id)) continue;
      seenThreads.add(entry.thread.id);
      threadEntries.push(entry);
    }
  }
  const threadIdsByReviewId = new Map<string, string[]>();
  for (const entry of threadEntries) {
    if (!entry.openerReviewId) continue;
    const ids = threadIdsByReviewId.get(entry.openerReviewId) ?? [];
    ids.push(entry.thread.id);
    threadIdsByReviewId.set(entry.openerReviewId, ids);
  }

  const timeline: ChangeRequestTimelineItem[] = [];
  const seenItems = new Set<string>();
  // Older pages were fetched newest-first; reverse them so the output is chronological.
  const pages = [...input.olderTimelinePages].toReversed();
  pages.push(input.first.timeline);
  for (const page of pages) {
    for (const node of page.nodes) {
      const item = normalizeGitHubTimelineNode(node, threadIdsByReviewId);
      if (!item || seenItems.has(item.id)) continue;
      seenItems.add(item.id);
      timeline.push(item);
    }
  }

  return {
    provider: "github",
    number: input.first.number,
    headSha: input.first.headSha,
    viewer: input.first.viewer,
    timeline,
    timelineTruncated: input.timelineTruncated,
    reviewThreads: threadEntries.map((entry) => entry.thread),
    reviewThreadsTruncated: input.reviewThreadsTruncated,
    pendingReview: input.first.pendingReview,
  };
}

/**
 * Bounded activity read. `runQuery` executes one GraphQL document (query and
 * variables over stdin) and returns raw stdout; `fail` maps a decode failure
 * into the caller's error type.
 */
export function fetchGitHubChangeRequestActivity<E>(input: {
  readonly owner: string;
  readonly name: string;
  readonly number: number;
  readonly runQuery: (
    query: string,
    variables: Readonly<Record<string, string | number>>,
  ) => Effect.Effect<string, E>;
  readonly fail: (detail: string) => E;
}): Effect.Effect<ChangeRequestActivity, E> {
  const variables = { owner: input.owner, name: input.name, number: input.number };
  const decode = <A>(result: Result.Result<A, string>) =>
    Result.isSuccess(result)
      ? Effect.succeed(result.success)
      : Effect.fail(input.fail(result.failure));

  return Effect.gen(function* () {
    const first = yield* input
      .runQuery(GITHUB_PULL_REQUEST_ACTIVITY_QUERY, variables)
      .pipe(Effect.flatMap((raw) => decode(decodeGitHubActivityFirstPageJson(raw))));

    const olderTimelinePages: GitHubTimelinePage[] = [];
    let timelinePage = first.timeline;
    const seenTimelineCursors = new Set<string>();
    while (
      timelinePage.hasPreviousPage &&
      timelinePage.startCursor &&
      !seenTimelineCursors.has(timelinePage.startCursor) &&
      olderTimelinePages.length + 1 < GITHUB_ACTIVITY_TIMELINE_MAX_PAGES
    ) {
      seenTimelineCursors.add(timelinePage.startCursor);
      const cursor: string = timelinePage.startCursor;
      timelinePage = yield* input
        .runQuery(GITHUB_PULL_REQUEST_TIMELINE_PAGE_QUERY, { ...variables, before: cursor })
        .pipe(Effect.flatMap((raw) => decode(decodeGitHubTimelinePageJson(raw))));
      olderTimelinePages.push(timelinePage);
    }

    const laterThreadPages: GitHubReviewThreadsPage[] = [];
    let threadPage = first.reviewThreads;
    const seenThreadCursors = new Set<string>();
    while (
      threadPage.hasNextPage &&
      threadPage.endCursor &&
      !seenThreadCursors.has(threadPage.endCursor) &&
      laterThreadPages.length + 1 < GITHUB_ACTIVITY_REVIEW_THREAD_MAX_PAGES
    ) {
      seenThreadCursors.add(threadPage.endCursor);
      const cursor: string = threadPage.endCursor;
      threadPage = yield* input
        .runQuery(GITHUB_PULL_REQUEST_REVIEW_THREADS_PAGE_QUERY, { ...variables, after: cursor })
        .pipe(Effect.flatMap((raw) => decode(decodeGitHubReviewThreadsPageJson(raw))));
      laterThreadPages.push(threadPage);
    }

    return assembleGitHubChangeRequestActivity({
      first,
      olderTimelinePages,
      laterThreadPages,
      timelineTruncated: timelinePage.hasPreviousPage,
      reviewThreadsTruncated: threadPage.hasNextPage,
    });
  });
}
