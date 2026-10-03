import { Result, Schema } from "effect";
import {
  PositiveInt,
  TrimmedNonEmptyString,
  type SourceControlChangeRequestMergeCapabilities,
  type SourceControlChangeRequestMergeability,
  type SourceControlChangeRequestStack,
  type SourceControlChangeRequestStackEntry,
  type SourceControlChangeRequestStackSummary,
} from "@ryco/contracts";
import { decodeJsonResult, formatSchemaError } from "@ryco/shared/schemaJson";

export const GITHUB_STACK_PAGE_SIZE = 50;
export const GITHUB_STACK_SUMMARY_BATCH_SIZE = 40;

export const GITHUB_PULL_REQUEST_STACK_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      stackEntry { position }
      stack {
        number
        size
        baseRefName
        entries(first: $first, after: $after) {
          totalCount
          nodes {
            position
            pullRequest {
              number
              title
              url
              headRefName
              baseRefName
              state
              isDraft
              mergedAt
              mergeable
              mergeStateStatus
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
}`;

export function buildGitHubPullRequestStackSummariesQuery(numbers: ReadonlyArray<number>): string {
  const selections = [...new Set(numbers)]
    .filter((number) => Number.isSafeInteger(number) && number > 0)
    .map(
      (number) => `    pr_${number}: pullRequest(number: ${number}) {
      stackEntry { position }
      stack { number size baseRefName }
    }`,
    )
    .join("\n");
  return `query($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
${selections}
  }
}`;
}

const RawGraphQlErrorSchema = Schema.Struct({
  message: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawPullRequestStackMemberSchema = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  headRefName: TrimmedNonEmptyString,
  baseRefName: TrimmedNonEmptyString,
  state: Schema.String,
  isDraft: Schema.Boolean,
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  mergeable: Schema.optional(Schema.NullOr(Schema.String)),
  mergeStateStatus: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawPullRequestStackEntrySchema = Schema.Struct({
  position: PositiveInt,
  pullRequest: Schema.NullOr(RawPullRequestStackMemberSchema),
});

const RawPullRequestStackResponseSchema = Schema.Struct({
  errors: Schema.optional(Schema.NullOr(Schema.Array(Schema.NullOr(RawGraphQlErrorSchema)))),
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        repository: Schema.NullOr(
          Schema.Struct({
            pullRequest: Schema.NullOr(
              Schema.Struct({
                stackEntry: Schema.NullOr(Schema.Struct({ position: PositiveInt })),
                stack: Schema.NullOr(
                  Schema.Struct({
                    number: PositiveInt,
                    size: PositiveInt,
                    baseRefName: TrimmedNonEmptyString,
                    entries: Schema.Struct({
                      totalCount: PositiveInt,
                      nodes: Schema.Array(Schema.NullOr(RawPullRequestStackEntrySchema)),
                      pageInfo: Schema.Struct({
                        hasNextPage: Schema.Boolean,
                        endCursor: Schema.optional(Schema.NullOr(Schema.String)),
                      }),
                    }),
                  }),
                ),
              }),
            ),
          }),
        ),
      }),
    ),
  ),
});

const RawPullRequestStackSummarySchema = Schema.Struct({
  stackEntry: Schema.NullOr(Schema.Struct({ position: PositiveInt })),
  stack: Schema.NullOr(
    Schema.Struct({
      number: PositiveInt,
      size: PositiveInt,
      baseRefName: TrimmedNonEmptyString,
    }),
  ),
});

const RawPullRequestStackSummariesResponseSchema = Schema.Struct({
  errors: Schema.optional(Schema.NullOr(Schema.Array(Schema.NullOr(RawGraphQlErrorSchema)))),
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        repository: Schema.NullOr(
          Schema.Record(Schema.String, Schema.NullOr(RawPullRequestStackSummarySchema)),
        ),
      }),
    ),
  ),
});

const RawAsyncMergeResultSchema = Schema.Struct({
  status: Schema.Literals(["pending", "merged", "enqueued", "failed"]),
  details: Schema.Struct({
    message: Schema.optional(Schema.String),
    uuid: Schema.optional(Schema.NullOr(Schema.String)),
    sha: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});

const RawRepositoryMergeCapabilitiesSchema = Schema.Struct({
  allow_merge_commit: Schema.Boolean,
  allow_squash_merge: Schema.Boolean,
  allow_rebase_merge: Schema.Boolean,
  delete_branch_on_merge: Schema.optional(Schema.NullOr(Schema.Boolean)),
});

const decodeStackPage = decodeJsonResult(RawPullRequestStackResponseSchema);
const decodeStackSummaries = decodeJsonResult(RawPullRequestStackSummariesResponseSchema);
const decodeAsyncMerge = decodeJsonResult(RawAsyncMergeResultSchema);
const decodeMergeCapabilities = decodeJsonResult(RawRepositoryMergeCapabilitiesSchema);

function graphQlErrorDetail(raw: {
  readonly errors?:
    | ReadonlyArray<{ readonly message?: string | null | undefined } | null>
    | null
    | undefined;
}): string | null {
  if (!raw.errors || raw.errors.length === 0) return null;
  const messages =
    raw.errors
      ?.flatMap((error) => {
        const message = error?.message?.trim();
        return message ? [message] : [];
      })
      .join("; ") ?? "";
  return messages
    ? `GitHub GraphQL returned errors: ${messages}`
    : "GitHub GraphQL returned errors.";
}

function normalizeMergeability(
  value: string | null | undefined,
): SourceControlChangeRequestMergeability {
  switch (value?.trim().toUpperCase()) {
    case "MERGEABLE":
      return "mergeable";
    case "CONFLICTING":
      return "conflicting";
    default:
      return "unknown";
  }
}

function normalizeStackEntry(
  raw: Schema.Schema.Type<typeof RawPullRequestStackEntrySchema>,
): SourceControlChangeRequestStackEntry | null {
  const pullRequest = raw.pullRequest;
  if (!pullRequest) return null;
  const mergeStateStatus = pullRequest.mergeStateStatus?.trim() || null;
  return {
    position: raw.position,
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    headRefName: pullRequest.headRefName,
    baseRefName: pullRequest.baseRefName,
    state: pullRequest.mergedAt
      ? "merged"
      : pullRequest.state.trim().toUpperCase() === "OPEN"
        ? "open"
        : "closed",
    isDraft: pullRequest.isDraft,
    mergeability: normalizeMergeability(pullRequest.mergeable),
    mergeStateStatus,
  };
}

export interface DecodedGitHubPullRequestStackPage {
  readonly selectedPosition: number | null;
  readonly stack: {
    readonly number: number;
    readonly size: number;
    readonly baseRefName: string;
    readonly totalCount: number;
    readonly entries: ReadonlyArray<SourceControlChangeRequestStackEntry>;
    readonly hasNextPage: boolean;
    readonly endCursor: string | null;
  } | null;
}

export function decodeGitHubPullRequestStackPageJson(
  raw: string,
): Result.Result<DecodedGitHubPullRequestStackPage, string> {
  const decoded = decodeStackPage(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(`Invalid GitHub stack response: ${formatSchemaError(decoded.failure)}`);
  }
  const graphQlError = graphQlErrorDetail(decoded.success);
  if (graphQlError) return Result.fail(graphQlError);
  const pullRequest = decoded.success.data?.repository?.pullRequest;
  if (!pullRequest) return Result.fail("GitHub returned no pull request for the stack lookup.");
  const { stack, stackEntry } = pullRequest;
  if (!stack && !stackEntry) return Result.succeed({ selectedPosition: null, stack: null });
  if (!stack || !stackEntry) {
    return Result.fail("GitHub returned incomplete pull request stack metadata.");
  }
  const entries: SourceControlChangeRequestStackEntry[] = [];
  for (const node of stack.entries.nodes) {
    if (!node) return Result.fail("GitHub returned an empty pull request stack entry.");
    const normalized = normalizeStackEntry(node);
    if (!normalized) {
      return Result.fail("GitHub returned a stack entry without its pull request.");
    }
    entries.push(normalized);
  }
  return Result.succeed({
    selectedPosition: stackEntry.position,
    stack: {
      number: stack.number,
      size: stack.size,
      baseRefName: stack.baseRefName,
      totalCount: stack.entries.totalCount,
      entries,
      hasNextPage: stack.entries.pageInfo.hasNextPage,
      endCursor: stack.entries.pageInfo.endCursor?.trim() || null,
    },
  });
}

export function normalizeGitHubPullRequestStackPages(
  pages: ReadonlyArray<DecodedGitHubPullRequestStackPage>,
  selectedPullRequestNumber: number,
): Result.Result<SourceControlChangeRequestStack | null, string> {
  const first = pages[0];
  if (!first) return Result.fail("GitHub returned no pull request stack pages.");
  if (!first.stack && first.selectedPosition === null) {
    return pages.length === 1
      ? Result.succeed(null)
      : Result.fail("GitHub returned pagination for a standalone pull request.");
  }
  if (!first.stack || first.selectedPosition === null) {
    return Result.fail("GitHub returned incomplete pull request stack metadata.");
  }

  const entries: SourceControlChangeRequestStackEntry[] = [];
  for (const [index, page] of pages.entries()) {
    const stack = page.stack;
    if (
      !stack ||
      page.selectedPosition !== first.selectedPosition ||
      stack.number !== first.stack.number ||
      stack.size !== first.stack.size ||
      stack.totalCount !== first.stack.totalCount ||
      stack.baseRefName !== first.stack.baseRefName
    ) {
      return Result.fail("GitHub changed or omitted stack metadata during pagination.");
    }
    if (index < pages.length - 1 && !stack.hasNextPage) {
      return Result.fail("GitHub ended stack pagination before the final page.");
    }
    if (index === pages.length - 1 && stack.hasNextPage) {
      return Result.fail("GitHub returned only part of the pull request stack.");
    }
    entries.push(...stack.entries);
  }

  const ordered = entries.toSorted((left, right) => left.position - right.position);
  if (
    first.stack.size !== first.stack.totalCount ||
    ordered.length !== first.stack.size ||
    first.selectedPosition > first.stack.size ||
    ordered.some((entry, index) => entry.position !== index + 1) ||
    ordered[first.selectedPosition - 1]?.number !== selectedPullRequestNumber
  ) {
    return Result.fail("GitHub returned a partial or inconsistent pull request stack.");
  }

  return Result.succeed({
    number: first.stack.number,
    size: first.stack.size,
    position: first.selectedPosition,
    baseRefName: first.stack.baseRefName,
    entries: ordered,
  });
}

export function decodeGitHubPullRequestStackSummariesJson(
  raw: string,
  numbers: ReadonlyArray<number>,
): Result.Result<ReadonlyMap<number, SourceControlChangeRequestStackSummary>, string> {
  const decoded = decodeStackSummaries(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(
      `Invalid GitHub stack summary response: ${formatSchemaError(decoded.failure)}`,
    );
  }
  const graphQlError = graphQlErrorDetail(decoded.success);
  if (graphQlError) return Result.fail(graphQlError);
  const repository = decoded.success.data?.repository;
  if (!repository) return Result.fail("GitHub returned no repository for stack summaries.");

  const summaries = new Map<number, SourceControlChangeRequestStackSummary>();
  for (const number of numbers) {
    const pullRequest = repository[`pr_${number}`];
    if (!pullRequest) continue;
    const { stack, stackEntry } = pullRequest;
    if (!stack && !stackEntry) continue;
    if (!stack || !stackEntry || stackEntry.position > stack.size) {
      return Result.fail(`GitHub returned incomplete stack metadata for pull request #${number}.`);
    }
    summaries.set(number, {
      number: stack.number,
      size: stack.size,
      position: stackEntry.position,
      baseRefName: stack.baseRefName,
    });
  }
  return Result.succeed(summaries);
}

export interface GitHubAsyncMergeResult {
  readonly status: "pending" | "merged" | "enqueued" | "failed";
  readonly message: string | null;
  readonly uuid: string | null;
}

export function decodeGitHubAsyncMergeResultJson(
  raw: string,
): Result.Result<GitHubAsyncMergeResult, string> {
  const decoded = decodeAsyncMerge(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(
      `Invalid GitHub asynchronous merge response: ${formatSchemaError(decoded.failure)}`,
    );
  }
  return Result.succeed({
    status: decoded.success.status,
    message: decoded.success.details.message?.trim() || null,
    uuid: decoded.success.details.uuid?.trim() || null,
  });
}

export function decodeGitHubRepositoryMergeCapabilitiesJson(
  raw: string,
): Result.Result<
  SourceControlChangeRequestMergeCapabilities & { readonly deleteBranchOnMerge?: boolean },
  string
> {
  const decoded = decodeMergeCapabilities(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(`Invalid GitHub repository response: ${formatSchemaError(decoded.failure)}`);
  }
  const deleteBranchOnMerge = decoded.success.delete_branch_on_merge;
  return Result.succeed({
    merge: decoded.success.allow_merge_commit,
    squash: decoded.success.allow_squash_merge,
    rebase: decoded.success.allow_rebase_merge,
    ...(typeof deleteBranchOnMerge === "boolean" ? { deleteBranchOnMerge } : {}),
  });
}
