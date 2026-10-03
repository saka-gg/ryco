import { Cause, DateTime, Exit, Option, Result, Schema } from "effect";
import {
  PositiveInt,
  SourceControlChangeRequestReviewer,
  TrimmedNonEmptyString,
  type SourceControlChangeRequestAutoMerge,
  type SourceControlChangeRequestMergeability,
  type SourceControlChangeRequestMergeStateStatus,
  type SourceControlChangeRequestReviewDecision,
} from "@ryco/contracts";
import { decodeJsonResult, formatSchemaError } from "@ryco/shared/schemaJson";
import {
  normalizeReactionGroups,
  RawGitHubReactionGroupSchema,
  type NormalizedGitHubReaction,
} from "./gitHubReactions.ts";

export interface NormalizedGitHubLabel {
  readonly name: string;
  readonly color?: string;
  readonly description?: string;
}

export interface NormalizedGitHubCheckRollupItem {
  readonly kind: "check-run" | "status-context" | "unknown";
  readonly name: string;
  readonly workflowName?: string;
  readonly status: Option.Option<string>;
  readonly conclusion: Option.Option<string>;
  readonly url: Option.Option<string>;
  readonly startedAt: Option.Option<DateTime.Utc>;
  readonly completedAt: Option.Option<DateTime.Utc>;
  /** Set by the detail's required-checks lookup (`gitHubRequiredChecks.ts`), never by `gh pr`. */
  readonly isRequired?: boolean;
}

export interface NormalizedGitHubPullRequestRecord {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt: Option.Option<DateTime.Utc>;
  readonly isCrossRepository?: boolean;
  readonly isDraft?: boolean;
  readonly author: string | null;
  readonly assignees: ReadonlyArray<string>;
  readonly labels: ReadonlyArray<NormalizedGitHubLabel>;
  readonly commentsCount: number | null;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
  readonly headSha?: string;
  readonly mergeability?: SourceControlChangeRequestMergeability;
  readonly checkRollup?: ReadonlyArray<NormalizedGitHubCheckRollupItem>;
  readonly createdAt?: DateTime.Utc;
  readonly reviewDecision?: SourceControlChangeRequestReviewDecision | null;
  readonly additions?: number;
  readonly deletions?: number;
  readonly changedFiles?: number;
}

function normalizeLabels(
  raw:
    | ReadonlyArray<{
        name: string;
        color?: string | null | undefined;
        description?: string | null | undefined;
      }>
    | undefined,
): ReadonlyArray<NormalizedGitHubLabel> {
  if (!raw) return [];
  return raw.map((l) => {
    const color = l.color?.trim() ?? "";
    const description = l.description?.trim() ?? "";
    return {
      name: l.name,
      ...(color.length > 0 ? { color } : {}),
      ...(description.length > 0 ? { description } : {}),
    };
  });
}

const GitHubPullRequestSchema = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  baseRefName: TrimmedNonEmptyString,
  headRefName: TrimmedNonEmptyString,
  headRefOid: Schema.optional(Schema.NullOr(Schema.String)),
  mergeable: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  updatedAt: Schema.optional(Schema.OptionFromNullOr(Schema.DateTimeUtcFromString)),
  createdAt: Schema.optional(Schema.NullOr(Schema.String)),
  closedAt: Schema.optional(Schema.NullOr(Schema.String)),
  reviewDecision: Schema.optional(Schema.NullOr(Schema.String)),
  mergeStateStatus: Schema.optional(Schema.NullOr(Schema.String)),
  mergedBy: Schema.optional(
    Schema.NullOr(Schema.Struct({ login: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
  autoMergeRequest: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        mergeMethod: Schema.optional(Schema.NullOr(Schema.String)),
        enabledAt: Schema.optional(Schema.NullOr(Schema.String)),
        enabledBy: Schema.optional(
          Schema.NullOr(Schema.Struct({ login: Schema.optional(Schema.NullOr(Schema.String)) })),
        ),
      }),
    ),
  ),
  latestReviews: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          author: Schema.optional(
            Schema.NullOr(Schema.Struct({ login: Schema.optional(Schema.NullOr(Schema.String)) })),
          ),
          state: Schema.optional(Schema.NullOr(Schema.String)),
          submittedAt: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  ),
  isCrossRepository: Schema.optional(Schema.Boolean),
  isDraft: Schema.optional(Schema.Boolean),
  author: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
  assignees: Schema.optional(Schema.Array(Schema.Struct({ login: Schema.String }))),
  labels: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        color: Schema.optional(Schema.NullOr(Schema.String)),
        description: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  headRepository: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nameWithOwner: Schema.String,
      }),
    ),
  ),
  headRepositoryOwner: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        login: Schema.String,
      }),
    ),
  ),
  statusCheckRollup: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          __typename: Schema.optional(Schema.String),
          name: Schema.optional(Schema.NullOr(Schema.String)),
          workflowName: Schema.optional(Schema.NullOr(Schema.String)),
          context: Schema.optional(Schema.NullOr(Schema.String)),
          status: Schema.optional(Schema.NullOr(Schema.String)),
          conclusion: Schema.optional(Schema.NullOr(Schema.String)),
          state: Schema.optional(Schema.NullOr(Schema.String)),
          detailsUrl: Schema.optional(Schema.NullOr(Schema.String)),
          targetUrl: Schema.optional(Schema.NullOr(Schema.String)),
          startedAt: Schema.optional(Schema.NullOr(Schema.String)),
          completedAt: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  ),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  comments: Schema.optional(
    Schema.Union([
      Schema.Array(
        Schema.Struct({
          id: Schema.optional(Schema.NullOr(Schema.String)),
          author: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
          authorAssociation: Schema.optional(Schema.NullOr(Schema.String)),
          body: Schema.String,
          createdAt: Schema.String,
          reactionGroups: Schema.optional(Schema.Array(RawGitHubReactionGroupSchema)),
        }),
      ),
      Schema.Number,
    ]),
  ),
  reviewRequests: Schema.optional(
    Schema.Array(
      Schema.Struct({
        __typename: Schema.optional(Schema.NullOr(Schema.String)),
        login: Schema.optional(Schema.NullOr(Schema.String)),
        name: Schema.optional(Schema.NullOr(Schema.String)),
        slug: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  reviews: Schema.optional(
    Schema.Array(
      Schema.Struct({
        author: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
        authorAssociation: Schema.optional(Schema.NullOr(Schema.String)),
        state: Schema.optional(Schema.NullOr(Schema.String)),
        body: Schema.optional(Schema.NullOr(Schema.String)),
        id: Schema.optional(Schema.NullOr(Schema.String)),
        reactionGroups: Schema.optional(Schema.Array(RawGitHubReactionGroupSchema)),
        submittedAt: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  commits: Schema.optional(
    Schema.Array(
      Schema.Struct({
        oid: Schema.String,
        messageHeadline: Schema.optional(Schema.NullOr(Schema.String)),
        committedDate: Schema.optional(Schema.NullOr(Schema.String)),
        authors: Schema.optional(
          Schema.Array(
            Schema.Struct({
              login: Schema.optional(Schema.NullOr(Schema.String)),
              name: Schema.optional(Schema.NullOr(Schema.String)),
            }),
          ),
        ),
      }),
    ),
  ),
  additions: Schema.optional(Schema.NullOr(Schema.Number)),
  deletions: Schema.optional(Schema.NullOr(Schema.Number)),
  changedFiles: Schema.optional(Schema.NullOr(Schema.Number)),
  files: Schema.optional(
    Schema.Array(
      Schema.Struct({
        path: Schema.String,
        additions: Schema.optional(Schema.NullOr(Schema.Number)),
        deletions: Schema.optional(Schema.NullOr(Schema.Number)),
      }),
    ),
  ),
});

function trimOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function optionFromTrimmedString(value: string | null | undefined): Option.Option<string> {
  const trimmed = trimOptionalString(value);
  return trimmed ? Option.some(trimmed) : Option.none();
}

function optionFromIsoDateTime(value: string | null | undefined): Option.Option<DateTime.Utc> {
  const trimmed = trimOptionalString(value);
  if (!trimmed) return Option.none();
  const date = new Date(trimmed);
  if (!Number.isFinite(date.getTime())) return Option.none();
  return Option.some(DateTime.fromDateUnsafe(date));
}

function normalizeGitHubPullRequestState(input: {
  state?: string | null | undefined;
  mergedAt?: string | null | undefined;
}): "open" | "closed" | "merged" {
  const normalizedState = input.state?.trim().toUpperCase();
  if (
    (typeof input.mergedAt === "string" && input.mergedAt.trim().length > 0) ||
    normalizedState === "MERGED"
  ) {
    return "merged";
  }
  if (normalizedState === "CLOSED") {
    return "closed";
  }
  return "open";
}

function normalizeMergeability(
  value: string | null | undefined,
): SourceControlChangeRequestMergeability | null {
  switch (value?.trim().toUpperCase()) {
    case "MERGEABLE":
      return "mergeable";
    case "CONFLICTING":
      return "conflicting";
    case "UNKNOWN":
      return "unknown";
    default:
      return null;
  }
}

function normalizeCheckRollupKind(
  value: string | null | undefined,
): NormalizedGitHubCheckRollupItem["kind"] {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "checkrun") return "check-run";
  if (normalized === "statuscontext") return "status-context";
  return "unknown";
}

function normalizeCheckRollupItem(
  raw: NonNullable<Schema.Schema.Type<typeof GitHubPullRequestSchema>["statusCheckRollup"]>[number],
  index: number,
): NormalizedGitHubCheckRollupItem {
  const name =
    trimOptionalString(raw.name) ?? trimOptionalString(raw.context) ?? `Status check ${index + 1}`;
  const workflowName = trimOptionalString(raw.workflowName);
  const url = trimOptionalString(raw.detailsUrl) ?? trimOptionalString(raw.targetUrl);
  return {
    kind: normalizeCheckRollupKind(raw.__typename),
    name,
    ...(workflowName ? { workflowName } : {}),
    status: optionFromTrimmedString(raw.status ?? raw.state),
    conclusion: optionFromTrimmedString(raw.conclusion),
    url: optionFromTrimmedString(url),
    startedAt: optionFromIsoDateTime(raw.startedAt),
    completedAt: optionFromIsoDateTime(raw.completedAt),
  };
}

function normalizeReviewDecision(
  value: string | null | undefined,
): SourceControlChangeRequestReviewDecision | null {
  switch (value?.trim().toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "REVIEW_REQUIRED":
      return "review_required";
    default:
      return null;
  }
}

function nonNegativeInt(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeGitHubPullRequestRecord(
  raw: Schema.Schema.Type<typeof GitHubPullRequestSchema>,
): NormalizedGitHubPullRequestRecord {
  const headRepositoryNameWithOwner = trimOptionalString(raw.headRepository?.nameWithOwner);
  const headRepositoryOwnerLogin =
    trimOptionalString(raw.headRepositoryOwner?.login) ??
    (typeof headRepositoryNameWithOwner === "string" && headRepositoryNameWithOwner.includes("/")
      ? (headRepositoryNameWithOwner.split("/")[0] ?? null)
      : null);
  const commentsCount =
    typeof raw.comments === "number"
      ? raw.comments
      : Array.isArray(raw.comments)
        ? raw.comments.length
        : null;
  const headSha = trimOptionalString(raw.headRefOid);
  const mergeability = normalizeMergeability(raw.mergeable);
  const createdAt = Option.getOrNull(optionFromIsoDateTime(raw.createdAt));
  const additions = nonNegativeInt(raw.additions);
  const deletions = nonNegativeInt(raw.deletions);
  const changedFiles = nonNegativeInt(raw.changedFiles);

  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    state: normalizeGitHubPullRequestState(raw),
    updatedAt: raw.updatedAt ?? Option.none(),
    author: raw.author?.login ?? null,
    assignees: (raw.assignees ?? []).map((a) => a.login),
    labels: normalizeLabels(raw.labels),
    commentsCount,
    ...(typeof raw.isCrossRepository === "boolean"
      ? { isCrossRepository: raw.isCrossRepository }
      : {}),
    ...(typeof raw.isDraft === "boolean" ? { isDraft: raw.isDraft } : {}),
    ...(headRepositoryNameWithOwner ? { headRepositoryNameWithOwner } : {}),
    ...(headRepositoryOwnerLogin ? { headRepositoryOwnerLogin } : {}),
    ...(headSha ? { headSha } : {}),
    ...(mergeability ? { mergeability } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(raw.reviewDecision !== undefined
      ? { reviewDecision: normalizeReviewDecision(raw.reviewDecision) }
      : {}),
    ...(additions !== null ? { additions } : {}),
    ...(deletions !== null ? { deletions } : {}),
    ...(changedFiles !== null ? { changedFiles } : {}),
    ...(raw.statusCheckRollup
      ? {
          checkRollup: raw.statusCheckRollup.map((item, index) =>
            normalizeCheckRollupItem(item, index),
          ),
        }
      : {}),
  };
}

const decodeGitHubPullRequestList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeGitHubPullRequest = decodeJsonResult(GitHubPullRequestSchema);
const decodeGitHubPullRequestEntry = Schema.decodeUnknownExit(GitHubPullRequestSchema);

export const formatGitHubJsonDecodeError = formatSchemaError;

export function decodeGitHubPullRequestListJson(
  raw: string,
): Result.Result<
  ReadonlyArray<NormalizedGitHubPullRequestRecord>,
  Cause.Cause<Schema.SchemaError>
> {
  const result = decodeGitHubPullRequestList(raw);
  if (Result.isSuccess(result)) {
    const pullRequests: NormalizedGitHubPullRequestRecord[] = [];
    for (const entry of result.success) {
      const decodedEntry = decodeGitHubPullRequestEntry(entry);
      if (Exit.isFailure(decodedEntry)) {
        continue;
      }
      pullRequests.push(normalizeGitHubPullRequestRecord(decodedEntry.value));
    }
    return Result.succeed(pullRequests);
  }
  return Result.fail(result.failure);
}

export function decodeGitHubPullRequestJson(
  raw: string,
): Result.Result<NormalizedGitHubPullRequestRecord, Cause.Cause<Schema.SchemaError>> {
  const result = decodeGitHubPullRequest(raw);
  if (Result.isSuccess(result)) {
    return Result.succeed(normalizeGitHubPullRequestRecord(result.success));
  }
  return Result.fail(result.failure);
}

export interface NormalizedGitHubPullRequestCommit {
  readonly oid: string;
  readonly shortOid: string;
  readonly messageHeadline: string;
  readonly committedDate?: string;
  readonly author?: string;
}

export type NormalizedGitHubReviewState =
  | "approved"
  | "changes_requested"
  | "commented"
  | "dismissed"
  | "pending";

export interface NormalizedGitHubPullRequestFile {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

export interface NormalizedGitHubPullRequestDetail extends NormalizedGitHubPullRequestRecord {
  readonly body: string;
  readonly comments: ReadonlyArray<{
    readonly id?: string;
    readonly author: string;
    readonly body: string;
    readonly createdAt: string;
    readonly authorAssociation?: string;
    readonly reviewState?: NormalizedGitHubReviewState;
    readonly reactions?: ReadonlyArray<NormalizedGitHubReaction>;
  }>;
  readonly linkedIssueNumbers: ReadonlyArray<number>;
  readonly reviewers: ReadonlyArray<string>;
  readonly commits: ReadonlyArray<NormalizedGitHubPullRequestCommit>;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly files: ReadonlyArray<NormalizedGitHubPullRequestFile>;
  readonly reviewerStates: ReadonlyArray<SourceControlChangeRequestReviewer>;
  readonly mergeStateStatus?: SourceControlChangeRequestMergeStateStatus;
  readonly autoMerge?: SourceControlChangeRequestAutoMerge | null;
  readonly closedAt?: DateTime.Utc;
  readonly mergedAt?: DateTime.Utc;
  readonly mergedBy?: string;
}

function normalizePullRequestComment(raw: {
  readonly id?: string | null;
  readonly author?: { readonly login: string } | null;
  readonly authorAssociation?: string | null;
  readonly body: string;
  readonly createdAt: string;
  readonly reactionGroups?:
    | ReadonlyArray<Schema.Schema.Type<typeof RawGitHubReactionGroupSchema>>
    | undefined;
}): NormalizedGitHubPullRequestDetail["comments"][number] {
  const reactions = normalizeReactionGroups(raw.reactionGroups);
  const base = {
    ...(raw.id ? { id: raw.id } : {}),
    author: raw.author?.login ?? "unknown",
    body: raw.body,
    createdAt: raw.createdAt,
    ...(reactions.length > 0 ? { reactions } : {}),
  };
  if (raw.authorAssociation) {
    return { ...base, authorAssociation: raw.authorAssociation };
  }
  return base;
}

const LINKED_ISSUE_PATTERN = /\b(?:close[sd]?|fixe?[sd]?|resolve[sd]?)\s+#(\d+)/giu;

export function parseLinkedIssueNumbers(body: string): ReadonlyArray<number> {
  if (!body) return [];
  const seen = new Set<number>();
  const numbers: number[] = [];
  for (const match of body.matchAll(LINKED_ISSUE_PATTERN)) {
    const captured = match[1];
    if (!captured) continue;
    const parsed = Number.parseInt(captured, 10);
    if (Number.isNaN(parsed) || seen.has(parsed)) continue;
    seen.add(parsed);
    numbers.push(parsed);
  }
  return numbers;
}

function trimNonEmpty(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pickReviewerLabel(entry: {
  login?: string | null | undefined;
  name?: string | null | undefined;
}): string | null {
  return trimNonEmpty(entry.login) ?? trimNonEmpty(entry.name);
}

function pickCommitAuthor(
  authors: ReadonlyArray<{
    login?: string | null | undefined;
    name?: string | null | undefined;
  }>,
): string | null {
  for (const a of authors) {
    const label = trimNonEmpty(a.login) ?? trimNonEmpty(a.name);
    if (label !== null) return label;
  }
  return null;
}

function normalizeCommits(
  raw:
    | ReadonlyArray<{
        oid: string;
        messageHeadline?: string | null | undefined;
        committedDate?: string | null | undefined;
        authors?:
          | ReadonlyArray<{
              login?: string | null | undefined;
              name?: string | null | undefined;
            }>
          | undefined;
      }>
    | undefined,
): ReadonlyArray<NormalizedGitHubPullRequestCommit> {
  if (!raw) return [];
  return raw.map((c) => {
    const messageHeadline = trimNonEmpty(c.messageHeadline) ?? "";
    const committedDate = trimNonEmpty(c.committedDate);
    const author = pickCommitAuthor(c.authors ?? []);
    return {
      oid: c.oid,
      shortOid: c.oid.slice(0, 7),
      messageHeadline,
      ...(committedDate ? { committedDate } : {}),
      ...(author ? { author } : {}),
    };
  });
}

export function normalizeGitHubReviewState(
  state: string | null | undefined,
): NormalizedGitHubReviewState | null {
  switch (state?.trim().toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "COMMENTED":
      return "commented";
    case "DISMISSED":
      return "dismissed";
    case "PENDING":
      return "pending";
    default:
      return null;
  }
}

function reviewToComment(raw: {
  id?: string | null | undefined;
  author?: { login: string } | null | undefined;
  authorAssociation?: string | null | undefined;
  state?: string | null | undefined;
  body?: string | null | undefined;
  reactionGroups?:
    | ReadonlyArray<Schema.Schema.Type<typeof RawGitHubReactionGroupSchema>>
    | undefined;
  submittedAt?: string | null | undefined;
}): NormalizedGitHubPullRequestDetail["comments"][number] | null {
  const body = (raw.body ?? "").trim();
  if (body.length === 0) return null;
  const submittedAt = trimNonEmpty(raw.submittedAt);
  if (submittedAt === null) return null;
  const reviewState = normalizeGitHubReviewState(raw.state);
  const reactions = normalizeReactionGroups(raw.reactionGroups);
  return {
    ...(raw.id ? { id: raw.id } : {}),
    author: raw.author?.login ?? "unknown",
    body: raw.body ?? "",
    createdAt: submittedAt,
    ...(raw.authorAssociation ? { authorAssociation: raw.authorAssociation } : {}),
    ...(reviewState ? { reviewState } : {}),
    ...(reactions.length > 0 ? { reactions } : {}),
  };
}

function normalizeFiles(
  raw:
    | ReadonlyArray<{
        path: string;
        additions?: number | null | undefined;
        deletions?: number | null | undefined;
      }>
    | undefined,
): ReadonlyArray<NormalizedGitHubPullRequestFile> {
  if (!raw) return [];
  return raw.map((f) => ({
    path: f.path,
    additions: typeof f.additions === "number" ? f.additions : 0,
    deletions: typeof f.deletions === "number" ? f.deletions : 0,
  }));
}

const MERGE_STATE_STATUSES: ReadonlySet<string> =
  new Set<SourceControlChangeRequestMergeStateStatus>([
    "behind",
    "blocked",
    "clean",
    "dirty",
    "draft",
    "has_hooks",
    "unknown",
    "unstable",
  ]);

function normalizeMergeStateStatus(
  value: string | null | undefined,
): SourceControlChangeRequestMergeStateStatus | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return MERGE_STATE_STATUSES.has(normalized)
    ? (normalized as SourceControlChangeRequestMergeStateStatus)
    : null;
}

function normalizeMergeMethod(
  value: string | null | undefined,
): "merge" | "squash" | "rebase" | null {
  switch (value?.trim().toUpperCase()) {
    case "MERGE":
      return "merge";
    case "SQUASH":
      return "squash";
    case "REBASE":
      return "rebase";
    default:
      return null;
  }
}

type RawGitHubPullRequest = Schema.Schema.Type<typeof GitHubPullRequestSchema>;

function normalizeAutoMerge(
  raw: RawGitHubPullRequest["autoMergeRequest"],
): SourceControlChangeRequestAutoMerge | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const mergeMethod = normalizeMergeMethod(raw.mergeMethod);
  if (!mergeMethod) return null;
  const enabledBy = trimNonEmpty(raw.enabledBy?.login);
  const enabledAt = Option.getOrNull(optionFromIsoDateTime(raw.enabledAt));
  return {
    mergeMethod,
    ...(enabledBy ? { enabledBy } : {}),
    ...(enabledAt ? { enabledAt } : {}),
  };
}

const isReviewer = Schema.is(SourceControlChangeRequestReviewer);

function isBotLogin(login: string): boolean {
  return /\[bot\]$/iu.test(login);
}

/**
 * Per-reviewer standing: each reviewer's latest submitted review, overlaid with
 * outstanding review requests (a re-requested reviewer reads as `requested`
 * but keeps the time of their last review). Team requests use `org/slug`.
 */
export function buildGitHubReviewerStates(input: {
  readonly latestReviews: RawGitHubPullRequest["latestReviews"];
  readonly reviewRequests: RawGitHubPullRequest["reviewRequests"];
}): ReadonlyArray<SourceControlChangeRequestReviewer> {
  const reviewers = new Map<string, SourceControlChangeRequestReviewer>();
  for (const review of input.latestReviews ?? []) {
    const login = trimNonEmpty(review.author?.login);
    const state = normalizeGitHubReviewState(review.state);
    if (!login || !state || state === "pending") continue;
    const submittedAt = Option.getOrNull(optionFromIsoDateTime(review.submittedAt));
    reviewers.set(login.toLowerCase(), {
      login,
      kind: isBotLogin(login) ? "bot" : "user",
      state,
      ...(submittedAt ? { submittedAt } : {}),
    });
  }
  for (const request of input.reviewRequests ?? []) {
    const typename = request.__typename?.trim();
    const isTeam = typename === "Team";
    const login = isTeam
      ? (trimNonEmpty(request.slug) ?? trimNonEmpty(request.name))
      : trimNonEmpty(request.login);
    if (!login) continue;
    const key = login.toLowerCase();
    const previous = reviewers.get(key);
    reviewers.set(key, {
      login,
      kind: isTeam ? "team" : typename === "Bot" || isBotLogin(login) ? "bot" : "user",
      state: "requested",
      ...(previous?.submittedAt ? { submittedAt: previous.submittedAt } : {}),
    });
  }
  return [...reviewers.values()].filter(isReviewer);
}

export function decodeGitHubPullRequestDetailJson(
  raw: string,
): Result.Result<NormalizedGitHubPullRequestDetail, Cause.Cause<Schema.SchemaError>> {
  const result = decodeGitHubPullRequest(raw);
  if (!Result.isSuccess(result)) return Result.fail(result.failure);
  const summary = normalizeGitHubPullRequestRecord(result.success);
  const body = result.success.body ?? "";
  const rawComments = Array.isArray(result.success.comments) ? result.success.comments : [];
  const reviewers = (result.success.reviewRequests ?? [])
    .map((r) => pickReviewerLabel(r))
    .filter((label): label is string => label !== null);
  const generalComments = rawComments.map((c) => normalizePullRequestComment(c));
  const reviewComments = (result.success.reviews ?? [])
    .map((r) => reviewToComment(r))
    .filter((c): c is NonNullable<typeof c> => c !== null);
  const merged = [...generalComments, ...reviewComments].toSorted((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  const files = normalizeFiles(result.success.files);
  const mergeStateStatus = normalizeMergeStateStatus(result.success.mergeStateStatus);
  const autoMerge = normalizeAutoMerge(result.success.autoMergeRequest);
  const closedAt = Option.getOrNull(optionFromIsoDateTime(result.success.closedAt));
  const mergedAt = Option.getOrNull(optionFromIsoDateTime(result.success.mergedAt));
  const mergedBy = trimNonEmpty(result.success.mergedBy?.login);
  const detail: NormalizedGitHubPullRequestDetail = {
    ...summary,
    body,
    comments: merged,
    linkedIssueNumbers: parseLinkedIssueNumbers(body),
    reviewers,
    commits: normalizeCommits(result.success.commits),
    additions: typeof result.success.additions === "number" ? result.success.additions : 0,
    deletions: typeof result.success.deletions === "number" ? result.success.deletions : 0,
    changedFiles:
      typeof result.success.changedFiles === "number" ? result.success.changedFiles : files.length,
    files,
    reviewerStates: buildGitHubReviewerStates({
      latestReviews: result.success.latestReviews,
      reviewRequests: result.success.reviewRequests,
    }),
    ...(mergeStateStatus ? { mergeStateStatus } : {}),
    ...(autoMerge !== undefined ? { autoMerge } : {}),
    ...(closedAt ? { closedAt } : {}),
    ...(mergedAt ? { mergedAt } : {}),
    ...(mergedBy ? { mergedBy } : {}),
  };
  return Result.succeed(detail);
}
