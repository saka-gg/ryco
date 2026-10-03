import { DateTime, Exit, Schema } from "effect";
import {
  ChangeRequestReviewComment,
  ChangeRequestReviewThread,
  ChangeRequestTimelineItem,
  ChangeRequestViewerCapabilities,
  type ChangeRequestActivity,
  type ChangeRequestActor,
  type ChangeRequestDiffSide,
  type SourceControlCommentReaction,
  type SourceControlCommentReactionContent,
  type SourceControlReviewState,
} from "@ryco/contracts";

import { stripCommentMutationMarker } from "./gitHubCommentMutationMarker.ts";
import { lastForgejoDiffHunkLine, type ForgejoDiffLineIndex } from "./forgejoDiffLines.ts";
import type { ForgejoCommit } from "./forgejoPullRequests.ts";

/**
 * Forgejo (Gitea-compatible REST v1) review conversation reads for the pull
 * request page: lenient wire schemas and their normalization into the
 * `ChangeRequestActivity` contract.
 *
 * Payload shapes follow the API definitions `TimelineComment`, `PullReview`,
 * `PullReviewComment` and `Reaction` (https://codeberg.org/api/swagger) as
 * produced by Forgejo's `services/convert/issue_comment.go` and
 * `services/convert/pull_review.go`. Every field is optional so one odd row
 * (an older instance, a deleted user) is skipped instead of failing the read,
 * and each normalized item is re-checked against its contract schema.
 */

// ── Bounds ────────────────────────────────────────────────────────────

/** Forgejo's default `[api] MAX_RESPONSE_ITEMS`; larger `limit`s are clamped to it. */
export const FORGEJO_PAGE_LIMIT = 50;
/** Timeline pages walked oldest-first (1000 rows) before the read gives up on the rest. */
export const FORGEJO_TIMELINE_MAX_PAGES = 20;
/** Newest timeline items kept; older ones are dropped and reported as truncated. */
export const FORGEJO_TIMELINE_MAX_ITEMS = 250;
/** Review list pages read (200 reviews). */
export const FORGEJO_REVIEW_MAX_PAGES = 4;
/** Newest reviews whose code comments are read (one request each). */
export const FORGEJO_REVIEW_COMMENT_READS_MAX = 60;
/** Comments carried per thread; `totalComments` reports the rest. */
export const FORGEJO_THREAD_COMMENTS_MAX = 100;
/** Pull request commit pages read (250 commits, newest first). */
export const FORGEJO_COMMIT_MAX_PAGES = 5;
/**
 * Newest comments whose reactions are read. Forgejo has no bulk reaction
 * read, so this is one request per comment; older comments carry none.
 */
export const FORGEJO_REACTION_READS_MAX = 30;

// ── Wire schemas ──────────────────────────────────────────────────────

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));
const OptionalNumber = Schema.optional(Schema.NullOr(Schema.Number));
const OptionalBoolean = Schema.optional(Schema.NullOr(Schema.Boolean));

/** `User`. */
export const ForgejoActorSchema = Schema.Struct({
  id: OptionalNumber,
  login: OptionalString,
  username: OptionalString,
  full_name: OptionalString,
  avatar_url: OptionalString,
});
export type ForgejoActor = typeof ForgejoActorSchema.Type;

const ForgejoTeamSchema = Schema.Struct({ id: OptionalNumber, name: OptionalString });

const ForgejoTimelineLabelSchema = Schema.Struct({
  id: OptionalNumber,
  name: OptionalString,
  color: OptionalString,
  description: OptionalString,
});

const ForgejoReferencedIssueSchema = Schema.Struct({
  number: OptionalNumber,
  title: OptionalString,
  html_url: OptionalString,
  state: OptionalString,
  pull_request: Schema.optional(Schema.NullOr(Schema.Struct({ merged: OptionalBoolean }))),
  repository: Schema.optional(Schema.NullOr(Schema.Struct({ full_name: OptionalString }))),
});

/** `TimelineComment` (`GET /repos/{owner}/{repo}/issues/{index}/timeline`). */
export const ForgejoTimelineEventSchema = Schema.Struct({
  id: Schema.Number,
  type: Schema.String,
  body: OptionalString,
  created_at: OptionalString,
  updated_at: OptionalString,
  html_url: OptionalString,
  user: Schema.optional(Schema.NullOr(ForgejoActorSchema)),
  assignee: Schema.optional(Schema.NullOr(ForgejoActorSchema)),
  assignee_team: Schema.optional(Schema.NullOr(ForgejoTeamSchema)),
  removed_assignee: OptionalBoolean,
  label: Schema.optional(Schema.NullOr(ForgejoTimelineLabelSchema)),
  old_title: OptionalString,
  new_title: OptionalString,
  old_ref: OptionalString,
  new_ref: OptionalString,
  review_id: OptionalNumber,
  ref_action: OptionalString,
  ref_issue: Schema.optional(Schema.NullOr(ForgejoReferencedIssueSchema)),
});
export type ForgejoTimelineEvent = typeof ForgejoTimelineEventSchema.Type;

/** `PullReview` (`GET /repos/{owner}/{repo}/pulls/{index}/reviews`). */
export const ForgejoPullReviewSchema = Schema.Struct({
  id: Schema.Number,
  user: Schema.optional(Schema.NullOr(ForgejoActorSchema)),
  team: Schema.optional(Schema.NullOr(ForgejoTeamSchema)),
  /** `APPROVED`, `PENDING`, `COMMENT`, `REQUEST_CHANGES`, `REQUEST_REVIEW`, or "". */
  state: OptionalString,
  body: OptionalString,
  commit_id: OptionalString,
  stale: OptionalBoolean,
  official: OptionalBoolean,
  dismissed: OptionalBoolean,
  comments_count: OptionalNumber,
  submitted_at: OptionalString,
  updated_at: OptionalString,
  html_url: OptionalString,
});
export type ForgejoPullReview = typeof ForgejoPullReviewSchema.Type;

/** `PullReviewComment` (`GET /repos/{owner}/{repo}/pulls/{index}/reviews/{id}/comments`). */
export const ForgejoPullReviewCommentSchema = Schema.Struct({
  id: Schema.Number,
  body: OptionalString,
  user: Schema.optional(Schema.NullOr(ForgejoActorSchema)),
  resolver: Schema.optional(Schema.NullOr(ForgejoActorSchema)),
  pull_request_review_id: OptionalNumber,
  created_at: OptionalString,
  updated_at: OptionalString,
  path: OptionalString,
  commit_id: OptionalString,
  original_commit_id: OptionalString,
  diff_hunk: OptionalString,
  /** New-side line (0 when the comment is on the base side). */
  position: OptionalNumber,
  /** Base-side line (0 when the comment is on the head side). */
  original_position: OptionalNumber,
  /** Lines after `position` the comment spans (Forgejo 16+; absent before). */
  extra_lines_count: OptionalNumber,
  html_url: OptionalString,
});
export type ForgejoPullReviewComment = typeof ForgejoPullReviewCommentSchema.Type;

/** `Reaction` (`GET /repos/{owner}/{repo}/issues/comments/{id}/reactions`). */
export const ForgejoReactionSchema = Schema.Struct({
  user: Schema.optional(Schema.NullOr(ForgejoActorSchema)),
  content: OptionalString,
  created_at: OptionalString,
});
export type ForgejoReaction = typeof ForgejoReactionSchema.Type;

/** Decode a JSON list one entry at a time, dropping entries that do not match. */
export function decodeForgejoEntries<S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
  entries: ReadonlyArray<unknown>,
): ReadonlyArray<S["Type"]> {
  const decode = Schema.decodeUnknownExit(schema);
  const decoded: Array<S["Type"]> = [];
  for (const entry of entries) {
    const result = decode(entry);
    if (Exit.isSuccess(result)) decoded.push(result.value);
  }
  return decoded;
}

// ── Normalization helpers ─────────────────────────────────────────────

const isTimelineItem = Schema.is(ChangeRequestTimelineItem);
const isReviewThread = Schema.is(ChangeRequestReviewThread);
const isReviewComment = Schema.is(ChangeRequestReviewComment);
const isViewerCapabilities = Schema.is(ChangeRequestViewerCapabilities);

function trimmed(value: string | null | undefined): string | null {
  const result = value?.trim() ?? "";
  return result.length > 0 ? result : null;
}

/** Forgejo reports unset times as the zero time (0001-01-01T00:00:00Z). */
export function parseForgejoTime(value: string | null | undefined): DateTime.Utc | null {
  const text = trimmed(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() > 1970
    ? DateTime.fromDateUnsafe(date)
    : null;
}

function positiveInt(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

export function forgejoLogin(raw: ForgejoActor | null | undefined): string | null {
  return trimmed(raw?.login) ?? trimmed(raw?.username);
}

/** Forgejo's built-in Actions user (`forgejo-actions`) has the reserved id -2. */
const FORGEJO_ACTIONS_USER_ID = -2;

export function normalizeForgejoActor(
  raw: ForgejoActor | null | undefined,
): ChangeRequestActor | undefined {
  const login = forgejoLogin(raw);
  if (!login) return undefined;
  const avatarUrl = trimmed(raw?.avatar_url);
  return {
    login,
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(raw?.id === FORGEJO_ACTIONS_USER_ID ? { isBot: true } : {}),
  };
}

export function sameForgejoLogin(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  return !!left && !!right && left.toLowerCase() === right.toLowerCase();
}

/** Whether two commit ids name the same commit (either may be abbreviated). */
export function sameForgejoCommit(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) return false;
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.length >= 7 && long.startsWith(short);
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

// ── Reactions ─────────────────────────────────────────────────────────

/** Forgejo's default `[ui] REACTIONS` are GitHub's eight, under Gitea's names. */
const REACTION_CONTENT_BY_FORGEJO: Readonly<Record<string, SourceControlCommentReactionContent>> = {
  "+1": "thumbs-up",
  "-1": "thumbs-down",
  laugh: "laugh",
  hooray: "hooray",
  confused: "confused",
  heart: "heart",
  rocket: "rocket",
  eyes: "eyes",
};

const REACTION_ORDER: ReadonlyArray<SourceControlCommentReactionContent> = [
  "thumbs-up",
  "thumbs-down",
  "laugh",
  "hooray",
  "confused",
  "heart",
  "rocket",
  "eyes",
];

export function toForgejoReactionContent(content: SourceControlCommentReactionContent): string {
  switch (content) {
    case "thumbs-up":
      return "+1";
    case "thumbs-down":
      return "-1";
    default:
      return content;
  }
}

export function fromForgejoReactionContent(
  content: string | null | undefined,
): SourceControlCommentReactionContent | null {
  const key = content?.trim().toLowerCase() ?? "";
  return REACTION_CONTENT_BY_FORGEJO[key] ?? null;
}

/** Count a comment's reactions per content; instance-specific custom reactions are left out. */
export function summarizeForgejoReactions(
  reactions: ReadonlyArray<ForgejoReaction>,
  viewerLogin: string | null,
): ReadonlyArray<SourceControlCommentReaction> {
  const counts = new Map<SourceControlCommentReactionContent, { count: number; viewer: boolean }>();
  for (const reaction of reactions) {
    const content = fromForgejoReactionContent(reaction.content);
    if (!content) continue;
    const entry = counts.get(content) ?? { count: 0, viewer: false };
    counts.set(content, {
      count: entry.count + 1,
      viewer: entry.viewer || sameForgejoLogin(forgejoLogin(reaction.user), viewerLogin),
    });
  }
  return REACTION_ORDER.flatMap((content) => {
    const entry = counts.get(content);
    return entry ? [{ content, count: entry.count, viewerHasReacted: entry.viewer }] : [];
  });
}

// ── Viewer ────────────────────────────────────────────────────────────

/** Who is reading, and what the repository lets them do (from `permissions`). */
export interface ForgejoViewerContext {
  readonly login: string;
  /** `permissions.push` or `permissions.admin`. */
  readonly canWrite: boolean;
  readonly isAdmin: boolean;
}

export function forgejoViewerContext(input: {
  readonly login: string | null;
  readonly permissions:
    | {
        readonly admin?: boolean | null | undefined;
        readonly push?: boolean | null | undefined;
      }
    | null
    | undefined;
}): ForgejoViewerContext | null {
  const login = trimmed(input.login);
  if (!login) return null;
  const isAdmin = input.permissions?.admin === true;
  return { login, isAdmin, canWrite: isAdmin || input.permissions?.push === true };
}

/**
 * Viewer permissions on one pull request. Forgejo reports repository
 * permissions and, on the base branch, whether the viewer may merge into it;
 * anything it does not report stays false so the page hides the control.
 */
export function deriveForgejoViewerCapabilities(input: {
  readonly viewer: ForgejoViewerContext | null;
  readonly authorLogin: string | null;
  readonly isLocked: boolean;
  readonly isCrossRepository: boolean;
  readonly allowMaintainerEdit: boolean;
  /** `Branch.user_can_merge` of the base branch, when it was read. */
  readonly userCanMergeBase: boolean | null;
}): ChangeRequestViewerCapabilities | null {
  const viewer = input.viewer;
  if (!viewer) return null;
  const isAuthor = sameForgejoLogin(viewer.login, input.authorLogin);
  const capabilities: ChangeRequestViewerCapabilities = {
    login: viewer.login,
    isAuthor,
    canUpdate: isAuthor || viewer.canWrite,
    canMerge: input.userCanMergeBase ?? viewer.canWrite,
    canReview: !input.isLocked || viewer.canWrite,
    // Updating the head pushes to it: a fork head only takes maintainer pushes when allowed.
    canUpdateBranch: input.isCrossRepository
      ? isAuthor || (input.allowMaintainerEdit && viewer.canWrite)
      : viewer.canWrite,
    // Forgejo's API can schedule an auto-merge but never reports one, so Ryco does not offer it.
    canEnableAutoMerge: false,
    canDisableAutoMerge: false,
  };
  return isViewerCapabilities(capabilities) ? capabilities : null;
}

/** Comment authors may edit and delete their comments; repository admins may edit any. */
function viewerOwnsComment(
  viewer: ForgejoViewerContext | null,
  author: ForgejoActor | null | undefined,
): boolean {
  if (!viewer) return false;
  return viewer.isAdmin || sameForgejoLogin(viewer.login, forgejoLogin(author));
}

// ── Review comment and thread ids ─────────────────────────────────────

/** A review comment id: `<reviewId>:<commentId>`, so deletes can address the review. */
export function forgejoReviewCommentId(reviewId: number, commentId: number): string {
  return `${reviewId}:${commentId}`;
}

/** A thread id: `<reviewId>/<first comment id>`; replies attach to that review. */
export function forgejoReviewThreadId(reviewId: number, firstCommentId: number): string {
  return `${reviewId}/${firstCommentId}`;
}

export type ParsedForgejoCommentId =
  | { readonly kind: "issue-comment"; readonly commentId: number }
  | { readonly kind: "review-comment"; readonly reviewId: number; readonly commentId: number };

function safeId(value: string | undefined): number | null {
  if (value === undefined) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function parseForgejoCommentId(id: string): ParsedForgejoCommentId | null {
  const plain = /^(\d+)$/u.exec(id.trim());
  if (plain) {
    const commentId = safeId(plain[1]);
    return commentId === null ? null : { kind: "issue-comment", commentId };
  }
  const composite = /^(\d+):(\d+)$/u.exec(id.trim());
  const reviewId = safeId(composite?.[1]);
  const commentId = safeId(composite?.[2]);
  return reviewId !== null && commentId !== null
    ? { kind: "review-comment", reviewId, commentId }
    : null;
}

export function parseForgejoThreadId(
  id: string,
): { readonly reviewId: number; readonly firstCommentId: number } | null {
  const match = /^(\d+)\/(\d+)$/u.exec(id.trim());
  const reviewId = safeId(match?.[1]);
  const firstCommentId = safeId(match?.[2]);
  return reviewId !== null && firstCommentId !== null ? { reviewId, firstCommentId } : null;
}

// ── Review states ─────────────────────────────────────────────────────

/** A submitted review's state; null for pending reviews, review requests, and unknown states. */
export function normalizeForgejoReviewState(
  review: Pick<ForgejoPullReview, "state" | "dismissed">,
): SourceControlReviewState | null {
  const state = review.state?.trim().toUpperCase() ?? "";
  const submitted =
    state === "APPROVED"
      ? "approved"
      : state === "REQUEST_CHANGES"
        ? "changes_requested"
        : state === "COMMENT"
          ? "commented"
          : null;
  if (!submitted) return null;
  return review.dismissed === true ? "dismissed" : submitted;
}

export function isForgejoPendingReview(review: Pick<ForgejoPullReview, "state">): boolean {
  return review.state?.trim().toUpperCase() === "PENDING";
}

// ── Review threads ────────────────────────────────────────────────────

export interface ForgejoReviewWithComments {
  readonly review: ForgejoPullReview;
  readonly comments: ReadonlyArray<ForgejoPullReviewComment>;
}

/** Where a thread sits now. */
export interface ForgejoThreadAnchorContext {
  readonly headSha: string | null;
  /** The current diff's lines; null when it was not read (threads off the head then read as outdated). */
  readonly diff: ForgejoDiffLineIndex | null;
}

/** The comment's stored side and line: positive on the head side, negative on the base side, 0 for none. */
function signedLine(comment: ForgejoPullReviewComment): number {
  const position = positiveInt(comment.position);
  if (position !== null) return position;
  const original = positiveInt(comment.original_position);
  return original !== null ? -original : 0;
}

interface ThreadAnchor {
  readonly subjectType: "line" | "file";
  readonly side: ChangeRequestDiffSide;
  readonly line: number | null;
  readonly startLine: number | null;
  readonly originalLine: number | null;
  readonly originalStartLine: number | null;
  readonly originalCommitOid: string | null;
  readonly isOutdated: boolean;
}

/**
 * The commented line, read from the end of `diff_hunk` (written against the
 * head the review was on, `review.commit_id`). It is current when that head
 * is still the head, or when the current diff still shows the same text at
 * that line; otherwise the thread is outdated and keeps only its original
 * anchor. Lines that shifted are reported as outdated rather than guessed.
 */
export function resolveForgejoThreadAnchor(input: {
  readonly path: string;
  readonly opener: ForgejoPullReviewComment;
  readonly review: ForgejoPullReview;
  readonly context: ForgejoThreadAnchorContext;
}): ThreadAnchor {
  const { opener, review, context } = input;
  const stored = signedLine(opener);
  const originalCommitOid = trimmed(review.commit_id) ?? trimmed(opener.commit_id);
  if (stored === 0) {
    return {
      subjectType: "file",
      side: "right",
      line: null,
      startLine: null,
      originalLine: null,
      originalStartLine: null,
      originalCommitOid,
      isOutdated: false,
    };
  }
  const side: ChangeRequestDiffSide = stored > 0 ? "right" : "left";
  const extra = Math.max(0, positiveInt(opener.extra_lines_count) ?? 0);
  const hunkLine = lastForgejoDiffHunkLine(opener.diff_hunk, side);
  const originalLine = hunkLine?.line ?? Math.abs(stored) + extra;
  const originalStartLine = extra > 0 && originalLine - extra >= 1 ? originalLine - extra : null;

  const onHead = context.headSha !== null && sameForgejoCommit(originalCommitOid, context.headSha);
  const current = hunkLine
    ? onHead ||
      (context.diff !== null &&
        context.diff.lineText(input.path, side, hunkLine.line) === hunkLine.text)
    : // Without an excerpt, the stored line is only trusted when it was blamed on the head itself.
      onHead && sameForgejoCommit(opener.commit_id, context.headSha);
  return {
    subjectType: "line",
    side,
    line: current ? originalLine : null,
    startLine: current ? originalStartLine : null,
    originalLine,
    originalStartLine,
    originalCommitOid,
    isOutdated: !current,
  };
}

/**
 * Whether any thread needs the current diff to decide whether it is outdated
 * (it was written on another head), so the diff is only read when it matters.
 */
export function forgejoThreadsNeedCurrentDiff(
  reviews: ReadonlyArray<ForgejoReviewWithComments>,
  headSha: string | null,
): boolean {
  return reviews.some(
    ({ review, comments }) =>
      comments.length > 0 &&
      !sameForgejoCommit(trimmed(review.commit_id) ?? trimmed(comments[0]?.commit_id), headSha),
  );
}

function normalizeReviewComment(
  raw: ForgejoPullReviewComment,
  review: ForgejoPullReview,
  context: {
    readonly viewer: ForgejoViewerContext | null;
    readonly reactionsByCommentId: ReadonlyMap<number, ReadonlyArray<SourceControlCommentReaction>>;
  },
): ChangeRequestReviewComment | null {
  const createdAt = parseForgejoTime(raw.created_at);
  if (!createdAt) return null;
  const updatedAt = parseForgejoTime(raw.updated_at);
  const reactions = context.reactionsByCommentId.get(raw.id);
  const owns = viewerOwnsComment(context.viewer, raw.user);
  const comment: ChangeRequestReviewComment = {
    id: forgejoReviewCommentId(review.id, raw.id),
    author: normalizeForgejoActor(raw.user) ?? { login: "ghost" },
    body: bodyOf(raw.body),
    createdAt,
    ...optionalFields({ updatedAt, url: trimmed(raw.html_url) }),
    ...(reactions && reactions.length > 0 ? { reactions } : {}),
    state: isForgejoPendingReview(review) ? "pending" : "submitted",
    viewerCanUpdate: owns,
    viewerCanDelete: owns,
  };
  return isReviewComment(comment) ? comment : null;
}

function createdMillis(value: string | null | undefined): number {
  const time = parseForgejoTime(value);
  return time ? DateTime.toEpochMillis(time) : 0;
}

/**
 * Forgejo threads are positional: a review's code comments on one path and
 * line form a conversation, and replies (from the web or the API) join the
 * review of the comment they answer. Threads are keyed the same way, so an
 * id round-trips into a reply. Resolution lives on the first comment.
 */
export function buildForgejoReviewThreads(input: {
  readonly reviews: ReadonlyArray<ForgejoReviewWithComments>;
  readonly anchor: ForgejoThreadAnchorContext;
  readonly viewer: ForgejoViewerContext | null;
  readonly viewerCanReply: boolean;
  readonly reactionsByCommentId?: ReadonlyMap<number, ReadonlyArray<SourceControlCommentReaction>>;
}): {
  readonly threads: ReadonlyArray<ChangeRequestReviewThread>;
  readonly threadIdsByReviewId: ReadonlyMap<number, ReadonlyArray<string>>;
} {
  const reactionsByCommentId = input.reactionsByCommentId ?? new Map();
  const built: Array<{ readonly thread: ChangeRequestReviewThread; readonly order: number }> = [];
  const threadIdsByReviewId = new Map<number, string[]>();

  for (const { review, comments } of input.reviews) {
    const groups = new Map<string, ForgejoPullReviewComment[]>();
    for (const comment of comments) {
      const path = trimmed(comment.path);
      if (!path) continue;
      const key = `${path}\u0000${signedLine(comment)}`;
      const group = groups.get(key);
      if (group) group.push(comment);
      else groups.set(key, [comment]);
    }
    for (const group of groups.values()) {
      const sorted = group.toSorted(
        (left, right) =>
          createdMillis(left.created_at) - createdMillis(right.created_at) || left.id - right.id,
      );
      const opener = sorted[0];
      const path = trimmed(opener?.path);
      if (!opener || !path) continue;
      const anchor = resolveForgejoThreadAnchor({ path, opener, review, context: input.anchor });
      const normalized = sorted.flatMap((comment) => {
        const result = normalizeReviewComment(comment, review, {
          viewer: input.viewer,
          reactionsByCommentId,
        });
        return result ? [result] : [];
      });
      if (normalized.length === 0) continue;
      const resolvedBy = forgejoLogin(opener.resolver);
      const diffHunk = trimmed(opener.diff_hunk) ? (opener.diff_hunk ?? undefined) : undefined;
      const thread: ChangeRequestReviewThread = {
        id: forgejoReviewThreadId(review.id, opener.id),
        path,
        subjectType: anchor.subjectType,
        side: anchor.side,
        line: anchor.line,
        startLine: anchor.startLine,
        originalLine: anchor.originalLine,
        originalStartLine: anchor.originalStartLine,
        ...optionalFields({ originalCommitOid: anchor.originalCommitOid, diffHunk, resolvedBy }),
        isResolved: resolvedBy !== null,
        isOutdated: anchor.isOutdated,
        viewerCanReply: input.viewerCanReply,
        // Forgejo's API cannot resolve conversations (only its web UI can).
        viewerCanResolve: false,
        viewerCanUnresolve: false,
        comments: normalized.slice(0, FORGEJO_THREAD_COMMENTS_MAX),
        totalComments: normalized.length,
      };
      if (!isReviewThread(thread)) continue;
      built.push({ thread, order: createdMillis(opener.created_at) });
      const ids = threadIdsByReviewId.get(review.id);
      if (ids) ids.push(thread.id);
      else threadIdsByReviewId.set(review.id, [thread.id]);
    }
  }

  return {
    threads: built.toSorted((left, right) => left.order - right.order).map((entry) => entry.thread),
    threadIdsByReviewId,
  };
}

// ── Timeline ──────────────────────────────────────────────────────────

/** The `pull_push` comment body: `{"is_force_push": bool, "commit_ids": [...]}`. */
const ForgejoPushContentSchema = Schema.Struct({
  is_force_push: OptionalBoolean,
  commit_ids: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
});
const decodePushContent = Schema.decodeUnknownExit(ForgejoPushContentSchema);

function parsePushContent(
  body: string | null | undefined,
): typeof ForgejoPushContentSchema.Type | null {
  if (!body) return null;
  try {
    const decoded = decodePushContent(JSON.parse(body));
    return Exit.isSuccess(decoded) ? decoded.value : null;
  } catch {
    return null;
  }
}

function referencedState(
  issue: typeof ForgejoReferencedIssueSchema.Type,
): "open" | "closed" | "merged" | null {
  if (issue.pull_request?.merged === true) return "merged";
  const state = issue.state?.trim().toLowerCase();
  return state === "open" || state === "closed" ? state : null;
}

function normalizeTimelineEvent(
  event: ForgejoTimelineEvent,
  context: {
    readonly reviewsById: ReadonlyMap<number, ForgejoPullReview>;
    readonly threadIdsByReviewId: ReadonlyMap<number, ReadonlyArray<string>>;
    readonly reactionsByCommentId: ReadonlyMap<number, ReadonlyArray<SourceControlCommentReaction>>;
    readonly viewer: ForgejoViewerContext | null;
    readonly baseRefName: string | null;
  },
): ChangeRequestTimelineItem | null {
  const createdAt = parseForgejoTime(event.created_at);
  if (!createdAt) return null;
  const actor = normalizeForgejoActor(event.user);
  const head = { id: String(event.id), createdAt, ...(actor ? { actor } : {}) };

  switch (event.type) {
    case "comment": {
      const reactions = context.reactionsByCommentId.get(event.id);
      const owns = viewerOwnsComment(context.viewer, event.user);
      return {
        ...head,
        kind: "comment",
        body: bodyOf(event.body),
        ...optionalFields({
          updatedAt: parseForgejoTime(event.updated_at),
          url: trimmed(event.html_url),
        }),
        ...(reactions && reactions.length > 0 ? { reactions } : {}),
        viewerCanUpdate: owns,
        viewerCanDelete: owns,
      };
    }
    case "review": {
      const reviewId = positiveInt(event.review_id);
      const review = reviewId !== null ? context.reviewsById.get(reviewId) : undefined;
      const state = review ? normalizeForgejoReviewState(review) : null;
      if (reviewId === null || !review || !state) return null;
      return {
        ...head,
        kind: "review",
        state,
        body: bodyOf(event.body ?? review.body),
        threadIds: context.threadIdsByReviewId.get(reviewId) ?? [],
        ...optionalFields({ url: trimmed(event.html_url) ?? trimmed(review.html_url) }),
        // Forgejo keeps a review's summary on the review; Ryco does not edit it.
        viewerCanUpdate: false,
      };
    }
    case "pull_push": {
      const content = parsePushContent(event.body);
      // Plain pushes are covered by the commit items; only rewrites are events.
      if (content?.is_force_push !== true) return null;
      const [beforeOid, afterOid] = content.commit_ids ?? [];
      return {
        ...head,
        kind: "force-pushed",
        ...optionalFields({ beforeOid: trimmed(beforeOid), afterOid: trimmed(afterOid) }),
      };
    }
    case "review_request": {
      const user = forgejoLogin(event.assignee);
      const team = trimmed(event.assignee_team?.name);
      const reviewer = user ?? team;
      if (!reviewer) return null;
      return {
        ...head,
        kind: event.removed_assignee === true ? "review-request-removed" : "review-requested",
        reviewer,
        reviewerKind: user ? "user" : "team",
      };
    }
    case "label": {
      const name = trimmed(event.label?.name);
      if (!name) return null;
      const color = trimmed(event.label?.color)?.replace(/^#/u, "");
      return {
        ...head,
        // Forgejo writes "1" into the comment when a label is added.
        kind: event.body?.trim() === "1" ? "labeled" : "unlabeled",
        label: {
          name,
          ...optionalFields({ color, description: trimmed(event.label?.description) }),
        },
      };
    }
    case "assignees": {
      const assignee = forgejoLogin(event.assignee);
      if (!assignee) return null;
      return {
        ...head,
        kind: event.removed_assignee === true ? "unassigned" : "assigned",
        assignee,
      };
    }
    case "change_title":
      return {
        ...head,
        kind: "renamed",
        previousTitle: event.old_title ?? "",
        currentTitle: event.new_title ?? "",
      };
    case "merge_pull":
      return {
        ...head,
        kind: "merged",
        ...optionalFields({ baseRefName: trimmed(context.baseRefName) }),
      };
    case "close":
      return { ...head, kind: "closed" };
    case "reopen":
      return { ...head, kind: "reopened" };
    case "delete_branch":
      return { ...head, kind: "head-ref-deleted" };
    case "change_target_branch":
      return {
        ...head,
        kind: "base-ref-changed",
        ...optionalFields({
          previousRefName: trimmed(event.old_ref),
          currentRefName: trimmed(event.new_ref),
        }),
      };
    case "pull_scheduled_merge":
      return { ...head, kind: "auto-merge-enabled" };
    case "pull_cancel_scheduled_merge":
      return { ...head, kind: "auto-merge-disabled" };
    case "dismiss_review": {
      const reviewId = positiveInt(event.review_id);
      const review = reviewId !== null ? context.reviewsById.get(reviewId) : undefined;
      return {
        ...head,
        kind: "review-dismissed",
        ...optionalFields({
          reviewAuthor: forgejoLogin(review?.user),
          message: trimmed(event.body) ? event.body : null,
        }),
      };
    }
    case "issue_ref":
    case "pull_ref":
    case "comment_ref": {
      const source = event.ref_issue;
      const number = positiveInt(source?.number);
      if (!source || number === null) return null;
      return {
        ...head,
        kind: "cross-referenced",
        source: {
          kind: source.pull_request ? "change-request" : "issue",
          number,
          title: source.title ?? "",
          url: source.html_url ?? "",
          ...optionalFields({
            repository: trimmed(source.repository?.full_name),
            state: referencedState(source),
          }),
        },
        ...(event.ref_action?.trim().toLowerCase() === "closes" ? { willCloseTarget: true } : {}),
      };
    }
    default:
      // Milestones, projects, time tracking, pins, locks, dependencies and
      // code comments (shown in threads) have no timeline item.
      return null;
  }
}

function normalizeCommitItem(commit: ForgejoCommit): ChangeRequestTimelineItem | null {
  const oid = trimmed(commit.sha);
  const createdAt =
    parseForgejoTime(commit.commit?.committer?.date) ??
    parseForgejoTime(commit.commit?.author?.date) ??
    parseForgejoTime(commit.created);
  if (!oid || !createdAt) return null;
  const message = commit.commit?.message ?? "";
  const newline = message.indexOf("\n");
  const messageHeadline = (newline === -1 ? message : message.slice(0, newline)).trim();
  const messageBody = newline === -1 ? "" : message.slice(newline + 1).trim();
  const actor =
    normalizeForgejoActor(commit.author) ??
    (trimmed(commit.commit?.author?.name)
      ? { login: trimmed(commit.commit?.author?.name)! }
      : undefined);
  return {
    id: `commit:${oid}`,
    createdAt,
    ...(actor ? { actor } : {}),
    kind: "commit",
    oid,
    shortOid: oid.slice(0, 7),
    messageHeadline,
    ...(messageBody ? { messageBody } : {}),
  };
}

/**
 * The conversation timeline, oldest first: timeline rows (comments, reviews,
 * events) interleaved with the pull request's commits by time. When there
 * are more than `maxItems`, the oldest are dropped.
 */
export function normalizeForgejoTimeline(input: {
  readonly events: ReadonlyArray<ForgejoTimelineEvent>;
  readonly commits: ReadonlyArray<ForgejoCommit>;
  readonly reviewsById: ReadonlyMap<number, ForgejoPullReview>;
  readonly threadIdsByReviewId: ReadonlyMap<number, ReadonlyArray<string>>;
  readonly reactionsByCommentId?: ReadonlyMap<number, ReadonlyArray<SourceControlCommentReaction>>;
  readonly viewer: ForgejoViewerContext | null;
  readonly baseRefName: string | null;
  readonly maxItems?: number;
}): { readonly items: ReadonlyArray<ChangeRequestTimelineItem>; readonly truncated: boolean } {
  const context = {
    reviewsById: input.reviewsById,
    threadIdsByReviewId: input.threadIdsByReviewId,
    reactionsByCommentId: input.reactionsByCommentId ?? new Map(),
    viewer: input.viewer,
    baseRefName: input.baseRefName,
  };
  const seen = new Set<string>();
  const items: ChangeRequestTimelineItem[] = [];
  const add = (item: ChangeRequestTimelineItem | null) => {
    if (!item || seen.has(item.id) || !isTimelineItem(item)) return;
    seen.add(item.id);
    items.push(item);
  };
  for (const event of input.events) add(normalizeTimelineEvent(event, context));
  for (const commit of input.commits) add(normalizeCommitItem(commit));

  const ordered = items
    .map((item, index) => ({ item, index }))
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(left.item.createdAt) -
          DateTime.toEpochMillis(right.item.createdAt) || left.index - right.index,
    )
    .map((entry) => entry.item);
  const maxItems = input.maxItems ?? FORGEJO_TIMELINE_MAX_ITEMS;
  return ordered.length > maxItems
    ? { items: ordered.slice(ordered.length - maxItems), truncated: true }
    : { items: ordered, truncated: false };
}

/** The viewer's unsubmitted review, which the next submitted review absorbs. */
export function forgejoPendingReview(
  reviews: ReadonlyArray<ForgejoReviewWithComments>,
  viewer: ForgejoViewerContext | null,
): ChangeRequestActivity["pendingReview"] {
  if (!viewer) return null;
  const pending = reviews.find(
    ({ review }) =>
      isForgejoPendingReview(review) && sameForgejoLogin(forgejoLogin(review.user), viewer.login),
  );
  if (!pending) return null;
  const counted = pending.review.comments_count;
  return {
    id: String(pending.review.id),
    commentsCount:
      typeof counted === "number" && Number.isSafeInteger(counted) && counted >= 0
        ? counted
        : pending.comments.length,
  };
}
