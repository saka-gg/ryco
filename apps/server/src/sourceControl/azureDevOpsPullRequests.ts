import { Cause, DateTime, Exit, Option, Result, Schema } from "effect";
import {
  PositiveInt,
  TrimmedNonEmptyString,
  type SourceControlChangeRequestMergeability,
  type SourceControlChangeRequestReviewDecision,
  type SourceControlLabel,
} from "@ryco/contracts";
import { decodeJsonResult, formatSchemaError } from "@ryco/shared/schemaJson";

/**
 * Azure DevOps `GitPullRequest` as `az repos pr show` / `az repos pr list`
 * print it (REST 7.1 shape:
 * https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/get-pull-request?view=azure-devops-rest-7.1).
 * Every field beyond the identity of the pull request is optional: list rows
 * and older servers omit many of them.
 */

export const AzureDevOpsIdentityRefSchema = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.String)),
  displayName: Schema.optional(Schema.NullOr(Schema.String)),
  uniqueName: Schema.optional(Schema.NullOr(Schema.String)),
  imageUrl: Schema.optional(Schema.NullOr(Schema.String)),
  isContainer: Schema.optional(Schema.NullOr(Schema.Boolean)),
});
export type AzureDevOpsIdentityRef = typeof AzureDevOpsIdentityRefSchema.Type;

/** `IdentityRefWithVote`: 10 approved, 5 approved with suggestions, 0 none, -5 waiting for author, -10 rejected. */
export const AzureDevOpsReviewerSchema = Schema.Struct({
  ...AzureDevOpsIdentityRefSchema.fields,
  vote: Schema.optional(Schema.NullOr(Schema.Number)),
  isRequired: Schema.optional(Schema.NullOr(Schema.Boolean)),
  hasDeclined: Schema.optional(Schema.NullOr(Schema.Boolean)),
});
export type AzureDevOpsReviewer = typeof AzureDevOpsReviewerSchema.Type;

const AzureDevOpsGitUserDateSchema = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  email: Schema.optional(Schema.NullOr(Schema.String)),
  date: Schema.optional(Schema.NullOr(Schema.String)),
});

export const AzureDevOpsCommitRefSchema = Schema.Struct({
  commitId: TrimmedNonEmptyString,
  comment: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(AzureDevOpsGitUserDateSchema)),
  committer: Schema.optional(Schema.NullOr(AzureDevOpsGitUserDateSchema)),
});
export type AzureDevOpsCommitRef = typeof AzureDevOpsCommitRefSchema.Type;

export const AzureDevOpsPullRequestSchema = Schema.Struct({
  pullRequestId: PositiveInt,
  title: TrimmedNonEmptyString,
  url: Schema.optional(Schema.String),
  sourceRefName: TrimmedNonEmptyString,
  targetRefName: TrimmedNonEmptyString,
  status: Schema.String,
  creationDate: Schema.optional(Schema.OptionFromNullOr(Schema.DateTimeUtcFromString)),
  closedDate: Schema.optional(Schema.OptionFromNullOr(Schema.DateTimeUtcFromString)),
  _links: Schema.optional(
    Schema.Struct({
      web: Schema.optional(
        Schema.Struct({
          href: Schema.String,
        }),
      ),
    }),
  ),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  isDraft: Schema.optional(Schema.NullOr(Schema.Boolean)),
  createdBy: Schema.optional(Schema.NullOr(AzureDevOpsIdentityRefSchema)),
  closedBy: Schema.optional(Schema.NullOr(AzureDevOpsIdentityRefSchema)),
  /** `PullRequestAsyncStatus`: notSet, queued, conflicts, succeeded, rejectedByPolicy, failure. */
  mergeStatus: Schema.optional(Schema.NullOr(Schema.String)),
  lastMergeSourceCommit: Schema.optional(Schema.NullOr(AzureDevOpsCommitRefSchema)),
  lastMergeTargetCommit: Schema.optional(Schema.NullOr(AzureDevOpsCommitRefSchema)),
  lastMergeCommit: Schema.optional(Schema.NullOr(AzureDevOpsCommitRefSchema)),
  reviewers: Schema.optional(Schema.NullOr(Schema.Array(AzureDevOpsReviewerSchema))),
  labels: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          name: Schema.String,
          active: Schema.optional(Schema.NullOr(Schema.Boolean)),
        }),
      ),
    ),
  ),
  autoCompleteSetBy: Schema.optional(Schema.NullOr(AzureDevOpsIdentityRefSchema)),
  completionOptions: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        mergeStrategy: Schema.optional(Schema.NullOr(Schema.String)),
        squashMerge: Schema.optional(Schema.NullOr(Schema.Unknown)),
        deleteSourceBranch: Schema.optional(Schema.NullOr(Schema.Unknown)),
      }),
    ),
  ),
  repository: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.optional(Schema.NullOr(Schema.String)),
        name: Schema.optional(Schema.NullOr(Schema.String)),
        webUrl: Schema.optional(Schema.NullOr(Schema.String)),
        remoteUrl: Schema.optional(Schema.NullOr(Schema.String)),
        project: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              id: Schema.optional(Schema.NullOr(Schema.String)),
              name: Schema.optional(Schema.NullOr(Schema.String)),
            }),
          ),
        ),
      }),
    ),
  ),
  forkSource: Schema.optional(Schema.NullOr(Schema.Unknown)),
});
export type AzureDevOpsPullRequest = typeof AzureDevOpsPullRequestSchema.Type;

export interface NormalizedAzureDevOpsPullRequestRecord {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt: Option.Option<DateTime.Utc>;
  readonly isDraft?: boolean;
  readonly author?: string;
  readonly headSha?: string;
  readonly createdAt?: DateTime.Utc;
  readonly labels?: ReadonlyArray<SourceControlLabel>;
  readonly mergeability?: SourceControlChangeRequestMergeability;
  readonly reviewDecision?: SourceControlChangeRequestReviewDecision | null;
  readonly isCrossRepository?: boolean;
}

function trimOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeAzureDevOpsRefName(refName: string): string {
  return refName.trim().replace(/^refs\/heads\//, "");
}

export function normalizeAzureDevOpsPullRequestState(status: string): "open" | "closed" | "merged" {
  switch (status.trim().toLowerCase()) {
    case "completed":
      return "merged";
    case "abandoned":
      return "closed";
    default:
      return "open";
  }
}

/** The login Ryco shows for an Azure identity: `uniqueName` (UPN / email), else the display name. */
export function azureDevOpsIdentityLogin(
  identity: AzureDevOpsIdentityRef | null | undefined,
): string | null {
  return (
    trimOptionalString(identity?.uniqueName) ??
    trimOptionalString(identity?.displayName) ??
    trimOptionalString(identity?.id)
  );
}

/** `mergeStatus` → mergeability: only `succeeded` and `conflicts` are facts. */
export function azureDevOpsMergeability(
  mergeStatus: string | null | undefined,
): SourceControlChangeRequestMergeability {
  switch (mergeStatus?.trim().toLowerCase()) {
    case "succeeded":
      return "mergeable";
    case "conflicts":
      return "conflicting";
    default:
      return "unknown";
  }
}

/**
 * The verdict the reviewer votes alone establish: a negative vote is a
 * request for changes; required reviewers decide approval. Without required
 * reviewers the votes do not say whether review is required (branch policies
 * do), so there is no verdict.
 */
export function azureDevOpsReviewDecisionFromVotes(
  reviewers: ReadonlyArray<AzureDevOpsReviewer>,
): SourceControlChangeRequestReviewDecision | null {
  if (reviewers.some((reviewer) => (reviewer.vote ?? 0) < 0)) return "changes_requested";
  const required = reviewers.filter((reviewer) => reviewer.isRequired === true);
  if (required.length === 0) return null;
  return required.every((reviewer) => (reviewer.vote ?? 0) > 0) ? "approved" : "review_required";
}

export function azureDevOpsPullRequestWebUrl(raw: AzureDevOpsPullRequest): string {
  const web = trimOptionalString(raw._links?.web?.href);
  if (web) return web;
  // The repository's web URL, else its HTTPS clone URL (same path, minus credentials).
  const repositoryWebUrl =
    trimOptionalString(raw.repository?.webUrl) ??
    trimOptionalString(raw.repository?.remoteUrl)?.replace(/^(https?:\/\/)[^@/]+@/u, "$1") ??
    null;
  if (repositoryWebUrl && /^https?:\/\//u.test(repositoryWebUrl)) {
    return `${repositoryWebUrl.replace(/\/+$/u, "")}/pullrequest/${raw.pullRequestId}`;
  }
  return trimOptionalString(raw.url) ?? "";
}

export function normalizeAzureDevOpsPullRequestRecord(
  raw: AzureDevOpsPullRequest,
): NormalizedAzureDevOpsPullRequestRecord {
  const author = azureDevOpsIdentityLogin(raw.createdBy);
  const headSha = trimOptionalString(raw.lastMergeSourceCommit?.commitId);
  const createdAt = raw.creationDate ? Option.getOrUndefined(raw.creationDate) : undefined;
  const labels = (raw.labels ?? [])
    .filter((label) => label.active !== false)
    .map((label) => label.name.trim())
    .filter((name) => name.length > 0)
    .map((name) => ({ name }));
  const state = normalizeAzureDevOpsPullRequestState(raw.status);
  return {
    number: raw.pullRequestId,
    title: raw.title,
    url: azureDevOpsPullRequestWebUrl(raw),
    baseRefName: normalizeAzureDevOpsRefName(raw.targetRefName),
    headRefName: normalizeAzureDevOpsRefName(raw.sourceRefName),
    state,
    updatedAt: (raw.closedDate ?? Option.none()).pipe(
      Option.orElse(() => raw.creationDate ?? Option.none()),
    ),
    ...(typeof raw.isDraft === "boolean" ? { isDraft: raw.isDraft } : {}),
    ...(author ? { author } : {}),
    ...(headSha ? { headSha } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(labels.length > 0 ? { labels } : {}),
    ...(raw.mergeStatus ? { mergeability: azureDevOpsMergeability(raw.mergeStatus) } : {}),
    ...(raw.reviewers && state === "open"
      ? { reviewDecision: azureDevOpsReviewDecisionFromVotes(raw.reviewers) }
      : {}),
    ...(raw.forkSource ? { isCrossRepository: true } : {}),
  };
}

const decodeAzureDevOpsPullRequestList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeAzureDevOpsPullRequest = decodeJsonResult(AzureDevOpsPullRequestSchema);
const decodeAzureDevOpsPullRequestEntry = Schema.decodeUnknownExit(AzureDevOpsPullRequestSchema);

export const formatAzureDevOpsJsonDecodeError = formatSchemaError;

export function decodeAzureDevOpsPullRequestListJson(
  raw: string,
): Result.Result<
  ReadonlyArray<NormalizedAzureDevOpsPullRequestRecord>,
  Cause.Cause<Schema.SchemaError>
> {
  const result = decodeAzureDevOpsPullRequestList(raw);
  if (Result.isSuccess(result)) {
    const pullRequests: NormalizedAzureDevOpsPullRequestRecord[] = [];
    for (const entry of result.success) {
      const decodedEntry = decodeAzureDevOpsPullRequestEntry(entry);
      if (Exit.isFailure(decodedEntry)) {
        continue;
      }
      pullRequests.push(normalizeAzureDevOpsPullRequestRecord(decodedEntry.value));
    }
    return Result.succeed(pullRequests);
  }
  return Result.fail(result.failure);
}

/** The full `GitPullRequest` (`az repos pr show`), undigested. */
export function decodeAzureDevOpsRawPullRequestJson(
  raw: string,
): Result.Result<AzureDevOpsPullRequest, Cause.Cause<Schema.SchemaError>> {
  return decodeAzureDevOpsPullRequest(raw);
}

export function decodeAzureDevOpsPullRequestJson(
  raw: string,
): Result.Result<NormalizedAzureDevOpsPullRequestRecord, Cause.Cause<Schema.SchemaError>> {
  const result = decodeAzureDevOpsPullRequest(raw);
  if (Result.isSuccess(result)) {
    return Result.succeed(normalizeAzureDevOpsPullRequestRecord(result.success));
  }
  return Result.fail(result.failure);
}
