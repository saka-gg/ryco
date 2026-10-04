import { Cause, DateTime, Exit, Option, Result, Schema } from "effect";
import {
  PositiveInt,
  TrimmedNonEmptyString,
  type SourceControlChangeRequestAutoMerge,
  type SourceControlChangeRequestMergeCapabilities,
  type SourceControlChangeRequestMergeMethod,
  type SourceControlChangeRequestMergeStateStatus,
  type SourceControlChangeRequestMergeability,
  type SourceControlChangeRequestReviewDecision,
  type SourceControlChangeRequestReviewer,
  type SourceControlChangeRequestReviewerState,
  type SourceControlLabel,
} from "@ryco/contracts";
import { decodeJsonResult, formatSchemaError } from "@ryco/shared/schemaJson";
import { authorName } from "./gitLabIssues.ts";
import type { GitLabDiffRefs } from "./gitLabMergeRequestDiffs.ts";

/**
 * GitLab merge request payloads (REST v4 and `glab mr view/list --output
 * json`, which marshal the same snake_case fields) and the readiness facts
 * derived from them.
 *
 * Docs:
 * - https://docs.gitlab.com/api/merge_requests/#retrieve-a-merge-request
 *   (`detailed_merge_status`, `diff_refs`, `head_pipeline`, `user.can_merge`)
 * - https://docs.gitlab.com/api/merge_requests/#retrieve-merge-request-reviewers
 * - https://docs.gitlab.com/api/merge_request_approvals/#retrieve-approval-state-for-a-merge-request
 * - https://docs.gitlab.com/api/projects/#retrieve-a-project (`merge_method`, `squash_option`)
 */

export interface NormalizedGitLabMergeRequestRecord {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt: Option.Option<DateTime.Utc>;
  readonly isCrossRepository?: boolean;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
  readonly isDraft?: boolean;
  readonly author?: string;
  readonly assignees?: ReadonlyArray<string>;
  readonly labels?: ReadonlyArray<SourceControlLabel>;
  readonly commentsCount?: number;
  readonly headSha?: string;
  readonly mergeability?: SourceControlChangeRequestMergeability;
  /**
   * `detailed_merge_status` as a merge state (open merge requests only), so
   * a list row blocked by a rebase, unresolved threads or a required pipeline
   * says so instead of reading ready.
   */
  readonly mergeStateStatus?: SourceControlChangeRequestMergeStateStatus;
  /** Only the verdicts `detailed_merge_status` states; approvals need their own read. */
  readonly reviewDecision?: Extract<
    SourceControlChangeRequestReviewDecision,
    "review_required" | "changes_requested"
  >;
  readonly createdAt?: DateTime.Utc;
  readonly mergedAt?: DateTime.Utc;
  readonly closedAt?: DateTime.Utc;
}

const GitLabProjectReferenceSchema = Schema.Struct({
  path_with_namespace: Schema.optional(Schema.String),
  pathWithNamespace: Schema.optional(Schema.String),
  namespace: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        path: Schema.optional(Schema.String),
        full_path: Schema.optional(Schema.String),
        fullPath: Schema.optional(Schema.String),
      }),
    ),
  ),
});

/** A user reference (`author`, `assignees[]`, `reviewers[]`, `merged_by`, …). */
export const GitLabUserRefSchema = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.Number)),
  username: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  avatar_url: Schema.optional(Schema.NullOr(Schema.String)),
  bot: Schema.optional(Schema.NullOr(Schema.Boolean)),
});
export type GitLabUserRef = typeof GitLabUserRefSchema.Type;

const GitLabMergeRequestSchema = Schema.Struct({
  iid: PositiveInt,
  title: TrimmedNonEmptyString,
  web_url: TrimmedNonEmptyString,
  source_branch: TrimmedNonEmptyString,
  target_branch: TrimmedNonEmptyString,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  updated_at: Schema.optional(Schema.OptionFromNullOr(Schema.DateTimeUtcFromString)),
  source_project_id: Schema.optional(Schema.NullOr(Schema.Number)),
  target_project_id: Schema.optional(Schema.NullOr(Schema.Number)),
  source_project: Schema.optional(Schema.NullOr(GitLabProjectReferenceSchema)),
  target_project: Schema.optional(Schema.NullOr(GitLabProjectReferenceSchema)),
  draft: Schema.optional(Schema.NullOr(Schema.Boolean)),
  work_in_progress: Schema.optional(Schema.NullOr(Schema.Boolean)),
  author: Schema.optional(Schema.NullOr(GitLabUserRefSchema)),
  assignees: Schema.optional(Schema.NullOr(Schema.Array(GitLabUserRefSchema))),
  reviewers: Schema.optional(Schema.NullOr(Schema.Array(GitLabUserRefSchema))),
  labels: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
  user_notes_count: Schema.optional(Schema.NullOr(Schema.Number)),
  sha: Schema.optional(Schema.NullOr(Schema.String)),
  has_conflicts: Schema.optional(Schema.NullOr(Schema.Boolean)),
  detailed_merge_status: Schema.optional(Schema.NullOr(Schema.String)),
  merge_status: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.optional(Schema.NullOr(Schema.String)),
  merged_at: Schema.optional(Schema.NullOr(Schema.String)),
  closed_at: Schema.optional(Schema.NullOr(Schema.String)),
});

function trimOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export function parseGitLabTimestamp(value: string | null | undefined): DateTime.Utc | null {
  const trimmed = trimOptionalString(value);
  if (!trimmed) return null;
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : DateTime.fromDateUnsafe(date);
}

function normalizeGitLabMergeRequestState(
  state: string | null | undefined,
): "open" | "closed" | "merged" {
  const normalized = state?.trim().toLowerCase();
  if (normalized === "merged") {
    return "merged";
  }
  if (normalized === "closed") {
    return "closed";
  }
  return "open";
}

function projectPathWithNamespace(
  project: Schema.Schema.Type<typeof GitLabProjectReferenceSchema> | null | undefined,
): string | null {
  const explicit =
    trimOptionalString(project?.path_with_namespace) ??
    trimOptionalString(project?.pathWithNamespace);
  if (explicit) {
    return explicit;
  }

  const namespacePath =
    trimOptionalString(project?.namespace?.full_path) ??
    trimOptionalString(project?.namespace?.fullPath) ??
    trimOptionalString(project?.namespace?.path);
  return namespacePath;
}

function ownerLoginFromPathWithNamespace(pathWithNamespace: string | null): string | null {
  const [owner] = pathWithNamespace?.split("/") ?? [];
  return trimOptionalString(owner);
}

function usernames(users: ReadonlyArray<GitLabUserRef> | null | undefined): string[] {
  return (users ?? []).flatMap((user) => {
    const login = trimOptionalString(user.username);
    return login ? [login] : [];
  });
}

/** `#rrggbb` → `rrggbb`, the contract's label colour form. */
function labelColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const hex = value.trim().replace(/^#/u, "");
  return /^[0-9a-f]{3,8}$/iu.test(hex) ? hex.toLowerCase() : null;
}

/** Labels arrive as names, or as objects with `with_labels_details`. */
export function normalizeGitLabLabels(raw: ReadonlyArray<unknown>): SourceControlLabel[] {
  const labels: SourceControlLabel[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const name = entry.trim();
      if (name) labels.push({ name });
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) continue;
    const color = labelColor(record.color);
    const description =
      typeof record.description === "string" ? record.description.trim() : undefined;
    labels.push({
      name,
      ...(color ? { color } : {}),
      ...(description ? { description } : {}),
    });
  }
  return labels;
}

const UNSETTLED_MERGE_STATUSES = new Set([
  "checking",
  "unchecked",
  "preparing",
  "approvals_syncing",
]);

/**
 * `has_conflicts` is only meaningful once GitLab checked the merge
 * (`merge_status`), so an unchecked merge request reads `unknown`.
 */
export function gitLabMergeability(input: {
  readonly hasConflicts?: boolean | null | undefined;
  readonly detailedMergeStatus?: string | null | undefined;
  readonly mergeStatus?: string | null | undefined;
}): SourceControlChangeRequestMergeability | undefined {
  const detailed = trimOptionalString(input.detailedMergeStatus)?.toLowerCase() ?? null;
  const status = trimOptionalString(input.mergeStatus)?.toLowerCase() ?? null;
  if (detailed === null && status === null && input.hasConflicts == null) return undefined;
  if (input.hasConflicts === true || detailed === "conflict") return "conflicting";
  if (status === "cannot_be_merged" || status === "cannot_be_merged_recheck") return "conflicting";
  if (detailed !== null && UNSETTLED_MERGE_STATUSES.has(detailed)) return "unknown";
  if (status === "can_be_merged" || detailed === "mergeable") return "mergeable";
  if (status === "unchecked" || status === "checking") return "unknown";
  // A reported block (approvals, pipeline, discussions) is not a conflict.
  return detailed !== null && detailed !== "not_open" ? "mergeable" : "unknown";
}

/**
 * `detailed_merge_status` → the contract's merge state. Every GitLab block
 * refuses the merge (pipelines included: `ci_must_pass` means the project
 * requires a green pipeline), so they read `blocked`, never `unstable`.
 */
export function gitLabMergeStateStatus(
  detailedMergeStatus: string | null | undefined,
): SourceControlChangeRequestMergeStateStatus | undefined {
  const status = trimOptionalString(detailedMergeStatus)?.toLowerCase();
  if (!status) return undefined;
  switch (status) {
    case "mergeable":
      return "clean";
    case "need_rebase":
      return "behind";
    case "conflict":
      return "dirty";
    case "draft_status":
      return "draft";
    case "checking":
    case "unchecked":
    case "preparing":
    case "approvals_syncing":
    case "not_open":
      return "unknown";
    default:
      return "blocked";
  }
}

function normalizeGitLabMergeRequestRecord(
  raw: Schema.Schema.Type<typeof GitLabMergeRequestSchema>,
): NormalizedGitLabMergeRequestRecord {
  const sourceProjectPath = projectPathWithNamespace(raw.source_project);
  const targetProjectPath = projectPathWithNamespace(raw.target_project);
  const isCrossRepository =
    typeof raw.source_project_id === "number" && typeof raw.target_project_id === "number"
      ? raw.source_project_id !== raw.target_project_id
      : sourceProjectPath !== null && targetProjectPath !== null
        ? sourceProjectPath.toLowerCase() !== targetProjectPath.toLowerCase()
        : undefined;
  const headRepositoryOwnerLogin = ownerLoginFromPathWithNamespace(sourceProjectPath);
  const isDraft = raw.draft ?? raw.work_in_progress ?? undefined;
  const author = trimOptionalString(raw.author?.username);
  const assignees = raw.assignees ? usernames(raw.assignees) : undefined;
  const labels = raw.labels ? normalizeGitLabLabels(raw.labels) : undefined;
  const headSha = trimOptionalString(raw.sha);
  const mergeability = gitLabMergeability({
    hasConflicts: raw.has_conflicts,
    detailedMergeStatus: raw.detailed_merge_status,
    mergeStatus: raw.merge_status,
  });
  const createdAt = parseGitLabTimestamp(raw.created_at);
  const mergedAt = parseGitLabTimestamp(raw.merged_at);
  const closedAt = parseGitLabTimestamp(raw.closed_at);
  const detailedStatus = trimOptionalString(raw.detailed_merge_status)?.toLowerCase();
  const state = normalizeGitLabMergeRequestState(raw.state);
  const mergeStateStatus =
    state !== "open"
      ? undefined
      : isDraft === true
        ? ("draft" as const)
        : gitLabMergeStateStatus(raw.detailed_merge_status);
  const reviewDecision =
    detailedStatus === "not_approved"
      ? ("review_required" as const)
      : detailedStatus === "requested_changes"
        ? ("changes_requested" as const)
        : undefined;

  return {
    number: raw.iid,
    title: raw.title,
    url: raw.web_url,
    baseRefName: raw.target_branch,
    headRefName: raw.source_branch,
    state,
    updatedAt: raw.updated_at ?? Option.none(),
    ...(typeof isCrossRepository === "boolean" ? { isCrossRepository } : {}),
    ...(sourceProjectPath ? { headRepositoryNameWithOwner: sourceProjectPath } : {}),
    ...(headRepositoryOwnerLogin ? { headRepositoryOwnerLogin } : {}),
    ...(typeof isDraft === "boolean" ? { isDraft } : {}),
    ...(author ? { author } : {}),
    ...(assignees && assignees.length > 0 ? { assignees } : {}),
    ...(labels && labels.length > 0 ? { labels } : {}),
    ...(typeof raw.user_notes_count === "number" && raw.user_notes_count >= 0
      ? { commentsCount: raw.user_notes_count }
      : {}),
    ...(headSha ? { headSha } : {}),
    ...(mergeability ? { mergeability } : {}),
    ...(mergeStateStatus ? { mergeStateStatus } : {}),
    ...(reviewDecision ? { reviewDecision } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(mergedAt ? { mergedAt } : {}),
    ...(closedAt ? { closedAt } : {}),
  };
}

const decodeGitLabMergeRequestList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeGitLabMergeRequest = decodeJsonResult(GitLabMergeRequestSchema);
const decodeGitLabMergeRequestEntry = Schema.decodeUnknownExit(GitLabMergeRequestSchema);

export const formatGitLabJsonDecodeError = formatSchemaError;

export function decodeGitLabMergeRequestListJson(
  raw: string,
): Result.Result<
  ReadonlyArray<NormalizedGitLabMergeRequestRecord>,
  Cause.Cause<Schema.SchemaError>
> {
  const result = decodeGitLabMergeRequestList(raw);
  if (Result.isSuccess(result)) {
    const mergeRequests: NormalizedGitLabMergeRequestRecord[] = [];
    for (const entry of result.success) {
      const decodedEntry = decodeGitLabMergeRequestEntry(entry);
      if (Exit.isFailure(decodedEntry)) {
        continue;
      }
      mergeRequests.push(normalizeGitLabMergeRequestRecord(decodedEntry.value));
    }
    return Result.succeed(mergeRequests);
  }
  return Result.fail(result.failure);
}

export function decodeGitLabMergeRequestJson(
  raw: string,
): Result.Result<NormalizedGitLabMergeRequestRecord, Cause.Cause<Schema.SchemaError>> {
  const result = decodeGitLabMergeRequest(raw);
  if (Result.isSuccess(result)) {
    return Result.succeed(normalizeGitLabMergeRequestRecord(result.success));
  }
  return Result.fail(result.failure);
}

// ── Single merge request ──────────────────────────────────────────────

/** Facts from the single merge request payload that only the page needs. */
export interface GitLabMergeRequestFacts {
  readonly iid: number;
  readonly authorId: number | null;
  readonly authorUsername: string | null;
  /** `diff_refs.head_sha`, else `sha`. */
  readonly headSha: string | null;
  readonly diffRefs: GitLabDiffRefs | null;
  /** `user.can_merge` for the authenticated user. */
  readonly canMerge: boolean | null;
  readonly discussionLocked: boolean;
  readonly isDraft: boolean;
  /** Auto-merge (`merge_when_pipeline_succeeds`) is armed. */
  readonly autoMergeEnabled: boolean;
  readonly autoMergeBy: string | null;
  readonly squash: boolean;
  readonly forceRemoveSourceBranch: boolean | null;
  readonly isCrossRepository: boolean;
  /**
   * `head_pipeline` as GitLab reports it. It can lag the head (a push that
   * started no pipeline) and, for merged-results / merge-train pipelines, runs
   * on a merge commit; `resolveGitLabHeadPipeline` checks it against the head.
   */
  readonly headPipeline: {
    readonly id: number;
    readonly iid: number | null;
    readonly name: string | null;
    readonly sha: string | null;
  } | null;
  readonly reviewers: ReadonlyArray<GitLabUserRef>;
  readonly assignees: ReadonlyArray<GitLabUserRef>;
  readonly detailedMergeStatus: string | null;
  readonly mergeCommitSha: string | null;
  readonly mergedAt: DateTime.Utc | null;
  readonly closedAt: DateTime.Utc | null;
  readonly mergedBy: string | null;
  readonly changesCount: number | null;
  readonly title: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly webUrl: string;
  readonly state: "open" | "closed" | "merged";
}

export interface NormalizedGitLabMergeRequestDetail extends NormalizedGitLabMergeRequestRecord {
  readonly body: string;
  readonly comments: ReadonlyArray<{
    readonly author: string;
    readonly body: string;
    readonly createdAt: string;
  }>;
  readonly facts?: GitLabMergeRequestFacts;
}

const GitLabDiffRefsSchema = Schema.Struct({
  base_sha: Schema.optional(Schema.NullOr(Schema.String)),
  head_sha: Schema.optional(Schema.NullOr(Schema.String)),
  start_sha: Schema.optional(Schema.NullOr(Schema.String)),
});

export const GitLabMergeRequestDetailSchema = Schema.Struct({
  ...GitLabMergeRequestSchema.fields,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  notes: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          author: Schema.optional(
            Schema.NullOr(
              Schema.Struct({
                username: Schema.optional(Schema.String),
                name: Schema.optional(Schema.String),
              }),
            ),
          ),
          body: Schema.String,
          created_at: Schema.String,
        }),
      ),
    ),
  ),
  diff_refs: Schema.optional(Schema.NullOr(GitLabDiffRefsSchema)),
  head_pipeline: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.Number,
        iid: Schema.optional(Schema.NullOr(Schema.Number)),
        name: Schema.optional(Schema.NullOr(Schema.String)),
        sha: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  user: Schema.optional(
    Schema.NullOr(Schema.Struct({ can_merge: Schema.optional(Schema.NullOr(Schema.Boolean)) })),
  ),
  merge_when_pipeline_succeeds: Schema.optional(Schema.NullOr(Schema.Boolean)),
  merge_user: Schema.optional(Schema.NullOr(GitLabUserRefSchema)),
  merged_by: Schema.optional(Schema.NullOr(GitLabUserRefSchema)),
  changes_count: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
  force_remove_source_branch: Schema.optional(Schema.NullOr(Schema.Boolean)),
  discussion_locked: Schema.optional(Schema.NullOr(Schema.Boolean)),
  merge_commit_sha: Schema.optional(Schema.NullOr(Schema.String)),
  squash_commit_sha: Schema.optional(Schema.NullOr(Schema.String)),
  squash: Schema.optional(Schema.NullOr(Schema.Boolean)),
});
type RawGitLabMergeRequestDetail = typeof GitLabMergeRequestDetailSchema.Type;

function diffRefsOf(raw: RawGitLabMergeRequestDetail): GitLabDiffRefs | null {
  const base = trimOptionalString(raw.diff_refs?.base_sha);
  const start = trimOptionalString(raw.diff_refs?.start_sha);
  const head = trimOptionalString(raw.diff_refs?.head_sha);
  return base && start && head ? { base_sha: base, start_sha: start, head_sha: head } : null;
}

function changesCountOf(value: string | number | null | undefined): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  // "1000+" when GitLab capped the count: a lower bound is still a count.
  const match = /^(\d+)\+?$/u.exec(value?.trim() ?? "");
  return match?.[1] ? Number(match[1]) : null;
}

export function gitLabMergeRequestFacts(raw: RawGitLabMergeRequestDetail): GitLabMergeRequestFacts {
  const record = normalizeGitLabMergeRequestRecord(raw);
  const diffRefs = diffRefsOf(raw);
  return {
    iid: raw.iid,
    authorId: typeof raw.author?.id === "number" ? raw.author.id : null,
    authorUsername: trimOptionalString(raw.author?.username),
    headSha: diffRefs?.head_sha ?? trimOptionalString(raw.sha),
    diffRefs,
    canMerge: typeof raw.user?.can_merge === "boolean" ? raw.user.can_merge : null,
    discussionLocked: raw.discussion_locked === true,
    isDraft: record.isDraft === true,
    autoMergeEnabled: raw.merge_when_pipeline_succeeds === true && record.state === "open",
    autoMergeBy: trimOptionalString(raw.merge_user?.username),
    squash: raw.squash === true,
    forceRemoveSourceBranch:
      typeof raw.force_remove_source_branch === "boolean" ? raw.force_remove_source_branch : null,
    isCrossRepository: record.isCrossRepository === true,
    headPipeline: raw.head_pipeline
      ? {
          id: raw.head_pipeline.id,
          iid: typeof raw.head_pipeline.iid === "number" ? raw.head_pipeline.iid : null,
          name: trimOptionalString(raw.head_pipeline.name),
          sha: trimOptionalString(raw.head_pipeline.sha),
        }
      : null,
    reviewers: raw.reviewers ?? [],
    assignees: raw.assignees ?? [],
    detailedMergeStatus: trimOptionalString(raw.detailed_merge_status),
    mergeCommitSha:
      trimOptionalString(raw.squash_commit_sha) ?? trimOptionalString(raw.merge_commit_sha),
    mergedAt: parseGitLabTimestamp(raw.merged_at),
    closedAt: parseGitLabTimestamp(raw.closed_at),
    mergedBy:
      trimOptionalString(raw.merged_by?.username) ?? trimOptionalString(raw.merge_user?.username),
    changesCount: changesCountOf(raw.changes_count),
    title: raw.title,
    sourceBranch: raw.source_branch,
    targetBranch: raw.target_branch,
    webUrl: raw.web_url,
    state: record.state,
  };
}

const decodeGitLabMergeRequestDetail = decodeJsonResult(GitLabMergeRequestDetailSchema);

export function decodeGitLabMergeRequestDetailJson(
  raw: string,
): Result.Result<NormalizedGitLabMergeRequestDetail, Cause.Cause<Schema.SchemaError>> {
  const result = decodeGitLabMergeRequestDetail(raw);
  if (!Result.isSuccess(result)) return Result.fail(result.failure);
  const summary = normalizeGitLabMergeRequestRecord(result.success);
  const detail: NormalizedGitLabMergeRequestDetail = {
    ...summary,
    body: result.success.description ?? "",
    comments: (result.success.notes ?? []).map((note) => ({
      author: authorName(note.author) ?? "unknown",
      body: note.body,
      createdAt: note.created_at,
    })),
    facts: gitLabMergeRequestFacts(result.success),
  };
  return Result.succeed(detail);
}

// ── Reviews and approvals ─────────────────────────────────────────────

export const GitLabReviewerSchema = Schema.Struct({
  user: GitLabUserRefSchema,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.optional(Schema.NullOr(Schema.String)),
});
export type GitLabReviewer = typeof GitLabReviewerSchema.Type;

export const GitLabApprovalStateSchema = Schema.Struct({
  approved: Schema.optional(Schema.NullOr(Schema.Boolean)),
  approvals_required: Schema.optional(Schema.NullOr(Schema.Number)),
  approvals_left: Schema.optional(Schema.NullOr(Schema.Number)),
  user_has_approved: Schema.optional(Schema.NullOr(Schema.Boolean)),
  user_can_approve: Schema.optional(Schema.NullOr(Schema.Boolean)),
  approved_by: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          user: GitLabUserRefSchema,
          approved_at: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  ),
});
export type GitLabApprovalState = typeof GitLabApprovalStateSchema.Type;

/** Reviewer `state` (GitLab 17+): `unreviewed`, `review_started`, `reviewed`, `requested_changes`, `approved`, `unapproved`. */
function reviewerState(state: string | null | undefined): SourceControlChangeRequestReviewerState {
  switch (state?.trim().toLowerCase()) {
    case "approved":
      return "approved";
    case "requested_changes":
      return "changes_requested";
    case "reviewed":
      return "commented";
    case "unapproved":
      return "dismissed";
    default:
      return "requested";
  }
}

/**
 * Per-reviewer standing: requested reviewers with their review state, plus
 * approvers who were never asked (an approval is a review on GitLab).
 */
export function gitLabReviewerStates(input: {
  readonly reviewers: ReadonlyArray<GitLabReviewer>;
  readonly approvals: GitLabApprovalState | null;
}): SourceControlChangeRequestReviewer[] {
  const byLogin = new Map<string, SourceControlChangeRequestReviewer>();
  for (const reviewer of input.reviewers) {
    const login = trimOptionalString(reviewer.user.username);
    if (!login) continue;
    const avatarUrl = trimOptionalString(reviewer.user.avatar_url);
    byLogin.set(login, {
      login,
      kind: reviewer.user.bot === true ? "bot" : "user",
      state: reviewerState(reviewer.state),
      ...(avatarUrl ? { avatarUrl } : {}),
    });
  }
  for (const approval of input.approvals?.approved_by ?? []) {
    const login = trimOptionalString(approval.user.username);
    if (!login) continue;
    const existing = byLogin.get(login);
    const submittedAt = parseGitLabTimestamp(approval.approved_at);
    const avatarUrl = trimOptionalString(approval.user.avatar_url);
    if (existing?.state === "changes_requested") continue;
    byLogin.set(login, {
      ...(existing ?? { login, kind: approval.user.bot === true ? "bot" : "user" }),
      state: "approved",
      ...(avatarUrl && !existing?.avatarUrl ? { avatarUrl } : {}),
      ...(submittedAt ? { submittedAt } : {}),
    });
  }
  return [...byLogin.values()];
}

/**
 * The aggregate verdict: any requested change wins; otherwise unmet approval
 * rules mean a review is required; otherwise an approval approves. With no
 * rule and no approval there is no verdict (as GitHub reports none).
 */
export function gitLabReviewDecision(input: {
  readonly reviewerStates: ReadonlyArray<SourceControlChangeRequestReviewer>;
  readonly approvals: GitLabApprovalState | null;
}): SourceControlChangeRequestReviewDecision | null {
  if (input.reviewerStates.some((reviewer) => reviewer.state === "changes_requested")) {
    return "changes_requested";
  }
  const approvals = input.approvals;
  if (!approvals) return null;
  if (typeof approvals.approvals_left === "number" && approvals.approvals_left > 0) {
    return "review_required";
  }
  return (approvals.approved_by ?? []).length > 0 ? "approved" : null;
}

// ── Project merge settings ────────────────────────────────────────────

export const GitLabProjectSchema = Schema.Struct({
  id: Schema.Number,
  path_with_namespace: Schema.optional(Schema.NullOr(Schema.String)),
  merge_method: Schema.optional(Schema.NullOr(Schema.String)),
  squash_option: Schema.optional(Schema.NullOr(Schema.String)),
  remove_source_branch_after_merge: Schema.optional(Schema.NullOr(Schema.Boolean)),
  permissions: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        project_access: Schema.optional(
          Schema.NullOr(Schema.Struct({ access_level: Schema.Number })),
        ),
        group_access: Schema.optional(
          Schema.NullOr(Schema.Struct({ access_level: Schema.Number })),
        ),
      }),
    ),
  ),
});
export type GitLabProject = typeof GitLabProjectSchema.Type;

/** Highest of project and group access (10 Guest … 30 Developer, 40 Maintainer, 50 Owner). */
export function gitLabAccessLevel(project: GitLabProject | null): number {
  return Math.max(
    project?.permissions?.project_access?.access_level ?? 0,
    project?.permissions?.group_access?.access_level ?? 0,
  );
}

export const GITLAB_DEVELOPER_ACCESS = 30;

/**
 * The project's merge method as a contract method. `merge` and
 * `rebase_merge` both create a merge commit (semi-linear history for the
 * latter); only `ff` lands commits without one, which is a rebase merge.
 */
export function gitLabProjectMergeMethod(
  project: GitLabProject | null,
): Exclude<SourceControlChangeRequestMergeMethod, "squash"> {
  return project?.merge_method?.trim().toLowerCase() === "ff" ? "rebase" : "merge";
}

/**
 * Methods `PUT .../merge` can honour: the project method (merge commit or
 * fast-forward, chosen per project, not per merge request) and squash unless
 * the project forbids it; `always` forces squash for every merge.
 */
export function gitLabMergeCapabilities(
  project: GitLabProject | null,
): SourceControlChangeRequestMergeCapabilities {
  const method = gitLabProjectMergeMethod(project);
  const squashOption = project?.squash_option?.trim().toLowerCase() ?? "default_off";
  const projectMethodAllowed = squashOption !== "always";
  return {
    merge: projectMethodAllowed && method === "merge",
    rebase: projectMethodAllowed && method === "rebase",
    squash: squashOption !== "never",
  };
}

export function gitLabAutoMerge(input: {
  readonly facts: GitLabMergeRequestFacts;
  readonly project: GitLabProject | null;
}): SourceControlChangeRequestAutoMerge | null {
  if (!input.facts.autoMergeEnabled) return null;
  return {
    mergeMethod: input.facts.squash ? "squash" : gitLabProjectMergeMethod(input.project),
    ...(input.facts.autoMergeBy ? { enabledBy: input.facts.autoMergeBy } : {}),
  };
}

// ── Draft titles ──────────────────────────────────────────────────────

/**
 * GitLab marks drafts by title prefix (`Draft:`, `[Draft]`, `(Draft)`, legacy
 * `WIP:`); the update API has no draft field.
 * Docs: https://docs.gitlab.com/user/project/merge_requests/drafts/
 */
const DRAFT_PREFIX = /^\s*(?:\[draft\]|\(draft\)|draft:|draft\s+-|\[wip\]|wip:)\s*/iu;

export function stripGitLabDraftPrefix(title: string): string {
  let current = title;
  for (let match = DRAFT_PREFIX.exec(current); match; match = DRAFT_PREFIX.exec(current)) {
    current = current.slice(match[0].length);
  }
  return current.trim();
}

export function gitLabDraftTitle(title: string, draft: boolean): string {
  const bare = stripGitLabDraftPrefix(title);
  return draft ? `Draft: ${bare}` : bare;
}
