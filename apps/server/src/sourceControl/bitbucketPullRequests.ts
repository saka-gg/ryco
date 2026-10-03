import { Cause, DateTime, Option, Result, Schema } from "effect";
import {
  PositiveInt,
  TrimmedNonEmptyString,
  type SourceControlChangeRequestCommit,
  type SourceControlChangeRequestMergeability,
  type SourceControlChangeRequestMergeCapabilities,
  type SourceControlChangeRequestMergeStateStatus,
  type SourceControlChangeRequestReviewDecision,
  type SourceControlChangeRequestReviewer,
  type SourceControlCheckRollupItem,
} from "@ryco/contracts";
import { decodeJsonResult } from "@ryco/shared/schemaJson";

export interface NormalizedBitbucketPullRequestRecord {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt: Option.Option<DateTime.Utc>;
  readonly author?: string;
  readonly isCrossRepository?: boolean;
  readonly commentsCount?: number;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
  readonly isDraft?: boolean;
  readonly createdAt?: DateTime.Utc;
}

export const BitbucketRepositoryRefSchema = Schema.Struct({
  full_name: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  workspace: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        slug: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
      }),
    ),
  ),
});

export const BitbucketPullRequestBranchSchema = Schema.Struct({
  repository: Schema.optional(Schema.NullOr(BitbucketRepositoryRefSchema)),
  branch: Schema.Struct({
    name: TrimmedNonEmptyString,
    /** Strategies the destination branch allows (destination endpoint only). */
    merge_strategies: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
    default_merge_strategy: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  /** Abbreviated (12 hex) on pull request payloads. */
  commit: Schema.optional(
    Schema.NullOr(Schema.Struct({ hash: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
});

const BitbucketLinkSchema = Schema.optional(
  Schema.NullOr(Schema.Struct({ href: Schema.optional(Schema.NullOr(Schema.String)) })),
);

/** `account` / `user` objects (https://developer.atlassian.com/cloud/bitbucket/rest/api-group-users/). */
export const BitbucketPullRequestUserSchema = Schema.Struct({
  display_name: Schema.optional(Schema.NullOr(Schema.String)),
  nickname: Schema.optional(Schema.NullOr(Schema.String)),
  account_id: Schema.optional(Schema.NullOr(Schema.String)),
  username: Schema.optional(Schema.NullOr(Schema.String)),
  uuid: Schema.optional(Schema.NullOr(Schema.String)),
  links: Schema.optional(
    Schema.NullOr(Schema.Struct({ avatar: BitbucketLinkSchema, html: BitbucketLinkSchema })),
  ),
});
export type BitbucketAccount = typeof BitbucketPullRequestUserSchema.Type;

export const BitbucketPullRequestParticipantSchema = Schema.Struct({
  user: BitbucketPullRequestUserSchema,
  role: Schema.optional(Schema.NullOr(Schema.String)),
  approved: Schema.optional(Schema.Boolean),
  /** `approved`, `changes_requested`, or null. */
  state: Schema.optional(Schema.NullOr(Schema.String)),
  participated_on: Schema.optional(Schema.NullOr(Schema.String)),
});

export const BitbucketPullRequestSchema = Schema.Struct({
  id: PositiveInt,
  title: TrimmedNonEmptyString,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  updated_on: Schema.optional(Schema.OptionFromNullOr(Schema.DateTimeUtcFromString)),
  author: Schema.optional(Schema.NullOr(BitbucketPullRequestUserSchema)),
  reviewers: Schema.optional(Schema.Array(BitbucketPullRequestUserSchema)),
  participants: Schema.optional(Schema.Array(BitbucketPullRequestParticipantSchema)),
  comment_count: Schema.optional(Schema.Number),
  task_count: Schema.optional(Schema.Number),
  links: Schema.Struct({
    html: Schema.Struct({
      href: TrimmedNonEmptyString,
    }),
  }),
  source: BitbucketPullRequestBranchSchema,
  destination: BitbucketPullRequestBranchSchema,
  draft: Schema.optional(Schema.NullOr(Schema.Boolean)),
  queued: Schema.optional(Schema.NullOr(Schema.Boolean)),
  created_on: Schema.optional(Schema.NullOr(Schema.String)),
  close_source_branch: Schema.optional(Schema.NullOr(Schema.Boolean)),
  closed_by: Schema.optional(Schema.NullOr(BitbucketPullRequestUserSchema)),
  merge_commit: Schema.optional(
    Schema.NullOr(Schema.Struct({ hash: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
});
export type BitbucketPullRequest = typeof BitbucketPullRequestSchema.Type;

export const BitbucketPullRequestListSchema = Schema.Struct({
  values: Schema.Array(BitbucketPullRequestSchema),
  next: Schema.optional(TrimmedNonEmptyString),
});

/** `42`, `#42`, or a pull request URL → `42`. */
export function normalizeBitbucketChangeRequestId(reference: string): string {
  const trimmed = reference.trim().replace(/^#/, "");
  const urlMatch = /(?:pull-requests|pullrequests|pull-request|pull|pr)\/(\d+)(?:\D.*)?$/i.exec(
    trimmed,
  );
  return urlMatch?.[1] ?? trimmed;
}

function trimOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function repositoryOwner(repository: Schema.Schema.Type<typeof BitbucketRepositoryRefSchema>) {
  return (
    trimOptionalString(repository.workspace?.slug) ??
    (repository.full_name?.includes("/") ? (repository.full_name.split("/")[0] ?? null) : null)
  );
}

function normalizeBitbucketPullRequestState(state: string | null | undefined) {
  switch (state?.trim().toUpperCase()) {
    case "MERGED":
      return "merged" as const;
    case "DECLINED":
    case "SUPERSEDED":
      return "closed" as const;
    case "OPEN":
    default:
      return "open" as const;
  }
}

/**
 * The login Ryco shows for a Bitbucket account. Bitbucket retired usernames,
 * so the display name is the identity list rows, timelines, reviewers and
 * pickers share (`uuid` / `account_id` stay internal for matching).
 */
export function bitbucketUserDisplayName(
  user: typeof BitbucketPullRequestUserSchema.Type | null | undefined,
): string | null {
  const display =
    trimOptionalString(user?.display_name) ??
    trimOptionalString(user?.nickname) ??
    trimOptionalString(user?.username) ??
    trimOptionalString(user?.account_id) ??
    trimOptionalString(user?.uuid);
  return display;
}

export function normalizeBitbucketPullRequestRecord(
  raw: Schema.Schema.Type<typeof BitbucketPullRequestSchema>,
): NormalizedBitbucketPullRequestRecord {
  const headRepositoryNameWithOwner = trimOptionalString(raw.source.repository?.full_name);
  const baseRepositoryNameWithOwner = trimOptionalString(raw.destination.repository?.full_name);
  const headRepositoryOwnerLogin = raw.source.repository
    ? repositoryOwner(raw.source.repository)
    : null;
  const author = bitbucketUserDisplayName(raw.author);
  const isCrossRepository =
    headRepositoryNameWithOwner !== null &&
    baseRepositoryNameWithOwner !== null &&
    headRepositoryNameWithOwner !== baseRepositoryNameWithOwner;

  return {
    number: raw.id,
    title: raw.title,
    url: raw.links.html.href,
    baseRefName: raw.destination.branch.name,
    headRefName: raw.source.branch.name,
    state: normalizeBitbucketPullRequestState(raw.state),
    updatedAt: raw.updated_on ?? Option.none(),
    ...(author ? { author } : {}),
    ...(typeof raw.comment_count === "number" ? { commentsCount: raw.comment_count } : {}),
    ...(isCrossRepository ? { isCrossRepository: true } : {}),
    ...(headRepositoryNameWithOwner ? { headRepositoryNameWithOwner } : {}),
    ...(headRepositoryOwnerLogin ? { headRepositoryOwnerLogin } : {}),
    ...(typeof raw.draft === "boolean" ? { isDraft: raw.draft } : {}),
    ...Option.match(raw.created_on ? DateTime.make(raw.created_on) : Option.none(), {
      onNone: () => ({}),
      onSome: (createdAt) => ({ createdAt }),
    }),
  };
}

export interface NormalizedBitbucketPullRequestDetail extends NormalizedBitbucketPullRequestRecord {
  readonly body: string;
  readonly comments: ReadonlyArray<{
    readonly author: string;
    readonly body: string;
    readonly createdAt: string;
  }>;
  readonly reviewers: ReadonlyArray<string>;
  readonly participants: ReadonlyArray<{
    readonly displayName: string;
    readonly username?: string;
    readonly role?: string;
    readonly approved?: boolean;
  }>;
  readonly tasksCount?: number;
  readonly linkedWorkItemKeys: ReadonlyArray<string>;
  // Pull requests page enrichment (see `bitbucketPullRequestPage.ts`); absent when a read failed.
  /** Full head hash (pull request payloads abbreviate it). */
  readonly headSha?: string;
  readonly commits?: ReadonlyArray<SourceControlChangeRequestCommit>;
  readonly reviewerStates?: ReadonlyArray<SourceControlChangeRequestReviewer>;
  readonly reviewDecision?: SourceControlChangeRequestReviewDecision | null;
  readonly mergeability?: SourceControlChangeRequestMergeability;
  readonly mergeStateStatus?: SourceControlChangeRequestMergeStateStatus;
  readonly mergeCapabilities?: SourceControlChangeRequestMergeCapabilities;
  readonly checkRollup?: ReadonlyArray<SourceControlCheckRollupItem>;
  readonly deleteBranchOnMerge?: boolean;
  readonly mergedBy?: string;
}

export const BitbucketPullRequestDetailSchema = Schema.Struct({
  ...BitbucketPullRequestSchema.fields,
  summary: Schema.optional(
    Schema.NullOr(Schema.Struct({ raw: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
});

const decodeBitbucketPullRequestDetailDecoder = decodeJsonResult(BitbucketPullRequestDetailSchema);

const WORK_ITEM_KEY_PATTERN = /\b([A-Z][A-Z0-9]{1,9})-(\d+)\b/giu;

function extractWorkItemKeys(input: string): ReadonlyArray<string> {
  const keys = new Set<string>();
  for (const match of input.matchAll(WORK_ITEM_KEY_PATTERN)) {
    const projectKey = match[1]?.toUpperCase();
    const issueNumber = match[2];
    if (!projectKey || !issueNumber || Number(issueNumber) <= 0) continue;
    keys.add(`${projectKey}-${issueNumber}`);
  }
  return Array.from(keys);
}

export function normalizeBitbucketPullRequestDetailRecord(
  raw: Schema.Schema.Type<typeof BitbucketPullRequestDetailSchema>,
  comments: NormalizedBitbucketPullRequestDetail["comments"],
): NormalizedBitbucketPullRequestDetail {
  const summary = normalizeBitbucketPullRequestRecord(raw);
  const body = raw.summary?.raw ?? "";
  return {
    ...summary,
    body,
    comments,
    reviewers: (raw.reviewers ?? [])
      .map(bitbucketUserDisplayName)
      .filter((value): value is string => value !== null),
    participants: (raw.participants ?? [])
      .map((participant) => {
        const displayName = bitbucketUserDisplayName(participant.user);
        if (displayName === null) return null;
        const detail: {
          readonly displayName: string;
          username?: string;
          role?: string;
          approved?: boolean;
        } = {
          displayName,
        };
        if (participant.user.nickname) detail.username = participant.user.nickname;
        if (participant.role) detail.role = participant.role;
        if (participant.approved !== undefined) detail.approved = participant.approved;
        return detail;
      })
      .filter((value): value is NonNullable<typeof value> => value !== null),
    ...(typeof raw.task_count === "number" ? { tasksCount: raw.task_count } : {}),
    linkedWorkItemKeys: extractWorkItemKeys(`${raw.title}\n${body}`),
  };
}

export function decodeBitbucketPullRequestDetailJson(
  raw: string,
  comments: NormalizedBitbucketPullRequestDetail["comments"],
): Result.Result<NormalizedBitbucketPullRequestDetail, Cause.Cause<Schema.SchemaError>> {
  const result = decodeBitbucketPullRequestDetailDecoder(raw);
  if (!Result.isSuccess(result)) return Result.fail(result.failure);
  return Result.succeed(normalizeBitbucketPullRequestDetailRecord(result.success, comments));
}
