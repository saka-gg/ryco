import { Context, Effect, Layer, Result, Schema, SchemaIssue } from "effect";

import {
  TrimmedNonEmptyString,
  type SourceControlGetChangeRequestFilesViewedInput,
  type SourceControlChangeRequestFilesViewed,
  type SourceControlSetChangeRequestFileViewedInput,
  type SourceControlSetChangeRequestFileViewedResult,
  type SourceControlChangeRequestMergeCapabilities,
  type SourceControlChangeRequestMergeMethod,
  type SourceControlChangeRequestMergeability,
  type SourceControlChangeRequestStack,
  type SourceControlChangeRequestStackSummary,
  type SourceControlCommentReactionContent,
  type SourceControlRepositoryVisibility,
  type VcsError,
} from "@ryco/contracts";
import { formatSchemaError } from "@ryco/shared/schemaJson";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubIssues from "./gitHubIssues.ts";
import type { NormalizedGitHubIssueDetail, NormalizedGitHubIssueRecord } from "./gitHubIssues.ts";
import * as GitHubActions from "./gitHubActions.ts";
import { buildGitHubIssueCreateArgv, parseGitHubIssueCreateOutput } from "./gitHubIssueCreate.ts";
import * as GitHubPullRequests from "./gitHubPullRequests.ts";
import * as GitHubPullRequestStacks from "./gitHubPullRequestStacks.ts";
import {
  decodeGitHubReactionGroupsBySubjectJson,
  formatGitHubReactionGroupsDecodeError,
  toGitHubReactionContent,
  type NormalizedGitHubReaction,
  type NormalizedGitHubSubjectReactions,
} from "./gitHubReactions.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const GITHUB_API_VERSION = "2026-03-10";
const ASYNC_MERGE_POLL_LIMIT = 300;
const STATUS_CHECK_ROLLUP_JSON_FIELD = "statusCheckRollup";

const GITHUB_PULL_REQUEST_CORE_JSON_FIELDS = [
  "number",
  "title",
  "url",
  "baseRefName",
  "headRefName",
  "headRefOid",
  "mergeable",
  "state",
  "mergedAt",
] as const;

const GITHUB_PULL_REQUEST_METADATA_JSON_FIELDS = [
  "isCrossRepository",
  "isDraft",
  "author",
  "assignees",
  "labels",
  "comments",
  "headRepository",
  "headRepositoryOwner",
] as const;

export const GITHUB_PULL_REQUEST_SUMMARY_JSON_FIELDS = [
  ...GITHUB_PULL_REQUEST_CORE_JSON_FIELDS,
  ...GITHUB_PULL_REQUEST_METADATA_JSON_FIELDS,
  STATUS_CHECK_ROLLUP_JSON_FIELD,
] as const;

export const GITHUB_PULL_REQUEST_LIST_JSON_FIELDS = [
  ...GITHUB_PULL_REQUEST_CORE_JSON_FIELDS,
  "updatedAt",
  ...GITHUB_PULL_REQUEST_METADATA_JSON_FIELDS,
  STATUS_CHECK_ROLLUP_JSON_FIELD,
] as const;

export const GITHUB_PULL_REQUEST_DETAIL_JSON_FIELDS = [
  ...GITHUB_PULL_REQUEST_CORE_JSON_FIELDS,
  ...GITHUB_PULL_REQUEST_METADATA_JSON_FIELDS,
  STATUS_CHECK_ROLLUP_JSON_FIELD,
  "body",
  "comments",
  "reviewRequests",
  "reviews",
  "commits",
  "additions",
  "deletions",
  "changedFiles",
  "files",
] as const;

export function formatGitHubJsonFields(fields: ReadonlyArray<string>): string {
  return fields.join(",");
}

export function withoutStatusCheckRollupJsonField(
  fields: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return fields.filter((field) => field !== STATUS_CHECK_ROLLUP_JSON_FIELD);
}

export class GitHubCliError extends Schema.TaggedError<GitHubCliError>()("GitHubCliError", {
  operation: Schema.String,
  detail: Schema.String,
  reason: Schema.optional(Schema.Literal("async-merge-unavailable")),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `GitHub CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export interface GitHubLabel {
  readonly name: string;
  readonly color?: string;
  readonly description?: string;
}

export interface GitHubPullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state?: "open" | "closed" | "merged";
  readonly isCrossRepository?: boolean;
  readonly isDraft?: boolean;
  readonly author?: string | null;
  readonly assignees?: ReadonlyArray<string>;
  readonly labels?: ReadonlyArray<GitHubLabel>;
  readonly commentsCount?: number | null;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
  readonly headSha?: string;
  readonly mergeability?: SourceControlChangeRequestMergeability;
  readonly checkRollup?: ReadonlyArray<GitHubPullRequests.NormalizedGitHubCheckRollupItem>;
}

export interface GitHubPullRequestCommit {
  readonly oid: string;
  readonly shortOid: string;
  readonly messageHeadline: string;
  readonly committedDate?: string;
  readonly author?: string;
}

export type GitHubReviewState =
  | "approved"
  | "changes_requested"
  | "commented"
  | "dismissed"
  | "pending";

export interface GitHubPullRequestFile {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

export interface GitHubPullRequestDetail extends GitHubPullRequestSummary {
  readonly body: string;
  readonly comments: ReadonlyArray<{
    readonly id?: string;
    readonly author: string;
    readonly body: string;
    readonly createdAt: string;
    readonly authorAssociation?: string;
    readonly reviewState?: GitHubReviewState;
    readonly reactions?: ReadonlyArray<NormalizedGitHubReaction>;
  }>;
  readonly linkedIssueNumbers: ReadonlyArray<number>;
  readonly reviewers: ReadonlyArray<string>;
  readonly commits: ReadonlyArray<GitHubPullRequestCommit>;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly files: ReadonlyArray<GitHubPullRequestFile>;
}

export interface GitHubRepositoryCloneUrls {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
}

export type GitHubWorkflowRun = GitHubActions.NormalizedGitHubWorkflowRun;
export type GitHubWorkflowJob = GitHubActions.NormalizedGitHubWorkflowJob;
export type GitHubPullRequestWorkflowContext =
  GitHubActions.NormalizedGitHubPullRequestWorkflowContext;

export interface GitHubCliShape {
  readonly execute: (input: {
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly stdin?: string;
    readonly allowNonZeroExit?: boolean;
    readonly timeoutMs?: number;
  }) => Effect.Effect<VcsProcess.VcsProcessOutput, GitHubCliError>;

  readonly getPullRequestStack: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly host: string;
    readonly number: number;
  }) => Effect.Effect<SourceControlChangeRequestStack | null, GitHubCliError>;

  readonly getPullRequestStackSummaries: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly host: string;
    readonly numbers: ReadonlyArray<number>;
  }) => Effect.Effect<ReadonlyMap<number, SourceControlChangeRequestStackSummary>, GitHubCliError>;

  readonly getRepositoryMergeCapabilities: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly host: string;
  }) => Effect.Effect<SourceControlChangeRequestMergeCapabilities, GitHubCliError>;

  readonly mergePullRequestAsync: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly host: string;
    readonly number: number;
    readonly mergeMethod: SourceControlChangeRequestMergeMethod;
    readonly stackMembership: "stacked" | "standalone";
  }) => Effect.Effect<{ readonly outcome: "merged" | "enqueued" }, GitHubCliError>;

  readonly listOpenPullRequests: (input: {
    readonly cwd: string;
    readonly headSelector: string;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<GitHubPullRequestSummary>, GitHubCliError>;

  readonly getPullRequest: (input: {
    readonly cwd: string;
    readonly reference: string;
  }) => Effect.Effect<GitHubPullRequestSummary, GitHubCliError>;

  readonly getRepositoryCloneUrls: (input: {
    readonly cwd: string;
    readonly repository: string;
  }) => Effect.Effect<GitHubRepositoryCloneUrls, GitHubCliError>;

  readonly createRepository: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly visibility: SourceControlRepositoryVisibility;
  }) => Effect.Effect<GitHubRepositoryCloneUrls, GitHubCliError>;

  readonly createPullRequest: (input: {
    readonly cwd: string;
    readonly baseBranch: string;
    readonly headSelector: string;
    readonly title: string;
    readonly bodyFile: string;
  }) => Effect.Effect<void, GitHubCliError>;

  readonly getDefaultBranch: (input: {
    readonly cwd: string;
  }) => Effect.Effect<string | null, GitHubCliError>;

  readonly checkoutPullRequest: (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly force?: boolean;
  }) => Effect.Effect<void, GitHubCliError>;

  readonly listIssues: (input: {
    readonly cwd: string;
    readonly state: "open" | "closed" | "all";
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<NormalizedGitHubIssueRecord>, GitHubCliError>;

  readonly getIssue: (input: {
    readonly cwd: string;
    readonly reference: string;
  }) => Effect.Effect<NormalizedGitHubIssueDetail, GitHubCliError>;

  readonly searchIssues: (input: {
    readonly cwd: string;
    readonly query: string;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<NormalizedGitHubIssueRecord>, GitHubCliError>;

  readonly searchPullRequests: (input: {
    readonly cwd: string;
    readonly query: string;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<GitHubPullRequestSummary>, GitHubCliError>;

  readonly getPullRequestDetail: (input: {
    readonly cwd: string;
    readonly reference: string;
  }) => Effect.Effect<GitHubPullRequestDetail, GitHubCliError>;

  readonly getPullRequestFilesViewed: (
    input: SourceControlGetChangeRequestFilesViewedInput,
  ) => Effect.Effect<SourceControlChangeRequestFilesViewed, GitHubCliError>;
  readonly setPullRequestFileViewed: (
    input: SourceControlSetChangeRequestFileViewedInput,
  ) => Effect.Effect<SourceControlSetChangeRequestFileViewedResult, GitHubCliError>;
  readonly getPullRequestDiff: (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly expectedHeadSha?: string | undefined;
  }) => Effect.Effect<string, GitHubCliError>;

  readonly createIssue: (input: {
    readonly cwd: string;
    readonly title: string;
    readonly bodyFile: string;
    readonly labels?: ReadonlyArray<string>;
    readonly assignees?: ReadonlyArray<string>;
  }) => Effect.Effect<{ url: string; number: number }, GitHubCliError>;

  readonly addIssueComment: (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly bodyFile: string;
  }) => Effect.Effect<void, GitHubCliError>;

  readonly addPullRequestComment: (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly bodyFile: string;
  }) => Effect.Effect<void, GitHubCliError>;

  readonly addReaction: (input: {
    readonly cwd: string;
    readonly subjectId: string;
    readonly content: SourceControlCommentReactionContent;
  }) => Effect.Effect<void, GitHubCliError>;

  readonly removeReaction: (input: {
    readonly cwd: string;
    readonly subjectId: string;
    readonly content: SourceControlCommentReactionContent;
  }) => Effect.Effect<void, GitHubCliError>;

  readonly getCommentReactionGroups: (input: {
    readonly cwd: string;
    readonly commentIds: ReadonlyArray<string>;
  }) => Effect.Effect<ReadonlyArray<NormalizedGitHubSubjectReactions>, GitHubCliError>;

  readonly listLabels: (input: {
    readonly cwd: string;
  }) => Effect.Effect<ReadonlyArray<GitHubLabel>, GitHubCliError>;

  readonly listAssignees: (input: {
    readonly cwd: string;
  }) => Effect.Effect<
    ReadonlyArray<{ login: string; name?: string | null; avatarUrl?: string | null }>,
    GitHubCliError
  >;

  readonly listWorkflowRuns: (input: {
    readonly cwd: string;
    readonly headSha?: string;
    readonly branch?: string;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<GitHubWorkflowRun>, GitHubCliError>;

  readonly getPullRequestWorkflowContext: (input: {
    readonly cwd: string;
    readonly reference: string;
  }) => Effect.Effect<GitHubPullRequestWorkflowContext, GitHubCliError>;

  readonly listWorkflowRunJobs: (input: {
    readonly cwd: string;
    readonly runId: string;
  }) => Effect.Effect<ReadonlyArray<GitHubWorkflowJob>, GitHubCliError>;

  readonly getWorkflowJobLog: (input: {
    readonly cwd: string;
    readonly runId: string;
    readonly jobId: string;
  }) => Effect.Effect<string, GitHubCliError>;

  readonly rerunFailedWorkflowJobs: (input: {
    readonly cwd: string;
    readonly runId: string;
  }) => Effect.Effect<void, GitHubCliError>;

  readonly rerunWorkflowJob: (input: {
    readonly cwd: string;
    readonly jobId: string;
  }) => Effect.Effect<void, GitHubCliError>;
}

export class GitHubCli extends Context.Service<GitHubCli, GitHubCliShape>()(
  "ryco/source-control/GitHubCli",
) {}

function errorText(error: VcsError | unknown): string {
  if (typeof error === "object" && error !== null) {
    const tag = "_tag" in error && typeof error._tag === "string" ? error._tag : "";
    const detail = "detail" in error && typeof error.detail === "string" ? error.detail : "";
    const message = "message" in error && typeof error.message === "string" ? error.message : "";
    return [tag, detail, message].filter(Boolean).join("\n");
  }

  return String(error);
}

export function isStatusCheckRollupAccessError(error: GitHubCliError): boolean {
  const causeText = error.cause ? errorText(error.cause) : "";
  const lower = `${errorText(error)}\n${causeText}`.toLowerCase();
  return (
    lower.includes(STATUS_CHECK_ROLLUP_JSON_FIELD.toLowerCase()) &&
    (lower.includes("resource not accessible by integration") ||
      lower.includes("must have actions read permission") ||
      lower.includes("permission") ||
      lower.includes("forbidden") ||
      lower.includes("http 403"))
  );
}

function normalizeGitHubCliError(
  operation: "execute" | "stdout",
  error: VcsError | unknown,
): GitHubCliError {
  const text = errorText(error);
  const lower = text.toLowerCase();

  if (lower.includes("command not found: gh") || lower.includes("enoent")) {
    return new GitHubCliError({
      operation,
      detail: "GitHub CLI (`gh`) is required but not available on PATH.",
      cause: error,
    });
  }

  if (
    lower.includes("authentication failed") ||
    lower.includes("not logged in") ||
    lower.includes("gh auth login") ||
    lower.includes("no oauth token")
  ) {
    return new GitHubCliError({
      operation,
      detail: "GitHub CLI is not authenticated. Run `gh auth login` and retry.",
      cause: error,
    });
  }

  if (
    lower.includes("api rate limit exceeded") ||
    lower.includes("secondary rate limit") ||
    lower.includes("rate limit")
  ) {
    return new GitHubCliError({
      operation,
      detail: "GitHub API rate limit exceeded. Wait for the reset window and retry.",
      cause: error,
    });
  }

  if (
    lower.includes("resource not accessible by integration") ||
    lower.includes("must have actions read permission") ||
    lower.includes("must have actions write permission") ||
    lower.includes("permission denied") ||
    lower.includes("forbidden") ||
    lower.includes("http 403")
  ) {
    return new GitHubCliError({
      operation,
      detail:
        "GitHub Actions is not accessible for this repository. Check token permissions, required Actions access, and repository Actions settings.",
      cause: error,
    });
  }

  if (
    lower.includes("http 410") ||
    lower.includes("gone") ||
    lower.includes("expired") ||
    lower.includes("logs are no longer available")
  ) {
    return new GitHubCliError({
      operation,
      detail: "GitHub Actions logs are no longer available for this run.",
      cause: error,
    });
  }

  if (
    lower.includes("could not resolve to a pullrequest") ||
    lower.includes("repository.pullrequest") ||
    lower.includes("no pull requests found for branch") ||
    lower.includes("pull request not found")
  ) {
    return new GitHubCliError({
      operation,
      detail: "Pull request not found. Check the PR number or URL and try again.",
      cause: error,
    });
  }

  if (
    lower.includes("not found") ||
    lower.includes("http 404") ||
    lower.includes("no workflow runs found")
  ) {
    return new GitHubCliError({
      operation,
      detail: "GitHub Actions run or repository was not found.",
      cause: error,
    });
  }

  return new GitHubCliError({
    operation,
    detail: text,
    cause: error,
  });
}

const RawGitHubRepositoryCloneUrlsSchema = Schema.Struct({
  nameWithOwner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
});

function normalizeRepositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawGitHubRepositoryCloneUrlsSchema>,
): GitHubRepositoryCloneUrls {
  return {
    nameWithOwner: raw.nameWithOwner,
    url: raw.url,
    sshUrl: raw.sshUrl,
  };
}

/**
 * `gh repo create` prints the canonical URL of the new repository on stdout
 * (e.g. `https://github.com/owner/repo`). Reading it back here avoids a
 * follow-up `gh repo view`, which can race GitHub's GraphQL eventual
 * consistency window and falsely report the just-created repo as missing.
 */
function deriveRepositoryCloneUrlsFromCreateOutput(
  stdout: string,
  repository: string,
): GitHubRepositoryCloneUrls {
  const fallbackHost = "github.com";
  const match = stdout.match(/https?:\/\/[^\s]+/);
  if (match) {
    const cleaned = match[0].replace(/\.git$/, "");
    try {
      const parsed = new URL(cleaned);
      const pathname = parsed.pathname.replace(/^\/+|\/+$/g, "");
      const segments = pathname.split("/").filter(Boolean);
      if (segments.length === 2) {
        const nameWithOwner = `${segments[0]}/${segments[1]}`;
        return {
          nameWithOwner,
          url: `${parsed.origin}/${nameWithOwner}`,
          sshUrl: `git@${parsed.host}:${nameWithOwner}.git`,
        };
      }
    } catch {
      // Fall through to the input-derived defaults below.
    }
  }
  return {
    nameWithOwner: repository,
    url: `https://${fallbackHost}/${repository}`,
    sshUrl: `git@${fallbackHost}:${repository}.git`,
  };
}

function decodeGitHubJson<S extends Schema.Top>(
  raw: string,
  schema: S,
  operation: string,
  invalidDetail: string,
): Effect.Effect<S["Type"], GitHubCliError, S["DecodingServices"]> {
  return Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
    Effect.mapError(
      (error) =>
        new GitHubCliError({
          operation,
          detail: `${invalidDetail}: ${SchemaIssue.makeFormatterDefault()(error.issue)}`,
          cause: error,
        }),
    ),
  );
}

function workflowRunLimit(limit: number | undefined): number {
  const value = Math.trunc(limit ?? 20);
  if (!Number.isFinite(value)) return 20;
  return Math.min(50, Math.max(1, value));
}

function workflowRunsEndpoint(input: {
  readonly headSha?: string;
  readonly branch?: string;
  readonly limit?: number;
}) {
  const params = new URLSearchParams();
  params.set("per_page", String(workflowRunLimit(input.limit)));
  if (input.headSha?.trim()) {
    params.set("head_sha", input.headSha.trim());
  } else if (input.branch?.trim()) {
    // `branch` scopes to a ref when we have no specific commit (the default
    // branch has no pull request head to filter on). Mutually exclusive with
    // `head_sha` in the GitHub API, so only one is ever set.
    params.set("branch", input.branch.trim());
  }
  return `repos/{owner}/{repo}/actions/runs?${params.toString()}`;
}

function isWorkflowRerunStateError(error: GitHubCliError): boolean {
  const causeText = error.cause ? errorText(error.cause) : "";
  const lower = `${errorText(error)}\n${causeText}`.toLowerCase();
  return (
    lower.includes("http 422") ||
    lower.includes("unprocessable entity") ||
    lower.includes("cannot rerun") ||
    lower.includes("cannot re-run") ||
    lower.includes("no failed jobs")
  );
}

function withGitHubCliOperation<A>(
  operation: string,
  effect: Effect.Effect<A, GitHubCliError>,
  options?: { readonly normalizeWorkflowRerunErrors?: boolean },
): Effect.Effect<A, GitHubCliError> {
  return effect.pipe(
    Effect.mapError(
      (error) =>
        new GitHubCliError({
          operation,
          detail:
            options?.normalizeWorkflowRerunErrors === true && isWorkflowRerunStateError(error)
              ? "GitHub Actions cannot rerun this workflow run or job in its current state."
              : error.detail,
          cause: error,
        }),
    ),
  );
}

function pullRequestApiReference(reference: string): string {
  const trimmed = reference.trim();
  if (/^\d+$/u.test(trimmed)) return trimmed;

  try {
    const url = new URL(trimmed);
    const match = /\/pull\/(\d+)(?:\/|$)/u.exec(url.pathname);
    if (match?.[1]) return match[1];
  } catch {
    // Fall through to the original input. GitHub will return a useful error.
  }

  return trimmed;
}

function repositoryParts(
  repository: string,
): { readonly owner: string; readonly name: string } | null {
  const match = /^([^/\s]+)\/([^/\s]+)$/u.exec(repository.trim());
  return match?.[1] && match[2] ? { owner: match[1], name: match[2] } : null;
}

function githubApiVersionArgs(): ReadonlyArray<string> {
  return ["-H", `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`];
}

function githubResultOrError<A>(
  result: Result.Result<A, string>,
  operation: string,
): Effect.Effect<A, GitHubCliError> {
  return Result.isSuccess(result)
    ? Effect.succeed(result.success)
    : Effect.fail(new GitHubCliError({ operation, detail: result.failure }));
}

function isAsyncMergeEndpointUnavailable(output: VcsProcess.VcsProcessOutput): boolean {
  return output.exitCode !== 0 && /\bHTTP\s+404\b/iu.test(`${output.stderr}\n${output.stdout}`);
}

function nonEmptyProcessDetail(output: VcsProcess.VcsProcessOutput): string {
  const stderr = output.stderr.trim();
  if (stderr) return stderr;
  const stdout = output.stdout.trim();
  return stdout || `GitHub CLI exited with code ${output.exitCode}.`;
}

const COMMENT_REACTION_GROUPS_QUERY =
  "query($ids:[ID!]!){nodes(ids:$ids){id ... on Reactable{reactionGroups{content viewerHasReacted reactors{totalCount} users{totalCount}}}}}";

function mergeCommentReactionGroups<
  T extends { readonly id?: string; readonly reactions?: ReadonlyArray<NormalizedGitHubReaction> },
>(
  comments: ReadonlyArray<T>,
  groups: ReadonlyArray<NormalizedGitHubSubjectReactions>,
): ReadonlyArray<T> {
  if (groups.length === 0) return comments;
  const reactionsById = new Map(groups.map((group) => [group.id, group.reactions]));
  return comments.map((comment) => {
    if (!comment.id) return comment;
    const reactions = reactionsById.get(comment.id);
    if (!reactions) return comment;
    return {
      ...comment,
      ...(reactions.length > 0 ? { reactions } : { reactions: [] }),
    };
  });
}

export const make = Effect.fn("makeGitHubCli")(function* () {
  const process = yield* VcsProcess.VcsProcess;

  const execute: GitHubCliShape["execute"] = (input) =>
    process
      .run({
        operation: "GitHubCli.execute",
        command: "gh",
        args: input.args,
        cwd: input.cwd,
        ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
        ...(input.allowNonZeroExit !== undefined
          ? { allowNonZeroExit: input.allowNonZeroExit }
          : {}),
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      })
      .pipe(Effect.mapError((error) => normalizeGitHubCliError("execute", error)));

  const viewedIdentitySchema = Schema.Struct({
    id: TrimmedNonEmptyString,
    headRefOid: TrimmedNonEmptyString,
    url: TrimmedNonEmptyString,
  });
  const viewedPageSchema = Schema.Struct({
    data: Schema.Struct({
      node: Schema.Struct({
        headRefOid: TrimmedNonEmptyString,
        files: Schema.Struct({
          nodes: Schema.Array(
            Schema.Struct({
              path: Schema.String.check(Schema.isMinLength(1)),
              viewerViewedState: Schema.Literals(["VIEWED", "UNVIEWED", "DISMISSED"]),
            }),
          ),
          pageInfo: Schema.Struct({
            hasNextPage: Schema.Boolean,
            endCursor: Schema.NullOr(TrimmedNonEmptyString),
          }),
        }),
      }),
    }),
  });
  const resolveViewedIdentity = (input: SourceControlGetChangeRequestFilesViewedInput) =>
    execute({
      cwd: input.cwd,
      args: ["pr", "view", input.reference, "--json", "id,headRefOid,url"],
    }).pipe(
      Effect.flatMap((result) =>
        decodeGitHubJson(
          result.stdout,
          viewedIdentitySchema,
          "viewedFiles",
          "Invalid pull request identity",
        ),
      ),
    );
  const graphql = (cwd: string, url: string, query: string, variables: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const hostname = yield* Effect.try({
        try: () => new URL(url).hostname,
        catch: (cause) =>
          new GitHubCliError({
            operation: "viewedFiles",
            detail: "Invalid pull request URL",
            cause,
          }),
      });
      const result = yield* execute({
        cwd,
        args: [
          "api",
          "graphql",
          "--hostname",
          hostname,
          "-f",
          `query=${query}`,
          ...variables.flatMap((value) => ["-f", value]),
        ],
      });
      return result.stdout;
    });
  const getPullRequestFilesViewed: GitHubCliShape["getPullRequestFilesViewed"] = (input) =>
    Effect.gen(function* () {
      const identity = yield* resolveViewedIdentity(input);
      const files: Array<SourceControlChangeRequestFilesViewed["files"][number]> = [];
      const cursors = new Set<string>();
      const paths = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < 100; page += 1) {
        const raw: string = yield* graphql(
          input.cwd,
          identity.url,
          "query($id:ID!,$cursor:String){node(id:$id){... on PullRequest{headRefOid files(first:100,after:$cursor){nodes{path viewerViewedState} pageInfo{hasNextPage endCursor}}}}}",
          [`id=${identity.id}`, ...(cursor ? [`cursor=${cursor}`] : [])],
        );
        const response: typeof viewedPageSchema.Type = yield* decodeGitHubJson(
          raw,
          viewedPageSchema,
          "getPullRequestFilesViewed",
          "Invalid viewed file response",
        );
        const node = response.data.node;
        if (node.headRefOid !== identity.headRefOid)
          return yield* Effect.fail(
            new GitHubCliError({
              operation: "getPullRequestFilesViewed",
              detail: "Pull request changed while loading review progress. Refresh and try again.",
            }),
          );
        for (const file of node.files.nodes) {
          if (paths.has(file.path))
            return yield* Effect.fail(
              new GitHubCliError({
                operation: "getPullRequestFilesViewed",
                detail: "Duplicate file in GitHub review progress.",
              }),
            );
          paths.add(file.path);
          files.push({
            path: file.path,
            state:
              file.viewerViewedState === "VIEWED"
                ? "viewed"
                : file.viewerViewedState === "DISMISSED"
                  ? "stale"
                  : "unviewed",
          });
        }
        if (!node.files.pageInfo.hasNextPage)
          return {
            provider: "github" as const,
            capability: { storage: "host" as const },
            headSha: identity.headRefOid,
            files,
          };
        cursor = node.files.pageInfo.endCursor;
        if (!cursor || cursors.has(cursor))
          return yield* Effect.fail(
            new GitHubCliError({
              operation: "getPullRequestFilesViewed",
              detail: "Invalid GitHub review progress pagination.",
            }),
          );
        cursors.add(cursor);
      }
      return yield* Effect.fail(
        new GitHubCliError({
          operation: "getPullRequestFilesViewed",
          detail: "GitHub review progress exceeds the pagination limit.",
        }),
      );
    });
  const setPullRequestFileViewed: GitHubCliShape["setPullRequestFileViewed"] = (input) =>
    Effect.gen(function* () {
      const identity = yield* resolveViewedIdentity(input);
      if (identity.headRefOid !== input.expectedHeadSha)
        return yield* Effect.fail(
          new GitHubCliError({
            operation: "setPullRequestFileViewed",
            detail: "Pull request changed. Refresh the diff before updating review progress.",
          }),
        );
      const mutation = input.viewed ? "markFileAsViewed" : "unmarkFileAsViewed";
      const raw = yield* graphql(
        input.cwd,
        identity.url,
        `mutation($id:ID!,$path:String!){${mutation}(input:{pullRequestId:$id,path:$path}){pullRequest{id headRefOid}}}`,
        [`id=${identity.id}`, `path=${input.path}`],
      );
      const result = yield* decodeGitHubJson(
        raw,
        Schema.Struct({
          data: Schema.Struct({
            [mutation]: Schema.Struct({
              pullRequest: Schema.Struct({
                id: TrimmedNonEmptyString,
                headRefOid: TrimmedNonEmptyString,
              }),
            }),
          }),
        }),
        "setPullRequestFileViewed",
        "Invalid viewed file mutation response",
      );
      const updated = result.data[mutation]?.pullRequest;
      if (!updated || updated.id !== identity.id || updated.headRefOid !== input.expectedHeadSha) {
        // GitHub has no expected-head argument. Undo a mark if a push raced it so
        // unseen new content cannot silently remain marked reviewed on the host.
        if (input.viewed)
          yield* graphql(
            input.cwd,
            identity.url,
            "mutation($id:ID!,$path:String!){unmarkFileAsViewed(input:{pullRequestId:$id,path:$path}){pullRequest{id}}}",
            [`id=${identity.id}`, `path=${input.path}`],
          );
        return yield* Effect.fail(
          new GitHubCliError({
            operation: "setPullRequestFileViewed",
            detail: "Pull request changed while updating review progress. Refresh and try again.",
          }),
        );
      }
      return {
        path: input.path,
        state: input.viewed ? ("viewed" as const) : ("unviewed" as const),
        headSha: updated.headRefOid,
      };
    });

  const executePrJson = (input: {
    readonly cwd: string;
    readonly argsBeforeJson: ReadonlyArray<string>;
    readonly jsonFields: ReadonlyArray<string>;
    readonly timeoutMs?: number;
  }) => {
    const run = (jsonFields: ReadonlyArray<string>) =>
      execute({
        cwd: input.cwd,
        args: [...input.argsBeforeJson, "--json", formatGitHubJsonFields(jsonFields)],
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      });

    return run(input.jsonFields).pipe(
      Effect.catchIf(isStatusCheckRollupAccessError, () =>
        run(withoutStatusCheckRollupJsonField(input.jsonFields)),
      ),
    );
  };

  const getCommentReactionGroups: GitHubCliShape["getCommentReactionGroups"] = (input) => {
    const commentIds = [...new Set(input.commentIds.map((id) => id.trim()).filter(Boolean))];
    if (commentIds.length === 0) return Effect.succeed([]);
    return execute({
      cwd: input.cwd,
      args: [
        "api",
        "graphql",
        "-f",
        `query=${COMMENT_REACTION_GROUPS_QUERY}`,
        ...commentIds.flatMap((id) => ["-F", `ids[]=${id}`]),
      ],
    }).pipe(
      Effect.map((r) => r.stdout.trim()),
      Effect.flatMap((raw) =>
        Effect.sync(() => decodeGitHubReactionGroupsBySubjectJson(raw)).pipe(
          Effect.flatMap((decoded) =>
            Result.isSuccess(decoded)
              ? Effect.succeed(decoded.success)
              : Effect.fail(
                  new GitHubCliError({
                    operation: "getCommentReactionGroups",
                    detail: `GitHub CLI returned invalid reaction group JSON: ${formatGitHubReactionGroupsDecodeError(decoded.failure)}`,
                    cause: decoded.failure,
                  }),
                ),
          ),
        ),
      ),
    );
  };

  const hydrateCommentReactionGroups = <
    T extends {
      readonly comments: ReadonlyArray<{
        readonly id?: string;
        readonly reactions?: ReadonlyArray<NormalizedGitHubReaction>;
      }>;
    },
  >(
    cwd: string,
    detail: T,
  ): Effect.Effect<T, GitHubCliError> => {
    const commentIds = detail.comments.flatMap((comment) => (comment.id ? [comment.id] : []));
    if (commentIds.length === 0) return Effect.succeed(detail);
    return getCommentReactionGroups({ cwd, commentIds }).pipe(
      Effect.map(
        (groups) =>
          ({
            ...detail,
            comments: mergeCommentReactionGroups(detail.comments, groups),
          }) as T,
      ),
      Effect.catch(() => Effect.succeed(detail)),
    );
  };

  const getPullRequestStack: GitHubCliShape["getPullRequestStack"] = (input) =>
    Effect.gen(function* () {
      const parts = repositoryParts(input.repository);
      if (!parts) {
        return yield* new GitHubCliError({
          operation: "getPullRequestStack",
          detail: "GitHub repository must be in owner/repository form.",
        });
      }

      const pages: GitHubPullRequestStacks.DecodedGitHubPullRequestStackPage[] = [];
      const seenCursors = new Set<string>();
      let after: string | null = null;
      while (true) {
        const result: VcsProcess.VcsProcessOutput = yield* execute({
          cwd: input.cwd,
          args: [
            "api",
            "graphql",
            "--hostname",
            input.host,
            "-f",
            `query=${GitHubPullRequestStacks.GITHUB_PULL_REQUEST_STACK_QUERY}`,
            "-f",
            `owner=${parts.owner}`,
            "-f",
            `repo=${parts.name}`,
            "-F",
            `number=${input.number}`,
            "-F",
            `first=${GitHubPullRequestStacks.GITHUB_STACK_PAGE_SIZE}`,
            ...(after ? ["-f", `after=${after}`] : []),
          ],
        });
        const page: GitHubPullRequestStacks.DecodedGitHubPullRequestStackPage =
          yield* githubResultOrError(
            GitHubPullRequestStacks.decodeGitHubPullRequestStackPageJson(result.stdout.trim()),
            "getPullRequestStack",
          );
        pages.push(page);
        if (!page.stack?.hasNextPage) break;
        const cursor: string | null = page.stack.endCursor;
        if (!cursor || seenCursors.has(cursor)) {
          return yield* new GitHubCliError({
            operation: "getPullRequestStack",
            detail: "GitHub returned an invalid or repeated stack pagination cursor.",
          });
        }
        seenCursors.add(cursor);
        after = cursor;
      }

      return yield* githubResultOrError(
        GitHubPullRequestStacks.normalizeGitHubPullRequestStackPages(pages, input.number),
        "getPullRequestStack",
      );
    });

  const getPullRequestStackSummaries: GitHubCliShape["getPullRequestStackSummaries"] = (input) =>
    Effect.gen(function* () {
      const parts = repositoryParts(input.repository);
      if (!parts) {
        return yield* new GitHubCliError({
          operation: "getPullRequestStackSummaries",
          detail: "GitHub repository must be in owner/repository form.",
        });
      }
      const numbers = [...new Set(input.numbers)].filter(
        (number) => Number.isSafeInteger(number) && number > 0,
      );
      if (numbers.length === 0) return new Map();
      const batches: number[][] = [];
      for (
        let index = 0;
        index < numbers.length;
        index += GitHubPullRequestStacks.GITHUB_STACK_SUMMARY_BATCH_SIZE
      ) {
        batches.push(
          numbers.slice(index, index + GitHubPullRequestStacks.GITHUB_STACK_SUMMARY_BATCH_SIZE),
        );
      }
      const results = yield* Effect.forEach(
        batches,
        (batch) =>
          execute({
            cwd: input.cwd,
            args: [
              "api",
              "graphql",
              "--hostname",
              input.host,
              "-f",
              `query=${GitHubPullRequestStacks.buildGitHubPullRequestStackSummariesQuery(batch)}`,
              "-f",
              `owner=${parts.owner}`,
              "-f",
              `repo=${parts.name}`,
            ],
          }).pipe(
            Effect.flatMap((result) =>
              githubResultOrError(
                GitHubPullRequestStacks.decodeGitHubPullRequestStackSummariesJson(
                  result.stdout.trim(),
                  batch,
                ),
                "getPullRequestStackSummaries",
              ),
            ),
          ),
        { concurrency: 2 },
      );
      const summaries = new Map<number, SourceControlChangeRequestStackSummary>();
      for (const result of results) {
        for (const [number, summary] of result) summaries.set(number, summary);
      }
      return summaries;
    });

  const getRepositoryMergeCapabilities: GitHubCliShape["getRepositoryMergeCapabilities"] = (
    input,
  ) =>
    execute({
      cwd: input.cwd,
      args: [
        "api",
        "--hostname",
        input.host,
        ...githubApiVersionArgs(),
        `repos/${input.repository}`,
      ],
    }).pipe(
      Effect.flatMap((result) =>
        githubResultOrError(
          GitHubPullRequestStacks.decodeGitHubRepositoryMergeCapabilitiesJson(result.stdout.trim()),
          "getRepositoryMergeCapabilities",
        ),
      ),
    );

  const mergePullRequestAsync: GitHubCliShape["mergePullRequestAsync"] = (input) =>
    Effect.gen(function* () {
      const endpoint = `repos/${input.repository}/pulls/${input.number}/merge-async`;
      const submission = yield* execute({
        cwd: input.cwd,
        args: [
          "api",
          "--hostname",
          input.host,
          ...githubApiVersionArgs(),
          "--method",
          "PUT",
          endpoint,
          "--input",
          "-",
        ],
        stdin: JSON.stringify({ merge_method: input.mergeMethod, merge_action: "default" }),
        allowNonZeroExit: true,
      });

      if (isAsyncMergeEndpointUnavailable(submission)) {
        if (input.stackMembership === "stacked") {
          return yield* new GitHubCliError({
            operation: "mergePullRequestAsync",
            detail:
              "GitHub's asynchronous merge endpoint is unavailable. A known stack cannot be merged through the legacy single-pull-request command.",
            reason: "async-merge-unavailable",
          });
        }
        const legacy = yield* execute({
          cwd: input.cwd,
          args: [
            "pr",
            "merge",
            String(input.number),
            "--repo",
            `${input.host}/${input.repository}`,
            `--${input.mergeMethod}`,
          ],
        });
        return {
          outcome: /merge queue/iu.test(`${legacy.stdout}\n${legacy.stderr}`)
            ? "enqueued"
            : "merged",
        };
      }

      const decodeOutput = (output: VcsProcess.VcsProcessOutput) => {
        const raw = output.stdout.trim();
        if (!raw) {
          return Effect.fail(
            new GitHubCliError({
              operation: "mergePullRequestAsync",
              detail: nonEmptyProcessDetail(output),
            }),
          );
        }
        return githubResultOrError(
          GitHubPullRequestStacks.decodeGitHubAsyncMergeResultJson(raw),
          "mergePullRequestAsync",
        );
      };

      const awaitMerge = Effect.gen(function* () {
        let result = yield* decodeOutput(submission);
        for (let pollCount = 0; ; pollCount += 1) {
          switch (result.status) {
            case "merged":
              return { outcome: "merged" as const };
            case "enqueued":
              return { outcome: "enqueued" as const };
            case "failed":
              return yield* new GitHubCliError({
                operation: "mergePullRequestAsync",
                detail: result.message || "GitHub could not merge the pull request.",
              });
            case "pending": {
              if (!result.uuid) {
                return yield* new GitHubCliError({
                  operation: "mergePullRequestAsync",
                  detail: "GitHub returned a pending merge request without an identifier.",
                });
              }
              if (pollCount >= ASYNC_MERGE_POLL_LIMIT) {
                return yield* new GitHubCliError({
                  operation: "mergePullRequestAsync",
                  detail: "GitHub's asynchronous merge did not finish within five minutes.",
                });
              }
              yield* Effect.sleep("1 second");
              const poll = yield* execute({
                cwd: input.cwd,
                args: [
                  "api",
                  "--hostname",
                  input.host,
                  ...githubApiVersionArgs(),
                  `${endpoint}/${result.uuid}`,
                ],
                allowNonZeroExit: true,
              });
              result = yield* decodeOutput(poll);
              break;
            }
          }
        }
      });
      return yield* awaitMerge.pipe(
        Effect.timeoutOrElse({
          duration: "5 minutes",
          orElse: () =>
            Effect.fail(
              new GitHubCliError({
                operation: "mergePullRequestAsync",
                detail: "GitHub's asynchronous merge did not finish within five minutes.",
              }),
            ),
        }),
      );
    });

  return GitHubCli.of({
    execute,
    getPullRequestStack,
    getPullRequestStackSummaries,
    getRepositoryMergeCapabilities,
    mergePullRequestAsync,
    listOpenPullRequests: (input) =>
      executePrJson({
        cwd: input.cwd,
        argsBeforeJson: [
          "pr",
          "list",
          "--head",
          input.headSelector,
          "--state",
          "open",
          "--limit",
          String(input.limit ?? 1),
        ],
        jsonFields: GITHUB_PULL_REQUEST_SUMMARY_JSON_FIELDS,
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : Effect.sync(() => GitHubPullRequests.decodeGitHubPullRequestListJson(raw)).pipe(
                Effect.flatMap((decoded) => {
                  if (!Result.isSuccess(decoded)) {
                    return Effect.fail(
                      new GitHubCliError({
                        operation: "listOpenPullRequests",
                        detail: `GitHub CLI returned invalid PR list JSON: ${GitHubPullRequests.formatGitHubJsonDecodeError(decoded.failure)}`,
                        cause: decoded.failure,
                      }),
                    );
                  }

                  return Effect.succeed(
                    decoded.success.map(({ updatedAt: _updatedAt, ...summary }) => summary),
                  );
                }),
              ),
        ),
      ),
    getPullRequest: (input) =>
      executePrJson({
        cwd: input.cwd,
        argsBeforeJson: ["pr", "view", input.reference],
        jsonFields: GITHUB_PULL_REQUEST_SUMMARY_JSON_FIELDS,
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          Effect.sync(() => GitHubPullRequests.decodeGitHubPullRequestJson(raw)).pipe(
            Effect.flatMap((decoded) => {
              if (!Result.isSuccess(decoded)) {
                return Effect.fail(
                  new GitHubCliError({
                    operation: "getPullRequest",
                    detail: `GitHub CLI returned invalid pull request JSON: ${GitHubPullRequests.formatGitHubJsonDecodeError(decoded.failure)}`,
                    cause: decoded.failure,
                  }),
                );
              }

              return Effect.succeed(
                (({ updatedAt: _updatedAt, ...summary }) => summary)(decoded.success),
              );
            }),
          ),
        ),
      ),
    getRepositoryCloneUrls: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "view", input.repository, "--json", "nameWithOwner,url,sshUrl"],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeGitHubJson(
            raw,
            RawGitHubRepositoryCloneUrlsSchema,
            "getRepositoryCloneUrls",
            "GitHub CLI returned invalid repository JSON.",
          ),
        ),
        Effect.map(normalizeRepositoryCloneUrls),
      ),
    createRepository: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "create", input.repository, `--${input.visibility}`],
      }).pipe(
        Effect.map((result) =>
          deriveRepositoryCloneUrlsFromCreateOutput(result.stdout, input.repository),
        ),
      ),
    createPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "create",
          "--base",
          input.baseBranch,
          "--head",
          input.headSelector,
          "--title",
          input.title,
          "--body-file",
          input.bodyFile,
        ],
      }).pipe(Effect.asVoid),
    getDefaultBranch: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
      }).pipe(
        Effect.map((value) => {
          const trimmed = value.stdout.trim();
          return trimmed.length > 0 ? trimmed : null;
        }),
      ),
    checkoutPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: ["pr", "checkout", input.reference, ...(input.force ? ["--force"] : [])],
      }).pipe(Effect.asVoid),
    listIssues: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "issue",
          "list",
          "--state",
          input.state,
          "--limit",
          String(input.limit ?? 50),
          "--json",
          "number,title,url,state,updatedAt,author,labels,assignees,comments",
        ],
      }).pipe(
        Effect.map((r) => r.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : Effect.sync(() => GitHubIssues.decodeGitHubIssueListJson(raw)).pipe(
                Effect.flatMap((decoded) =>
                  Result.isSuccess(decoded)
                    ? Effect.succeed(decoded.success)
                    : Effect.fail(
                        new GitHubCliError({
                          operation: "listIssues",
                          detail: `GitHub CLI returned invalid issue list JSON: ${GitHubIssues.formatGitHubIssueDecodeError(decoded.failure)}`,
                          cause: decoded.failure,
                        }),
                      ),
                ),
              ),
        ),
      ),
    getIssue: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "issue",
          "view",
          input.reference,
          "--json",
          "number,title,url,state,updatedAt,author,labels,assignees,body,comments",
        ],
      }).pipe(
        Effect.map((r) => r.stdout.trim()),
        Effect.flatMap((raw) =>
          Effect.sync(() => GitHubIssues.decodeGitHubIssueDetailJson(raw)).pipe(
            Effect.flatMap((decoded) =>
              Result.isSuccess(decoded)
                ? hydrateCommentReactionGroups(input.cwd, decoded.success)
                : Effect.fail(
                    new GitHubCliError({
                      operation: "getIssue",
                      detail: `GitHub CLI returned invalid issue JSON: ${GitHubIssues.formatGitHubIssueDecodeError(decoded.failure)}`,
                      cause: decoded.failure,
                    }),
                  ),
            ),
          ),
        ),
      ),
    searchIssues: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "issue",
          "list",
          "--search",
          input.query,
          "--limit",
          String(input.limit ?? 20),
          "--json",
          "number,title,url,state,updatedAt,author,labels,assignees,comments",
        ],
      }).pipe(
        Effect.map((r) => r.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : Effect.sync(() => GitHubIssues.decodeGitHubIssueListJson(raw)).pipe(
                Effect.flatMap((decoded) =>
                  Result.isSuccess(decoded)
                    ? Effect.succeed(decoded.success)
                    : Effect.fail(
                        new GitHubCliError({
                          operation: "searchIssues",
                          detail: `GitHub CLI returned invalid issue list JSON: ${GitHubIssues.formatGitHubIssueDecodeError(decoded.failure)}`,
                          cause: decoded.failure,
                        }),
                      ),
                ),
              ),
        ),
      ),
    searchPullRequests: (input) =>
      executePrJson({
        cwd: input.cwd,
        argsBeforeJson: [
          "pr",
          "list",
          "--search",
          input.query,
          "--limit",
          String(input.limit ?? 20),
        ],
        jsonFields: GITHUB_PULL_REQUEST_SUMMARY_JSON_FIELDS,
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : Effect.sync(() => GitHubPullRequests.decodeGitHubPullRequestListJson(raw)).pipe(
                Effect.flatMap((decoded) => {
                  if (!Result.isSuccess(decoded)) {
                    return Effect.fail(
                      new GitHubCliError({
                        operation: "searchPullRequests",
                        detail: `GitHub CLI returned invalid PR list JSON: ${GitHubPullRequests.formatGitHubJsonDecodeError(decoded.failure)}`,
                        cause: decoded.failure,
                      }),
                    );
                  }
                  return Effect.succeed(
                    decoded.success.map(({ updatedAt: _updatedAt, ...summary }) => summary),
                  );
                }),
              ),
        ),
      ),
    getPullRequestDetail: (input) =>
      executePrJson({
        cwd: input.cwd,
        argsBeforeJson: ["pr", "view", input.reference],
        jsonFields: GITHUB_PULL_REQUEST_DETAIL_JSON_FIELDS,
      }).pipe(
        Effect.map((r) => r.stdout.trim()),
        Effect.flatMap((raw) =>
          Effect.sync(() => GitHubPullRequests.decodeGitHubPullRequestDetailJson(raw)).pipe(
            Effect.flatMap((decoded) => {
              if (!Result.isSuccess(decoded)) {
                return Effect.fail(
                  new GitHubCliError({
                    operation: "getPullRequestDetail",
                    detail: `GitHub CLI returned invalid pull request JSON: ${GitHubPullRequests.formatGitHubJsonDecodeError(decoded.failure)}`,
                    cause: decoded.failure,
                  }),
                );
              }
              const { updatedAt: _updatedAt, ...rest } = decoded.success;
              return hydrateCommentReactionGroups(input.cwd, rest);
            }),
          ),
        ),
      ),
    getPullRequestFilesViewed,
    setPullRequestFileViewed,
    getPullRequestDiff: (input) =>
      Effect.gen(function* () {
        const verifyHead = () =>
          resolveViewedIdentity(input).pipe(
            Effect.flatMap((identity) =>
              identity.headRefOid === input.expectedHeadSha
                ? Effect.void
                : Effect.fail(
                    new GitHubCliError({
                      operation: "getPullRequestDiff",
                      detail: "Pull request changed while loading the diff. Refresh and try again.",
                    }),
                  ),
            ),
          );
        if (input.expectedHeadSha) yield* verifyHead();
        const result = yield* execute({ cwd: input.cwd, args: ["pr", "diff", input.reference] });
        if (input.expectedHeadSha) yield* verifyHead();
        return result.stdout;
      }),
    createIssue: (input) =>
      execute({
        cwd: input.cwd,
        args: buildGitHubIssueCreateArgv({
          title: input.title,
          bodyFile: input.bodyFile,
          ...(input.labels ? { labels: input.labels } : {}),
          ...(input.assignees ? { assignees: input.assignees } : {}),
        }),
      }).pipe(
        Effect.flatMap((r) => {
          const parsed = parseGitHubIssueCreateOutput(r.stdout);
          return parsed
            ? Effect.succeed(parsed)
            : Effect.fail(
                new GitHubCliError({
                  operation: "createIssue",
                  detail: `Unrecognized 'gh issue create' output: ${r.stdout.slice(0, 200)}`,
                }),
              );
        }),
      ),
    addIssueComment: (input) =>
      execute({
        cwd: input.cwd,
        args: ["issue", "comment", input.reference, "--body-file", input.bodyFile],
      }).pipe(Effect.asVoid),
    addPullRequestComment: (input) =>
      execute({
        cwd: input.cwd,
        args: ["pr", "comment", input.reference, "--body-file", input.bodyFile],
      }).pipe(Effect.asVoid),
    addReaction: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "api",
          "graphql",
          "-f",
          "query=mutation($subjectId:ID!,$content:ReactionContent!){addReaction(input:{subjectId:$subjectId,content:$content}){reaction{content}}}",
          "-f",
          `subjectId=${input.subjectId}`,
          "-f",
          `content=${toGitHubReactionContent(input.content)}`,
        ],
      }).pipe(Effect.asVoid),
    removeReaction: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "api",
          "graphql",
          "-f",
          "query=mutation($subjectId:ID!,$content:ReactionContent!){removeReaction(input:{subjectId:$subjectId,content:$content}){reaction{content}}}",
          "-f",
          `subjectId=${input.subjectId}`,
          "-f",
          `content=${toGitHubReactionContent(input.content)}`,
        ],
      }).pipe(Effect.asVoid),
    getCommentReactionGroups,
    listLabels: (input) =>
      execute({
        cwd: input.cwd,
        args: ["label", "list", "--json", "name,color,description", "--limit", "1000"],
      }).pipe(
        Effect.map((r) => r.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : Effect.sync(() => GitHubIssues.decodeJsonLabelList(raw)).pipe(
                Effect.flatMap((decoded) =>
                  Result.isSuccess(decoded)
                    ? Effect.succeed(
                        decoded.success.map((l) => ({
                          name: l.name,
                          ...(l.color ? { color: l.color } : {}),
                          ...(l.description ? { description: l.description } : {}),
                        })),
                      )
                    : Effect.fail(
                        new GitHubCliError({
                          operation: "listLabels",
                          detail: `Invalid label list output: ${formatSchemaError(decoded.failure)}`,
                          cause: decoded.failure,
                        }),
                      ),
                ),
              ),
        ),
      ),
    listAssignees: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "api",
          "-X",
          "GET",
          "repos/{owner}/{repo}/assignees",
          "-F",
          "per_page=100",
          "--paginate",
        ],
      }).pipe(
        Effect.map((r) => r.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : Effect.sync(() => GitHubIssues.decodeJsonAssigneeList(raw)).pipe(
                Effect.flatMap((decoded) =>
                  Result.isSuccess(decoded)
                    ? Effect.succeed(
                        decoded.success.map((u) => ({
                          login: u.login,
                          ...(u.name ? { name: u.name } : {}),
                          ...(u.avatar_url ? { avatarUrl: u.avatar_url } : {}),
                        })),
                      )
                    : Effect.fail(
                        new GitHubCliError({
                          operation: "listAssignees",
                          detail: `Invalid assignees output: ${formatSchemaError(decoded.failure)}`,
                          cause: decoded.failure,
                        }),
                      ),
                ),
              ),
        ),
      ),
    listWorkflowRuns: (input) =>
      execute({
        cwd: input.cwd,
        args: ["api", workflowRunsEndpoint(input)],
        timeoutMs: 45_000,
      }).pipe(
        Effect.map((r) => r.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : Effect.sync(() => GitHubActions.decodeGitHubWorkflowRunsJson(raw)).pipe(
                Effect.flatMap((decoded) =>
                  Result.isSuccess(decoded)
                    ? Effect.succeed(decoded.success)
                    : Effect.fail(
                        new GitHubCliError({
                          operation: "listWorkflowRuns",
                          detail: `Invalid workflow run output: ${GitHubActions.formatGitHubWorkflowDecodeError(decoded.failure)}`,
                          cause: decoded.failure,
                        }),
                      ),
                ),
              ),
        ),
      ),
    getPullRequestWorkflowContext: (input) =>
      execute({
        cwd: input.cwd,
        args: ["api", `repos/{owner}/{repo}/pulls/${pullRequestApiReference(input.reference)}`],
      }).pipe(
        Effect.map((r) => r.stdout.trim()),
        Effect.flatMap((raw) =>
          Effect.sync(() => GitHubActions.decodeGitHubPullRequestWorkflowContextJson(raw)).pipe(
            Effect.flatMap((decoded) =>
              Result.isSuccess(decoded)
                ? Effect.succeed(decoded.success)
                : Effect.fail(
                    new GitHubCliError({
                      operation: "getPullRequestWorkflowContext",
                      detail: `Invalid pull request workflow context output: ${GitHubActions.formatGitHubWorkflowDecodeError(decoded.failure)}`,
                      cause: decoded.failure,
                    }),
                  ),
            ),
          ),
        ),
      ),
    listWorkflowRunJobs: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "api",
          "--paginate",
          "--slurp",
          `repos/{owner}/{repo}/actions/runs/${input.runId}/jobs?per_page=100`,
        ],
        timeoutMs: 45_000,
      }).pipe(
        Effect.map((r) => r.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : Effect.sync(() => GitHubActions.decodeGitHubWorkflowJobsJson(raw)).pipe(
                Effect.flatMap((decoded) =>
                  Result.isSuccess(decoded)
                    ? Effect.succeed(decoded.success)
                    : Effect.fail(
                        new GitHubCliError({
                          operation: "listWorkflowRunJobs",
                          detail: `Invalid workflow jobs output: ${GitHubActions.formatGitHubWorkflowDecodeError(decoded.failure)}`,
                          cause: decoded.failure,
                        }),
                      ),
                ),
              ),
        ),
      ),
    getWorkflowJobLog: (input) =>
      execute({
        cwd: input.cwd,
        args: ["run", "view", input.runId, "--job", input.jobId, "--log"],
        timeoutMs: 60_000,
      }).pipe(Effect.map((r) => r.stdout)),
    rerunFailedWorkflowJobs: (input) =>
      withGitHubCliOperation(
        "rerunFailedWorkflowJobs",
        execute({
          cwd: input.cwd,
          args: [
            "api",
            "-X",
            "POST",
            `repos/{owner}/{repo}/actions/runs/${input.runId}/rerun-failed-jobs`,
          ],
          timeoutMs: 45_000,
        }),
        { normalizeWorkflowRerunErrors: true },
      ).pipe(Effect.asVoid),
    rerunWorkflowJob: (input) =>
      withGitHubCliOperation(
        "rerunWorkflowJob",
        execute({
          cwd: input.cwd,
          args: ["api", "-X", "POST", `repos/{owner}/{repo}/actions/jobs/${input.jobId}/rerun`],
          timeoutMs: 45_000,
        }),
        { normalizeWorkflowRerunErrors: true },
      ).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(GitHubCli, make());
