import { DateTime, Schema } from "effect";
import {
  ChangeRequestReviewThread,
  ChangeRequestTimelineItem,
  type ChangeRequestActivity,
  type ChangeRequestActor,
  type ChangeRequestDiffSide,
  type ChangeRequestReviewComment,
  type ChangeRequestViewerCapabilities,
} from "@ryco/contracts";

import {
  gitLabDiffHunkExcerpt,
  findGitLabDiffEntry,
  type GitLabDiffEntry,
} from "./gitLabMergeRequestDiffs.ts";
import {
  GITLAB_DEVELOPER_ACCESS,
  GitLabUserRefSchema,
  gitLabAccessLevel,
  parseGitLabTimestamp,
  type GitLabMergeRequestFacts,
  type GitLabProject,
  type GitLabUserRef,
} from "./gitLabMergeRequests.ts";

/**
 * The pull request page's activity for a GitLab merge request: the timeline
 * (user notes, parsed system notes, state/label events, commits, pushes),
 * diff threads (discussions with a position), and the viewer's permissions.
 * Pure: `GitLabSourceControlProvider` fetches the pages and calls
 * `assembleGitLabChangeRequestActivity`.
 *
 * Docs:
 * - https://docs.gitlab.com/api/notes/#list-all-merge-request-notes
 * - https://docs.gitlab.com/api/discussions/#list-all-merge-request-discussion-items
 * - https://docs.gitlab.com/api/resource_state_events/
 * - https://docs.gitlab.com/api/resource_label_events/
 * - https://docs.gitlab.com/api/merge_requests/#retrieve-merge-request-commits
 * - https://docs.gitlab.com/api/merge_requests/#retrieve-merge-request-diff-versions
 * - https://docs.gitlab.com/api/draft_notes/#list-all-merge-request-draft-notes
 * - https://docs.gitlab.com/api/users/#retrieve-the-current-user
 */

/** Notes and discussions per page and pages read per activity load. */
export const GITLAB_ACTIVITY_NOTE_PAGES = 3;
export const GITLAB_ACTIVITY_DISCUSSION_PAGES = 3;
export const GITLAB_ACTIVITY_EVENT_PAGES = 1;
/** Comments kept per thread (GitLab returns a discussion's notes unpaged). */
export const GITLAB_THREAD_COMMENTS_MAX = 100;
/** Thread openers by one author this close together came from one published review. */
const REVIEW_BATCH_WINDOW_MS = 60_000;

// ── Schemas ───────────────────────────────────────────────────────────

const GitLabLineRangePointSchema = Schema.Struct({
  line_code: Schema.optional(Schema.NullOr(Schema.String)),
  type: Schema.optional(Schema.NullOr(Schema.String)),
  old_line: Schema.optional(Schema.NullOr(Schema.Number)),
  new_line: Schema.optional(Schema.NullOr(Schema.Number)),
});

export const GitLabPositionSchema = Schema.Struct({
  base_sha: Schema.optional(Schema.NullOr(Schema.String)),
  start_sha: Schema.optional(Schema.NullOr(Schema.String)),
  head_sha: Schema.optional(Schema.NullOr(Schema.String)),
  old_path: Schema.optional(Schema.NullOr(Schema.String)),
  new_path: Schema.optional(Schema.NullOr(Schema.String)),
  position_type: Schema.optional(Schema.NullOr(Schema.String)),
  old_line: Schema.optional(Schema.NullOr(Schema.Number)),
  new_line: Schema.optional(Schema.NullOr(Schema.Number)),
  line_range: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        start: Schema.optional(Schema.NullOr(GitLabLineRangePointSchema)),
        end: Schema.optional(Schema.NullOr(GitLabLineRangePointSchema)),
      }),
    ),
  ),
});
export type GitLabPosition = typeof GitLabPositionSchema.Type;

export const GitLabNoteSchema = Schema.Struct({
  id: Schema.Number,
  type: Schema.optional(Schema.NullOr(Schema.String)),
  body: Schema.String,
  author: Schema.optional(Schema.NullOr(GitLabUserRefSchema)),
  created_at: Schema.String,
  updated_at: Schema.optional(Schema.NullOr(Schema.String)),
  system: Schema.optional(Schema.NullOr(Schema.Boolean)),
  position: Schema.optional(Schema.NullOr(GitLabPositionSchema)),
  resolvable: Schema.optional(Schema.NullOr(Schema.Boolean)),
  resolved: Schema.optional(Schema.NullOr(Schema.Boolean)),
  resolved_by: Schema.optional(Schema.NullOr(GitLabUserRefSchema)),
  internal: Schema.optional(Schema.NullOr(Schema.Boolean)),
});
export type GitLabNote = typeof GitLabNoteSchema.Type;

export const GitLabDiscussionSchema = Schema.Struct({
  id: Schema.String,
  individual_note: Schema.optional(Schema.NullOr(Schema.Boolean)),
  resolvable: Schema.optional(Schema.NullOr(Schema.Boolean)),
  resolved: Schema.optional(Schema.NullOr(Schema.Boolean)),
  notes: Schema.Array(GitLabNoteSchema),
});
export type GitLabDiscussion = typeof GitLabDiscussionSchema.Type;

export const GitLabStateEventSchema = Schema.Struct({
  id: Schema.Number,
  user: Schema.optional(Schema.NullOr(GitLabUserRefSchema)),
  created_at: Schema.String,
  state: Schema.String,
});
export type GitLabStateEvent = typeof GitLabStateEventSchema.Type;

export const GitLabLabelEventSchema = Schema.Struct({
  id: Schema.Number,
  user: Schema.optional(Schema.NullOr(GitLabUserRefSchema)),
  created_at: Schema.String,
  action: Schema.String,
  label: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        name: Schema.String,
        color: Schema.optional(Schema.NullOr(Schema.String)),
        description: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});
export type GitLabLabelEvent = typeof GitLabLabelEventSchema.Type;

export const GitLabCommitSchema = Schema.Struct({
  id: Schema.String,
  short_id: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  message: Schema.optional(Schema.NullOr(Schema.String)),
  author_name: Schema.optional(Schema.NullOr(Schema.String)),
  authored_date: Schema.optional(Schema.NullOr(Schema.String)),
  committed_date: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.optional(Schema.NullOr(Schema.String)),
});
export type GitLabCommit = typeof GitLabCommitSchema.Type;

export const GitLabVersionSchema = Schema.Struct({
  id: Schema.Number,
  head_commit_sha: Schema.String,
  base_commit_sha: Schema.optional(Schema.NullOr(Schema.String)),
  start_commit_sha: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.String,
});
export type GitLabVersion = typeof GitLabVersionSchema.Type;

export const GitLabDraftNoteSchema = Schema.Struct({
  id: Schema.Number,
  author_id: Schema.optional(Schema.NullOr(Schema.Number)),
  note: Schema.optional(Schema.NullOr(Schema.String)),
});
export type GitLabDraftNote = typeof GitLabDraftNoteSchema.Type;

export const GitLabCurrentUserSchema = Schema.Struct({
  id: Schema.Number,
  username: Schema.String,
  avatar_url: Schema.optional(Schema.NullOr(Schema.String)),
  bot: Schema.optional(Schema.NullOr(Schema.Boolean)),
});
export type GitLabCurrentUser = typeof GitLabCurrentUserSchema.Type;

// ── Helpers ───────────────────────────────────────────────────────────

const isTimelineItem = Schema.is(ChangeRequestTimelineItem);
const isReviewThread = Schema.is(ChangeRequestReviewThread);

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}

function positiveInt(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function gitLabActor(user: GitLabUserRef | null | undefined): ChangeRequestActor | null {
  const login = trimmed(user?.username);
  if (!login) return null;
  const avatarUrl = trimmed(user?.avatar_url);
  return {
    login,
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(user?.bot === true ? { isBot: true } : {}),
  };
}

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith("#")) return String.fromCodePoint(Number(entity.slice(1)));
    return HTML_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** System notes are Markdown or (newer GitLab) HTML; compare them as plain text. */
export function gitLabSystemNoteText(body: string): string {
  return decodeHtmlEntities(body.replace(/<[^>]*>/gu, ""))
    .replace(/\*\*/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Strip GitLab's inline-diff markers (`{-old-}`, `{+new+}`) from a title. */
function stripInlineDiffMarkers(text: string): string {
  return text.replace(/\{[-+]|[-+]\}/gu, "");
}

/** The two titles of a "changed title from … to …" note, HTML or Markdown form. */
export function parseGitLabTitleChange(
  body: string,
): { readonly previousTitle: string; readonly currentTitle: string } | null {
  const html = [...body.matchAll(/<code[^>]*class="idiff"[^>]*>([\s\S]*?)<\/code>/giu)];
  if (html.length >= 2 && html[0]?.[1] !== undefined && html[1]?.[1] !== undefined) {
    return {
      previousTitle: decodeHtmlEntities(html[0][1].replace(/<[^>]*>/gu, "")).trim(),
      currentTitle: decodeHtmlEntities(html[1][1].replace(/<[^>]*>/gu, "")).trim(),
    };
  }
  const markdown = /changed title from \*\*([\s\S]*)\*\* to \*\*([\s\S]*)\*\*\s*$/u.exec(
    body.trim(),
  );
  if (markdown?.[1] !== undefined && markdown[2] !== undefined) {
    return {
      previousTitle: stripInlineDiffMarkers(markdown[1]).trim(),
      currentTitle: stripInlineDiffMarkers(markdown[2]).trim(),
    };
  }
  return null;
}

/** `@user` mentions in one clause of a system note. */
function mentionedUsers(text: string): string[] {
  return [...text.matchAll(/@([\w.-]+)/gu)].flatMap((match) =>
    match[1] ? [match[1].replace(/\.+$/u, "")] : [],
  );
}

/** Split "requested review from @a and removed review request for @b" into its clauses. */
function clauses(
  text: string,
  phrases: ReadonlyArray<string>,
): Array<{ readonly phrase: string; readonly users: string[] }> {
  const lower = text.toLowerCase();
  const found = phrases
    .flatMap((phrase) => {
      const index = lower.indexOf(phrase);
      return index >= 0 ? [{ phrase, index }] : [];
    })
    .toSorted((left, right) => left.index - right.index);
  return found.map((entry, position) => {
    const end = found[position + 1]?.index ?? text.length;
    return {
      phrase: entry.phrase,
      users: mentionedUsers(text.slice(entry.index + entry.phrase.length, end)),
    };
  });
}

function projectWebUrl(mergeRequestUrl: string): string | null {
  const index = mergeRequestUrl.indexOf("/-/merge_requests/");
  return index > 0 ? mergeRequestUrl.slice(0, index) : null;
}

function crossReference(
  text: string,
  mergeRequestUrl: string,
): {
  readonly kind: "issue" | "change-request";
  readonly number: number;
  readonly url: string;
  readonly repository?: string;
} | null {
  const match = /^mentioned in (merge request|issue) ([\w./-]*?)([!#])(\d+)$/u.exec(text);
  const number = match?.[4] ? positiveInt(Number(match[4])) : null;
  const projectUrl = projectWebUrl(mergeRequestUrl);
  if (!match || number === null || !projectUrl) return null;
  const kind = match[1] === "merge request" ? "change-request" : "issue";
  const repository = trimmed(match[2]);
  const base = repository ? `${new URL(projectUrl).origin}/${repository}` : projectUrl;
  return {
    kind,
    number,
    url: `${base}/-/${kind === "change-request" ? "merge_requests" : "issues"}/${number}`,
    ...(repository ? { repository } : {}),
  };
}

/**
 * One system note as timeline items. GitLab writes system notes as prose, so
 * only its documented, stable phrasings are recognised; anything else is
 * dropped rather than guessed at. State and label changes come from their
 * resource-event APIs, commits from the commit list, so their notes drop too.
 */
export function gitLabSystemNoteItems(
  note: GitLabNote,
  context: { readonly mergeRequestUrl: string; readonly targetBranch: string },
): ChangeRequestTimelineItem[] {
  const createdAt = parseGitLabTimestamp(note.created_at);
  if (!createdAt) return [];
  const actor = gitLabActor(note.author);
  const base = { createdAt, ...(actor ? { actor } : {}) };
  const id = `note:${note.id}`;
  const text = gitLabSystemNoteText(note.body);
  const lower = text.toLowerCase();

  if (lower.startsWith("changed title from")) {
    const titles = parseGitLabTitleChange(note.body);
    return titles ? [{ ...base, id, kind: "renamed", ...titles }] : [];
  }
  if (
    lower === "marked this merge request as draft" ||
    lower === "marked as a work in progress" ||
    lower === "marked this merge request as a draft"
  ) {
    return [{ ...base, id, kind: "converted-to-draft" }];
  }
  if (
    lower === "marked this merge request as ready" ||
    lower === "unmarked as a work in progress"
  ) {
    return [{ ...base, id, kind: "ready-for-review" }];
  }
  if (lower.startsWith("requested review from") || lower.startsWith("removed review request for")) {
    return clauses(text, ["requested review from", "removed review request for"]).flatMap(
      (clause) =>
        clause.users.map((reviewer) => ({
          ...base,
          id: `${id}:${clause.phrase === "requested review from" ? "review-requested" : "review-request-removed"}:${reviewer}`,
          kind:
            clause.phrase === "requested review from"
              ? ("review-requested" as const)
              : ("review-request-removed" as const),
          reviewer,
          reviewerKind: "user" as const,
        })),
    );
  }
  if (lower.startsWith("assigned to") || lower.startsWith("unassigned")) {
    return clauses(text, ["assigned to", "unassigned"]).flatMap((clause) =>
      clause.users.map((assignee) => ({
        ...base,
        id: `${id}:${clause.phrase === "assigned to" ? "assigned" : "unassigned"}:${assignee}`,
        kind: clause.phrase === "assigned to" ? ("assigned" as const) : ("unassigned" as const),
        assignee,
      })),
    );
  }
  if (lower === "approved this merge request") {
    return [{ ...base, id, kind: "review", state: "approved", body: "", threadIds: [] }];
  }
  if (lower === "requested changes") {
    return [{ ...base, id, kind: "review", state: "changes_requested", body: "", threadIds: [] }];
  }
  if (
    lower === "unapproved this merge request" ||
    lower.startsWith("revoked approval for this merge request")
  ) {
    return actor ? [{ ...base, id, kind: "review-dismissed", reviewAuthor: actor.login }] : [];
  }
  if (lower.startsWith("reset approvals from")) {
    const dismissed: ChangeRequestTimelineItem[] = [];
    for (const reviewAuthor of mentionedUsers(text)) {
      dismissed.push({
        ...base,
        id: `${id}:review-dismissed:${reviewAuthor}`,
        kind: "review-dismissed",
        reviewAuthor,
        message: "Approvals reset by a push to the branch.",
      });
    }
    return dismissed;
  }
  if (/^enabled (?:an )?automatic (?:merge|add to merge train)/u.test(lower)) {
    return [{ ...base, id, kind: "auto-merge-enabled" }];
  }
  if (
    /^(?:canceled|cancelled|aborted) (?:the )?automatic (?:merge|add to merge train)/u.test(lower)
  ) {
    return [{ ...base, id, kind: "auto-merge-disabled" }];
  }
  const target = /^changed target branch from `?(.+?)`? to `?(.+?)`?$/u.exec(text);
  if (target?.[1] && target[2]) {
    return [
      {
        ...base,
        id,
        kind: "base-ref-changed",
        previousRefName: target[1],
        currentRefName: target[2],
      },
    ];
  }
  const reference = crossReference(text, context.mergeRequestUrl);
  if (reference) {
    return [{ ...base, id, kind: "cross-referenced", source: { ...reference, title: "" } }];
  }
  return [];
}

/** Commits a push note ("added 2 commits … <li>abc123 - …") credits to its author. */
export function gitLabPushedCommitPrefixes(note: GitLabNote): ReadonlyArray<string> {
  const text = gitLabSystemNoteText(note.body);
  if (!/^added \d+ (?:new )?commits?/iu.test(text)) return [];
  return [...note.body.matchAll(/<li>\s*([0-9a-f]{7,40})\s+-/giu)].flatMap((match) =>
    match[1] ? [match[1].toLowerCase()] : [],
  );
}

// ── Threads ───────────────────────────────────────────────────────────

export interface GitLabThreadContext {
  readonly mergeRequestUrl: string;
  /** The merge request's current head; a position on another head is outdated. */
  readonly headSha: string | null;
  readonly viewerId: number | null;
  readonly viewerCanReply: boolean;
  /** Developer access or authorship of the merge request (resolve prerequisites). */
  readonly viewerCanResolve: boolean;
  readonly diffEntries: ReadonlyArray<GitLabDiffEntry> | null;
}

function noteComment(
  note: GitLabNote,
  context: GitLabThreadContext,
): ChangeRequestReviewComment | null {
  const createdAt = parseGitLabTimestamp(note.created_at);
  if (!createdAt) return null;
  const updatedAt = parseGitLabTimestamp(note.updated_at);
  const own = context.viewerId !== null && note.author?.id === context.viewerId;
  return {
    id: String(note.id),
    author: gitLabActor(note.author) ?? { login: "ghost" },
    body: note.body,
    createdAt,
    ...(updatedAt && DateTime.toEpochMillis(updatedAt) !== DateTime.toEpochMillis(createdAt)
      ? { updatedAt }
      : {}),
    url: `${context.mergeRequestUrl}#note_${note.id}`,
    state: "submitted",
    viewerCanUpdate: own,
    viewerCanDelete: own,
  };
}

function lineOf(point: {
  readonly old_line?: number | null | undefined;
  readonly new_line?: number | null | undefined;
}): { readonly side: ChangeRequestDiffSide; readonly line: number } | null {
  const newLine = positiveInt(point.new_line);
  if (newLine !== null) return { side: "right", line: newLine };
  const oldLine = positiveInt(point.old_line);
  return oldLine !== null ? { side: "left", line: oldLine } : null;
}

export interface GitLabThreadEntry {
  readonly thread: ChangeRequestReviewThread;
  readonly openerAuthor: string | null;
  readonly openerCreatedAt: DateTime.Utc;
}

/**
 * A discussion with a diff position as a review thread. Positions follow the
 * merge request across pushes: GitLab moves a note's `position` to the new
 * head while its line still exists, so a position still on an older head no
 * longer maps onto the diff and the thread is outdated.
 */
export function gitLabReviewThread(
  discussion: GitLabDiscussion,
  context: GitLabThreadContext,
): GitLabThreadEntry | null {
  const notes = discussion.notes.filter((note) => note.system !== true);
  const opener = notes[0];
  const position = opener?.position;
  if (!opener || !position) return null;
  const positionType = position.position_type?.trim().toLowerCase() ?? "text";
  if (positionType !== "text" && positionType !== "file") return null;
  const path = trimmed(position.new_path) ?? trimmed(position.old_path);
  const openerCreatedAt = parseGitLabTimestamp(opener.created_at);
  if (!path || !openerCreatedAt) return null;

  const positionHead = trimmed(position.head_sha);
  const isOutdated =
    positionHead !== null && context.headSha !== null && positionHead !== context.headSha;
  const anchor = positionType === "text" ? lineOf(position) : null;
  if (positionType === "text" && !anchor) return null;
  const side = anchor?.side ?? "right";

  const rangeStart = position.line_range?.start ? lineOf(position.line_range.start) : null;
  const start =
    anchor && rangeStart && (rangeStart.line !== anchor.line || rangeStart.side !== anchor.side)
      ? rangeStart
      : null;

  const entry =
    !isOutdated && anchor && context.diffEntries
      ? findGitLabDiffEntry(context.diffEntries, path)
      : undefined;
  const diffHunk = entry && anchor ? gitLabDiffHunkExcerpt(entry, anchor.side, anchor.line) : null;

  const resolvable = notes.filter((note) => note.resolvable === true);
  const isResolvable = resolvable.length > 0 || discussion.resolvable === true;
  const isResolved =
    resolvable.length > 0
      ? resolvable.every((note) => note.resolved === true)
      : discussion.resolved === true;
  const resolvedBy = isResolved
    ? (resolvable.map((note) => trimmed(note.resolved_by?.username)).findLast(Boolean) ?? null)
    : null;

  const comments = notes.slice(0, GITLAB_THREAD_COMMENTS_MAX).flatMap((note) => {
    const comment = noteComment(note, context);
    return comment ? [comment] : [];
  });
  const thread: ChangeRequestReviewThread = {
    id: discussion.id,
    path,
    subjectType: positionType === "file" ? "file" : "line",
    side,
    ...(start ? { startSide: start.side } : {}),
    line: anchor && !isOutdated ? anchor.line : null,
    ...(start ? { startLine: isOutdated ? null : start.line } : {}),
    ...(anchor ? { originalLine: anchor.line } : {}),
    ...(start ? { originalStartLine: start.line } : {}),
    ...(positionHead ? { originalCommitOid: positionHead } : {}),
    ...(diffHunk ? { diffHunk } : {}),
    isResolved,
    isOutdated,
    ...(resolvedBy ? { resolvedBy } : {}),
    viewerCanReply: context.viewerCanReply,
    viewerCanResolve: isResolvable && !isResolved && context.viewerCanResolve,
    viewerCanUnresolve: isResolvable && isResolved && context.viewerCanResolve,
    comments,
    totalComments: Math.max(notes.length, comments.length),
  };
  if (!isReviewThread(thread)) return null;
  return { thread, openerAuthor: trimmed(opener.author?.username), openerCreatedAt };
}

// ── Viewer ────────────────────────────────────────────────────────────

export function gitLabViewerCapabilities(input: {
  readonly user: GitLabCurrentUser | null;
  readonly project: GitLabProject | null;
  readonly facts: GitLabMergeRequestFacts;
}): ChangeRequestViewerCapabilities | null {
  const { user, facts } = input;
  const login = trimmed(user?.username);
  if (!user || !login) return null;
  const access = gitLabAccessLevel(input.project);
  const isAuthor =
    facts.authorId !== null ? facts.authorId === user.id : facts.authorUsername === login;
  // Author or Developer+ edits, labels, assigns, closes (GitLab `update_merge_request`).
  const canUpdate = isAuthor || access >= GITLAB_DEVELOPER_ACCESS;
  const canMerge = facts.canMerge === true;
  return {
    login,
    isAuthor,
    canUpdate,
    canMerge,
    // Locked discussions accept comments from project members only.
    canReview: !facts.discussionLocked || access > 0,
    canUpdateBranch: canUpdate,
    canEnableAutoMerge: canMerge,
    canDisableAutoMerge: canMerge || (facts.autoMergeBy !== null && facts.autoMergeBy === login),
  };
}

// ── Assembly ──────────────────────────────────────────────────────────

export interface GitLabPagedItems<A> {
  readonly items: ReadonlyArray<A>;
  /** More pages exist than were read. */
  readonly truncated: boolean;
}

export interface GitLabActivityInput {
  readonly facts: GitLabMergeRequestFacts;
  readonly user: GitLabCurrentUser | null;
  readonly project: GitLabProject | null;
  /** Any order; the newest pages when truncated. */
  readonly notes: GitLabPagedItems<GitLabNote>;
  /** Oldest first, as GitLab lists them. */
  readonly discussions: GitLabPagedItems<GitLabDiscussion>;
  readonly stateEvents: ReadonlyArray<GitLabStateEvent>;
  readonly labelEvents: ReadonlyArray<GitLabLabelEvent>;
  readonly commits: GitLabPagedItems<GitLabCommit>;
  readonly versions: ReadonlyArray<GitLabVersion>;
  /** The viewer's unpublished draft notes; null when the host could not say. */
  readonly draftNotes: ReadonlyArray<GitLabDraftNote> | null;
  readonly diffEntries: ReadonlyArray<GitLabDiffEntry> | null;
}

function epoch(value: DateTime.Utc): number {
  return DateTime.toEpochMillis(value);
}

function commitItems(
  input: GitLabActivityInput,
  pushers: ReadonlyMap<string, ChangeRequestActor>,
): ChangeRequestTimelineItem[] {
  return input.commits.items.flatMap((commit) => {
    const createdAt =
      parseGitLabTimestamp(commit.committed_date) ??
      parseGitLabTimestamp(commit.created_at) ??
      parseGitLabTimestamp(commit.authored_date);
    const oid = trimmed(commit.id);
    if (!createdAt || !oid) return [];
    const message = commit.message ?? commit.title ?? "";
    const [headline = "", ...rest] = message.split("\n");
    const body = rest.join("\n").trim();
    const actor = [...pushers.entries()].find(([prefix]) =>
      oid.toLowerCase().startsWith(prefix),
    )?.[1];
    return [
      {
        id: `commit:${oid}`,
        kind: "commit" as const,
        createdAt,
        ...(actor ? { actor } : {}),
        oid,
        shortOid: trimmed(commit.short_id) ?? oid.slice(0, 8),
        messageHeadline: trimmed(commit.title) ?? headline.trim(),
        ...(body ? { messageBody: body } : {}),
      },
    ];
  });
}

/**
 * A push that rewrote history: the previous version's head is no longer one
 * of the merge request's commits. Undecidable when the commit list is cut.
 */
function forcePushItems(input: GitLabActivityInput): ChangeRequestTimelineItem[] {
  if (input.commits.truncated) return [];
  const known = new Set(input.commits.items.map((commit) => commit.id.toLowerCase()));
  const versions = input.versions
    .flatMap((version) => {
      const createdAt = parseGitLabTimestamp(version.created_at);
      return createdAt ? [{ version, createdAt }] : [];
    })
    .toSorted((left, right) => epoch(left.createdAt) - epoch(right.createdAt));
  const items: ChangeRequestTimelineItem[] = [];
  for (let index = 1; index < versions.length; index += 1) {
    const previous = versions[index - 1];
    const current = versions[index];
    if (!previous || !current) continue;
    const before = previous.version.head_commit_sha.trim();
    const after = current.version.head_commit_sha.trim();
    if (!before || !after || before === after || known.has(before.toLowerCase())) continue;
    items.push({
      id: `version:${current.version.id}`,
      kind: "force-pushed",
      createdAt: current.createdAt,
      beforeOid: before,
      afterOid: after,
    });
  }
  return items;
}

function eventItems(input: GitLabActivityInput): ChangeRequestTimelineItem[] {
  const items: ChangeRequestTimelineItem[] = [];
  for (const event of input.stateEvents) {
    const createdAt = parseGitLabTimestamp(event.created_at);
    if (!createdAt) continue;
    const actor = gitLabActor(event.user);
    const base = { id: `state:${event.id}`, createdAt, ...(actor ? { actor } : {}) };
    switch (event.state.trim().toLowerCase()) {
      case "merged":
        items.push({
          ...base,
          kind: "merged",
          ...(input.facts.mergeCommitSha ? { commitOid: input.facts.mergeCommitSha } : {}),
          baseRefName: input.facts.targetBranch,
        });
        break;
      case "closed":
        items.push({ ...base, kind: "closed" });
        break;
      case "reopened":
        items.push({ ...base, kind: "reopened" });
        break;
    }
  }
  for (const event of input.labelEvents) {
    const createdAt = parseGitLabTimestamp(event.created_at);
    const name = trimmed(event.label?.name);
    const action = event.action.trim().toLowerCase();
    if (!createdAt || !name || (action !== "add" && action !== "remove")) continue;
    const actor = gitLabActor(event.user);
    const color = trimmed(event.label?.color)?.replace(/^#/u, "").toLowerCase();
    const description = trimmed(event.label?.description);
    items.push({
      id: `label:${event.id}`,
      kind: action === "add" ? "labeled" : "unlabeled",
      createdAt,
      ...(actor ? { actor } : {}),
      label: {
        name,
        ...(color && /^[0-9a-f]{3,8}$/u.test(color) ? { color } : {}),
        ...(description ? { description } : {}),
      },
    });
  }
  return items;
}

/** Threads published together (one author, openers within a minute) form one review. */
function reviewItems(entries: ReadonlyArray<GitLabThreadEntry>): ChangeRequestTimelineItem[] {
  const sorted = entries.toSorted(
    (left, right) => epoch(left.openerCreatedAt) - epoch(right.openerCreatedAt),
  );
  const items: ChangeRequestTimelineItem[] = [];
  let batch: GitLabThreadEntry[] = [];
  const flush = () => {
    const first = batch[0];
    if (!first) return;
    const actor = first.thread.comments[0]?.author;
    items.push({
      id: `review:${first.thread.id}`,
      kind: "review",
      createdAt: first.openerCreatedAt,
      ...(actor ? { actor } : {}),
      state: "commented",
      body: "",
      threadIds: batch.map((entry) => entry.thread.id),
    });
    batch = [];
  };
  for (const entry of sorted) {
    const last = batch.at(-1);
    if (
      last &&
      (last.openerAuthor !== entry.openerAuthor ||
        epoch(entry.openerCreatedAt) - epoch(last.openerCreatedAt) > REVIEW_BATCH_WINDOW_MS)
    ) {
      flush();
    }
    batch.push(entry);
  }
  flush();
  return items;
}

export function assembleGitLabChangeRequestActivity(
  input: GitLabActivityInput,
): ChangeRequestActivity {
  const { facts } = input;
  const viewer = gitLabViewerCapabilities(input);
  const access = gitLabAccessLevel(input.project);
  const threadContext: GitLabThreadContext = {
    mergeRequestUrl: facts.webUrl,
    headSha: facts.headSha,
    viewerId: input.user?.id ?? null,
    viewerCanReply: viewer !== null && viewer.canReview,
    viewerCanResolve: viewer !== null && (viewer.isAuthor || access >= GITLAB_DEVELOPER_ACCESS),
    diffEntries: input.diffEntries,
  };
  const threadEntries = input.discussions.items.flatMap((discussion) => {
    const entry = gitLabReviewThread(discussion, threadContext);
    return entry ? [entry] : [];
  });
  const threadIds = new Set(threadEntries.map((entry) => entry.thread.id));

  const pushers = new Map<string, ChangeRequestActor>();
  const timeline: ChangeRequestTimelineItem[] = [];
  const seen = new Set<string>();
  const push = (item: ChangeRequestTimelineItem) => {
    if (seen.has(item.id) || !isTimelineItem(item)) return;
    seen.add(item.id);
    timeline.push(item);
  };

  const notes = input.notes.items.toSorted(
    (left, right) =>
      Date.parse(left.created_at) - Date.parse(right.created_at) || left.id - right.id,
  );
  for (const note of notes) {
    if (note.system === true) {
      const actor = gitLabActor(note.author);
      if (actor) for (const prefix of gitLabPushedCommitPrefixes(note)) pushers.set(prefix, actor);
      for (const item of gitLabSystemNoteItems(note, {
        mergeRequestUrl: facts.webUrl,
        targetBranch: facts.targetBranch,
      })) {
        push(item);
      }
      continue;
    }
    // Diff notes belong to their thread; image comments have no place on the page.
    if (note.position || note.type === "DiffNote") continue;
    const comment = noteComment(note, { ...threadContext, diffEntries: null });
    if (!comment) continue;
    push({
      id: `note:${note.id}`,
      kind: "comment",
      createdAt: comment.createdAt,
      actor: comment.author,
      body: comment.body,
      ...(comment.updatedAt ? { updatedAt: comment.updatedAt } : {}),
      ...(comment.url ? { url: comment.url } : {}),
      viewerCanUpdate: comment.viewerCanUpdate === true,
      viewerCanDelete: comment.viewerCanDelete === true,
    });
  }

  // Older items than the oldest note read would sit in a gap; drop them with it.
  const cutoff = input.notes.truncated && notes[0] ? Date.parse(notes[0].created_at) : null;
  for (const item of [
    ...eventItems(input),
    ...commitItems(input, pushers),
    ...forcePushItems(input),
    ...reviewItems(threadEntries.filter((entry) => threadIds.has(entry.thread.id))),
  ]) {
    if (cutoff !== null && epoch(item.createdAt) < cutoff) continue;
    push(item);
  }

  timeline.sort((left, right) => epoch(left.createdAt) - epoch(right.createdAt));

  return {
    provider: "gitlab",
    number: facts.iid,
    headSha: facts.headSha,
    viewer,
    timeline,
    timelineTruncated: input.notes.truncated || input.commits.truncated,
    reviewThreads: threadEntries.map((entry) => entry.thread),
    reviewThreadsTruncated: input.discussions.truncated,
    pendingReview:
      input.draftNotes && input.draftNotes.length > 0
        ? { id: "draft-notes", commentsCount: input.draftNotes.length }
        : null,
  };
}
