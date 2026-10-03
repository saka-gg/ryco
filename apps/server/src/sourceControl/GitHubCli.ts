import { Context, DateTime, Effect, Layer, Option, Result, Schema, SchemaIssue } from "effect";

import {
  CHANGE_REQUEST_FILE_CONTENTS_MAX_BYTES,
  PositiveInt,
  TrimmedNonEmptyString,
  type ChangeRequestActivity,
  type ChangeRequestDraftReviewComment,
  type ChangeRequestFileContents,
  type ChangeRequestFileContentsInput,
  type ChangeRequestReviewEvent,
  type ChangeRequestReviewThread,
  type ChangeRequestSetThreadResolvedResult,
  type ChangeRequestSubmitReviewResult,
  type ChangeRequestUpdateAction,
  type ChangeRequestUpdateCommentInput,
  type ChangeRequestUpdateCommentResult,
  type SourceControlChangeRequestAutoMerge,
  type SourceControlChangeRequestMergeStateStatus,
  type SourceControlChangeRequestReviewDecision,
  type SourceControlChangeRequestReviewer,
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
import { parseGitHubRepositoryIdentityFromUrl } from "@ryco/shared/sourceControl";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubIssues from "./gitHubIssues.ts";
import type { NormalizedGitHubIssueDetail, NormalizedGitHubIssueRecord } from "./gitHubIssues.ts";
import * as GitHubActions from "./gitHubActions.ts";
import { buildGitHubIssueCreateArgv, parseGitHubIssueCreateOutput } from "./gitHubIssueCreate.ts";
import {
  appendCommentMutationMarker,
  hasCommentMutationMarker,
} from "./gitHubCommentMutationMarker.ts";
import * as GitHubPullRequestActivity from "./gitHubPullRequestActivity.ts";
import * as GitHubPullRequestMutations from "./gitHubPullRequestMutations.ts";
import * as GitHubPullRequests from "./gitHubPullRequests.ts";
import * as GitHubPullRequestStacks from "./gitHubPullRequestStacks.ts";
import * as GitHubRequiredChecks from "./gitHubRequiredChecks.ts";
import {
  decodeGitHubReactionGroupsBySubjectJson,
  formatGitHubReactionGroupsDecodeError,
  toGitHubReactionContent,
  type NormalizedGitHubReaction,
  type NormalizedGitHubSubjectReactions,
} from "./gitHubReactions.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
/** Ceiling for a single-commit diff; larger diffs fail clearly instead of truncating mid-hunk. */
const COMMIT_DIFF_MAX_BYTES = 8 * 1024 * 1024;
const FILE_CONTENTS_TIMEOUT_MS = 60_000;
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
  "updatedAt",
  ...GITHUB_PULL_REQUEST_METADATA_JSON_FIELDS,
  STATUS_CHECK_ROLLUP_JSON_FIELD,
] as const;

export const GITHUB_PULL_REQUEST_LIST_JSON_FIELDS = [
  ...GITHUB_PULL_REQUEST_CORE_JSON_FIELDS,
  "updatedAt",
  "createdAt",
  "reviewDecision",
  "additions",
  "deletions",
  "changedFiles",
  ...GITHUB_PULL_REQUEST_METADATA_JSON_FIELDS,
  STATUS_CHECK_ROLLUP_JSON_FIELD,
] as const;

export const GITHUB_PULL_REQUEST_DETAIL_JSON_FIELDS = [
  ...GITHUB_PULL_REQUEST_CORE_JSON_FIELDS,
  "updatedAt",
  "createdAt",
  "closedAt",
  "mergedBy",
  "reviewDecision",
  "latestReviews",
  "mergeStateStatus",
  "autoMergeRequest",
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
  readonly updatedAt?: Option.Option<DateTime.Utc>;
  readonly createdAt?: DateTime.Utc;
  readonly reviewDecision?: SourceControlChangeRequestReviewDecision | null;
  readonly additions?: number;
  readonly deletions?: number;
  readonly changedFiles?: number;
}

/** Resolved identity of a pull request, used to address API calls precisely. */
export interface GitHubPullRequestTarget {
  /** GraphQL node id. */
  readonly id: string;
  readonly number: number;
  readonly url: string;
  readonly host: string;
  readonly owner: string;
  readonly name: string;
  readonly nameWithOwner: string;
  /** `host/owner/name`, the `--repo` form `gh` accepts for any host. */
  readonly repo: string;
  readonly state: "open" | "closed" | "merged";
  readonly headRefOid: string;
  readonly headRefName: string;
  readonly baseRefName: string;
  /** Base tip GitHub last diffed against (frozen at merge time for merged pull requests). */
  readonly baseRefOid: string | null;
  readonly isCrossRepository: boolean;
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
  readonly reviewerStates?: ReadonlyArray<SourceControlChangeRequestReviewer>;
  readonly mergeStateStatus?: SourceControlChangeRequestMergeStateStatus;
  readonly autoMerge?: SourceControlChangeRequestAutoMerge | null;
  readonly closedAt?: DateTime.Utc;
  readonly mergedAt?: DateTime.Utc;
  readonly mergedBy?: string;
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
    readonly maxOutputBytes?: number;
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
  }) => Effect.Effect<GitHubRepositoryMergeCapabilities, GitHubCliError>;

  /** Which checks on `headSha` the pull request's base branch requires (paged, bounded). */
  readonly getPullRequestRequiredChecks: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly host: string;
    readonly number: number;
    readonly headSha: string;
  }) => Effect.Effect<
    ReadonlyArray<GitHubRequiredChecks.NormalizedGitHubRequiredCheck>,
    GitHubCliError
  >;

  readonly mergePullRequestAsync: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly host: string;
    readonly number: number;
    readonly mergeMethod: SourceControlChangeRequestMergeMethod;
    readonly stackMembership: "stacked" | "standalone";
    /** GitHub refuses the merge when the head no longer matches. */
    readonly expectedHeadSha?: string | undefined;
  }) => Effect.Effect<{ readonly outcome: "merged" | "enqueued" }, GitHubCliError>;

  /** Delete a same-repository head branch (`DELETE git/refs/heads/<branch>`); a missing ref is success. */
  readonly deleteBranch: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly host: string;
    readonly branch: string;
  }) => Effect.Effect<void, GitHubCliError>;

  readonly getPullRequestTarget: (input: {
    readonly cwd: string;
    readonly reference: string;
  }) => Effect.Effect<GitHubPullRequestTarget, GitHubCliError>;

  readonly getPullRequestActivity: (input: {
    readonly cwd: string;
    readonly reference: string;
  }) => Effect.Effect<ChangeRequestActivity, GitHubCliError>;

  readonly getPullRequestReviewThread: (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly threadId: string;
  }) => Effect.Effect<ChangeRequestReviewThread, GitHubCliError>;

  /** Reply, skipping the post when a reply with the same `clientMutationId` already exists. */
  readonly replyToPullRequestReviewThread: (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly threadId: string;
    readonly body: string;
    readonly clientMutationId?: string | undefined;
  }) => Effect.Effect<ChangeRequestReviewThread, GitHubCliError>;

  readonly setPullRequestReviewThreadResolved: (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly threadId: string;
    readonly resolved: boolean;
  }) => Effect.Effect<ChangeRequestSetThreadResolvedResult, GitHubCliError>;

  readonly updatePullRequestComment: (
    input: ChangeRequestUpdateCommentInput,
  ) => Effect.Effect<ChangeRequestUpdateCommentResult, GitHubCliError>;

  readonly submitPullRequestReview: (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly event: ChangeRequestReviewEvent;
    readonly body?: string | undefined;
    readonly comments: ReadonlyArray<ChangeRequestDraftReviewComment>;
    readonly expectedHeadSha: string;
  }) => Effect.Effect<ChangeRequestSubmitReviewResult, GitHubCliError>;

  /** Apply one lifecycle action. `bodyFile` carries a new description for `edit`. */
  readonly updatePullRequest: (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly action: ChangeRequestUpdateAction;
    readonly bodyFile?: string | undefined;
  }) => Effect.Effect<void, GitHubCliError>;

  readonly getPullRequestFileContents: (
    input: ChangeRequestFileContentsInput,
  ) => Effect.Effect<ChangeRequestFileContents, GitHubCliError>;

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
    readonly draft?: boolean | undefined;
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
    /** Scope the diff to one commit of the pull request. */
    readonly commitSha?: string | undefined;
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

export type GitHubRepositoryMergeCapabilities = SourceControlChangeRequestMergeCapabilities & {
  /** Repository setting `delete_branch_on_merge`, when GitHub reported it. */
  readonly deleteBranchOnMerge?: boolean;
};

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

/**
 * Which GitHub surface a `gh` invocation targets. Actions calls keep their
 * Actions-specific guidance; everything else (pull requests, reviews,
 * comments, mutations) gets messages that describe the actual failure.
 */
export type GitHubCliErrorDomain = "actions" | "general";

export function gitHubCliErrorDomain(args: ReadonlyArray<string>): GitHubCliErrorDomain {
  const command = args[0];
  if (command === "run" || command === "workflow") return "actions";
  return args.some((arg) => /(?:^|\/)actions\//u.test(arg)) ? "actions" : "general";
}

/**
 * GitHub's own wording from `gh` stderr (`gh: Not Found (HTTP 404)`,
 * `GraphQL: … (path)`) or an API error body, without process noise.
 */
export function gitHubErrorMessage(error: VcsError | unknown): string | null {
  const source =
    typeof error === "object" &&
    error !== null &&
    "detail" in error &&
    typeof error.detail === "string"
      ? error.detail
      : errorText(error);
  const lines = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (const line of lines) {
    const match = /^(?:gh:|GraphQL:|error:)\s*(.+)$/iu.exec(line);
    if (match?.[1]) return match[1].trim();
  }
  return lines[0] ?? null;
}

/** Messages from a GitHub REST or GraphQL error body (`{message, errors:[…]}`). */
export function gitHubApiErrorBodyMessage(raw: string): string | null {
  const text = raw.trim();
  if (!text.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(text) as {
      readonly message?: unknown;
      readonly errors?: unknown;
    };
    const details = Array.isArray(parsed.errors)
      ? parsed.errors.flatMap((entry: unknown) => {
          if (typeof entry === "string") return [entry];
          if (typeof entry !== "object" || entry === null) return [];
          const record = entry as Record<string, unknown>;
          if (typeof record.message === "string" && record.message.trim()) {
            return [record.message.trim()];
          }
          const parts = [record.code, record.field].filter(
            (part): part is string => typeof part === "string" && part.length > 0,
          );
          return parts.length > 0 ? [parts.join(" ")] : [];
        })
      : [];
    const message = typeof parsed.message === "string" ? parsed.message.trim() : "";
    const combined = [message, details.join("; ")].filter((part) => part.length > 0);
    return combined.length > 0 ? combined.join(": ") : null;
  } catch {
    return null;
  }
}

function withGitHubMessage(prefix: string, message: string | null, suffix = ""): string {
  return message ? `${prefix}: ${message}.${suffix}` : `${prefix}.${suffix}`;
}

export function normalizeGitHubCliError(
  operation: string,
  error: VcsError | unknown,
  domain: GitHubCliErrorDomain = "general",
): GitHubCliError {
  const text = errorText(error);
  const lower = text.toLowerCase();
  const message = gitHubErrorMessage(error)?.replace(/\.$/u, "") ?? null;
  const fail = (detail: string) => new GitHubCliError({ operation, detail, cause: error });

  if (lower.includes("command not found: gh") || lower.includes("enoent")) {
    return fail("GitHub CLI (`gh`) is required but not available on PATH.");
  }

  if (
    lower.includes("authentication failed") ||
    lower.includes("not logged in") ||
    lower.includes("gh auth login") ||
    lower.includes("no oauth token")
  ) {
    return fail("GitHub CLI is not authenticated. Run `gh auth login` and retry.");
  }

  if (
    lower.includes("api rate limit exceeded") ||
    lower.includes("secondary rate limit") ||
    lower.includes("rate limit")
  ) {
    return fail("GitHub API rate limit exceeded. Wait for the reset window and retry.");
  }

  if (domain === "general") {
    if (
      /head branch was modified|head (?:sha|oid|commit)[^.\n]*(?:does not match|didn't match|is not|has changed|changed)|expected head (?:oid|sha)|is not the head of|head ref (?:has )?changed|sha does not match/iu.test(
        text,
      )
    ) {
      return fail(
        "The pull request's head changed since it was loaded. Refresh and review the new commits, then try again.",
      );
    }

    if (
      lower.includes("resource not accessible") ||
      lower.includes("must have admin rights") ||
      lower.includes("must have push access") ||
      lower.includes("must have write access") ||
      lower.includes("does not have permission") ||
      lower.includes("permission denied") ||
      lower.includes("not authorized") ||
      lower.includes("forbidden") ||
      lower.includes("http 403")
    ) {
      return fail(
        withGitHubMessage(
          "GitHub denied permission for this action",
          message,
          " Check that your account has the required access to this repository.",
        ),
      );
    }
  } else if (
    lower.includes("resource not accessible by integration") ||
    lower.includes("must have actions read permission") ||
    lower.includes("must have actions write permission") ||
    lower.includes("permission denied") ||
    lower.includes("forbidden") ||
    lower.includes("http 403")
  ) {
    return fail(
      "GitHub Actions is not accessible for this repository. Check token permissions, required Actions access, and repository Actions settings.",
    );
  }

  if (
    domain === "actions" &&
    (lower.includes("http 410") ||
      lower.includes("gone") ||
      lower.includes("expired") ||
      lower.includes("logs are no longer available"))
  ) {
    return fail("GitHub Actions logs are no longer available for this run.");
  }

  if (
    lower.includes("could not resolve to a pullrequest") ||
    lower.includes("repository.pullrequest") ||
    lower.includes("no pull requests found for branch") ||
    lower.includes("pull request not found")
  ) {
    return fail("Pull request not found. Check the PR number or URL and try again.");
  }

  if (domain === "actions") {
    if (
      lower.includes("not found") ||
      lower.includes("http 404") ||
      lower.includes("no workflow runs found")
    ) {
      return fail("GitHub Actions run or repository was not found.");
    }
    return fail(text);
  }

  if (
    lower.includes("http 404") ||
    lower.includes("not found") ||
    lower.includes("could not resolve to a node")
  ) {
    return fail(
      withGitHubMessage(
        "GitHub could not find what this action refers to",
        message,
        " It may have been deleted, or your account may not have access.",
      ),
    );
  }

  if (
    lower.includes("http 422") ||
    lower.includes("validation failed") ||
    lower.includes("unprocessable")
  ) {
    return fail(withGitHubMessage("GitHub rejected the request", message ?? text));
  }

  return fail(text);
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

/** Keep `updatedAt` only when GitHub reported it, so absent timestamps stay absent. */
function withPresentUpdatedAt<T extends { readonly updatedAt: Option.Option<DateTime.Utc> }>(
  record: T,
): Omit<T, "updatedAt"> & { readonly updatedAt?: Option.Option<DateTime.Utc> } {
  const { updatedAt, ...rest } = record;
  return Option.isSome(updatedAt) ? { ...rest, updatedAt } : rest;
}

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

function gitHubApiFailure(
  operation: string,
  args: ReadonlyArray<string>,
  output: VcsProcess.VcsProcessOutput,
): GitHubCliError {
  const bodyMessage = gitHubApiErrorBodyMessage(output.stdout);
  const stderr = output.stderr.trim();
  const detail =
    [bodyMessage ? `gh: ${bodyMessage}` : null, stderr || null]
      .filter((part): part is string => part !== null)
      .join("\n") || `GitHub CLI exited with code ${output.exitCode}.`;
  return normalizeGitHubCliError(operation, { detail }, gitHubCliErrorDomain(args));
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  if (!text.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function hasGraphQlErrors(raw: string): boolean {
  const errors = parseJsonObject(raw)?.errors;
  return Array.isArray(errors) && errors.length > 0;
}

function hasGraphQlData(raw: string): boolean {
  const data = parseJsonObject(raw)?.data;
  return typeof data === "object" && data !== null;
}

function isHttpNotFound(output: VcsProcess.VcsProcessOutput): boolean {
  return output.exitCode !== 0 && /\bHTTP\s+404\b/iu.test(`${output.stderr}\n${output.stdout}`);
}

const RawPullRequestTargetSchema = Schema.Struct({
  id: TrimmedNonEmptyString,
  number: PositiveInt,
  url: TrimmedNonEmptyString,
  state: Schema.String,
  headRefOid: TrimmedNonEmptyString,
  headRefName: TrimmedNonEmptyString,
  baseRefName: TrimmedNonEmptyString,
  baseRefOid: Schema.optional(Schema.NullOr(Schema.String)),
  isCrossRepository: Schema.optional(Schema.NullOr(Schema.Boolean)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
});

export const GITHUB_PULL_REQUEST_TARGET_JSON_FIELDS =
  "id,number,url,state,headRefOid,headRefName,baseRefName,baseRefOid,isCrossRepository,mergedAt";

interface GitHubFileRevisionContents {
  readonly contents: string | null;
  readonly truncated: boolean;
}

function staleHeadError(operation: string): GitHubCliError {
  return new GitHubCliError({
    operation,
    detail:
      "The pull request's head changed since it was loaded. Refresh and review the new commits, then try again.",
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
        ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
      })
      .pipe(
        Effect.mapError((error) =>
          normalizeGitHubCliError("execute", error, gitHubCliErrorDomain(input.args)),
        ),
      );

  /**
   * Run a `gh api` call and turn a non-zero exit into a normalized error that
   * carries GitHub's message from the response body (REST `{message, errors}`
   * or GraphQL `{errors}`), which `gh` otherwise only prints to stdout.
   */
  const api = (input: {
    readonly cwd: string;
    readonly operation: string;
    readonly args: ReadonlyArray<string>;
    readonly stdin?: string;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
  }) =>
    execute({
      cwd: input.cwd,
      args: input.args,
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
      allowNonZeroExit: true,
    }).pipe(
      Effect.flatMap((output) =>
        output.exitCode === 0
          ? Effect.succeed(output)
          : Effect.fail(gitHubApiFailure(input.operation, input.args, output)),
      ),
    );

  /**
   * One GraphQL document over stdin (`--input -`): variables can carry text
   * people wrote, and argv is visible in process listings and error messages.
   */
  const graphqlDocument = (input: {
    readonly cwd: string;
    readonly host: string;
    readonly operation: string;
    readonly query: string;
    readonly variables: GitHubPullRequestMutations.GitHubGraphQlVariables;
    /**
     * Hand a partial response (`data` alongside `errors`, which makes `gh`
     * exit non-zero) to the caller's decoder, which decides which errors are
     * fatal. Only for reads whose decoders inspect `errors` themselves.
     */
    readonly acceptPartialData?: boolean;
  }) => {
    const args = ["api", "graphql", "--hostname", input.host, "--input", "-"];
    return execute({
      cwd: input.cwd,
      args,
      stdin: GitHubPullRequestMutations.encodeGitHubGraphQlRequest({
        query: input.query,
        variables: input.variables,
      }),
      allowNonZeroExit: true,
    }).pipe(
      Effect.flatMap((output) => {
        if (output.exitCode === 0) {
          // A GraphQL error must never pass as success, even if gh exits cleanly.
          return hasGraphQlErrors(output.stdout) && input.acceptPartialData !== true
            ? Effect.fail(gitHubApiFailure(input.operation, args, output))
            : Effect.succeed(output.stdout);
        }
        return input.acceptPartialData === true && hasGraphQlData(output.stdout)
          ? Effect.succeed(output.stdout)
          : Effect.fail(gitHubApiFailure(input.operation, args, output));
      }),
    );
  };

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
  /**
   * GraphQL read with `-f` variables, for values this module composed itself
   * (node ids, paths, cursors). Anything a person wrote goes through
   * `graphqlDocument` over stdin instead.
   */
  const graphql = (
    cwd: string,
    url: string,
    query: string,
    variables: ReadonlyArray<string>,
    operation = "viewedFiles",
  ) =>
    Effect.gen(function* () {
      const hostname = yield* Effect.try({
        try: () => new URL(url).hostname,
        catch: (cause) =>
          new GitHubCliError({
            operation,
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
          "getPullRequestFilesViewed",
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
        "setPullRequestFileViewed",
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
            "setPullRequestFileViewed",
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

  const getPullRequestRequiredChecks: GitHubCliShape["getPullRequestRequiredChecks"] = (input) =>
    Effect.gen(function* () {
      const operation = "getPullRequestRequiredChecks";
      const parts = repositoryParts(input.repository);
      if (!parts) {
        return yield* new GitHubCliError({
          operation,
          detail: "GitHub repository must be in owner/repository form.",
        });
      }
      const checks: GitHubRequiredChecks.NormalizedGitHubRequiredCheck[] = [];
      const seenCursors = new Set<string>();
      let after: string | null = null;
      for (let page = 0; page < GitHubRequiredChecks.GITHUB_REQUIRED_CHECKS_MAX_PAGES; page += 1) {
        const result: VcsProcess.VcsProcessOutput = yield* execute({
          cwd: input.cwd,
          args: [
            "api",
            "graphql",
            "--hostname",
            input.host,
            "-f",
            `query=${GitHubRequiredChecks.GITHUB_REQUIRED_CHECKS_QUERY}`,
            "-f",
            `owner=${parts.owner}`,
            "-f",
            `repo=${parts.name}`,
            "-F",
            `number=${input.number}`,
            "-f",
            `oid=${input.headSha}`,
            "-F",
            `first=${GitHubRequiredChecks.GITHUB_REQUIRED_CHECKS_PAGE_SIZE}`,
            ...(after ? ["-f", `after=${after}`] : []),
          ],
        });
        const decoded: GitHubRequiredChecks.DecodedGitHubRequiredChecksPage =
          yield* githubResultOrError(
            GitHubRequiredChecks.decodeGitHubRequiredChecksPageJson(result.stdout.trim()),
            operation,
          );
        checks.push(...decoded.checks);
        const cursor = decoded.endCursor;
        // Past the last page (or a cursor GitHub repeats), the rest stay unmarked.
        if (!decoded.hasNextPage || !cursor || seenCursors.has(cursor)) break;
        seenCursors.add(cursor);
        after = cursor;
      }
      return checks;
    });

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
        stdin: JSON.stringify({
          merge_method: input.mergeMethod,
          merge_action: "default",
          ...(input.expectedHeadSha ? { sha: input.expectedHeadSha } : {}),
        }),
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
            ...(input.expectedHeadSha ? ["--match-head-commit", input.expectedHeadSha] : []),
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
        if (output.exitCode !== 0 && gitHubApiErrorBodyMessage(raw) !== null) {
          return Effect.fail(gitHubApiFailure("mergePullRequestAsync", [endpoint], output));
        }
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

  const getPullRequestTarget: GitHubCliShape["getPullRequestTarget"] = (input) =>
    execute({
      cwd: input.cwd,
      args: ["pr", "view", input.reference, "--json", GITHUB_PULL_REQUEST_TARGET_JSON_FIELDS],
    }).pipe(
      Effect.flatMap((result) =>
        decodeGitHubJson(
          result.stdout.trim(),
          RawPullRequestTargetSchema,
          "getPullRequestTarget",
          "GitHub CLI returned an invalid pull request identity",
        ),
      ),
      Effect.flatMap((raw) => {
        const identity = parseGitHubRepositoryIdentityFromUrl(raw.url);
        if (!identity) {
          return Effect.fail(
            new GitHubCliError({
              operation: "getPullRequestTarget",
              detail: "Could not determine the pull request's GitHub repository from its URL.",
            }),
          );
        }
        const state = raw.state.trim().toUpperCase();
        return Effect.succeed({
          id: raw.id,
          number: raw.number,
          url: raw.url,
          host: identity.host,
          owner: identity.owner,
          name: identity.repository,
          nameWithOwner: identity.nameWithOwner,
          repo: `${identity.host}/${identity.nameWithOwner}`,
          state:
            state === "MERGED" || raw.mergedAt?.trim()
              ? ("merged" as const)
              : state === "CLOSED"
                ? ("closed" as const)
                : ("open" as const),
          headRefOid: raw.headRefOid,
          headRefName: raw.headRefName,
          baseRefName: raw.baseRefName,
          baseRefOid: raw.baseRefOid?.trim() || null,
          isCrossRepository: raw.isCrossRepository === true,
        } satisfies GitHubPullRequestTarget);
      }),
    );

  const decodeOrFail = <A>(operation: string, result: Result.Result<A, string>) =>
    githubResultOrError(result, operation);

  /**
   * Refuse to mutate a node (thread, comment, review) unless it belongs to the
   * pull request the caller named; node ids are global, so a stale or forged
   * id could otherwise act on another pull request.
   */
  const requireNodeInPullRequest = (input: {
    readonly cwd: string;
    readonly target: GitHubPullRequestTarget;
    readonly nodeId: string;
    readonly operation: string;
    readonly expectedTypes: ReadonlyArray<string>;
    readonly label: string;
  }) =>
    graphqlDocument({
      cwd: input.cwd,
      host: input.target.host,
      operation: input.operation,
      query: GitHubPullRequestActivity.GITHUB_NODE_SCOPE_QUERY,
      variables: { id: input.nodeId },
    }).pipe(
      Effect.flatMap((raw) =>
        decodeOrFail(input.operation, GitHubPullRequestActivity.decodeGitHubNodeScopeJson(raw)),
      ),
      Effect.flatMap((node) => {
        if (!node || !input.expectedTypes.includes(node.typename)) {
          return Effect.fail(
            new GitHubCliError({
              operation: input.operation,
              detail: `The ${input.label} was not found on GitHub. It may have been deleted.`,
            }),
          );
        }
        return ensureScope(input.operation, input.target, node.scope, input.label);
      }),
    );

  const ensureScope = (
    operation: string,
    target: GitHubPullRequestTarget,
    scope: GitHubPullRequestActivity.GitHubPullRequestScope | null,
    label: string,
  ): Effect.Effect<void, GitHubCliError> =>
    scope &&
    scope.number === target.number &&
    (scope.repository === null ||
      scope.repository.toLowerCase() === target.nameWithOwner.toLowerCase())
      ? Effect.void
      : Effect.fail(
          new GitHubCliError({
            operation,
            detail: `The ${label} does not belong to pull request #${target.number}.`,
          }),
        );

  const getPullRequestActivity: GitHubCliShape["getPullRequestActivity"] = (input) =>
    getPullRequestTarget(input).pipe(
      Effect.flatMap((target) =>
        GitHubPullRequestActivity.fetchGitHubChangeRequestActivity({
          owner: target.owner,
          name: target.name,
          number: target.number,
          runQuery: (query, variables) =>
            graphqlDocument({
              cwd: input.cwd,
              host: target.host,
              operation: "getPullRequestActivity",
              query,
              variables,
              acceptPartialData: true,
            }),
          fail: (detail) => new GitHubCliError({ operation: "getPullRequestActivity", detail }),
        }),
      ),
    );

  const readReviewThread = (input: {
    readonly cwd: string;
    readonly target: GitHubPullRequestTarget;
    readonly threadId: string;
    readonly operation: string;
  }) =>
    graphqlDocument({
      cwd: input.cwd,
      host: input.target.host,
      operation: input.operation,
      query: GitHubPullRequestActivity.GITHUB_REVIEW_THREAD_NODE_QUERY,
      variables: { id: input.threadId },
    }).pipe(
      Effect.flatMap((raw) =>
        decodeOrFail(
          input.operation,
          GitHubPullRequestActivity.decodeGitHubReviewThreadNodeJson(raw),
        ),
      ),
      Effect.tap((result) =>
        ensureScope(input.operation, input.target, result.scope, "review thread"),
      ),
      Effect.map((result) => result.thread),
    );

  const getPullRequestReviewThread: GitHubCliShape["getPullRequestReviewThread"] = (input) =>
    getPullRequestTarget(input).pipe(
      Effect.flatMap((target) =>
        readReviewThread({
          cwd: input.cwd,
          target,
          threadId: input.threadId,
          operation: "getPullRequestReviewThread",
        }),
      ),
      Effect.map((entry) => entry.thread),
    );

  const replyToPullRequestReviewThread: GitHubCliShape["replyToPullRequestReviewThread"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const operation = "replyToPullRequestReviewThread";
      const target = yield* getPullRequestTarget(input);
      const existing = yield* readReviewThread({
        cwd: input.cwd,
        target,
        threadId: input.threadId,
        operation,
      });
      if (
        hasCommentMutationMarker(
          existing.rawCommentBodies.map((body) => ({ body })),
          input.clientMutationId,
        )
      ) {
        return existing.thread;
      }
      if (!existing.thread.viewerCanReply) {
        return yield* new GitHubCliError({
          operation,
          detail: "GitHub does not allow you to reply to this review thread.",
        });
      }
      yield* graphqlDocument({
        cwd: input.cwd,
        host: target.host,
        operation,
        query: GitHubPullRequestMutations.GITHUB_REVIEW_THREAD_REPLY_MUTATION,
        variables: {
          threadId: input.threadId,
          body: appendCommentMutationMarker(input.body, input.clientMutationId),
        },
      });
      const updated = yield* readReviewThread({
        cwd: input.cwd,
        target,
        threadId: input.threadId,
        operation,
      });
      return updated.thread;
    });

  const setPullRequestReviewThreadResolved: GitHubCliShape["setPullRequestReviewThreadResolved"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const operation = "setPullRequestReviewThreadResolved";
      const target = yield* getPullRequestTarget(input);
      yield* requireNodeInPullRequest({
        cwd: input.cwd,
        target,
        nodeId: input.threadId,
        operation,
        expectedTypes: ["PullRequestReviewThread"],
        label: "review thread",
      });
      const raw = yield* graphqlDocument({
        cwd: input.cwd,
        host: target.host,
        operation,
        query: input.resolved
          ? GitHubPullRequestMutations.GITHUB_RESOLVE_REVIEW_THREAD_MUTATION
          : GitHubPullRequestMutations.GITHUB_UNRESOLVE_REVIEW_THREAD_MUTATION,
        variables: { threadId: input.threadId },
      });
      return yield* decodeOrFail(
        operation,
        GitHubPullRequestActivity.decodeGitHubResolveThreadJson(raw),
      );
    });

  const updatePullRequestComment: GitHubCliShape["updatePullRequestComment"] = (input) =>
    Effect.gen(function* () {
      const operation = "updatePullRequestComment";
      const document = GitHubPullRequestMutations.gitHubCommentMutationDocument(
        input.commentKind,
        input.action,
      );
      if (!document) {
        return yield* new GitHubCliError({
          operation,
          detail: "GitHub reviews cannot be deleted once submitted; edit the summary instead.",
        });
      }
      const target = yield* getPullRequestTarget(input);
      yield* requireNodeInPullRequest({
        cwd: input.cwd,
        target,
        nodeId: input.commentId,
        operation,
        expectedTypes: [GitHubPullRequestMutations.GITHUB_COMMENT_NODE_TYPES[input.commentKind]],
        label: input.commentKind === "review" ? "review" : "comment",
      });
      yield* graphqlDocument({
        cwd: input.cwd,
        host: target.host,
        operation,
        query: document,
        variables:
          input.action === "edit"
            ? { id: input.commentId, body: input.body }
            : { id: input.commentId },
      });
      return { commentId: input.commentId, deleted: input.action === "delete" };
    });

  const submitPullRequestReview: GitHubCliShape["submitPullRequestReview"] = (input) =>
    Effect.gen(function* () {
      const operation = "submitPullRequestReview";
      // Everything but emptiness is checked before any request: an empty
      // comment review is fine when it submits the viewer's pending review,
      // which only the review context below can tell.
      const submission = yield* decodeOrFail(
        operation,
        GitHubPullRequestMutations.buildGitHubReviewSubmissionBody(input, {
          submitsPendingReview: true,
        }),
      );
      const target = yield* getPullRequestTarget(input);
      if (target.headRefOid !== input.expectedHeadSha) return yield* staleHeadError(operation);
      const context = yield* graphqlDocument({
        cwd: input.cwd,
        host: target.host,
        operation,
        query: GitHubPullRequestMutations.GITHUB_REVIEW_CONTEXT_QUERY,
        variables: { owner: target.owner, name: target.name, number: target.number },
      }).pipe(
        Effect.flatMap((raw) =>
          decodeOrFail(operation, GitHubPullRequestMutations.decodeGitHubReviewContextJson(raw)),
        ),
      );
      if (context.headRefOid !== input.expectedHeadSha) return yield* staleHeadError(operation);

      /** Add every draft to a pending review, then submit it with the verdict. */
      const fillAndSubmitPendingReview = (reviewId: string) =>
        Effect.gen(function* () {
          for (const comment of submission.comments) {
            yield* graphqlDocument({
              cwd: input.cwd,
              host: target.host,
              operation,
              query: GitHubPullRequestMutations.GITHUB_ADD_PENDING_REVIEW_THREAD_MUTATION,
              variables: {
                input: GitHubPullRequestMutations.buildGitHubPendingReviewThreadInput(
                  reviewId,
                  comment,
                ),
              },
            });
          }
          const raw = yield* graphqlDocument({
            cwd: input.cwd,
            host: target.host,
            operation,
            query: GitHubPullRequestMutations.GITHUB_SUBMIT_PENDING_REVIEW_MUTATION,
            variables: {
              reviewId,
              event: submission.event,
              body: submission.body ?? null,
            },
          });
          return yield* decodeOrFail(
            operation,
            GitHubPullRequestMutations.decodeGitHubSubmitPendingReviewJson(raw),
          );
        });

      const pendingReviewId = context.pendingReviewId;
      if (pendingReviewId) {
        // A pending review keeps the commit it was started on: threads added to
        // it anchor there and its verdict applies there. Absorbing drafts
        // written against a newer head would misplace them and approve (or
        // reject) code the reviewer never saw, so refuse instead.
        if (context.pendingReviewCommitOid !== input.expectedHeadSha) {
          return yield* new GitHubCliError({
            operation,
            detail:
              "You have a pending review on GitHub that was started on an older commit of this pull request. Submit or discard it on GitHub, then try again.",
          });
        }
        // GitHub allows one pending review per reviewer, so a review started on
        // the web absorbs these drafts and is submitted with them.
        return yield* fillAndSubmitPendingReview(pendingReviewId);
      }
      // Without a pending review, an empty comment review has nothing to submit.
      yield* decodeOrFail(
        operation,
        GitHubPullRequestMutations.buildGitHubReviewSubmissionBody(input),
      );

      if (submission.comments.some((comment) => comment.subject_type === "file")) {
        // REST review comments cannot be file-level (no `subject_type` on the
        // create-review endpoint), so stage a pending review pinned to the
        // expected head, add the drafts through GraphQL, and submit it. If any
        // step fails, the half-built review is discarded so a retry starts clean.
        const reviewId = yield* graphqlDocument({
          cwd: input.cwd,
          host: target.host,
          operation,
          query: GitHubPullRequestMutations.GITHUB_START_PENDING_REVIEW_MUTATION,
          variables: { pullRequestId: context.pullRequestId, commitOID: input.expectedHeadSha },
        }).pipe(
          Effect.flatMap((raw) =>
            decodeOrFail(
              operation,
              GitHubPullRequestMutations.decodeGitHubStartPendingReviewJson(raw),
            ),
          ),
        );
        return yield* fillAndSubmitPendingReview(reviewId).pipe(
          Effect.tapError(() =>
            graphqlDocument({
              cwd: input.cwd,
              host: target.host,
              operation,
              query: GitHubPullRequestMutations.GITHUB_DELETE_PENDING_REVIEW_MUTATION,
              variables: { reviewId },
            }).pipe(Effect.ignore),
          ),
        );
      }

      const output = yield* api({
        cwd: input.cwd,
        operation,
        args: [
          "api",
          "--hostname",
          target.host,
          "--method",
          "POST",
          `repos/${target.nameWithOwner}/pulls/${target.number}/reviews`,
          "--input",
          "-",
        ],
        stdin: JSON.stringify(submission),
      });
      return yield* decodeOrFail(
        operation,
        GitHubPullRequestMutations.decodeGitHubReviewSubmissionJson(output.stdout.trim()),
      );
    });

  const deleteBranch: GitHubCliShape["deleteBranch"] = (input) =>
    execute({
      cwd: input.cwd,
      args: [
        "api",
        "--hostname",
        input.host,
        "--method",
        "DELETE",
        `repos/${input.repository}/git/refs/heads/${GitHubPullRequestMutations.encodeGitHubPathSegments(input.branch)}`,
      ],
      allowNonZeroExit: true,
    }).pipe(
      Effect.flatMap((output) => {
        if (output.exitCode === 0) return Effect.void;
        // Already gone (GitHub's auto-delete, or a previous attempt) is the goal state.
        if (
          isHttpNotFound(output) ||
          /reference does not exist/iu.test(`${output.stdout}\n${output.stderr}`)
        ) {
          return Effect.void;
        }
        return Effect.fail(
          gitHubApiFailure("deleteBranch", ["api", `repos/${input.repository}/git/refs`], output),
        );
      }),
    );

  const updatePullRequest: GitHubCliShape["updatePullRequest"] = (input) =>
    Effect.gen(function* () {
      const operation = "updatePullRequest";
      const target = yield* getPullRequestTarget(input);
      const action = input.action;
      const args = yield* decodeOrFail(
        operation,
        GitHubPullRequestMutations.buildGitHubPullRequestLifecycleArgs({
          number: target.number,
          repo: target.repo,
          action,
          bodyFile: input.bodyFile,
        }),
      );
      if (args) {
        yield* execute({ cwd: input.cwd, args });
        return;
      }
      switch (action.kind) {
        case "update-branch": {
          if (target.headRefOid !== action.expectedHeadSha) {
            return yield* staleHeadError(operation);
          }
          yield* graphqlDocument({
            cwd: input.cwd,
            host: target.host,
            operation,
            query: GitHubPullRequestMutations.GITHUB_UPDATE_PULL_REQUEST_BRANCH_MUTATION,
            variables: {
              pullRequestId: target.id,
              expectedHeadOid: action.expectedHeadSha,
              updateMethod: action.method === "rebase" ? "REBASE" : "MERGE",
            },
          });
          return;
        }
        case "auto-merge": {
          if (
            action.enabled &&
            action.expectedHeadSha !== undefined &&
            target.headRefOid !== action.expectedHeadSha
          ) {
            return yield* staleHeadError(operation);
          }
          const request = GitHubPullRequestMutations.buildGitHubAutoMergeRequest({
            pullRequestId: target.id,
            action,
          });
          yield* graphqlDocument({
            cwd: input.cwd,
            host: target.host,
            operation,
            query: request.query,
            variables: request.variables,
          });
          return;
        }
        case "delete-branch": {
          if (target.state === "open") {
            return yield* new GitHubCliError({
              operation,
              detail: "Close or merge the pull request before deleting its branch.",
            });
          }
          if (target.isCrossRepository) {
            return yield* new GitHubCliError({
              operation,
              detail:
                "The head branch lives in a fork; Ryco only deletes branches in the pull request's own repository.",
            });
          }
          yield* deleteBranch({
            cwd: input.cwd,
            host: target.host,
            repository: target.nameWithOwner,
            branch: target.headRefName,
          });
          return;
        }
        default:
          return yield* new GitHubCliError({
            operation,
            detail: `Unsupported pull request action: ${action.kind}.`,
          });
      }
    });

  const fetchFileAtRevision = (input: {
    readonly cwd: string;
    readonly target: GitHubPullRequestTarget;
    readonly path: string;
    readonly revision: string;
  }): Effect.Effect<GitHubFileRevisionContents, GitHubCliError> =>
    execute({
      cwd: input.cwd,
      args: [
        "api",
        "--hostname",
        input.target.host,
        "-H",
        "Accept: application/vnd.github.raw",
        `repos/${input.target.nameWithOwner}/contents/${GitHubPullRequestMutations.encodeGitHubPathSegments(input.path)}?ref=${encodeURIComponent(input.revision)}`,
      ],
      allowNonZeroExit: true,
      timeoutMs: FILE_CONTENTS_TIMEOUT_MS,
      maxOutputBytes: CHANGE_REQUEST_FILE_CONTENTS_MAX_BYTES,
    }).pipe(
      Effect.flatMap((output): Effect.Effect<GitHubFileRevisionContents, GitHubCliError> => {
        if (output.exitCode !== 0) {
          // Absent on this side: the file was added or deleted by the change.
          if (isHttpNotFound(output)) {
            return Effect.succeed({ contents: null, truncated: false });
          }
          return Effect.fail(
            gitHubApiFailure(
              "getPullRequestFileContents",
              ["api", `repos/${input.target.nameWithOwner}/contents`],
              output,
            ),
          );
        }
        // Binary files cannot be expanded as text.
        if (output.stdout.includes("\u0000")) {
          return Effect.succeed({ contents: null, truncated: false });
        }
        return Effect.succeed({ contents: output.stdout, truncated: output.stdoutTruncated });
      }),
    );

  const getPullRequestFileContents: GitHubCliShape["getPullRequestFileContents"] = (input) =>
    Effect.gen(function* () {
      const operation = "getPullRequestFileContents";
      for (const path of [input.path, input.previousPath]) {
        if (path !== undefined && !GitHubPullRequestMutations.isGitHubRepositoryFilePath(path)) {
          return yield* new GitHubCliError({
            operation,
            detail: `Invalid repository file path: ${path}`,
          });
        }
      }
      const target = yield* getPullRequestTarget(input);
      // Diff against merge-base(base, head) exactly like GitHub's PR diff. The
      // recorded base tip (not the branch name) keeps merged pull requests
      // correct: once merged, the base branch contains the head.
      const baseRevision = target.baseRefOid
        ? encodeURIComponent(target.baseRefOid)
        : GitHubPullRequestMutations.encodeGitHubPathSegments(target.baseRefName);
      const baseSha = input.baseSha
        ? input.baseSha
        : yield* api({
            cwd: input.cwd,
            operation,
            args: [
              "api",
              "--hostname",
              target.host,
              `repos/${target.nameWithOwner}/compare/${baseRevision}...${encodeURIComponent(input.headSha)}?per_page=1`,
              "--jq",
              ".merge_base_commit.sha",
            ],
          }).pipe(
            Effect.flatMap((output) => {
              const sha = output.stdout.trim();
              return /^[0-9a-f]{7,64}$/iu.test(sha)
                ? Effect.succeed(sha)
                : Effect.fail(
                    new GitHubCliError({
                      operation,
                      detail: "GitHub did not report a merge base for this pull request.",
                    }),
                  );
            }),
          );
      const [oldSide, newSide] = yield* Effect.all(
        [
          fetchFileAtRevision({
            cwd: input.cwd,
            target,
            path: input.previousPath ?? input.path,
            revision: baseSha,
          }),
          fetchFileAtRevision({
            cwd: input.cwd,
            target,
            path: input.path,
            revision: input.headSha,
          }),
        ],
        { concurrency: 2 },
      );
      return {
        path: input.path,
        oldContents: oldSide.contents,
        newContents: newSide.contents,
        truncated: oldSide.truncated || newSide.truncated,
      } satisfies ChangeRequestFileContents;
    });

  /**
   * A single commit's diff, but only for commits that belong to the pull
   * request (GitHub's PR commit list, capped by GitHub at 250), so a commit
   * from elsewhere in the repository cannot be shown as part of this change.
   */
  const getPullRequestCommitDiff = (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly commitSha: string;
  }) =>
    Effect.gen(function* () {
      const operation = "getPullRequestDiff";
      const target = yield* getPullRequestTarget(input);
      const commits = yield* api({
        cwd: input.cwd,
        operation,
        args: [
          "api",
          "--hostname",
          target.host,
          "--paginate",
          `repos/${target.nameWithOwner}/pulls/${target.number}/commits?per_page=100`,
          "--jq",
          ".[].sha",
        ],
        timeoutMs: 45_000,
      }).pipe(
        Effect.map((output) =>
          output.stdout
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0),
        ),
      );
      const wanted = input.commitSha.toLowerCase();
      const matches = commits.filter((sha) =>
        wanted.length >= 7 ? sha.toLowerCase().startsWith(wanted) : sha.toLowerCase() === wanted,
      );
      const commitSha = matches.length === 1 ? matches[0] : undefined;
      if (!commitSha) {
        return yield* new GitHubCliError({
          operation,
          detail: `Commit ${input.commitSha} is not part of pull request #${target.number}.`,
        });
      }
      const output = yield* api({
        cwd: input.cwd,
        operation,
        args: [
          "api",
          "--hostname",
          target.host,
          "-H",
          "Accept: application/vnd.github.diff",
          `repos/${target.nameWithOwner}/commits/${commitSha}`,
        ],
        timeoutMs: 60_000,
        maxOutputBytes: COMMIT_DIFF_MAX_BYTES,
      });
      if (output.stdoutTruncated) {
        return yield* new GitHubCliError({
          operation,
          detail: "This commit's diff is too large to display.",
        });
      }
      return output.stdout;
    });

  return GitHubCli.of({
    execute,
    getPullRequestStack,
    getPullRequestStackSummaries,
    getRepositoryMergeCapabilities,
    getPullRequestRequiredChecks,
    mergePullRequestAsync,
    deleteBranch,
    getPullRequestTarget,
    getPullRequestActivity,
    getPullRequestReviewThread,
    replyToPullRequestReviewThread,
    setPullRequestReviewThreadResolved,
    updatePullRequestComment,
    submitPullRequestReview,
    updatePullRequest,
    getPullRequestFileContents,
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

                  return Effect.succeed(decoded.success.map(withPresentUpdatedAt));
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

              return Effect.succeed(withPresentUpdatedAt(decoded.success));
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
          ...(input.draft ? ["--draft"] : []),
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
                  return Effect.succeed(decoded.success.map(withPresentUpdatedAt));
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
              return hydrateCommentReactionGroups(input.cwd, withPresentUpdatedAt(decoded.success));
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
        const diff = input.commitSha?.trim()
          ? yield* getPullRequestCommitDiff({
              cwd: input.cwd,
              reference: input.reference,
              commitSha: input.commitSha.trim(),
            })
          : (yield* execute({ cwd: input.cwd, args: ["pr", "diff", input.reference] })).stdout;
        if (input.expectedHeadSha) yield* verifyHead();
        return diff;
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
