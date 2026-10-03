import { DateTime, Option, Schema } from "effect";
import type {
  SourceControlChangeRequestMergeCapabilities,
  SourceControlChangeRequestMergeMethod,
  SourceControlChangeRequestMergeStateStatus,
  SourceControlChangeRequestReviewDecision,
  SourceControlChangeRequestReviewer,
  SourceControlCheckRollupItem,
} from "@ryco/contracts";

import {
  forgejoLogin,
  isForgejoPendingReview,
  normalizeForgejoReviewState,
  parseForgejoTime,
  type ForgejoPullReview,
} from "./forgejoPullRequestActivity.ts";
import type {
  ForgejoPullRequestReadinessFacts,
  ForgejoRepository,
  NormalizedForgejoPullRequestRecord,
} from "./forgejoPullRequests.ts";

/**
 * Merge readiness for Forgejo pull requests: reviews, commit statuses, base
 * branch protection and repository merge settings, mapped onto the facts the
 * page's merge verdict reads. Only what Forgejo reports is stated; where it
 * is silent (branch rules it does not expose to readers) the facts stay
 * absent rather than guessed.
 *
 * Payloads: `CombinedStatus` / `CommitStatus`
 * (https://codeberg.org/api/swagger#/repository/repoGetCombinedStatusByRef)
 * and `Branch` (https://codeberg.org/api/swagger#/repository/repoGetBranch).
 */

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));
const OptionalNumber = Schema.optional(Schema.NullOr(Schema.Number));
const OptionalBoolean = Schema.optional(Schema.NullOr(Schema.Boolean));

/** `CommitStatus`. `status` is pending, success, error, failure, warning or skipped. */
export const ForgejoCommitStatusSchema = Schema.Struct({
  id: OptionalNumber,
  status: OptionalString,
  context: OptionalString,
  description: OptionalString,
  target_url: OptionalString,
  created_at: OptionalString,
  updated_at: OptionalString,
});
export type ForgejoCommitStatus = typeof ForgejoCommitStatusSchema.Type;

/** `CombinedStatus`: the newest status per context for one commit. */
export const ForgejoCombinedStatusSchema = Schema.Struct({
  state: OptionalString,
  sha: OptionalString,
  total_count: OptionalNumber,
  statuses: Schema.optional(Schema.NullOr(Schema.Array(ForgejoCommitStatusSchema))),
});
export type ForgejoCombinedStatus = typeof ForgejoCombinedStatusSchema.Type;

/** `Branch`, with the protection facts Forgejo exposes to readers. */
export const ForgejoBranchSchema = Schema.Struct({
  name: OptionalString,
  protected: OptionalBoolean,
  required_approvals: OptionalNumber,
  enable_status_check: OptionalBoolean,
  status_check_contexts: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  user_can_push: OptionalBoolean,
  user_can_merge: OptionalBoolean,
});
export type ForgejoBranch = typeof ForgejoBranchSchema.Type;

// ── Merge settings ────────────────────────────────────────────────────

/**
 * Ryco's three merge methods on Forgejo's merge styles: `merge` creates a
 * merge commit, `squash` squashes, and `rebase` rebases and fast-forwards
 * (Forgejo `rebase`). Forgejo's `rebase-merge` (rebase, then a merge commit)
 * and `fast-forward-only` have no Ryco equivalent and are not offered.
 */
export function forgejoMergeStyle(method: SourceControlChangeRequestMergeMethod): string {
  return method;
}

export function forgejoMergeCapabilities(
  repository: Pick<
    ForgejoRepository,
    "allow_merge_commits" | "allow_squash_merge" | "allow_rebase"
  >,
): SourceControlChangeRequestMergeCapabilities {
  return {
    merge: repository.allow_merge_commits === true,
    squash: repository.allow_squash_merge === true,
    rebase: repository.allow_rebase === true,
  };
}

// ── Checks ────────────────────────────────────────────────────────────

/**
 * Forgejo matches required status contexts as globs (`gobwas/glob` without
 * separators: `*` spans `/`). `*`, `?` and `{a,b}` are honored; anything else
 * matches literally.
 */
export function forgejoStatusContextPattern(pattern: string): RegExp {
  let source = "";
  let inAlternation = false;
  for (const char of pattern) {
    if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else if (char === "{") {
      inAlternation = true;
      source += "(?:";
    } else if (char === "}" && inAlternation) {
      inAlternation = false;
      source += ")";
    } else if (char === "," && inAlternation) source += "|";
    else source += char.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
  }
  return new RegExp(`^${inAlternation ? `${source})` : source}$`, "u");
}

function requiredPatterns(branch: ForgejoBranch | null): ReadonlyArray<RegExp> | null {
  if (!branch || branch.protected !== true || branch.enable_status_check !== true) return null;
  return (branch.status_check_contexts ?? [])
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0)
    .map(forgejoStatusContextPattern);
}

function optionString(value: string | null | undefined): Option.Option<string> {
  const text = value?.trim() ?? "";
  return text.length > 0 ? Option.some(text) : Option.none();
}

function optionTime(value: string | null | undefined): Option.Option<DateTime.Utc> {
  const time = parseForgejoTime(value);
  return time ? Option.some(time) : Option.none();
}

/**
 * One rollup item per status context. A pending status is still running; any
 * other state is final, with `warning` read as neutral (Forgejo does not block
 * on it). When the base branch requires status checks, each item says whether
 * it is required, and a required context that has not reported yet is listed
 * as expected, as Forgejo waits for it before merging.
 */
export function normalizeForgejoCheckRollup(input: {
  readonly status: ForgejoCombinedStatus | null;
  readonly branch: ForgejoBranch | null;
}): ReadonlyArray<SourceControlCheckRollupItem> {
  const patterns = requiredPatterns(input.branch);
  const items: SourceControlCheckRollupItem[] = [];
  for (const status of input.status?.statuses ?? []) {
    const name = status.context?.trim();
    if (!name) continue;
    const state = status.status?.trim().toLowerCase() ?? "";
    const pending = state === "pending" || state === "";
    const conclusion =
      state === "success"
        ? "success"
        : state === "failure" || state === "error"
          ? "failure"
          : state === "warning"
            ? "neutral"
            : state === "skipped"
              ? "skipped"
              : null;
    items.push({
      kind: "status-context",
      name,
      status: Option.some(pending ? "pending" : "completed"),
      conclusion: pending ? Option.none() : optionString(conclusion),
      url: optionString(status.target_url),
      startedAt: optionTime(status.created_at),
      completedAt: pending ? Option.none() : optionTime(status.updated_at),
      ...(patterns ? { isRequired: patterns.some((pattern) => pattern.test(name)) } : {}),
    });
  }
  // Expected contexts are only known once the reported ones were read.
  for (const raw of patterns && input.status ? (input.branch?.status_check_contexts ?? []) : []) {
    const pattern = raw.trim();
    // A glob names no single check; a literal one that never reported is still awaited.
    if (pattern.length === 0 || /[*?{]/u.test(pattern)) continue;
    if (items.some((item) => item.name === pattern)) continue;
    items.push({
      kind: "status-context",
      name: pattern,
      status: Option.some("expected"),
      conclusion: Option.none(),
      url: Option.none(),
      startedAt: Option.none(),
      completedAt: Option.none(),
      isRequired: true,
    });
  }
  return items;
}

// ── Reviews ───────────────────────────────────────────────────────────

function reviewTime(review: ForgejoPullReview): number {
  const time = parseForgejoTime(review.submitted_at) ?? parseForgejoTime(review.updated_at);
  return time ? DateTime.toEpochMillis(time) : 0;
}

/**
 * Forgejo marks a reviewer's newest approval or change request `official`
 * (when they have write access) and clears the flag on their earlier ones,
 * so official, undismissed reviews are each reviewer's standing verdict.
 */
function isStandingVerdict(review: ForgejoPullReview): boolean {
  const state = normalizeForgejoReviewState(review);
  return review.official === true && (state === "approved" || state === "changes_requested");
}

/**
 * Per reviewer: requested (asked and not reviewed since), else their standing
 * verdict, else their latest submitted review. Team requests are listed as
 * teams. Pending reviews and review requests are not reviews.
 */
export function deriveForgejoReviewerStates(input: {
  readonly reviews: ReadonlyArray<ForgejoPullReview>;
  readonly requestedReviewers: ReadonlyArray<string>;
  readonly requestedTeams: ReadonlyArray<string>;
}): ReadonlyArray<SourceControlChangeRequestReviewer> {
  const states: SourceControlChangeRequestReviewer[] = [];
  const requested = new Set(input.requestedReviewers.map((login) => login.toLowerCase()));
  for (const login of input.requestedReviewers) {
    states.push({ login, kind: "user", state: "requested" });
  }
  for (const team of input.requestedTeams) {
    states.push({ login: team, kind: "team", state: "requested" });
  }
  const chosen = new Map<string, ForgejoPullReview>();
  const ordered = input.reviews
    .filter((review) => !isForgejoPendingReview(review) && normalizeForgejoReviewState(review))
    .toSorted((left, right) => reviewTime(left) - reviewTime(right) || left.id - right.id);
  for (const review of ordered) {
    const key = forgejoLogin(review.user)?.toLowerCase();
    if (!key || requested.has(key)) continue;
    const previous = chosen.get(key);
    // A later comment does not replace a standing approval or change request.
    if (previous && isStandingVerdict(previous) && !isStandingVerdict(review)) continue;
    chosen.set(key, review);
  }
  for (const review of chosen.values()) {
    const login = forgejoLogin(review.user);
    const state = normalizeForgejoReviewState(review);
    if (!login || !state || state === "pending") continue;
    const submittedAt = parseForgejoTime(review.submitted_at);
    const avatarUrl = review.user?.avatar_url?.trim();
    states.push({
      login,
      kind: "user",
      state,
      ...(avatarUrl ? { avatarUrl } : {}),
      ...(submittedAt ? { submittedAt } : {}),
    });
  }
  return states;
}

/**
 * The aggregate verdict over standing verdicts (see `isStandingVerdict`): any
 * request for changes wins; otherwise approvals against the base branch's
 * `required_approvals`. Stale approvals (given before the latest push) do not
 * count, as when the branch ignores them. Null when no review is required and
 * none was given.
 */
export function deriveForgejoReviewDecision(input: {
  readonly reviews: ReadonlyArray<ForgejoPullReview>;
  readonly branch: ForgejoBranch | null;
}): SourceControlChangeRequestReviewDecision | null {
  let approvals = 0;
  for (const review of input.reviews) {
    if (!isStandingVerdict(review)) continue;
    if (normalizeForgejoReviewState(review) === "changes_requested") return "changes_requested";
    if (review.stale !== true) approvals += 1;
  }
  const required =
    input.branch?.protected === true ? Math.max(0, input.branch.required_approvals ?? 0) : 0;
  if (required > 0) return approvals >= required ? "approved" : "review_required";
  return approvals > 0 ? "approved" : null;
}

// ── Mergeability ──────────────────────────────────────────────────────

/**
 * Forgejo's `mergeable` is false while it is still checking, on conflicts,
 * on check errors and for drafts. Drafts say nothing about conflicts; for an
 * open non-draft pull request a false `mergeable` is read as conflicting
 * (checks settle within seconds, and the next poll corrects a transient).
 */
export function deriveForgejoMergeability(
  record: Pick<NormalizedForgejoPullRequestRecord, "state" | "isDraft" | "mergeable">,
): "mergeable" | "conflicting" | undefined {
  if (record.state !== "open" || record.isDraft === true || record.mergeable === undefined) {
    return undefined;
  }
  return record.mergeable ? "mergeable" : "conflicting";
}

/**
 * GitHub's merge state vocabulary over what Forgejo exposes: `draft`,
 * `dirty` (conflicts), `blocked` (the base branch's required approvals or
 * required checks are unmet, or changes were requested on a protected
 * branch), `unstable` (only optional checks fail) and `clean`. Without the
 * base branch (not readable) the state stays unknown, so the page treats
 * failing checks and missing reviews as blocking.
 */
export function deriveForgejoMergeStateStatus(input: {
  readonly record: Pick<NormalizedForgejoPullRequestRecord, "state" | "isDraft" | "mergeable">;
  readonly branch: ForgejoBranch | null;
  readonly checkRollup: ReadonlyArray<SourceControlCheckRollupItem>;
  readonly reviewDecision: SourceControlChangeRequestReviewDecision | null;
}): SourceControlChangeRequestMergeStateStatus | undefined {
  const { record } = input;
  if (record.state !== "open") return undefined;
  if (record.isDraft === true) return "draft";
  const mergeability = deriveForgejoMergeability(record);
  if (mergeability === "conflicting") return "dirty";
  if (!input.branch || mergeability === undefined) return undefined;
  const settled = (item: SourceControlCheckRollupItem) =>
    Option.isSome(item.conclusion) && Option.getOrUndefined(item.conclusion) !== "failure";
  const failed = (item: SourceControlCheckRollupItem) =>
    Option.getOrUndefined(item.conclusion) === "failure";
  if (input.branch.protected === true) {
    if (
      input.reviewDecision === "review_required" ||
      input.reviewDecision === "changes_requested"
    ) {
      return "blocked";
    }
    if (input.checkRollup.some((item) => item.isRequired === true && !settled(item))) {
      return "blocked";
    }
  }
  return input.checkRollup.some(failed) ? "unstable" : "clean";
}

/** Everything the merge verdict reads, for one pull request. */
export function deriveForgejoReadiness(input: {
  readonly record: NormalizedForgejoPullRequestRecord;
  readonly reviews: ReadonlyArray<ForgejoPullReview> | null;
  readonly status: ForgejoCombinedStatus | null;
  readonly branch: ForgejoBranch | null;
  readonly repository: ForgejoRepository | null;
}): ForgejoPullRequestReadinessFacts {
  const checkRollup = normalizeForgejoCheckRollup({ status: input.status, branch: input.branch });
  const reviewDecision = input.reviews
    ? deriveForgejoReviewDecision({ reviews: input.reviews, branch: input.branch })
    : null;
  const mergeability = deriveForgejoMergeability(input.record);
  const mergeStateStatus = input.reviews
    ? deriveForgejoMergeStateStatus({
        record: input.record,
        branch: input.branch,
        checkRollup,
        reviewDecision,
      })
    : undefined;
  return {
    ...(mergeability ? { mergeability } : {}),
    ...(mergeStateStatus ? { mergeStateStatus } : {}),
    ...(input.reviews ? { reviewDecision } : {}),
    ...(input.reviews
      ? {
          reviewerStates: deriveForgejoReviewerStates({
            reviews: input.reviews,
            requestedReviewers: input.record.requestedReviewers ?? [],
            requestedTeams: input.record.requestedTeams ?? [],
          }),
        }
      : {}),
    ...(input.status ? { checkRollup } : {}),
    ...(input.repository ? { mergeCapabilities: forgejoMergeCapabilities(input.repository) } : {}),
  };
}
