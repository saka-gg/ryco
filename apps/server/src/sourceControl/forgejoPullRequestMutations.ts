import { Result } from "effect";
import type {
  ChangeRequestDraftReviewComment,
  ChangeRequestReviewEvent,
  ChangeRequestSubmitReviewResult,
  SourceControlChangeRequestMergeMethod,
} from "@ryco/contracts";

import {
  normalizeForgejoReviewState,
  type ForgejoPullReview,
} from "./forgejoPullRequestActivity.ts";
import { forgejoMergeStyle } from "./forgejoPullRequestReadiness.ts";

/**
 * Request bodies for Forgejo pull request mutations, built and validated
 * before any request is sent. Shapes follow the API definitions
 * `CreatePullReviewOptions`, `CreatePullReviewComment`,
 * `CreatePullReviewCommentOptions`, `MergePullRequestOption`,
 * `EditPullRequestOption` and `PullReviewRequestOptions`
 * (https://codeberg.org/api/swagger).
 */

// ── Reviews ───────────────────────────────────────────────────────────

export type ForgejoReviewEvent = "APPROVED" | "REQUEST_CHANGES" | "COMMENT";

/** `CreatePullReviewComment`: exactly one of the positions is set. */
export interface ForgejoReviewDraftComment {
  readonly path: string;
  readonly body: string;
  readonly new_position?: number;
  readonly old_position?: number;
}

/** `POST /repos/{owner}/{repo}/pulls/{index}/reviews` body. */
export interface ForgejoReviewSubmissionBody {
  readonly event: ForgejoReviewEvent;
  readonly body: string;
  readonly commit_id: string;
  readonly comments: ReadonlyArray<ForgejoReviewDraftComment>;
}

export function toForgejoReviewEvent(event: ChangeRequestReviewEvent): ForgejoReviewEvent {
  switch (event) {
    case "approve":
      return "APPROVED";
    case "request_changes":
      return "REQUEST_CHANGES";
    case "comment":
      return "COMMENT";
  }
}

/**
 * A line comment on the line it ends on. Forgejo releases anchor a comment to
 * one line (`new_position` on the head side, `old_position` on the base
 * side); a range is anchored on its last line, as the host shows it.
 */
export function buildForgejoReviewDraftComment(
  comment: ChangeRequestDraftReviewComment,
): Result.Result<ForgejoReviewDraftComment, string> {
  if (comment.subjectType === "file") {
    return Result.fail(
      `Forgejo cannot attach a comment to a whole file (${comment.path}); comment on a line instead.`,
    );
  }
  if (comment.line === undefined) {
    return Result.fail(`The line comment on ${comment.path} is missing its line number.`);
  }
  if (comment.startLine !== undefined && comment.startLine > comment.line) {
    return Result.fail(
      `The comment range on ${comment.path} starts after it ends (${comment.startLine} > ${comment.line}).`,
    );
  }
  return Result.succeed(
    comment.side === "left"
      ? { path: comment.path, body: comment.body, old_position: comment.line }
      : { path: comment.path, body: comment.body, new_position: comment.line },
  );
}

/**
 * Validate a review and build its body. Forgejo requires a summary to request
 * changes, and a comment review needs a summary or line comments (its submit
 * endpoint does not count the comments already in a pending review, so a
 * pending review is submitted with a summary).
 */
export function buildForgejoReviewSubmissionBody(input: {
  readonly event: ChangeRequestReviewEvent;
  readonly body?: string | undefined;
  readonly comments: ReadonlyArray<ChangeRequestDraftReviewComment>;
  readonly expectedHeadSha: string;
}): Result.Result<ForgejoReviewSubmissionBody, string> {
  const body = input.body?.trim() ? input.body : "";
  if (input.event === "request_changes" && body.length === 0) {
    return Result.fail("Requesting changes needs a review summary.");
  }
  if (input.event === "comment" && body.length === 0 && input.comments.length === 0) {
    return Result.fail("A comment review needs a summary or at least one line comment.");
  }
  const comments: ForgejoReviewDraftComment[] = [];
  for (const comment of input.comments) {
    const built = buildForgejoReviewDraftComment(comment);
    if (Result.isFailure(built)) return Result.fail(built.failure);
    comments.push(built.success);
  }
  return Result.succeed({
    event: toForgejoReviewEvent(input.event),
    body,
    commit_id: input.expectedHeadSha,
    comments,
  });
}

/** The created review as the contract reports it. */
export function forgejoSubmitReviewResult(
  review: ForgejoPullReview,
): Result.Result<ChangeRequestSubmitReviewResult, string> {
  const raw = review.state?.trim().toUpperCase();
  const state = raw === "PENDING" ? "pending" : normalizeForgejoReviewState(review);
  if (!state) return Result.fail("Forgejo returned a review without a state.");
  const url = review.html_url?.trim();
  return Result.succeed({ reviewId: String(review.id), state, ...(url ? { url } : {}) });
}

// ── Merge ─────────────────────────────────────────────────────────────

/** `POST /repos/{owner}/{repo}/pulls/{index}/merge` body (`MergePullRequestOption`). */
export interface ForgejoMergeBody {
  readonly Do: string;
  /** Forgejo refuses with 409 (`head out of date`) when the head moved. */
  readonly head_commit_id?: string;
}

/**
 * The merge itself. Branch deletion is not delegated to Forgejo's
 * `delete_branch_after_merge`: a failed deletion there answers with an error
 * even though the merge landed, so Ryco deletes the branch afterwards itself.
 */
export function buildForgejoMergeBody(input: {
  readonly mergeMethod: SourceControlChangeRequestMergeMethod;
  readonly expectedHeadSha?: string | undefined;
}): ForgejoMergeBody {
  return {
    Do: forgejoMergeStyle(input.mergeMethod),
    ...(input.expectedHeadSha ? { head_commit_id: input.expectedHeadSha } : {}),
  };
}

// ── Draft state ───────────────────────────────────────────────────────

/**
 * Forgejo derives "draft" from a title prefix (`[repository.pull-request]
 * WORK_IN_PROGRESS_PREFIXES`, default `WIP:,[WIP]`, matched
 * case-insensitively); the API's `draft` is read-only. Ryco adds `WIP: ` and
 * strips either default prefix.
 */
export const FORGEJO_WORK_IN_PROGRESS_PREFIXES: ReadonlyArray<string> = ["WIP:", "[WIP]"];

export function hasForgejoWorkInProgressPrefix(title: string): boolean {
  const upper = title.trimStart().toUpperCase();
  return FORGEJO_WORK_IN_PROGRESS_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

export function forgejoWorkInProgressTitle(title: string, draft: boolean): string {
  if (draft) return hasForgejoWorkInProgressPrefix(title) ? title : `WIP: ${title.trimStart()}`;
  let next = title.trimStart();
  while (hasForgejoWorkInProgressPrefix(next)) {
    const prefix = FORGEJO_WORK_IN_PROGRESS_PREFIXES.find((candidate) =>
      next.toUpperCase().startsWith(candidate),
    );
    if (!prefix) break;
    next = next.slice(prefix.length).trimStart();
  }
  return next.length > 0 ? next : title;
}

// ── People ────────────────────────────────────────────────────────────

/** `PullReviewRequestOptions`: users by login, teams (`org/team`) by team name. */
export function splitForgejoReviewers(logins: ReadonlyArray<string>): {
  readonly reviewers: ReadonlyArray<string>;
  readonly team_reviewers: ReadonlyArray<string>;
} {
  const reviewers: string[] = [];
  const teams: string[] = [];
  for (const raw of logins) {
    const login = raw.trim();
    if (login.length === 0) continue;
    const slash = login.indexOf("/");
    if (slash === -1) reviewers.push(login);
    else teams.push(login.slice(slash + 1));
  }
  return { reviewers, team_reviewers: teams };
}

/** Forgejo replaces a pull request's assignees wholesale; apply one edit to the current set. */
export function nextForgejoAssignees(input: {
  readonly current: ReadonlyArray<string>;
  readonly add: ReadonlyArray<string>;
  readonly remove: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  const removed = new Set(input.remove.map((login) => login.toLowerCase()));
  const next: string[] = [];
  const seen = new Set<string>();
  for (const login of [...input.current, ...input.add]) {
    const key = login.toLowerCase();
    if (removed.has(key) || seen.has(key)) continue;
    seen.add(key);
    next.push(login);
  }
  return next;
}

/** Resolve label names to ids (Forgejo 7's `IssueLabelsOption` takes only ids). */
export function resolveForgejoLabelIds(
  names: ReadonlyArray<string>,
  labels: ReadonlyArray<{ readonly id: number; readonly name: string }>,
): Result.Result<ReadonlyArray<number>, string> {
  const ids: number[] = [];
  for (const name of names) {
    const label =
      labels.find((candidate) => candidate.name === name) ??
      labels.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    if (!label) return Result.fail(`No label named "${name}" exists in this repository.`);
    ids.push(label.id);
  }
  return Result.succeed(ids);
}

// ── Paths ─────────────────────────────────────────────────────────────

/** A repository-relative file path that cannot escape the repository route. */
export function isForgejoRepositoryFilePath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\0") || path.includes("\\")) {
    return false;
  }
  return path
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export function encodeForgejoPathSegments(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}
