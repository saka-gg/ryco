/**
 * Pure decoding and mapping for the pull request page on Azure DevOps
 * (REST 7.1 through `az devops invoke`). No I/O lives here: the operations in
 * `azureDevOpsPullRequestOperations.ts` fetch, this module turns host payloads
 * into the change request contract and builds request bodies.
 *
 * Shapes follow the official reference (Git REST 7.1):
 * - threads / comments: https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-threads?view=azure-devops-rest-7.1
 * - iterations: https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-iterations?view=azure-devops-rest-7.1
 * - iteration changes: https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-iteration-changes?view=azure-devops-rest-7.1
 * - policy evaluations: https://learn.microsoft.com/en-us/rest/api/azure/devops/policy/evaluations?view=azure-devops-rest-7.1
 */
import { Cause, DateTime, Option, Result, Schema } from "effect";
import type {
  ChangeRequestActor,
  ChangeRequestDraftReviewComment,
  ChangeRequestReviewComment,
  ChangeRequestReviewThread,
  ChangeRequestTimelineItem,
  ChangeRequestViewerCapabilities,
  SourceControlChangeRequestAutoMerge,
  SourceControlChangeRequestCommit,
  SourceControlChangeRequestMergeCapabilities,
  SourceControlChangeRequestMergeMethod,
  SourceControlChangeRequestMergeStateStatus,
  SourceControlChangeRequestReviewDecision,
  SourceControlChangeRequestReviewer,
  SourceControlReviewState,
} from "@ryco/contracts";
import { decodeJsonResult } from "@ryco/shared/schemaJson";

import {
  AzureDevOpsCommitRefSchema,
  AzureDevOpsIdentityRefSchema,
  azureDevOpsIdentityLogin,
  azureDevOpsReviewDecisionFromVotes,
  normalizeAzureDevOpsRefName,
  type AzureDevOpsCommitRef,
  type AzureDevOpsIdentityRef,
  type AzureDevOpsPullRequest,
  type AzureDevOpsReviewer,
} from "./azureDevOpsPullRequests.ts";

/** Page budget: the newest timeline items kept. */
export const AZURE_DEVOPS_TIMELINE_MAX_ITEMS = 300;
/** Page budget: review threads kept (newest first by publish date). */
export const AZURE_DEVOPS_REVIEW_THREADS_MAX = 200;
/** `GET .../pullRequests/{id}/commits?$top=` (one page; more sets `timelineTruncated`). */
export const AZURE_DEVOPS_PULL_REQUEST_COMMITS_PAGE = 250;
/** `GET .../iterations/{id}/changes?$top=` (the documented maximum). */
export const AZURE_DEVOPS_ITERATION_CHANGES_PAGE = 2000;
/** Pull request descriptions are capped by the host (Pull Requests - Update). */
export const AZURE_DEVOPS_DESCRIPTION_MAX_CHARS = 4000;

/** Git Repositories security namespace and the bits the viewer capabilities read. */
export const AZURE_DEVOPS_GIT_SECURITY_NAMESPACE = "2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87";
export const AZURE_DEVOPS_GIT_PERMISSION_GENERIC_CONTRIBUTE = 4;
export const AZURE_DEVOPS_GIT_PERMISSION_PULL_REQUEST_CONTRIBUTE = 16384;

/** Policy type ids from the official policy configuration examples. */
export const AZURE_DEVOPS_POLICY_TYPES = {
  build: "0609b952-1397-4640-95ec-e00a01b2c241",
  minimumApprovalCount: "fa4e907d-c16b-4a4c-9dfa-4906e5d171dd",
  requiredReviewers: "fd2167ab-b0be-447a-8ec8-39368250530e",
  mergeStrategy: "fa4e907d-c16b-4a4c-9dfa-4916e5d171ab",
} as const;

const EMPTY_GUID = "00000000-0000-0000-0000-000000000000";

// ── Schemas ──────────────────────────────────────────────────────────

const CommentPositionSchema = Schema.Struct({
  line: Schema.Number,
  offset: Schema.optional(Schema.NullOr(Schema.Number)),
});
type CommentPosition = typeof CommentPositionSchema.Type;

const NullablePosition = Schema.optional(Schema.NullOr(CommentPositionSchema));

export const AzureDevOpsCommentSchema = Schema.Struct({
  id: Schema.Number,
  parentCommentId: Schema.optional(Schema.NullOr(Schema.Number)),
  author: Schema.optional(Schema.NullOr(AzureDevOpsIdentityRefSchema)),
  content: Schema.optional(Schema.NullOr(Schema.String)),
  publishedDate: Schema.optional(Schema.NullOr(Schema.String)),
  lastUpdatedDate: Schema.optional(Schema.NullOr(Schema.String)),
  lastContentUpdatedDate: Schema.optional(Schema.NullOr(Schema.String)),
  /** `CommentType`: unknown, text, codeChange, system. */
  commentType: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
  isDeleted: Schema.optional(Schema.NullOr(Schema.Boolean)),
});
export type AzureDevOpsComment = typeof AzureDevOpsCommentSchema.Type;

export const AzureDevOpsThreadSchema = Schema.Struct({
  id: Schema.Number,
  publishedDate: Schema.optional(Schema.NullOr(Schema.String)),
  lastUpdatedDate: Schema.optional(Schema.NullOr(Schema.String)),
  comments: Schema.optional(Schema.NullOr(Schema.Array(AzureDevOpsCommentSchema))),
  /** `CommentThreadStatus`: unknown, active, fixed, wontFix, closed, byDesign, pending. */
  status: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
  threadContext: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        filePath: Schema.optional(Schema.NullOr(Schema.String)),
        leftFileStart: NullablePosition,
        leftFileEnd: NullablePosition,
        rightFileStart: NullablePosition,
        rightFileEnd: NullablePosition,
      }),
    ),
  ),
  pullRequestThreadContext: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        changeTrackingId: Schema.optional(Schema.NullOr(Schema.Number)),
        iterationContext: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              firstComparingIteration: Schema.optional(Schema.NullOr(Schema.Number)),
              secondComparingIteration: Schema.optional(Schema.NullOr(Schema.Number)),
            }),
          ),
        ),
        trackingCriteria: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              firstComparingIteration: Schema.optional(Schema.NullOr(Schema.Number)),
              secondComparingIteration: Schema.optional(Schema.NullOr(Schema.Number)),
              origFilePath: Schema.optional(Schema.NullOr(Schema.String)),
              origLeftFileStart: NullablePosition,
              origLeftFileEnd: NullablePosition,
              origRightFileStart: NullablePosition,
              origRightFileEnd: NullablePosition,
            }),
          ),
        ),
      }),
    ),
  ),
  properties: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
  identities: Schema.optional(
    Schema.NullOr(Schema.Record(Schema.String, AzureDevOpsIdentityRefSchema)),
  ),
  isDeleted: Schema.optional(Schema.NullOr(Schema.Boolean)),
});
export type AzureDevOpsThread = typeof AzureDevOpsThreadSchema.Type;

export const AzureDevOpsIterationSchema = Schema.Struct({
  id: Schema.Number,
  createdDate: Schema.optional(Schema.NullOr(Schema.String)),
  updatedDate: Schema.optional(Schema.NullOr(Schema.String)),
  /** `IterationReason`: push, forcePush, create, rebase, unknown, retarget, resolveConflicts. */
  reason: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(AzureDevOpsIdentityRefSchema)),
  sourceRefCommit: Schema.optional(Schema.NullOr(AzureDevOpsCommitRefSchema)),
  targetRefCommit: Schema.optional(Schema.NullOr(AzureDevOpsCommitRefSchema)),
  commonRefCommit: Schema.optional(Schema.NullOr(AzureDevOpsCommitRefSchema)),
  newTargetRefName: Schema.optional(Schema.NullOr(Schema.String)),
  oldTargetRefName: Schema.optional(Schema.NullOr(Schema.String)),
  push: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        date: Schema.optional(Schema.NullOr(Schema.String)),
        pushedBy: Schema.optional(Schema.NullOr(AzureDevOpsIdentityRefSchema)),
      }),
    ),
  ),
});
export type AzureDevOpsIteration = typeof AzureDevOpsIterationSchema.Type;

export const AzureDevOpsIterationChangesSchema = Schema.Struct({
  changeEntries: Schema.Array(
    Schema.Struct({
      changeTrackingId: Schema.optional(Schema.NullOr(Schema.Number)),
      changeId: Schema.optional(Schema.NullOr(Schema.Number)),
      changeType: Schema.optional(Schema.NullOr(Schema.String)),
      originalPath: Schema.optional(Schema.NullOr(Schema.String)),
      item: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            path: Schema.optional(Schema.NullOr(Schema.String)),
            objectId: Schema.optional(Schema.NullOr(Schema.String)),
            originalObjectId: Schema.optional(Schema.NullOr(Schema.String)),
          }),
        ),
      ),
    }),
  ),
  nextSkip: Schema.optional(Schema.NullOr(Schema.Number)),
  nextTop: Schema.optional(Schema.NullOr(Schema.Number)),
});
export type AzureDevOpsIterationChanges = typeof AzureDevOpsIterationChangesSchema.Type;

export const AzureDevOpsPolicyEvaluationSchema = Schema.Struct({
  evaluationId: Schema.optional(Schema.NullOr(Schema.String)),
  /** `PolicyEvaluationStatus`: queued, running, approved, rejected, notApplicable, broken. */
  status: Schema.optional(Schema.NullOr(Schema.String)),
  startedDate: Schema.optional(Schema.NullOr(Schema.String)),
  completedDate: Schema.optional(Schema.NullOr(Schema.String)),
  configuration: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.optional(Schema.NullOr(Schema.Number)),
        isBlocking: Schema.optional(Schema.NullOr(Schema.Boolean)),
        isEnabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
        isDeleted: Schema.optional(Schema.NullOr(Schema.Boolean)),
        settings: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
        type: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              id: Schema.optional(Schema.NullOr(Schema.String)),
              displayName: Schema.optional(Schema.NullOr(Schema.String)),
            }),
          ),
        ),
      }),
    ),
  ),
});
export type AzureDevOpsPolicyEvaluation = typeof AzureDevOpsPolicyEvaluationSchema.Type;

/** `GET _apis/connectionData` (`authenticatedUser` is the caller). */
export const AzureDevOpsConnectionDataSchema = Schema.Struct({
  authenticatedUser: Schema.Struct({
    id: Schema.String,
    providerDisplayName: Schema.optional(Schema.NullOr(Schema.String)),
    customDisplayName: Schema.optional(Schema.NullOr(Schema.String)),
    properties: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          Account: Schema.optional(
            Schema.NullOr(Schema.Struct({ $value: Schema.optional(Schema.NullOr(Schema.String)) })),
          ),
        }),
      ),
    ),
  }),
});

/** `GET _apis/profile/profiles/me` (fallback identity source). */
export const AzureDevOpsProfileSchema = Schema.Struct({
  id: Schema.String,
  displayName: Schema.optional(Schema.NullOr(Schema.String)),
  emailAddress: Schema.optional(Schema.NullOr(Schema.String)),
});

export const AzureDevOpsPermissionsSchema = Schema.Struct({
  value: Schema.Array(Schema.Boolean),
});

export const AzureDevOpsTeamMemberSchema = Schema.Struct({
  identity: AzureDevOpsIdentityRefSchema,
  isTeamAdmin: Schema.optional(Schema.NullOr(Schema.Boolean)),
});

export const AzureDevOpsTagSchema = Schema.Struct({
  name: Schema.String,
  active: Schema.optional(Schema.NullOr(Schema.Boolean)),
});

export const AzureDevOpsRefUpdateResultSchema = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  success: Schema.optional(Schema.NullOr(Schema.Boolean)),
  updateStatus: Schema.optional(Schema.NullOr(Schema.String)),
  customMessage: Schema.optional(Schema.NullOr(Schema.String)),
});

/** REST list responses are wrapped: `{ count, value }`; `az devops invoke` adds `continuation_token`. */
export function azureDevOpsCollection<S extends Schema.Top>(item: S) {
  return Schema.Struct({
    value: Schema.Array(item),
    count: Schema.optional(Schema.NullOr(Schema.Number)),
    continuation_token: Schema.optional(Schema.NullOr(Schema.String)),
  });
}

export function decodeAzureDevOpsJson<S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
): (raw: string) => Result.Result<S["Type"], Cause.Cause<Schema.SchemaError>> {
  return decodeJsonResult(schema);
}

// ── Small helpers ────────────────────────────────────────────────────

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}

export function parseAzureDevOpsDate(value: string | null | undefined): DateTime.Utc | null {
  const text = trimmed(value);
  if (!text) return null;
  const date = new Date(text);
  // Azure reports "never" as 0001-01-01.
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() > 1
    ? DateTime.fromDateUnsafe(date)
    : null;
}

function epochMillis(value: DateTime.Utc): number {
  return DateTime.toEpochMillis(value);
}

function isPositiveLine(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

export function isGitObjectId(value: string): boolean {
  return /^[0-9a-f]{7,64}$/iu.test(value);
}

/** Normalizes Azure identity ids ("d6245f20-2af8-…" and "d6245f202af8…" both occur). */
function identityKey(id: string | null | undefined): string | null {
  const key = id?.replace(/[-{}]/gu, "").trim().toLowerCase() ?? "";
  return key.length > 0 && key !== EMPTY_GUID.replace(/-/gu, "") ? key : null;
}

export function sameAzureDevOpsIdentity(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const a = identityKey(left);
  return a !== null && a === identityKey(right);
}

function toActor(identity: AzureDevOpsIdentityRef | null | undefined): ChangeRequestActor | null {
  const login = azureDevOpsIdentityLogin(identity);
  if (!login) return null;
  const avatarUrl = trimmed(identity?.imageUrl);
  return { login, ...(avatarUrl ? { avatarUrl } : {}) };
}

function threadProperty(thread: AzureDevOpsThread, key: string): string | null {
  const entry = thread.properties?.[key];
  if (entry === null || typeof entry !== "object" || !("$value" in entry)) return null;
  const value = (entry as { readonly $value: unknown }).$value;
  if (typeof value === "string") return trimmed(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function isSystemComment(comment: AzureDevOpsComment): boolean {
  const type = comment.commentType;
  return type === "system" || type === 3;
}

function liveTextComments(thread: AzureDevOpsThread): ReadonlyArray<AzureDevOpsComment> {
  return (thread.comments ?? []).filter(
    (comment) => comment.isDeleted !== true && !isSystemComment(comment),
  );
}

// ── Ids ──────────────────────────────────────────────────────────────

/** Comment ids are per thread on Azure, so the page carries `threadId:commentId`. */
export function encodeAzureDevOpsCommentId(threadId: number, commentId: number): string {
  return `${threadId}:${commentId}`;
}

export function decodeAzureDevOpsCommentId(
  value: string,
): { readonly threadId: number; readonly commentId: number } | null {
  const match = /^(\d+):(\d+)$/u.exec(value.trim());
  if (!match) return null;
  const threadId = Number(match[1]);
  const commentId = Number(match[2]);
  return threadId > 0 && commentId > 0 ? { threadId, commentId } : null;
}

export function decodeAzureDevOpsThreadId(value: string): number | null {
  const match = /^(\d+)$/u.exec(value.trim());
  const id = match ? Number(match[1]) : Number.NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// ── Identities ───────────────────────────────────────────────────────

export interface AzureDevOpsViewerIdentity {
  readonly id: string;
  readonly login: string;
}

/** Every identity the payloads mention, keyed by normalized id, for system-thread references. */
export function collectAzureDevOpsIdentities(input: {
  readonly pullRequest: AzureDevOpsPullRequest;
  readonly threads: ReadonlyArray<AzureDevOpsThread>;
}): ReadonlyMap<string, AzureDevOpsIdentityRef> {
  const identities = new Map<string, AzureDevOpsIdentityRef>();
  const add = (identity: AzureDevOpsIdentityRef | null | undefined) => {
    const key = identityKey(identity?.id);
    if (key && identity && !identities.has(key)) identities.set(key, identity);
  };
  add(input.pullRequest.createdBy);
  add(input.pullRequest.closedBy);
  add(input.pullRequest.autoCompleteSetBy);
  for (const reviewer of input.pullRequest.reviewers ?? []) add(reviewer);
  for (const thread of input.threads) {
    for (const comment of thread.comments ?? []) add(comment.author);
    for (const identity of Object.values(thread.identities ?? {})) add(identity);
  }
  return identities;
}

function referencedActor(
  identities: ReadonlyMap<string, AzureDevOpsIdentityRef>,
  id: string | null,
  displayName: string | null,
): ChangeRequestActor | null {
  const key = identityKey(id);
  const known = key ? identities.get(key) : undefined;
  return toActor(known) ?? (displayName ? { login: displayName } : null);
}

// ── Viewer ───────────────────────────────────────────────────────────

export interface AzureDevOpsViewerPermissions {
  /** `PullRequestContribute`: comment, vote, edit, retarget, abandon. */
  readonly pullRequestContribute: boolean;
  /** `GenericContribute`: complete (merge) and delete branches; policies still decide. */
  readonly genericContribute: boolean;
}

/**
 * Viewer capabilities from the caller's identity and repository-level Git
 * permissions. Unknown permissions fall back to what authorship alone proves
 * (the author can edit and comment on their own pull request).
 */
export function toAzureDevOpsViewerCapabilities(input: {
  readonly viewer: AzureDevOpsViewerIdentity;
  readonly permissions: AzureDevOpsViewerPermissions | null;
  readonly pullRequest: AzureDevOpsPullRequest;
}): ChangeRequestViewerCapabilities {
  const pullRequest = input.pullRequest;
  const isAuthor = sameAzureDevOpsIdentity(pullRequest.createdBy?.id, input.viewer.id);
  const isActive = pullRequest.status.trim().toLowerCase() === "active";
  const contribute = input.permissions?.pullRequestContribute ?? isAuthor;
  const canComplete = input.permissions?.genericContribute ?? false;
  const autoCompleteOn = identityKey(pullRequest.autoCompleteSetBy?.id) !== null;
  return {
    login: input.viewer.login,
    isAuthor,
    canUpdate: isAuthor || contribute,
    canMerge: isActive && canComplete,
    canReview: contribute,
    canUpdateBranch: false,
    canEnableAutoMerge: isActive && canComplete && !autoCompleteOn,
    canDisableAutoMerge:
      isActive &&
      autoCompleteOn &&
      (canComplete || sameAzureDevOpsIdentity(pullRequest.autoCompleteSetBy?.id, input.viewer.id)),
  };
}

/** Whether the viewer may comment, reply and change thread status. */
export function azureDevOpsViewerCanComment(
  viewer: ChangeRequestViewerCapabilities | null,
): boolean {
  return viewer?.canReview === true;
}

// ── Comments ─────────────────────────────────────────────────────────

function toReviewComment(
  threadId: number,
  comment: AzureDevOpsComment,
  viewerId: string | null,
): ChangeRequestReviewComment | null {
  const createdAt = parseAzureDevOpsDate(comment.publishedDate);
  if (!createdAt) return null;
  const author = toActor(comment.author) ?? { login: "unknown" };
  const edited = parseAzureDevOpsDate(comment.lastContentUpdatedDate);
  const own = viewerId !== null && sameAzureDevOpsIdentity(comment.author?.id, viewerId);
  return {
    id: encodeAzureDevOpsCommentId(threadId, comment.id),
    author,
    body: comment.content ?? "",
    createdAt,
    ...(edited && epochMillis(edited) > epochMillis(createdAt) ? { updatedAt: edited } : {}),
    state: "submitted",
    viewerCanUpdate: own,
    viewerCanDelete: own,
  };
}

/** Flattened text comments for the composer detail (every live thread, oldest first). */
export function flattenAzureDevOpsThreadComments(
  threads: ReadonlyArray<AzureDevOpsThread>,
): ReadonlyArray<{
  readonly id: string;
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
}> {
  return threads
    .filter((thread) => thread.isDeleted !== true)
    .flatMap((thread) =>
      liveTextComments(thread)
        .filter((comment) => (comment.content?.trim() ?? "").length > 0)
        .map((comment) => ({
          id: encodeAzureDevOpsCommentId(thread.id, comment.id),
          author: azureDevOpsIdentityLogin(comment.author) ?? "unknown",
          body: comment.content ?? "",
          createdAt: comment.publishedDate ?? "",
        })),
    )
    .filter((comment) => parseAzureDevOpsDate(comment.createdAt) !== null)
    .toSorted((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
}

// ── Review threads ───────────────────────────────────────────────────

const RESOLVED_THREAD_STATUSES = new Set(["fixed", "closed", "wontfix", "bydesign"]);
// Numeric `CommentThreadStatus` values (fixed 2, wontFix 3, closed 4, byDesign 5).
const RESOLVED_THREAD_STATUS_NUMBERS = new Set([2, 3, 4, 5]);

export function isAzureDevOpsThreadResolved(status: AzureDevOpsThread["status"]): boolean {
  if (typeof status === "number") return RESOLVED_THREAD_STATUS_NUMBERS.has(status);
  return RESOLVED_THREAD_STATUSES.has(status?.trim().toLowerCase() ?? "");
}

function threadFilePath(thread: AzureDevOpsThread): string | null {
  const path = trimmed(thread.threadContext?.filePath)?.replace(/^\/+/u, "");
  return path && path.length > 0 ? path : null;
}

interface ThreadAnchor {
  readonly side: "left" | "right";
  readonly start: CommentPosition | null;
  readonly end: CommentPosition | null;
}

function anchorFrom(
  left: { start: CommentPosition | null | undefined; end: CommentPosition | null | undefined },
  right: { start: CommentPosition | null | undefined; end: CommentPosition | null | undefined },
): ThreadAnchor | null {
  if (right.start || right.end) {
    return {
      side: "right",
      start: right.start ?? right.end ?? null,
      end: right.end ?? right.start ?? null,
    };
  }
  if (left.start || left.end) {
    return {
      side: "left",
      start: left.start ?? left.end ?? null,
      end: left.end ?? left.start ?? null,
    };
  }
  return null;
}

/**
 * One file thread on the page. Positions are read as the host tracked them to
 * `latestIterationId` (threads are listed with `$iteration=<latest>`): a thread
 * whose position still belongs to an older iteration could not be tracked and
 * is outdated (`line: null`, written position in `originalLine`).
 */
export function toAzureDevOpsReviewThread(input: {
  readonly thread: AzureDevOpsThread;
  readonly iterations: ReadonlyArray<AzureDevOpsIteration>;
  readonly viewer: ChangeRequestViewerCapabilities | null;
  readonly viewerId: string | null;
}): ChangeRequestReviewThread | null {
  const thread = input.thread;
  if (thread.isDeleted === true) return null;
  const path = threadFilePath(thread);
  if (!path) return null;
  const comments = liveTextComments(thread)
    .map((comment) => toReviewComment(thread.id, comment, input.viewerId))
    .filter((comment): comment is ChangeRequestReviewComment => comment !== null);
  if (comments.length === 0) return null;

  const context = thread.threadContext;
  const current = anchorFrom(
    { start: context?.leftFileStart, end: context?.leftFileEnd },
    { start: context?.rightFileStart, end: context?.rightFileEnd },
  );
  const tracking = thread.pullRequestThreadContext?.trackingCriteria ?? null;
  const tracked = tracking !== null && (tracking.secondComparingIteration ?? 0) > 0;
  const original = tracked
    ? anchorFrom(
        { start: tracking.origLeftFileStart, end: tracking.origLeftFileEnd },
        { start: tracking.origRightFileStart, end: tracking.origRightFileEnd },
      )
    : current;
  const writtenIteration =
    thread.pullRequestThreadContext?.iterationContext?.secondComparingIteration ?? null;
  const positionIteration = tracked
    ? (tracking.secondComparingIteration ?? null)
    : writtenIteration;
  const latestIteration = input.iterations.reduce<number | null>(
    (latest, iteration) => (latest === null || iteration.id > latest ? iteration.id : latest),
    null,
  );
  const isOutdated =
    current !== null &&
    positionIteration !== null &&
    latestIteration !== null &&
    positionIteration < latestIteration;

  const endLine = current?.end?.line;
  const startLine = current?.start?.line;
  const originalEnd = original?.end?.line;
  const originalStart = original?.start?.line;
  const originalCommitOid = trimmed(
    input.iterations.find((iteration) => iteration.id === writtenIteration)?.sourceRefCommit
      ?.commitId,
  );
  const resolved = isAzureDevOpsThreadResolved(thread.status);
  const canComment = azureDevOpsViewerCanComment(input.viewer);
  const line = !isOutdated && isPositiveLine(endLine) ? endLine : null;
  return {
    id: String(thread.id),
    path,
    subjectType: current ? "line" : "file",
    side: current?.side ?? "right",
    ...(current && isPositiveLine(startLine) && startLine !== endLine && !isOutdated
      ? { startLine, startSide: current.side }
      : {}),
    line,
    ...(isPositiveLine(originalEnd) ? { originalLine: originalEnd } : {}),
    ...(isPositiveLine(originalStart) && originalStart !== originalEnd
      ? { originalStartLine: originalStart }
      : {}),
    ...(originalCommitOid ? { originalCommitOid } : {}),
    isResolved: resolved,
    isOutdated,
    viewerCanReply: canComment,
    viewerCanResolve: canComment && !resolved,
    viewerCanUnresolve: canComment && resolved,
    comments,
    totalComments: comments.length,
  };
}

export function toAzureDevOpsReviewThreads(input: {
  readonly threads: ReadonlyArray<AzureDevOpsThread>;
  readonly iterations: ReadonlyArray<AzureDevOpsIteration>;
  readonly viewer: ChangeRequestViewerCapabilities | null;
  readonly viewerId: string | null;
}): { readonly threads: ReadonlyArray<ChangeRequestReviewThread>; readonly truncated: boolean } {
  const mapped = input.threads
    .map((thread) =>
      toAzureDevOpsReviewThread({
        thread,
        iterations: input.iterations,
        viewer: input.viewer,
        viewerId: input.viewerId,
      }),
    )
    .filter((thread): thread is ChangeRequestReviewThread => thread !== null);
  if (mapped.length <= AZURE_DEVOPS_REVIEW_THREADS_MAX) {
    return { threads: mapped, truncated: false };
  }
  // Keep the newest threads (by their first comment).
  const newest = mapped
    .toSorted(
      (left, right) =>
        epochMillis(right.comments[0]!.createdAt) - epochMillis(left.comments[0]!.createdAt),
    )
    .slice(0, AZURE_DEVOPS_REVIEW_THREADS_MAX);
  const kept = new Set(newest.map((thread) => thread.id));
  return { threads: mapped.filter((thread) => kept.has(thread.id)), truncated: true };
}

// ── Timeline ─────────────────────────────────────────────────────────

/** Vote value → review state (`IdentityRefWithVote.vote`). Reset votes (0) are not reviews. */
export function azureDevOpsVoteReviewState(vote: number): SourceControlReviewState | null {
  if (vote > 0) return "approved";
  if (vote < 0) return "changes_requested";
  return null;
}

function splitCommitMessage(message: string): { headline: string; body: string | null } {
  const normalized = message.replace(/\r\n/gu, "\n");
  const newline = normalized.indexOf("\n");
  if (newline < 0) return { headline: normalized.trim(), body: null };
  const body = normalized.slice(newline + 1).trim();
  return { headline: normalized.slice(0, newline).trim(), body: body.length > 0 ? body : null };
}

export function toAzureDevOpsChangeRequestCommit(
  commit: AzureDevOpsCommitRef,
): SourceControlChangeRequestCommit {
  const { headline } = splitCommitMessage(commit.comment ?? "");
  const author = trimmed(commit.author?.name) ?? trimmed(commit.author?.email);
  const committedDate = trimmed(commit.committer?.date) ?? trimmed(commit.author?.date);
  return {
    oid: commit.commitId,
    shortOid: commit.commitId.slice(0, 7),
    messageHeadline: headline,
    ...(committedDate ? { committedDate } : {}),
    ...(author ? { author } : {}),
  };
}

interface TimelineEntry {
  readonly order: number;
  readonly item: ChangeRequestTimelineItem;
}

/**
 * Chronological timeline from what Azure records:
 * - text threads without a file (general discussion) → `comment` per comment;
 * - system threads (`properties.CodeReviewThreadType`): `VoteUpdate` → `review`,
 *   `ReviewersUpdate` → `review-requested` / `review-request-removed`,
 *   `StatusUpdate` → `merged` / `closed` / `reopened`;
 * - pull request commits → `commit`; iterations → `force-pushed` and
 *   `base-ref-changed`;
 * - the pull request's own completion / abandonment when no status thread
 *   recorded it.
 */
export function toAzureDevOpsTimeline(input: {
  readonly pullRequest: AzureDevOpsPullRequest;
  readonly threads: ReadonlyArray<AzureDevOpsThread>;
  readonly iterations: ReadonlyArray<AzureDevOpsIteration>;
  readonly commits: ReadonlyArray<AzureDevOpsCommitRef>;
  readonly commitsTruncated: boolean;
  readonly viewerId: string | null;
}): { readonly timeline: ReadonlyArray<ChangeRequestTimelineItem>; readonly truncated: boolean } {
  const identities = collectAzureDevOpsIdentities({
    pullRequest: input.pullRequest,
    threads: input.threads,
  });
  const entries: TimelineEntry[] = [];
  const push = (item: ChangeRequestTimelineItem) => entries.push({ order: entries.length, item });
  let statusRecorded = false;

  for (const thread of input.threads) {
    if (thread.isDeleted === true) continue;
    const threadType = threadProperty(thread, "CodeReviewThreadType");
    const createdAt = parseAzureDevOpsDate(
      thread.publishedDate ?? thread.comments?.[0]?.publishedDate,
    );
    if (threadType) {
      if (!createdAt) continue;
      switch (threadType) {
        case "VoteUpdate": {
          const vote = Number(threadProperty(thread, "CodeReviewVoteResult"));
          const state = Number.isFinite(vote) ? azureDevOpsVoteReviewState(vote) : null;
          if (!state) break;
          const actor = referencedActor(
            identities,
            threadProperty(thread, "CodeReviewVotedByTfId"),
            threadProperty(thread, "CodeReviewVotedByDisplayName"),
          );
          push({
            kind: "review",
            id: `vote:${thread.id}`,
            createdAt,
            ...(actor ? { actor } : {}),
            state,
            body: "",
            threadIds: [],
          });
          break;
        }
        case "ReviewersUpdate": {
          const actor = referencedActor(
            identities,
            threadProperty(thread, "CodeReviewReviewersUpdatedByTfId"),
            threadProperty(thread, "CodeReviewReviewersUpdatedByDisplayname") ??
              threadProperty(thread, "CodeReviewReviewersUpdatedByDisplayName"),
          );
          for (const [kind, prefix] of [
            ["review-requested", "CodeReviewReviewersUpdatedAdded"],
            ["review-request-removed", "CodeReviewReviewersUpdatedRemoved"],
          ] as const) {
            const tfId = threadProperty(thread, `${prefix}TfId`);
            const reviewer = referencedActor(
              identities,
              tfId,
              threadProperty(thread, `${prefix}DisplayName`),
            );
            if (!reviewer) continue;
            const known = identityKey(tfId);
            const isTeam = known ? identities.get(known)?.isContainer === true : false;
            push({
              kind,
              id: `${kind}:${thread.id}`,
              createdAt,
              ...(actor ? { actor } : {}),
              reviewer: reviewer.login,
              reviewerKind: isTeam ? "team" : "user",
            });
          }
          break;
        }
        case "StatusUpdate": {
          const status = threadProperty(thread, "CodeReviewStatus")?.toLowerCase();
          const actor = referencedActor(
            identities,
            threadProperty(thread, "CodeReviewStatusUpdatedByTfId"),
            threadProperty(thread, "CodeReviewStatusUpdatedByDisplayName"),
          );
          const actorField = actor ? { actor } : {};
          if (status === "completed") {
            statusRecorded = statusRecorded || input.pullRequest.status === "completed";
            const commitOid = trimmed(input.pullRequest.lastMergeCommit?.commitId);
            push({
              kind: "merged",
              id: `status:${thread.id}`,
              createdAt,
              ...actorField,
              ...(commitOid ? { commitOid } : {}),
              baseRefName: normalizeAzureDevOpsRefName(input.pullRequest.targetRefName),
            });
          } else if (status === "abandoned") {
            statusRecorded = statusRecorded || input.pullRequest.status === "abandoned";
            push({ kind: "closed", id: `status:${thread.id}`, createdAt, ...actorField });
          } else if (status === "active" || status === "reactivated") {
            push({ kind: "reopened", id: `status:${thread.id}`, createdAt, ...actorField });
          }
          break;
        }
        default:
          break;
      }
      continue;
    }
    if (threadFilePath(thread)) continue;
    for (const comment of liveTextComments(thread)) {
      const reviewComment = toReviewComment(thread.id, comment, input.viewerId);
      if (!reviewComment) continue;
      push({
        kind: "comment",
        id: reviewComment.id,
        createdAt: reviewComment.createdAt,
        actor: reviewComment.author,
        body: reviewComment.body,
        ...(reviewComment.updatedAt ? { updatedAt: reviewComment.updatedAt } : {}),
        viewerCanUpdate: reviewComment.viewerCanUpdate === true,
        viewerCanDelete: reviewComment.viewerCanDelete === true,
      });
    }
  }

  for (const commit of input.commits) {
    const createdAt = parseAzureDevOpsDate(commit.committer?.date ?? commit.author?.date);
    if (!createdAt) continue;
    const { headline, body } = splitCommitMessage(commit.comment ?? "");
    const authorName = trimmed(commit.author?.name);
    push({
      kind: "commit",
      id: `commit:${commit.commitId}`,
      createdAt,
      ...(authorName ? { actor: { login: authorName } } : {}),
      oid: commit.commitId,
      shortOid: commit.commitId.slice(0, 7),
      messageHeadline: headline,
      ...(body ? { messageBody: body } : {}),
    });
  }

  const iterations = input.iterations.toSorted((left, right) => left.id - right.id);
  iterations.forEach((iteration, index) => {
    const createdAt = parseAzureDevOpsDate(iteration.createdDate);
    if (!createdAt) return;
    const actor = toActor(iteration.push?.pushedBy ?? iteration.author);
    const reason = iteration.reason?.trim().toLowerCase();
    if (reason === "forcepush" || reason === "rebase") {
      const beforeOid = trimmed(iterations[index - 1]?.sourceRefCommit?.commitId);
      const afterOid = trimmed(iteration.sourceRefCommit?.commitId);
      push({
        kind: "force-pushed",
        id: `iteration:${iteration.id}`,
        createdAt,
        ...(actor ? { actor } : {}),
        ...(beforeOid ? { beforeOid } : {}),
        ...(afterOid ? { afterOid } : {}),
      });
    } else if (reason === "retarget") {
      const previousRefName = trimmed(iteration.oldTargetRefName);
      const currentRefName = trimmed(iteration.newTargetRefName);
      push({
        kind: "base-ref-changed",
        id: `iteration:${iteration.id}`,
        createdAt,
        ...(actor ? { actor } : {}),
        ...(previousRefName
          ? { previousRefName: normalizeAzureDevOpsRefName(previousRefName) }
          : {}),
        ...(currentRefName ? { currentRefName: normalizeAzureDevOpsRefName(currentRefName) } : {}),
      });
    }
  });

  if (!statusRecorded) {
    const status = input.pullRequest.status.trim().toLowerCase();
    const actor = toActor(input.pullRequest.closedBy);
    const closedDate = closedDateOf(input.pullRequest);
    if (closedDate && status === "completed") {
      const commitOid = trimmed(input.pullRequest.lastMergeCommit?.commitId);
      push({
        kind: "merged",
        id: `pull-request:${input.pullRequest.pullRequestId}:merged`,
        createdAt: closedDate,
        ...(actor ? { actor } : {}),
        ...(commitOid ? { commitOid } : {}),
        baseRefName: normalizeAzureDevOpsRefName(input.pullRequest.targetRefName),
      });
    } else if (closedDate && status === "abandoned") {
      push({
        kind: "closed",
        id: `pull-request:${input.pullRequest.pullRequestId}:closed`,
        createdAt: closedDate,
        ...(actor ? { actor } : {}),
      });
    }
  }

  const sorted = entries
    .toSorted(
      (left, right) =>
        epochMillis(left.item.createdAt) - epochMillis(right.item.createdAt) ||
        left.order - right.order,
    )
    .map((entry) => entry.item);
  const truncated = sorted.length > AZURE_DEVOPS_TIMELINE_MAX_ITEMS;
  return {
    timeline: truncated ? sorted.slice(sorted.length - AZURE_DEVOPS_TIMELINE_MAX_ITEMS) : sorted,
    truncated: truncated || input.commitsTruncated,
  };
}

function closedDateOf(pullRequest: AzureDevOpsPullRequest): DateTime.Utc | null {
  return pullRequest.closedDate ? Option.getOrNull(pullRequest.closedDate) : null;
}

// ── Readiness ────────────────────────────────────────────────────────

function evaluationTypeId(evaluation: AzureDevOpsPolicyEvaluation): string {
  return evaluation.configuration?.type?.id?.trim().toLowerCase() ?? "";
}

function applicableEvaluations(
  evaluations: ReadonlyArray<AzureDevOpsPolicyEvaluation>,
): ReadonlyArray<AzureDevOpsPolicyEvaluation> {
  return evaluations.filter(
    (evaluation) =>
      evaluation.configuration?.isEnabled !== false &&
      evaluation.configuration?.isDeleted !== true &&
      evaluation.status?.trim().toLowerCase() !== "notapplicable",
  );
}

function statusOf(evaluation: AzureDevOpsPolicyEvaluation): string {
  return evaluation.status?.trim().toLowerCase() ?? "";
}

/**
 * Review verdict: votes say when changes were requested; blocking reviewer
 * policies (minimum approvals, required reviewers) say whether approval is
 * still missing. Without policy data only the votes decide.
 */
export function azureDevOpsReviewDecision(input: {
  readonly reviewers: ReadonlyArray<AzureDevOpsReviewer>;
  readonly evaluations: ReadonlyArray<AzureDevOpsPolicyEvaluation> | null;
}): SourceControlChangeRequestReviewDecision | null {
  const fromVotes = azureDevOpsReviewDecisionFromVotes(input.reviewers);
  if (fromVotes === "changes_requested" || input.evaluations === null) return fromVotes;
  const reviewerPolicies = applicableEvaluations(input.evaluations).filter((evaluation) => {
    const type = evaluationTypeId(evaluation);
    return (
      evaluation.configuration?.isBlocking === true &&
      (type === AZURE_DEVOPS_POLICY_TYPES.minimumApprovalCount ||
        type === AZURE_DEVOPS_POLICY_TYPES.requiredReviewers)
    );
  });
  if (reviewerPolicies.length === 0) return fromVotes;
  if (reviewerPolicies.some((evaluation) => statusOf(evaluation) === "rejected")) {
    return "changes_requested";
  }
  return reviewerPolicies.every((evaluation) => statusOf(evaluation) === "approved")
    ? "approved"
    : "review_required";
}

/**
 * Merge state from facts: draft, conflicts, blocking policies that have not
 * passed (`blocked`), optional policies that rejected (`unstable`), a
 * successful test merge with nothing blocking (`clean`); otherwise unknown.
 * Undefined when the policy evaluations could not be read.
 */
export function azureDevOpsMergeStateStatus(input: {
  readonly pullRequest: AzureDevOpsPullRequest;
  readonly evaluations: ReadonlyArray<AzureDevOpsPolicyEvaluation> | null;
}): SourceControlChangeRequestMergeStateStatus | undefined {
  const pullRequest = input.pullRequest;
  if (pullRequest.status.trim().toLowerCase() !== "active") return undefined;
  if (pullRequest.isDraft === true) return "draft";
  const mergeStatus = pullRequest.mergeStatus?.trim().toLowerCase();
  if (mergeStatus === "conflicts") return "dirty";
  if (input.evaluations === null) return undefined;
  const applicable = applicableEvaluations(input.evaluations);
  const blocking = applicable.filter((evaluation) => evaluation.configuration?.isBlocking === true);
  if (blocking.some((evaluation) => statusOf(evaluation) !== "approved")) return "blocked";
  if (mergeStatus === "rejectedbypolicy") return "blocked";
  if (mergeStatus !== "succeeded") return "unknown";
  return applicable.some((evaluation) => statusOf(evaluation) === "rejected")
    ? "unstable"
    : "clean";
}

function booleanSetting(settings: Record<string, unknown>, key: string): boolean | undefined {
  const value = settings[key];
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/**
 * Allowed strategies from an enabled "Require a merge strategy" policy
 * (`allowNoFastForward`, `allowSquash`, `allowRebase`, `allowRebaseMerge`, or
 * the legacy `useSquashMerge`); every strategy when no such policy applies.
 */
export function azureDevOpsMergeCapabilities(
  evaluations: ReadonlyArray<AzureDevOpsPolicyEvaluation> | null,
): SourceControlChangeRequestMergeCapabilities {
  const policies = applicableEvaluations(evaluations ?? []).filter(
    (evaluation) =>
      evaluationTypeId(evaluation) === AZURE_DEVOPS_POLICY_TYPES.mergeStrategy &&
      evaluation.configuration?.isBlocking !== false,
  );
  let capabilities: SourceControlChangeRequestMergeCapabilities = {
    merge: true,
    squash: true,
    rebase: true,
  };
  for (const policy of policies) {
    const settings = policy.configuration?.settings ?? {};
    const allowNoFastForward = booleanSetting(settings, "allowNoFastForward");
    const allowSquash = booleanSetting(settings, "allowSquash");
    const allowRebase = booleanSetting(settings, "allowRebase");
    const allowRebaseMerge = booleanSetting(settings, "allowRebaseMerge");
    const explicit = [allowNoFastForward, allowSquash, allowRebase, allowRebaseMerge].some(
      (value) => value !== undefined,
    );
    const allowed = explicit
      ? {
          merge: allowNoFastForward === true,
          squash: allowSquash === true,
          rebase: allowRebase === true,
        }
      : booleanSetting(settings, "useSquashMerge") === true
        ? { merge: false, squash: true, rebase: false }
        : { merge: true, squash: true, rebase: true };
    capabilities = {
      merge: capabilities.merge && allowed.merge,
      squash: capabilities.squash && allowed.squash,
      rebase: capabilities.rebase && allowed.rebase,
    };
  }
  return capabilities;
}

export function azureDevOpsReviewerStates(
  reviewers: ReadonlyArray<AzureDevOpsReviewer>,
): ReadonlyArray<SourceControlChangeRequestReviewer> {
  return reviewers.flatMap((reviewer) => {
    const login = azureDevOpsIdentityLogin(reviewer);
    if (!login || reviewer.hasDeclined === true) return [];
    const vote = reviewer.vote ?? 0;
    const avatarUrl = trimmed(reviewer.imageUrl);
    return [
      {
        login,
        kind: reviewer.isContainer === true ? ("team" as const) : ("user" as const),
        state: vote > 0 ? "approved" : vote < 0 ? "changes_requested" : "requested",
        ...(avatarUrl ? { avatarUrl } : {}),
      } satisfies SourceControlChangeRequestReviewer,
    ];
  });
}

const STRATEGY_TO_METHOD: Record<string, SourceControlChangeRequestMergeMethod> = {
  nofastforward: "merge",
  squash: "squash",
  rebase: "rebase",
  rebasemerge: "rebase",
};

export function azureDevOpsAutoMerge(
  pullRequest: AzureDevOpsPullRequest,
): SourceControlChangeRequestAutoMerge | null {
  if (identityKey(pullRequest.autoCompleteSetBy?.id) === null) return null;
  const strategy = pullRequest.completionOptions?.mergeStrategy?.trim().toLowerCase() ?? "";
  const squash = pullRequest.completionOptions?.squashMerge;
  const mergeMethod =
    STRATEGY_TO_METHOD[strategy] ?? (squash === true || squash === "true" ? "squash" : "merge");
  const enabledBy = azureDevOpsIdentityLogin(pullRequest.autoCompleteSetBy);
  return { mergeMethod, ...(enabledBy ? { enabledBy } : {}) };
}

// ── Request bodies ───────────────────────────────────────────────────

/** `GitPullRequestMergeStrategy` for a page merge method. */
export function azureDevOpsMergeStrategy(
  method: SourceControlChangeRequestMergeMethod,
): "noFastForward" | "squash" | "rebase" {
  switch (method) {
    case "merge":
      return "noFastForward";
    case "squash":
      return "squash";
    case "rebase":
      return "rebase";
  }
}

/** Pull Request Threads - Create, general discussion (official example shape). */
export function buildAzureDevOpsCommentThreadBody(content: string) {
  return {
    comments: [{ parentCommentId: 0, content, commentType: 1 }],
    status: 1,
  };
}

/** Pull Request Thread Comments - Create (reply to the thread's first comment). */
export function buildAzureDevOpsReplyBody(input: {
  readonly content: string;
  readonly parentCommentId: number;
}) {
  return { content: input.content, parentCommentId: input.parentCommentId, commentType: 1 };
}

/**
 * Pull Request Threads - Create on a file (official example shape). `left`
 * anchors on the base side (`leftFile*`), `right` on the head side
 * (`rightFile*`); a range spans `startLine`..`line`. Offsets are 1-based
 * character positions; the end offset covers the whole last line when its
 * length is known.
 */
export function buildAzureDevOpsFileThreadBody(input: {
  readonly comment: ChangeRequestDraftReviewComment;
  readonly iterationId: number;
  readonly changeTrackingId: number | null;
  readonly endLineLength?: number | undefined;
}) {
  const comment = input.comment;
  const filePath = `/${comment.path.replace(/^\/+/u, "")}`;
  const isFile = comment.subjectType === "file" || comment.line === undefined;
  const side = comment.side ?? "right";
  const endLine = comment.line;
  const startLine =
    comment.startLine !== undefined && endLine !== undefined && comment.startLine < endLine
      ? comment.startLine
      : endLine;
  const endOffset = Math.max(1, (input.endLineLength ?? 0) + 1);
  const positions =
    isFile || endLine === undefined || startLine === undefined
      ? {}
      : side === "left"
        ? {
            leftFileStart: { line: startLine, offset: 1 },
            leftFileEnd: { line: endLine, offset: endOffset },
          }
        : {
            rightFileStart: { line: startLine, offset: 1 },
            rightFileEnd: { line: endLine, offset: endOffset },
          };
  return {
    comments: [{ parentCommentId: 0, content: comment.body, commentType: 1 }],
    status: 1,
    threadContext: { filePath, ...positions },
    pullRequestThreadContext: {
      ...(input.changeTrackingId !== null ? { changeTrackingId: input.changeTrackingId } : {}),
      iterationContext: {
        firstComparingIteration: 1,
        secondComparingIteration: input.iterationId,
      },
    },
  };
}

/** `changeTrackingId` per repository path (no leading slash), including renamed-from paths. */
export function azureDevOpsChangeTrackingIds(
  changes: AzureDevOpsIterationChanges,
): ReadonlyMap<string, number> {
  const ids = new Map<string, number>();
  for (const entry of changes.changeEntries) {
    const trackingId = entry.changeTrackingId;
    if (typeof trackingId !== "number") continue;
    for (const path of [entry.item?.path, entry.originalPath]) {
      const normalized = trimmed(path)?.replace(/^\/+/u, "");
      if (normalized && !ids.has(normalized)) ids.set(normalized, trackingId);
    }
  }
  return ids;
}

export function latestAzureDevOpsIteration(
  iterations: ReadonlyArray<AzureDevOpsIteration>,
): AzureDevOpsIteration | null {
  return iterations.reduce<AzureDevOpsIteration | null>(
    (latest, iteration) => (latest === null || iteration.id > latest.id ? iteration : latest),
    null,
  );
}

export function azureDevOpsViewerFromConnectionData(
  data: typeof AzureDevOpsConnectionDataSchema.Type,
): AzureDevOpsViewerIdentity | null {
  const user = data.authenticatedUser;
  if (identityKey(user.id) === null) return null;
  const login =
    trimmed(user.properties?.Account?.$value) ??
    trimmed(user.customDisplayName) ??
    trimmed(user.providerDisplayName);
  return login ? { id: user.id, login } : null;
}

export function azureDevOpsViewerFromProfile(
  profile: typeof AzureDevOpsProfileSchema.Type,
): AzureDevOpsViewerIdentity | null {
  if (identityKey(profile.id) === null) return null;
  const login = trimmed(profile.emailAddress) ?? trimmed(profile.displayName);
  return login ? { id: profile.id, login } : null;
}
