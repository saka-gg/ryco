import { Cause, DateTime, Exit, Option, Result, Schema } from "effect";
import {
  PositiveInt,
  TrimmedNonEmptyString,
  type SourceControlChangeRequestCommit,
  type SourceControlChangeRequestFile,
  type SourceControlChangeRequestMergeCapabilities,
  type SourceControlChangeRequestMergeStateStatus,
  type SourceControlChangeRequestReviewDecision,
  type SourceControlChangeRequestReviewer,
  type SourceControlCheckRollupItem,
  type SourceControlLabel,
} from "@ryco/contracts";
import { decodeJsonResult, formatSchemaError } from "@ryco/shared/schemaJson";

import {
  ForgejoCommentListSchema,
  ForgejoUserSchema,
  forgejoAuthorName,
  normalizeForgejoComment,
  type NormalizedForgejoComment,
} from "./forgejoIssues.ts";

export interface NormalizedForgejoRepository {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
  readonly defaultBranch: string | null;
}

/**
 * Merge readiness facts read for one pull request (reviews, commit statuses,
 * base branch protection, repository merge settings). See
 * `forgejoPullRequestReadiness.ts`.
 */
export interface ForgejoPullRequestReadinessFacts {
  readonly mergeability?: "mergeable" | "conflicting" | "unknown";
  readonly mergeStateStatus?: SourceControlChangeRequestMergeStateStatus;
  readonly reviewDecision?: SourceControlChangeRequestReviewDecision | null;
  readonly reviewerStates?: ReadonlyArray<SourceControlChangeRequestReviewer>;
  readonly checkRollup?: ReadonlyArray<SourceControlCheckRollupItem>;
  readonly mergeCapabilities?: SourceControlChangeRequestMergeCapabilities;
}

export interface NormalizedForgejoPullRequestRecord {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly headLabel: string | null;
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt: Option.Option<DateTime.Utc>;
  readonly isCrossRepository?: boolean;
  readonly isDraft?: boolean;
  readonly author: string | null;
  readonly commentsCount: number | null;
  readonly headRepositoryNameWithOwner: string | null;
  readonly headRepositoryOwnerLogin: string | null;
  readonly headRepositoryCloneUrl: string | null;
  readonly headRepositorySshUrl: string | null;
  readonly headSha?: string;
  readonly baseSha?: string;
  readonly mergeBase?: string;
  /** Forgejo's `mergeable`: false while checking, on conflicts, on errors, and for drafts. */
  readonly mergeable?: boolean;
  readonly isLocked?: boolean;
  readonly allowMaintainerEdit?: boolean;
  readonly labels?: ReadonlyArray<SourceControlLabel>;
  readonly assignees?: ReadonlyArray<string>;
  readonly requestedReviewers?: ReadonlyArray<string>;
  readonly requestedTeams?: ReadonlyArray<string>;
  readonly createdAt?: DateTime.Utc;
  readonly closedAt?: DateTime.Utc;
  readonly mergedAt?: DateTime.Utc;
  readonly mergedBy?: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly changedFiles?: number;
  /** Present when the readiness facts were read (page lists and details). */
  readonly readiness?: ForgejoPullRequestReadinessFacts;
}

export interface NormalizedForgejoPullRequestDetail extends NormalizedForgejoPullRequestRecord {
  readonly body: string;
  readonly comments: ReadonlyArray<NormalizedForgejoComment>;
  readonly commits: ReadonlyArray<SourceControlChangeRequestCommit>;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly files: ReadonlyArray<SourceControlChangeRequestFile>;
}

const OptionalBoolean = Schema.optional(Schema.NullOr(Schema.Boolean));
const OptionalString = Schema.optional(Schema.NullOr(Schema.String));
const OptionalNumber = Schema.optional(Schema.NullOr(Schema.Number));

/** `permissions` on a repository read with a token (`Permission`). */
export const ForgejoRepositoryPermissionsSchema = Schema.Struct({
  admin: OptionalBoolean,
  push: OptionalBoolean,
  pull: OptionalBoolean,
});

/**
 * `Repository` (https://codeberg.org/api/swagger#/repository/repoGet). The
 * merge settings are only meaningful on the base repository.
 */
export const ForgejoRepositorySchema = Schema.Struct({
  full_name: TrimmedNonEmptyString,
  html_url: Schema.optional(Schema.String),
  clone_url: Schema.optional(Schema.String),
  ssh_url: Schema.optional(Schema.String),
  default_branch: Schema.optional(Schema.NullOr(Schema.String)),
  owner: Schema.optional(Schema.NullOr(ForgejoUserSchema)),
  permissions: Schema.optional(Schema.NullOr(ForgejoRepositoryPermissionsSchema)),
  allow_merge_commits: OptionalBoolean,
  allow_rebase: OptionalBoolean,
  allow_rebase_explicit: OptionalBoolean,
  allow_squash_merge: OptionalBoolean,
  allow_fast_forward_only_merge: OptionalBoolean,
  allow_rebase_update: OptionalBoolean,
  default_delete_branch_after_merge: OptionalBoolean,
  default_merge_style: OptionalString,
});
export type ForgejoRepository = typeof ForgejoRepositorySchema.Type;

const ForgejoPullRequestBranchSchema = Schema.Struct({
  ref: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  sha: OptionalString,
  repo: Schema.optional(Schema.NullOr(ForgejoRepositorySchema)),
  repo_id: Schema.optional(Schema.NullOr(Schema.Number)),
});

const ForgejoPullRequestLabelSchema = Schema.Struct({
  id: OptionalNumber,
  name: OptionalString,
  color: OptionalString,
  description: OptionalString,
});

const ForgejoTeamRefSchema = Schema.Struct({ id: OptionalNumber, name: OptionalString });

export const ForgejoPullRequestSchema = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: Schema.optional(Schema.String),
  html_url: Schema.optional(Schema.String),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  merged: Schema.optional(Schema.Boolean),
  draft: Schema.optional(Schema.Boolean),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  comments: Schema.optional(Schema.NullOr(Schema.Number)),
  user: Schema.optional(Schema.NullOr(ForgejoUserSchema)),
  updated_at: Schema.optional(Schema.OptionFromNullOr(Schema.DateTimeUtcFromString)),
  head: ForgejoPullRequestBranchSchema,
  base: ForgejoPullRequestBranchSchema,
  mergeable: OptionalBoolean,
  merge_base: OptionalString,
  is_locked: OptionalBoolean,
  allow_maintainer_edit: OptionalBoolean,
  labels: Schema.optional(Schema.NullOr(Schema.Array(ForgejoPullRequestLabelSchema))),
  assignees: Schema.optional(Schema.NullOr(Schema.Array(ForgejoUserSchema))),
  requested_reviewers: Schema.optional(Schema.NullOr(Schema.Array(ForgejoUserSchema))),
  requested_reviewers_teams: Schema.optional(Schema.NullOr(Schema.Array(ForgejoTeamRefSchema))),
  created_at: OptionalString,
  closed_at: OptionalString,
  merged_at: OptionalString,
  merged_by: Schema.optional(Schema.NullOr(ForgejoUserSchema)),
  additions: OptionalNumber,
  deletions: OptionalNumber,
  changed_files: OptionalNumber,
});
export type ForgejoPullRequest = typeof ForgejoPullRequestSchema.Type;

const ForgejoCommitUserSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  date: Schema.optional(Schema.String),
});

/** `Commit` (https://codeberg.org/api/swagger#/repository/repoGetPullRequestCommits). */
export const ForgejoCommitSchema = Schema.Struct({
  sha: Schema.optional(Schema.String),
  html_url: Schema.optional(Schema.String),
  created: OptionalString,
  commit: Schema.optional(
    Schema.Struct({
      message: Schema.optional(Schema.String),
      author: Schema.optional(Schema.NullOr(ForgejoCommitUserSchema)),
      committer: Schema.optional(Schema.NullOr(ForgejoCommitUserSchema)),
    }),
  ),
  author: Schema.optional(Schema.NullOr(ForgejoUserSchema)),
});
export type ForgejoCommit = typeof ForgejoCommitSchema.Type;

const ForgejoChangedFileSchema = Schema.Struct({
  filename: TrimmedNonEmptyString,
  additions: Schema.optional(Schema.Number),
  deletions: Schema.optional(Schema.Number),
});

export const ForgejoPullRequestListSchema = Schema.Array(ForgejoPullRequestSchema);
export const ForgejoCommitListSchema = Schema.Array(ForgejoCommitSchema);
export const ForgejoChangedFileListSchema = Schema.Array(ForgejoChangedFileSchema);

export const formatForgejoPullRequestDecodeError = formatSchemaError;

function trimOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeState(input: {
  readonly state?: string | null | undefined;
  readonly merged?: boolean | undefined;
}): "open" | "closed" | "merged" {
  if (input.merged === true) {
    return "merged";
  }
  return input.state?.trim().toLowerCase() === "closed" ? "closed" : "open";
}

function ownerLoginFromNameWithOwner(nameWithOwner: string | null): string | null {
  return trimOptionalString(nameWithOwner?.split("/")[0]);
}

function normalizeRepository(
  raw: Schema.Schema.Type<typeof ForgejoRepositorySchema>,
): NormalizedForgejoRepository {
  return {
    nameWithOwner: raw.full_name,
    url: raw.clone_url ?? raw.html_url ?? raw.full_name,
    sshUrl: raw.ssh_url ?? raw.clone_url ?? raw.html_url ?? raw.full_name,
    defaultBranch: trimOptionalString(raw.default_branch),
  };
}

export function normalizeForgejoRepositoryCloneUrls(
  raw: Schema.Schema.Type<typeof ForgejoRepositorySchema>,
): {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
} {
  const repository = normalizeRepository(raw);
  return {
    nameWithOwner: repository.nameWithOwner,
    url: repository.url,
    sshUrl: repository.sshUrl,
  };
}

function parseUtc(value: string | null | undefined): DateTime.Utc | undefined {
  const text = trimOptionalString(value);
  if (!text) return undefined;
  const date = new Date(text);
  // Forgejo reports unset times as the zero time (0001-01-01T00:00:00Z).
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() > 1970
    ? DateTime.fromDateUnsafe(date)
    : undefined;
}

function nonNegativeInt(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function logins(
  users: ReadonlyArray<Schema.Schema.Type<typeof ForgejoUserSchema>> | null | undefined,
): ReadonlyArray<string> {
  return (users ?? [])
    .map((user) => forgejoAuthorName(user))
    .filter((login): login is string => login !== null);
}

function normalizeLabels(
  labels:
    | ReadonlyArray<Schema.Schema.Type<typeof ForgejoPullRequestLabelSchema>>
    | null
    | undefined,
): ReadonlyArray<SourceControlLabel> {
  return (labels ?? []).flatMap((label) => {
    const name = trimOptionalString(label.name);
    if (!name) return [];
    const color = trimOptionalString(label.color)?.replace(/^#/u, "");
    const description = trimOptionalString(label.description);
    return [{ name, ...(color ? { color } : {}), ...(description ? { description } : {}) }];
  });
}

export function normalizeForgejoPullRequestRecord(
  raw: Schema.Schema.Type<typeof ForgejoPullRequestSchema>,
): NormalizedForgejoPullRequestRecord {
  const headRepository = raw.head.repo ? normalizeRepository(raw.head.repo) : null;
  const baseRepository = raw.base.repo ? normalizeRepository(raw.base.repo) : null;
  const headRepositoryNameWithOwner = headRepository?.nameWithOwner ?? null;
  const baseRepositoryNameWithOwner = baseRepository?.nameWithOwner ?? null;
  const isCrossRepository =
    headRepositoryNameWithOwner && baseRepositoryNameWithOwner
      ? headRepositoryNameWithOwner.toLowerCase() !== baseRepositoryNameWithOwner.toLowerCase()
      : typeof raw.head.repo_id === "number" && typeof raw.base.repo_id === "number"
        ? raw.head.repo_id !== raw.base.repo_id
        : undefined;

  return {
    number: raw.number,
    title: raw.title,
    url: raw.html_url ?? raw.url ?? `#${raw.number}`,
    baseRefName: trimOptionalString(raw.base.ref) ?? "main",
    headRefName: trimOptionalString(raw.head.ref) ?? trimOptionalString(raw.head.label) ?? "HEAD",
    headLabel: trimOptionalString(raw.head.label),
    state: normalizeState({ state: raw.state, merged: raw.merged }),
    updatedAt: raw.updated_at ?? Option.none(),
    ...(typeof isCrossRepository === "boolean" ? { isCrossRepository } : {}),
    ...(raw.draft !== undefined ? { isDraft: raw.draft } : {}),
    author: forgejoAuthorName(raw.user),
    commentsCount: raw.comments ?? null,
    headRepositoryNameWithOwner,
    headRepositoryOwnerLogin: ownerLoginFromNameWithOwner(headRepositoryNameWithOwner),
    headRepositoryCloneUrl: headRepository?.url ?? null,
    headRepositorySshUrl: headRepository?.sshUrl ?? null,
    ...optionalRecordFields(raw),
  };
}

function optionalRecordFields(
  raw: Schema.Schema.Type<typeof ForgejoPullRequestSchema>,
): Partial<NormalizedForgejoPullRequestRecord> {
  const headSha = trimOptionalString(raw.head.sha);
  const baseSha = trimOptionalString(raw.base.sha);
  const mergeBase = trimOptionalString(raw.merge_base);
  const labels = normalizeLabels(raw.labels);
  const assignees = logins(raw.assignees);
  const requestedReviewers = logins(raw.requested_reviewers);
  const requestedTeams = (raw.requested_reviewers_teams ?? []).flatMap((team) => {
    const name = trimOptionalString(team.name);
    return name ? [name] : [];
  });
  const createdAt = parseUtc(raw.created_at);
  const closedAt = parseUtc(raw.closed_at);
  const mergedAt = raw.merged === true ? parseUtc(raw.merged_at) : undefined;
  const mergedBy = raw.merged === true ? forgejoAuthorName(raw.merged_by) : null;
  const additions = nonNegativeInt(raw.additions);
  const deletions = nonNegativeInt(raw.deletions);
  const changedFiles = nonNegativeInt(raw.changed_files);
  return {
    ...(headSha ? { headSha } : {}),
    ...(baseSha ? { baseSha } : {}),
    ...(mergeBase ? { mergeBase } : {}),
    ...(typeof raw.mergeable === "boolean" ? { mergeable: raw.mergeable } : {}),
    ...(typeof raw.is_locked === "boolean" ? { isLocked: raw.is_locked } : {}),
    ...(typeof raw.allow_maintainer_edit === "boolean"
      ? { allowMaintainerEdit: raw.allow_maintainer_edit }
      : {}),
    ...(raw.labels ? { labels } : {}),
    ...(raw.assignees ? { assignees } : {}),
    ...(raw.requested_reviewers ? { requestedReviewers } : {}),
    ...(raw.requested_reviewers_teams ? { requestedTeams } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(closedAt ? { closedAt } : {}),
    ...(mergedAt ? { mergedAt } : {}),
    ...(mergedBy ? { mergedBy } : {}),
    ...(additions !== undefined ? { additions } : {}),
    ...(deletions !== undefined ? { deletions } : {}),
    ...(changedFiles !== undefined ? { changedFiles } : {}),
  };
}

function normalizeCommit(
  raw: Schema.Schema.Type<typeof ForgejoCommitSchema>,
): SourceControlChangeRequestCommit | null {
  const oid = trimOptionalString(raw.sha);
  if (!oid) return null;
  const headline = trimOptionalString(raw.commit?.message?.split(/\r?\n/)[0]) ?? "";
  return {
    oid,
    shortOid: oid.slice(0, 12),
    messageHeadline: headline,
    ...(raw.commit?.author?.date ? { committedDate: raw.commit.author.date } : {}),
    ...((forgejoAuthorName(raw.author) ?? raw.commit?.author?.name)
      ? { author: forgejoAuthorName(raw.author) ?? raw.commit?.author?.name }
      : {}),
  };
}

function normalizeChangedFile(
  raw: Schema.Schema.Type<typeof ForgejoChangedFileSchema>,
): SourceControlChangeRequestFile {
  return {
    path: raw.filename,
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
  };
}

export function normalizeForgejoPullRequestDetail(input: {
  readonly pullRequest: Schema.Schema.Type<typeof ForgejoPullRequestSchema>;
  readonly comments: ReadonlyArray<Schema.Schema.Type<typeof ForgejoCommentListSchema>[number]>;
  readonly commits: ReadonlyArray<Schema.Schema.Type<typeof ForgejoCommitListSchema>[number]>;
  readonly files: ReadonlyArray<Schema.Schema.Type<typeof ForgejoChangedFileListSchema>[number]>;
}): NormalizedForgejoPullRequestDetail {
  const files = input.files.map(normalizeChangedFile);
  const record = normalizeForgejoPullRequestRecord(input.pullRequest);
  return {
    ...record,
    body: input.pullRequest.body ?? "",
    comments: input.comments.map(normalizeForgejoComment),
    commits: input.commits
      .map(normalizeCommit)
      .filter((commit): commit is SourceControlChangeRequestCommit => commit !== null),
    // The pull request's own totals cover every file; the file list is paged.
    additions: record.additions ?? files.reduce((total, file) => total + file.additions, 0),
    deletions: record.deletions ?? files.reduce((total, file) => total + file.deletions, 0),
    changedFiles: record.changedFiles ?? files.length,
    files,
  };
}

const decodePullRequestList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodePullRequestDetail = decodeJsonResult(ForgejoPullRequestSchema);
const decodePullRequestEntry = Schema.decodeUnknownExit(ForgejoPullRequestSchema);

export function decodeForgejoPullRequestListJson(
  raw: string,
): Result.Result<
  ReadonlyArray<NormalizedForgejoPullRequestRecord>,
  Cause.Cause<Schema.SchemaError>
> {
  const result = decodePullRequestList(raw);
  if (!Result.isSuccess(result)) return Result.fail(result.failure);

  const pullRequests: NormalizedForgejoPullRequestRecord[] = [];
  for (const entry of result.success) {
    const decoded = decodePullRequestEntry(entry);
    if (Exit.isFailure(decoded)) continue;
    pullRequests.push(normalizeForgejoPullRequestRecord(decoded.value));
  }

  return Result.succeed(pullRequests);
}

export function decodeForgejoPullRequestDetailJson(
  raw: string,
): Result.Result<NormalizedForgejoPullRequestDetail, Cause.Cause<Schema.SchemaError>> {
  const result = decodePullRequestDetail(raw);
  if (!Result.isSuccess(result)) return Result.fail(result.failure);
  return Result.succeed(
    normalizeForgejoPullRequestDetail({
      pullRequest: result.success,
      comments: [],
      commits: [],
      files: [],
    }),
  );
}
