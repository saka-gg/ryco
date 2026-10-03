/**
 * Bitbucket Cloud (REST 2.0) payloads for the pull requests page and their
 * mapping onto the change request contract: review threads, the timeline,
 * viewer permissions, merge readiness, and the request bodies the page's
 * mutations send. Pure: no HTTP here (see `BitbucketApi.ts`).
 *
 * API reference: https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/
 * (schemas in https://dac-static.atlassian.com/cloud/bitbucket/swagger.v3.json).
 */
import { DateTime, Option, Result, Schema } from "effect";
import type {
  ChangeRequestActivity,
  ChangeRequestActor,
  ChangeRequestDraftReviewComment,
  ChangeRequestReviewComment,
  ChangeRequestReviewThread,
  ChangeRequestTimelineItem,
  ChangeRequestUpdateAction,
  ChangeRequestViewerCapabilities,
  SourceControlChangeRequestCommit,
  SourceControlChangeRequestMergeability,
  SourceControlChangeRequestMergeCapabilities,
  SourceControlChangeRequestMergeMethod,
  SourceControlChangeRequestMergeStateStatus,
  SourceControlChangeRequestReviewDecision,
  SourceControlChangeRequestReviewer,
  SourceControlCheckRollupItem,
} from "@ryco/contracts";

import {
  BitbucketPullRequestUserSchema,
  bitbucketUserDisplayName,
  type BitbucketAccount,
  type BitbucketPullRequest,
} from "./bitbucketPullRequests.ts";

// ── Bounds ────────────────────────────────────────────────────────────

/** Bitbucket's global page size range is 10–100 (REST intro, "Pagination"). */
export const BITBUCKET_PAGE_LEN = 100;
/** The activity log is read in smaller pages. */
export const BITBUCKET_ACTIVITY_PAGE_LEN = 50;
export const BITBUCKET_ACTIVITY_MAX_PAGES = 5;
export const BITBUCKET_COMMENTS_MAX_PAGES = 5;
export const BITBUCKET_COMMITS_MAX_PAGES = 3;
export const BITBUCKET_MEMBERS_MAX_PAGES = 5;
export const BITBUCKET_STATUSES_MAX_PAGES = 2;

// ── Raw schemas ───────────────────────────────────────────────────────

const NullableString = Schema.optional(Schema.NullOr(Schema.String));
const NullableNumber = Schema.optional(Schema.NullOr(Schema.Number));
const NullableBoolean = Schema.optional(Schema.NullOr(Schema.Boolean));
const NullableAccount = Schema.optional(Schema.NullOr(BitbucketPullRequestUserSchema));
const HtmlLinks = Schema.optional(
  Schema.NullOr(
    Schema.Struct({
      html: Schema.optional(Schema.NullOr(Schema.Struct({ href: NullableString }))),
    }),
  ),
);

/** `GET /user` (https://developer.atlassian.com/cloud/bitbucket/rest/api-group-users/). */
export const BitbucketViewerSchema = BitbucketPullRequestUserSchema;

/** The `inline` object of a pull request comment (`comment.inline`). */
export const BitbucketInlineSchema = Schema.Struct({
  path: Schema.String,
  /** Anchor line in the old file (the end line of a multi-line comment). */
  from: NullableNumber,
  /** Anchor line in the new file (the end line of a multi-line comment). */
  to: NullableNumber,
  start_from: NullableNumber,
  start_to: NullableNumber,
  /** Present on real payloads (see the activity endpoint's comment example). */
  outdated: NullableBoolean,
});

/** `pullrequest_comment`. */
export const BitbucketPullRequestCommentSchema = Schema.Struct({
  id: Schema.Number,
  created_on: Schema.String,
  updated_on: NullableString,
  content: Schema.optional(Schema.NullOr(Schema.Struct({ raw: NullableString }))),
  user: NullableAccount,
  deleted: NullableBoolean,
  /** Unpublished draft comment of the authenticated user. */
  pending: NullableBoolean,
  parent: Schema.optional(Schema.NullOr(Schema.Struct({ id: Schema.Number }))),
  inline: Schema.optional(Schema.NullOr(BitbucketInlineSchema)),
  resolution: Schema.optional(
    Schema.NullOr(Schema.Struct({ user: NullableAccount, created_on: NullableString })),
  ),
  links: HtmlLinks,
});
export type BitbucketPullRequestComment = typeof BitbucketPullRequestCommentSchema.Type;

export const BitbucketPullRequestCommentPageSchema = Schema.Struct({
  values: Schema.Array(BitbucketPullRequestCommentSchema),
  next: NullableString,
});

/** `comment_resolution`, returned by `POST .../comments/{id}/resolve`. */
export const BitbucketCommentResolutionSchema = Schema.Struct({
  user: NullableAccount,
  created_on: NullableString,
});

const ActivityEndpointSchema = Schema.Struct({
  commit: Schema.optional(Schema.NullOr(Schema.Struct({ hash: NullableString }))),
  branch: Schema.optional(Schema.NullOr(Schema.Struct({ name: NullableString }))),
});

const ActivityUpdateSchema = Schema.Struct({
  date: Schema.String,
  state: NullableString,
  title: NullableString,
  draft: NullableBoolean,
  source: Schema.optional(Schema.NullOr(ActivityEndpointSchema)),
  destination: Schema.optional(Schema.NullOr(ActivityEndpointSchema)),
  reviewers: Schema.optional(Schema.NullOr(Schema.Array(BitbucketPullRequestUserSchema))),
});
export type BitbucketActivityUpdate = typeof ActivityUpdateSchema.Type;

const ActivityVerdictSchema = Schema.Struct({ date: Schema.String, user: NullableAccount });

/** One `GET .../pullrequests/{id}/activity` entry: an update, approval, change request or comment. */
export const BitbucketActivityEntrySchema = Schema.Struct({
  update: Schema.optional(Schema.NullOr(ActivityUpdateSchema)),
  approval: Schema.optional(Schema.NullOr(ActivityVerdictSchema)),
  changes_requested: Schema.optional(Schema.NullOr(ActivityVerdictSchema)),
});
export type BitbucketActivityEntry = typeof BitbucketActivityEntrySchema.Type;

export const BitbucketActivityPageSchema = Schema.Struct({
  values: Schema.Array(BitbucketActivityEntrySchema),
  next: NullableString,
});

/** `commit` (pull request commits, `GET .../pullrequests/{id}/commits`). */
export const BitbucketCommitSchema = Schema.Struct({
  hash: Schema.String,
  date: NullableString,
  message: NullableString,
  author: Schema.optional(
    Schema.NullOr(Schema.Struct({ raw: NullableString, user: NullableAccount })),
  ),
  parents: Schema.optional(Schema.NullOr(Schema.Array(Schema.Struct({ hash: NullableString })))),
});
export type BitbucketCommit = typeof BitbucketCommitSchema.Type;

/**
 * Oldest first, parents before children (commit dates tie after rebases and
 * the endpoint's order is not a contract); unrelated commits by date.
 */
export function orderBitbucketCommits(
  commits: ReadonlyArray<BitbucketCommit>,
): ReadonlyArray<BitbucketCommit> {
  const at = (commit: BitbucketCommit) => {
    const date = parseDate(commit.date);
    return date ? DateTime.toEpochMillis(date) : 0;
  };
  const byHash = new Map(commits.map((commit) => [commit.hash, commit]));
  const pending = new Map(
    commits.map((commit) => [
      commit.hash,
      (commit.parents ?? []).filter((parent) => parent.hash && byHash.has(parent.hash)).length,
    ]),
  );
  const children = new Map<string, BitbucketCommit[]>();
  for (const commit of commits) {
    for (const parent of commit.parents ?? []) {
      if (!parent.hash || !byHash.has(parent.hash)) continue;
      children.set(parent.hash, [...(children.get(parent.hash) ?? []), commit]);
    }
  }
  const index = new Map(commits.map((commit, position) => [commit.hash, position]));
  const byAge = (left: BitbucketCommit, right: BitbucketCommit) =>
    at(left) - at(right) || (index.get(right.hash) ?? 0) - (index.get(left.hash) ?? 0);
  let ready = commits.filter((commit) => pending.get(commit.hash) === 0).toSorted(byAge);
  const ordered: BitbucketCommit[] = [];
  const placed = new Set<string>();
  while (ready.length > 0) {
    const [next, ...rest] = ready;
    ready = rest;
    if (!next || placed.has(next.hash)) continue;
    placed.add(next.hash);
    ordered.push(next);
    for (const child of children.get(next.hash) ?? []) {
      const remaining = (pending.get(child.hash) ?? 0) - 1;
      pending.set(child.hash, remaining);
      if (remaining === 0) ready = [...ready, child].toSorted(byAge);
    }
  }
  // Cycles cannot happen in git; keep anything unplaced rather than drop it.
  return [...ordered, ...commits.filter((commit) => !placed.has(commit.hash))];
}

export const BitbucketCommitPageSchema = Schema.Struct({
  values: Schema.Array(BitbucketCommitSchema),
  next: NullableString,
});

/** `GET .../merge-base/{revspec}` returns one `commit`. */
export const BitbucketMergeBaseSchema = Schema.Struct({ hash: Schema.String });

/** `commitstatus` (https://developer.atlassian.com/cloud/bitbucket/rest/api-group-commit-statuses/). */
export const BitbucketCommitStatusSchema = Schema.Struct({
  key: NullableString,
  name: NullableString,
  state: NullableString,
  url: NullableString,
  created_on: NullableString,
  updated_on: NullableString,
  links: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        commit: Schema.optional(Schema.NullOr(Schema.Struct({ href: NullableString }))),
      }),
    ),
  ),
});
export type BitbucketCommitStatus = typeof BitbucketCommitStatusSchema.Type;

export const BitbucketCommitStatusPageSchema = Schema.Struct({
  values: Schema.Array(BitbucketCommitStatusSchema),
  next: NullableString,
});

/** `pullrequest_mergeability_check` (`GET .../pullrequests/{id}/mergeability/checks`). */
export const BitbucketMergeabilityCheckSchema = Schema.Struct({
  type: Schema.String,
  status: Schema.String,
  required: NullableBoolean,
  blocking: NullableBoolean,
  /** `git_mergeability_check`: clean, conflicts, merge_impossible. */
  reason: NullableString,
  /** `standard_merge_check`: `{type, kind}`, e.g. kind `minimum_approvals`. */
  check: Schema.optional(Schema.NullOr(Schema.Struct({ kind: NullableString }))),
});
export type BitbucketMergeabilityCheck = typeof BitbucketMergeabilityCheckSchema.Type;

export const BitbucketMergeabilityChecksSchema = Schema.Struct({
  values: Schema.Array(BitbucketMergeabilityCheckSchema),
});

/** `GET /user/workspaces/{workspace}/permissions/repositories`. */
export const BitbucketRepositoryPermissionPageSchema = Schema.Struct({
  values: Schema.Array(
    Schema.Struct({
      permission: NullableString,
      repository: Schema.optional(Schema.NullOr(Schema.Struct({ full_name: NullableString }))),
    }),
  ),
});

/** The viewer's permission on `fullName` (`workspace/slug`, case-insensitive), if listed. */
export function bitbucketRepositoryPermission(
  page: typeof BitbucketRepositoryPermissionPageSchema.Type,
  fullName: string,
): string | null {
  const wanted = fullName.trim().toLowerCase();
  const entry = page.values.find(
    (value) => value.repository?.full_name?.trim().toLowerCase() === wanted,
  );
  return trimmed(entry?.permission);
}

/** `GET /workspaces/{workspace}/members`. */
export const BitbucketWorkspaceMemberPageSchema = Schema.Struct({
  values: Schema.Array(Schema.Struct({ user: NullableAccount })),
  next: NullableString,
});

/** `GET .../merge/task-status/{task_id}`. */
export const BitbucketMergeTaskStatusSchema = Schema.Struct({
  task_status: Schema.String,
  merge_result: Schema.optional(Schema.NullOr(Schema.Struct({ state: NullableString }))),
});

/** `participant`, returned by `POST .../approve` and `POST .../request-changes`. */
export const BitbucketParticipantSchema = Schema.Struct({
  user: NullableAccount,
  state: NullableString,
  participated_on: NullableString,
});

// ── Identity ──────────────────────────────────────────────────────────

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}

function parseDate(value: string | null | undefined): DateTime.Utc | null {
  const text = trimmed(value);
  return text ? Option.getOrNull(DateTime.make(text)) : null;
}

export const bitbucketLogin = bitbucketUserDisplayName;

export function bitbucketActor(
  account: BitbucketAccount | null | undefined,
): ChangeRequestActor | null {
  const login = bitbucketLogin(account);
  if (!login) return null;
  const avatarUrl = trimmed(account?.links?.avatar?.href);
  return { login, ...(avatarUrl ? { avatarUrl } : {}) };
}

/** Same account by `uuid`, else by Atlassian `account_id`. */
export function sameBitbucketAccount(
  left: BitbucketAccount | null | undefined,
  right: BitbucketAccount | null | undefined,
): boolean {
  const leftUuid = trimmed(left?.uuid)?.toLowerCase();
  const rightUuid = trimmed(right?.uuid)?.toLowerCase();
  if (leftUuid && rightUuid) return leftUuid === rightUuid;
  const leftId = trimmed(left?.account_id);
  const rightId = trimmed(right?.account_id);
  return leftId !== null && leftId === rightId;
}

/** Whether `login` names `account` (display name, nickname, account id or uuid). */
export function bitbucketAccountMatchesLogin(account: BitbucketAccount, login: string): boolean {
  const wanted = login.trim().toLowerCase();
  if (wanted.length === 0) return false;
  return [
    account.display_name,
    account.nickname,
    account.username,
    account.account_id,
    account.uuid,
  ]
    .map((value) => trimmed(value)?.toLowerCase())
    .some((value) => value === wanted);
}

const HEX_SHA = /^[0-9a-f]{7,64}$/iu;

/**
 * Bitbucket reports pull request heads abbreviated (12 hex), the page sends
 * full hashes: two revisions match when the shorter is a prefix of the longer.
 */
export function bitbucketCommitsMatch(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const a = trimmed(left)?.toLowerCase();
  const b = trimmed(right)?.toLowerCase();
  if (!a || !b || !HEX_SHA.test(a) || !HEX_SHA.test(b)) return false;
  return a.length <= b.length ? b.startsWith(a) : a.startsWith(b);
}

/** The full hash of `abbreviated` among `commits`, if listed. */
export function resolveBitbucketCommitHash(
  abbreviated: string | null | undefined,
  commits: ReadonlyArray<{ readonly hash: string }>,
): string | null {
  const short = trimmed(abbreviated);
  if (!short) return null;
  return commits.find((commit) => bitbucketCommitsMatch(commit.hash, short))?.hash ?? null;
}

/** A repository path the page may read (`src/{commit}/{path}`). */
export function isBitbucketRepositoryFilePath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\u0000")) return false;
  return path
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export function encodeBitbucketPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

// ── Review threads and conversation ───────────────────────────────────

export interface BitbucketViewerContext {
  readonly account: BitbucketAccount;
  /** Write or admin on the destination repository. */
  readonly canWrite: boolean;
  /** The viewer authored the pull request. */
  readonly isAuthor: boolean;
}

function commentBody(comment: BitbucketPullRequestComment): string {
  return comment.content?.raw ?? "";
}

function commentAuthor(comment: BitbucketPullRequestComment): ChangeRequestActor {
  return bitbucketActor(comment.user) ?? { login: "Former user" };
}

function ownsComment(
  comment: BitbucketPullRequestComment,
  viewer: BitbucketViewerContext | null,
): boolean {
  return viewer !== null && sameBitbucketAccount(comment.user, viewer.account);
}

function toReviewComment(
  comment: BitbucketPullRequestComment,
  viewer: BitbucketViewerContext | null,
): ChangeRequestReviewComment | null {
  const createdAt = parseDate(comment.created_on);
  if (!createdAt) return null;
  const updatedAt = parseDate(comment.updated_on);
  const url = trimmed(comment.links?.html?.href);
  const own = ownsComment(comment, viewer);
  return {
    id: String(comment.id),
    author: commentAuthor(comment),
    body: commentBody(comment),
    createdAt,
    ...(updatedAt ? { updatedAt } : {}),
    ...(url ? { url } : {}),
    state: comment.pending === true ? "pending" : "submitted",
    viewerCanUpdate: own,
    viewerCanDelete: own,
  };
}

interface ThreadAnchor {
  readonly subjectType: "line" | "file";
  readonly side: "left" | "right";
  readonly line: number | null;
  readonly startSide?: "left" | "right";
  readonly startLine?: number | null;
  readonly originalLine: number | null;
  readonly originalStartLine?: number | null;
  readonly isOutdated: boolean;
}

function positiveLine(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * `to` is the new-file (right) line, `from` the old-file (left) line; a
 * comment with neither is on the whole file. Multi-line comments carry the
 * start in `start_to` / `start_from`.
 */
export function bitbucketThreadAnchor(inline: typeof BitbucketInlineSchema.Type): ThreadAnchor {
  const to = positiveLine(inline.to);
  const from = positiveLine(inline.from);
  const anchor = to ?? from;
  if (anchor === null) {
    return {
      subjectType: "file",
      side: "right",
      line: null,
      originalLine: null,
      isOutdated: false,
    };
  }
  const side: "left" | "right" = to !== null ? "right" : "left";
  const startTo = positiveLine(inline.start_to);
  const startFrom = positiveLine(inline.start_from);
  const sameSideStart = side === "right" ? startTo : startFrom;
  const start =
    sameSideStart !== null
      ? { side, line: sameSideStart }
      : startTo !== null
        ? { side: "right" as const, line: startTo }
        : startFrom !== null
          ? { side: "left" as const, line: startFrom }
          : null;
  const isRange = start !== null && !(start.side === side && start.line === anchor);
  const isOutdated = inline.outdated === true;
  return {
    subjectType: "line",
    side,
    line: isOutdated ? null : anchor,
    originalLine: anchor,
    isOutdated,
    ...(isRange
      ? {
          startSide: start.side,
          startLine: isOutdated ? null : start.line,
          originalStartLine: start.line,
        }
      : {}),
  };
}

export interface BitbucketConversation {
  readonly threads: ReadonlyArray<ChangeRequestReviewThread>;
  /** Top-level (non-inline) comments and their replies, for the timeline. */
  readonly comments: ReadonlyArray<Extract<ChangeRequestTimelineItem, { kind: "comment" }>>;
  /** Some replies point at a comment outside the fetched window. */
  readonly missingRoots: boolean;
}

/**
 * Split pull request comments into review threads (an inline root comment and
 * every reply below it; the thread id is the root comment id, which the
 * resolve endpoint requires) and top-level conversation comments. Deleted
 * comments are dropped; a thread whose comments were all deleted disappears.
 */
export function buildBitbucketConversation(input: {
  readonly comments: ReadonlyArray<BitbucketPullRequestComment>;
  readonly viewer: BitbucketViewerContext | null;
}): BitbucketConversation {
  const byId = new Map(input.comments.map((comment) => [comment.id, comment]));
  const rootOf = (comment: BitbucketPullRequestComment): BitbucketPullRequestComment | null => {
    let current = comment;
    const seen = new Set<number>();
    while (current.parent) {
      if (seen.has(current.id)) return null;
      seen.add(current.id);
      const parent = byId.get(current.parent.id);
      if (!parent) return null;
      current = parent;
    }
    return current;
  };

  const epoch = (comment: BitbucketPullRequestComment) => {
    const at = parseDate(comment.created_on);
    return at ? DateTime.toEpochMillis(at) : 0;
  };
  const ordered = input.comments.toSorted(
    (left, right) => epoch(left) - epoch(right) || left.id - right.id,
  );
  const threadComments = new Map<number, BitbucketPullRequestComment[]>();
  const conversation: Array<Extract<ChangeRequestTimelineItem, { kind: "comment" }>> = [];
  let missingRoots = false;

  for (const comment of ordered) {
    const root = rootOf(comment);
    if (!root) {
      missingRoots = true;
      continue;
    }
    if (root.inline) {
      const members = threadComments.get(root.id) ?? [];
      members.push(comment);
      threadComments.set(root.id, members);
      continue;
    }
    if (comment.deleted === true) continue;
    const reviewComment = toReviewComment(comment, input.viewer);
    if (!reviewComment) continue;
    conversation.push({
      kind: "comment",
      id: reviewComment.id,
      createdAt: reviewComment.createdAt,
      actor: reviewComment.author,
      body: reviewComment.body,
      ...(reviewComment.updatedAt ? { updatedAt: reviewComment.updatedAt } : {}),
      ...(reviewComment.url ? { url: reviewComment.url } : {}),
      viewerCanUpdate: reviewComment.viewerCanUpdate ?? false,
      viewerCanDelete: reviewComment.viewerCanDelete ?? false,
    });
  }

  const threads: ChangeRequestReviewThread[] = [];
  for (const [rootId, members] of threadComments) {
    const root = byId.get(rootId);
    const inline = root?.inline;
    if (!root || !inline || !isBitbucketRepositoryFilePath(inline.path)) continue;
    const comments = members
      .filter((comment) => comment.deleted !== true)
      .map((comment) => toReviewComment(comment, input.viewer))
      .filter((comment): comment is ChangeRequestReviewComment => comment !== null);
    if (comments.length === 0) continue;
    const anchor = bitbucketThreadAnchor(inline);
    const isResolved = root.resolution != null;
    const resolvedBy = isResolved ? bitbucketLogin(root.resolution?.user) : null;
    const viewer = input.viewer;
    const mayResolve =
      viewer !== null &&
      root.pending !== true &&
      (viewer.canWrite || viewer.isAuthor || ownsComment(root, viewer));
    threads.push({
      id: String(root.id),
      path: inline.path,
      subjectType: anchor.subjectType,
      side: anchor.side,
      line: anchor.line,
      ...(anchor.startSide ? { startSide: anchor.startSide } : {}),
      ...(anchor.startLine !== undefined ? { startLine: anchor.startLine } : {}),
      originalLine: anchor.originalLine,
      ...(anchor.originalStartLine !== undefined
        ? { originalStartLine: anchor.originalStartLine }
        : {}),
      isResolved,
      isOutdated: anchor.isOutdated,
      ...(resolvedBy ? { resolvedBy } : {}),
      viewerCanReply: viewer !== null && root.pending !== true,
      viewerCanResolve: mayResolve && !isResolved,
      viewerCanUnresolve: mayResolve && isResolved,
      comments,
      totalComments: comments.length,
    });
  }
  threads.sort(
    (left, right) =>
      DateTime.toEpochMillis(left.comments[0]!.createdAt) -
      DateTime.toEpochMillis(right.comments[0]!.createdAt),
  );

  return { threads, comments: conversation, missingRoots };
}

// ── Timeline ──────────────────────────────────────────────────────────

/** `Name <email>` → `Name` (commits whose author is not a Bitbucket user). */
function rawAuthorName(raw: string | null | undefined): string | null {
  const text = trimmed(raw);
  if (!text) return null;
  return trimmed(text.replace(/<[^>]*>/gu, "")) ?? null;
}

export function bitbucketCommitActor(commit: BitbucketCommit): ChangeRequestActor | null {
  const user = bitbucketActor(commit.author?.user);
  if (user) return user;
  const name = rawAuthorName(commit.author?.raw);
  return name ? { login: name } : null;
}

function splitMessage(message: string | null | undefined): {
  readonly headline: string;
  readonly body: string | null;
} {
  const text = (message ?? "").replace(/\r\n/gu, "\n");
  const newline = text.indexOf("\n");
  if (newline < 0) return { headline: text.trim(), body: null };
  return { headline: text.slice(0, newline).trim(), body: trimmed(text.slice(newline + 1)) };
}

export function toBitbucketChangeRequestCommit(
  commit: BitbucketCommit,
): SourceControlChangeRequestCommit | null {
  const oid = trimmed(commit.hash);
  if (!oid) return null;
  const { headline } = splitMessage(commit.message);
  const author = bitbucketCommitActor(commit)?.login;
  const date = trimmed(commit.date);
  return {
    oid,
    shortOid: oid.slice(0, 7),
    messageHeadline: headline,
    ...(date ? { committedDate: date } : {}),
    ...(author ? { author } : {}),
  };
}

function isClosedState(state: string | null | undefined): boolean {
  const value = state?.trim().toUpperCase();
  return value === "DECLINED" || value === "SUPERSEDED";
}

function accountKey(account: BitbucketAccount): string | null {
  return (
    trimmed(account.uuid)?.toLowerCase() ??
    trimmed(account.account_id) ??
    bitbucketLogin(account)?.toLowerCase() ??
    null
  );
}

/**
 * The timeline from the activity log (updates, approvals, change requests),
 * the pull request's commits, and the conversation comments. Bitbucket's
 * updates are snapshots of the pull request, so events are found by diffing
 * successive snapshots: renames, state changes, draft toggles, base changes,
 * reviewer changes, and force pushes (a previous head that is no longer one
 * of the pull request's commits; only claimed when the commit list is
 * complete). Updates carry no actor; merges and closes take `closed_by` when
 * they are the pull request's final transition.
 */
export function buildBitbucketTimeline(input: {
  readonly pullRequest: BitbucketPullRequest;
  readonly activity: ReadonlyArray<BitbucketActivityEntry>;
  readonly commits: ReadonlyArray<BitbucketCommit>;
  readonly commitsComplete: boolean;
  readonly comments: ReadonlyArray<ChangeRequestTimelineItem>;
}): ReadonlyArray<ChangeRequestTimelineItem> {
  const items: ChangeRequestTimelineItem[] = [];
  const closedBy = bitbucketActor(input.pullRequest.closed_by);
  const finalState = input.pullRequest.state?.trim().toUpperCase() ?? "OPEN";

  for (const entry of input.activity) {
    for (const [verdict, state] of [
      [entry.approval, "approved"],
      [entry.changes_requested, "changes_requested"],
    ] as const) {
      if (!verdict) continue;
      const createdAt = parseDate(verdict.date);
      const actor = bitbucketActor(verdict.user);
      if (!createdAt) continue;
      items.push({
        kind: "review",
        id: `${state}:${accountKey(verdict.user ?? {}) ?? "unknown"}:${verdict.date}`,
        createdAt,
        ...(actor ? { actor } : {}),
        state,
        body: "",
        threadIds: [],
        viewerCanUpdate: false,
      });
    }
  }

  const updates = input.activity
    .flatMap((entry) => (entry.update ? [entry.update] : []))
    .map((update) => ({ update, at: parseDate(update.date) }))
    .filter(
      (entry): entry is { update: BitbucketActivityUpdate; at: DateTime.Utc } => entry.at !== null,
    )
    .toSorted((left, right) => DateTime.toEpochMillis(left.at) - DateTime.toEpochMillis(right.at));
  const lastTransition = (() => {
    for (let index = updates.length - 1; index > 0; index -= 1) {
      if (updates[index]!.update.state !== updates[index - 1]!.update.state) return index;
    }
    return -1;
  })();
  for (let index = 1; index < updates.length; index += 1) {
    const previous = updates[index - 1]!.update;
    const current = updates[index]!.update;
    const createdAt = updates[index]!.at;
    const id = (kind: string, suffix = "") => `${kind}:${current.date}${suffix}`;
    const previousTitle = trimmed(previous.title);
    const currentTitle = trimmed(current.title);
    if (previousTitle && currentTitle && previousTitle !== currentTitle) {
      items.push({ kind: "renamed", id: id("renamed"), createdAt, previousTitle, currentTitle });
    }
    const before = previous.state?.trim().toUpperCase();
    const after = current.state?.trim().toUpperCase();
    if (before && after && before !== after) {
      const actor = index === lastTransition && after === finalState ? closedBy : null;
      if (after === "MERGED") {
        const commitOid =
          index === lastTransition ? trimmed(input.pullRequest.merge_commit?.hash) : null;
        const baseRefName = trimmed(current.destination?.branch?.name);
        items.push({
          kind: "merged",
          id: id("merged"),
          createdAt,
          ...(actor ? { actor } : {}),
          ...(commitOid ? { commitOid } : {}),
          ...(baseRefName ? { baseRefName } : {}),
        });
      } else if (isClosedState(after) && !isClosedState(before)) {
        items.push({ kind: "closed", id: id("closed"), createdAt, ...(actor ? { actor } : {}) });
      } else if (after === "OPEN" && isClosedState(before)) {
        items.push({ kind: "reopened", id: id("reopened"), createdAt });
      }
    }
    if (typeof previous.draft === "boolean" && typeof current.draft === "boolean") {
      if (previous.draft !== current.draft) {
        items.push({
          kind: current.draft ? "converted-to-draft" : "ready-for-review",
          id: id(current.draft ? "converted-to-draft" : "ready-for-review"),
          createdAt,
        });
      }
    }
    const previousBase = trimmed(previous.destination?.branch?.name);
    const currentBase = trimmed(current.destination?.branch?.name);
    if (previousBase && currentBase && previousBase !== currentBase) {
      items.push({
        kind: "base-ref-changed",
        id: id("base-ref-changed"),
        createdAt,
        previousRefName: previousBase,
        currentRefName: currentBase,
      });
    }
    const beforeOid = trimmed(previous.source?.commit?.hash);
    const afterOid = trimmed(current.source?.commit?.hash);
    if (
      input.commitsComplete &&
      beforeOid &&
      afterOid &&
      !bitbucketCommitsMatch(beforeOid, afterOid) &&
      resolveBitbucketCommitHash(beforeOid, input.commits) === null
    ) {
      items.push({ kind: "force-pushed", id: id("force-pushed"), createdAt, beforeOid, afterOid });
    }
    if (previous.reviewers && current.reviewers) {
      const keys = (list: ReadonlyArray<BitbucketAccount>) =>
        new Map(
          list.flatMap((account) => {
            const key = accountKey(account);
            return key ? [[key, account] as const] : [];
          }),
        );
      const was = keys(previous.reviewers);
      const now = keys(current.reviewers);
      for (const [key, account] of now) {
        const reviewer = bitbucketLogin(account);
        if (was.has(key) || !reviewer) continue;
        items.push({
          kind: "review-requested",
          id: id("review-requested", `:${key}`),
          createdAt,
          reviewer,
          reviewerKind: "user",
        });
      }
      for (const [key, account] of was) {
        const reviewer = bitbucketLogin(account);
        if (now.has(key) || !reviewer) continue;
        items.push({
          kind: "review-request-removed",
          id: id("review-request-removed", `:${key}`),
          createdAt,
          reviewer,
          reviewerKind: "user",
        });
      }
    }
  }

  for (const commit of orderBitbucketCommits(input.commits)) {
    const createdAt = parseDate(commit.date);
    const oid = trimmed(commit.hash);
    if (!createdAt || !oid) continue;
    const { headline, body } = splitMessage(commit.message);
    const actor = bitbucketCommitActor(commit);
    items.push({
      kind: "commit",
      id: `commit:${oid}`,
      createdAt,
      ...(actor ? { actor } : {}),
      oid,
      shortOid: oid.slice(0, 7),
      messageHeadline: headline,
      ...(body ? { messageBody: body } : {}),
    });
  }

  items.push(...input.comments);
  const seen = new Set<string>();
  return items
    .map((item, index) => ({ item, index }))
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(left.item.createdAt) -
          DateTime.toEpochMillis(right.item.createdAt) || left.index - right.index,
    )
    .map(({ item }) => item)
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
}

// ── Viewer ────────────────────────────────────────────────────────────

/** `read` / `write` / `admin` / `none` → write access. */
export function bitbucketPermissionAllowsWrite(permission: string | null | undefined): boolean {
  const value = permission?.trim().toLowerCase();
  return value === "write" || value === "admin";
}

/**
 * Viewer permissions from `GET /user` and the viewer's repository permission
 * (null when it could not be read: conservative, no write). Bitbucket has no
 * update-branch or auto-merge; anyone who can read may comment.
 */
export function bitbucketViewerCapabilities(input: {
  readonly viewer: BitbucketAccount;
  readonly pullRequest: BitbucketPullRequest;
  readonly permission: string | null;
}): ChangeRequestViewerCapabilities | null {
  const login = bitbucketLogin(input.viewer);
  if (!login) return null;
  const isAuthor = sameBitbucketAccount(input.viewer, input.pullRequest.author);
  const canWrite = bitbucketPermissionAllowsWrite(input.permission);
  const isOpen = (input.pullRequest.state?.trim().toUpperCase() ?? "OPEN") === "OPEN";
  return {
    login,
    isAuthor,
    canUpdate: isAuthor || canWrite,
    canMerge: canWrite && isOpen,
    canReview: true,
    canUpdateBranch: false,
    canEnableAutoMerge: false,
    canDisableAutoMerge: false,
  };
}

export function assembleBitbucketChangeRequestActivity(input: {
  readonly pullRequest: BitbucketPullRequest;
  readonly headSha: string | null;
  readonly viewer: BitbucketAccount | null;
  readonly permission: string | null;
  readonly activity: ReadonlyArray<BitbucketActivityEntry>;
  readonly activityTruncated: boolean;
  readonly comments: ReadonlyArray<BitbucketPullRequestComment>;
  readonly commentsTruncated: boolean;
  readonly commits: ReadonlyArray<BitbucketCommit>;
  readonly commitsTruncated: boolean;
}): ChangeRequestActivity {
  const viewer = input.viewer
    ? bitbucketViewerCapabilities({
        viewer: input.viewer,
        pullRequest: input.pullRequest,
        permission: input.permission,
      })
    : null;
  const conversation = buildBitbucketConversation({
    comments: input.comments,
    viewer:
      input.viewer && viewer
        ? {
            account: input.viewer,
            canWrite: bitbucketPermissionAllowsWrite(input.permission),
            isAuthor: viewer.isAuthor,
          }
        : null,
  });
  return {
    provider: "bitbucket",
    number: input.pullRequest.id,
    headSha: input.headSha,
    viewer,
    timeline: buildBitbucketTimeline({
      pullRequest: input.pullRequest,
      activity: input.activity,
      commits: input.commits,
      commitsComplete: !input.commitsTruncated,
      comments: conversation.comments,
    }),
    timelineTruncated: input.activityTruncated || input.commentsTruncated || input.commitsTruncated,
    reviewThreads: conversation.threads,
    reviewThreadsTruncated: input.commentsTruncated || conversation.missingRoots,
    // Bitbucket's pending comments cannot be published through the API.
    pendingReview: null,
  };
}

// ── Merge readiness and checks ────────────────────────────────────────

/** Requested reviewers plus everyone who approved or requested changes. */
export function bitbucketReviewerStates(
  pullRequest: BitbucketPullRequest,
): ReadonlyArray<SourceControlChangeRequestReviewer> {
  const states = new Map<string, SourceControlChangeRequestReviewer>();
  for (const participant of pullRequest.participants ?? []) {
    const login = bitbucketLogin(participant.user);
    const key = accountKey(participant.user);
    if (!login || !key || sameBitbucketAccount(participant.user, pullRequest.author)) continue;
    const verdict = participant.state?.trim().toLowerCase();
    const state =
      verdict === "changes_requested"
        ? ("changes_requested" as const)
        : participant.approved === true || verdict === "approved"
          ? ("approved" as const)
          : participant.role?.trim().toUpperCase() === "REVIEWER"
            ? ("requested" as const)
            : null;
    if (!state) continue;
    const avatarUrl = trimmed(participant.user.links?.avatar?.href);
    const submittedAt = state === "requested" ? null : parseDate(participant.participated_on);
    states.set(key, {
      login,
      kind: "user",
      state,
      ...(avatarUrl ? { avatarUrl } : {}),
      ...(submittedAt ? { submittedAt } : {}),
    });
  }
  for (const reviewer of pullRequest.reviewers ?? []) {
    const login = bitbucketLogin(reviewer);
    const key = accountKey(reviewer);
    if (!login || !key || states.has(key)) continue;
    const avatarUrl = trimmed(reviewer.links?.avatar?.href);
    states.set(key, {
      login,
      kind: "user",
      state: "requested",
      ...(avatarUrl ? { avatarUrl } : {}),
    });
  }
  return [...states.values()];
}

const APPROVAL_CHECK_KINDS = new Set([
  "minimum_approvals",
  "minimum_default_reviewer_approvals",
  "require_approvals_to_merge",
  "require_default_reviewer_approvals_to_merge",
]);

/**
 * Changes requested wins; otherwise an approval restriction (a
 * `standard_merge_check` on approvals) decides; without one, any approval
 * reads as approved and none as no decision.
 */
export function bitbucketReviewDecision(
  reviewers: ReadonlyArray<SourceControlChangeRequestReviewer>,
  checks: ReadonlyArray<BitbucketMergeabilityCheck> | null,
): SourceControlChangeRequestReviewDecision | null {
  if (reviewers.some((reviewer) => reviewer.state === "changes_requested")) {
    return "changes_requested";
  }
  const approvalChecks = (checks ?? []).filter(
    (check) =>
      check.type === "standard_merge_check" &&
      APPROVAL_CHECK_KINDS.has(check.check?.kind?.trim().toLowerCase() ?? ""),
  );
  if (approvalChecks.length > 0) {
    return approvalChecks.every((check) => check.status.toUpperCase() === "PASSED")
      ? "approved"
      : "review_required";
  }
  return reviewers.some((reviewer) => reviewer.state === "approved") ? "approved" : null;
}

/**
 * Git mergeability and merge state from the mergeability checks. The
 * viewer's own permission check is left out: it says who may merge, not
 * whether the pull request can.
 */
export function bitbucketMergeReadiness(input: {
  readonly checks: ReadonlyArray<BitbucketMergeabilityCheck> | null;
  readonly isDraft: boolean;
}): {
  readonly mergeability: SourceControlChangeRequestMergeability;
  readonly mergeStateStatus: SourceControlChangeRequestMergeStateStatus;
} {
  if (input.checks === null) {
    return {
      mergeability: "unknown",
      mergeStateStatus: input.isDraft ? "draft" : "unknown",
    };
  }
  const git = input.checks.find((check) => check.type === "git_mergeability_check");
  const reason = git?.reason?.trim().toLowerCase();
  const mergeability: SourceControlChangeRequestMergeability =
    reason === "clean"
      ? "mergeable"
      : reason === "conflicts" || reason === "merge_impossible"
        ? "conflicting"
        : "unknown";
  if (mergeability === "conflicting") return { mergeability, mergeStateStatus: "dirty" };
  if (input.isDraft) return { mergeability, mergeStateStatus: "draft" };
  const relevant = input.checks.filter(
    (check) =>
      check.type !== "current_user_permission_check" && check.type !== "pullrequest_state_check",
  );
  if (relevant.some((check) => check.blocking === true)) {
    return { mergeability, mergeStateStatus: "blocked" };
  }
  if (mergeability === "unknown") return { mergeability, mergeStateStatus: "unknown" };
  const allPassed = relevant.every((check) => check.status.toUpperCase() === "PASSED");
  return { mergeability, mergeStateStatus: allPassed ? "clean" : "unstable" };
}

function statusCommitHash(status: BitbucketCommitStatus): string | null {
  const href = trimmed(status.links?.commit?.href);
  const match = href ? /\/commit\/([0-9a-f]{7,64})(?:[/?#]|$)/iu.exec(href) : null;
  return match?.[1] ?? null;
}

/**
 * Build statuses of the head commit as status contexts. `INPROGRESS` runs;
 * `SUCCESSFUL`, `FAILED` and `STOPPED` are completed with that conclusion.
 */
export function bitbucketCheckRollup(
  statuses: ReadonlyArray<BitbucketCommitStatus>,
  headSha: string | null,
): ReadonlyArray<SourceControlCheckRollupItem> {
  const rollup: SourceControlCheckRollupItem[] = [];
  for (const status of statuses) {
    const commit = statusCommitHash(status);
    if (headSha && commit && !bitbucketCommitsMatch(commit, headSha)) continue;
    const name = trimmed(status.name) ?? trimmed(status.key);
    if (!name) continue;
    const state = status.state?.trim().toUpperCase();
    const completed = state === "SUCCESSFUL" || state === "FAILED" || state === "STOPPED";
    const conclusion =
      state === "SUCCESSFUL"
        ? "SUCCESS"
        : state === "FAILED"
          ? "FAILURE"
          : state === "STOPPED"
            ? "CANCELLED"
            : null;
    const startedAt = parseDate(status.created_on);
    const completedAt = completed ? parseDate(status.updated_on) : null;
    const url = trimmed(status.url);
    rollup.push({
      kind: "status-context",
      name,
      status: Option.some(
        completed ? "COMPLETED" : state === "INPROGRESS" ? "IN_PROGRESS" : "PENDING",
      ),
      conclusion: Option.fromNullishOr(conclusion),
      url: Option.fromNullishOr(url),
      startedAt: Option.fromNullishOr(startedAt),
      completedAt: Option.fromNullishOr(completedAt),
    });
  }
  return rollup;
}

const MERGE_STRATEGIES: Record<SourceControlChangeRequestMergeMethod, ReadonlyArray<string>> = {
  merge: ["merge_commit"],
  squash: ["squash", "squash_fast_forward"],
  rebase: ["rebase_fast_forward", "fast_forward"],
};

/** Methods the destination branch allows (`destination.branch.merge_strategies`). */
export function bitbucketMergeCapabilities(
  strategies: ReadonlyArray<string> | null | undefined,
): SourceControlChangeRequestMergeCapabilities | undefined {
  if (!strategies) return undefined;
  const allowed = new Set(strategies.map((strategy) => strategy.trim().toLowerCase()));
  const has = (method: SourceControlChangeRequestMergeMethod) =>
    MERGE_STRATEGIES[method].some((strategy) => allowed.has(strategy));
  return { merge: has("merge"), squash: has("squash"), rebase: has("rebase") };
}

/**
 * The Bitbucket `merge_strategy` for a page merge method: merge → merge
 * commit, squash → squash (or squash fast-forward), rebase → rebase
 * fast-forward (or fast-forward). Null when the branch allows none of them.
 */
export function bitbucketMergeStrategy(
  method: SourceControlChangeRequestMergeMethod,
  strategies: ReadonlyArray<string> | null | undefined,
): string | null {
  const candidates = MERGE_STRATEGIES[method];
  if (!strategies) return candidates[0] ?? null;
  const allowed = new Set(strategies.map((strategy) => strategy.trim().toLowerCase()));
  return candidates.find((strategy) => allowed.has(strategy)) ?? null;
}

// ── Request bodies ────────────────────────────────────────────────────

export interface BitbucketInlineCommentBody {
  readonly content: { readonly raw: string };
  readonly inline: {
    readonly path: string;
    readonly from?: number;
    readonly to?: number;
    readonly start_from?: number;
    readonly start_to?: number;
  };
}

/**
 * A draft line comment as a Bitbucket inline comment: `right` anchors `to`
 * (new file), `left` anchors `from` (old file), a range adds `start_to` /
 * `start_from` on the start side, and a file comment carries only `path`.
 */
export function buildBitbucketInlineCommentBody(
  comment: ChangeRequestDraftReviewComment,
): Result.Result<BitbucketInlineCommentBody, string> {
  if (!isBitbucketRepositoryFilePath(comment.path)) {
    return Result.fail(`Invalid repository file path: ${comment.path}`);
  }
  if (comment.body.trim().length === 0) return Result.fail("Line comments need a body.");
  const content = { raw: comment.body };
  if (comment.subjectType === "file") {
    return Result.succeed({ content, inline: { path: comment.path } });
  }
  if (comment.line === undefined) {
    return Result.fail(`The comment on ${comment.path} has no line.`);
  }
  const side = comment.side ?? "right";
  const startSide = comment.startSide ?? side;
  const startLine = comment.startLine;
  if (startLine !== undefined && startSide === side && startLine > comment.line) {
    return Result.fail(`The comment range on ${comment.path} ends before it starts.`);
  }
  const anchorKey = side === "right" ? "to" : "from";
  const range =
    startLine !== undefined && !(startSide === side && startLine === comment.line)
      ? { [startSide === "right" ? "start_to" : "start_from"]: startLine }
      : {};
  return Result.succeed({
    content,
    inline: { path: comment.path, [anchorKey]: comment.line, ...range },
  });
}

export interface BitbucketPullRequestUpdateBody {
  readonly title: string;
  readonly description?: string;
  readonly destination?: { readonly branch: { readonly name: string } };
  readonly draft?: boolean;
  readonly reviewers: ReadonlyArray<{ readonly uuid: string } | { readonly account_id: string }>;
}

/** `{uuid}` (or `{account_id}`) references; accounts with neither are dropped. */
export function bitbucketAccountReferences(
  accounts: ReadonlyArray<BitbucketAccount>,
): BitbucketPullRequestUpdateBody["reviewers"] {
  const references: Array<{ readonly uuid: string } | { readonly account_id: string }> = [];
  for (const account of accounts) {
    const uuid = trimmed(account.uuid);
    const accountId = trimmed(account.account_id);
    if (uuid) references.push({ uuid });
    else if (accountId) references.push({ account_id: accountId });
  }
  return references;
}

/**
 * `PUT .../pullrequests/{id}` body for edit / set-draft / reviewers. The
 * title and the reviewer list are always sent: Bitbucket requires the title
 * and has been reported to clear reviewers a PUT leaves out.
 */
export function buildBitbucketPullRequestUpdateBody(input: {
  readonly pullRequest: BitbucketPullRequest;
  readonly action: Extract<ChangeRequestUpdateAction, { kind: "edit" | "set-draft" }>;
}): BitbucketPullRequestUpdateBody;
export function buildBitbucketPullRequestUpdateBody(input: {
  readonly pullRequest: BitbucketPullRequest;
  readonly action: { readonly kind: "reviewers" };
  readonly reviewers: ReadonlyArray<BitbucketAccount>;
}): BitbucketPullRequestUpdateBody;
export function buildBitbucketPullRequestUpdateBody(input: {
  readonly pullRequest: BitbucketPullRequest;
  readonly action:
    | Extract<ChangeRequestUpdateAction, { kind: "edit" | "set-draft" }>
    | { readonly kind: "reviewers" };
  readonly reviewers?: ReadonlyArray<BitbucketAccount>;
}): BitbucketPullRequestUpdateBody {
  const current = input.pullRequest;
  const reviewers = bitbucketAccountReferences(input.reviewers ?? current.reviewers ?? []);
  switch (input.action.kind) {
    case "edit":
      return {
        title: input.action.title ?? current.title,
        ...(input.action.body !== undefined ? { description: input.action.body } : {}),
        ...(input.action.baseRefName !== undefined
          ? { destination: { branch: { name: input.action.baseRefName } } }
          : {}),
        reviewers,
      };
    case "set-draft":
      return { title: current.title, draft: input.action.draft, reviewers };
    case "reviewers":
      return { title: current.title, reviewers };
  }
}

/**
 * The reviewer set after adding and removing logins. `add` resolves against
 * `candidates` (pull request participants, then workspace members); a login
 * that matches nobody, or two different accounts, fails.
 */
export function resolveBitbucketReviewerSet(input: {
  readonly current: ReadonlyArray<BitbucketAccount>;
  readonly candidates: ReadonlyArray<BitbucketAccount>;
  readonly add: ReadonlyArray<string>;
  readonly remove: ReadonlyArray<string>;
}): Result.Result<ReadonlyArray<BitbucketAccount>, string> {
  const next = input.current.filter(
    (account) => !input.remove.some((login) => bitbucketAccountMatchesLogin(account, login)),
  );
  for (const login of input.add) {
    if (next.some((account) => bitbucketAccountMatchesLogin(account, login))) continue;
    const matches = new Map<string, BitbucketAccount>();
    for (const candidate of input.candidates) {
      const key = accountKey(candidate);
      if (key && bitbucketAccountMatchesLogin(candidate, login)) matches.set(key, candidate);
    }
    if (matches.size === 0) return Result.fail(`No Bitbucket user named ${login} was found.`);
    if (matches.size > 1) {
      return Result.fail(`Several Bitbucket users are named ${login}; pick one on Bitbucket.`);
    }
    next.push([...matches.values()][0]!);
  }
  return Result.succeed(next);
}
