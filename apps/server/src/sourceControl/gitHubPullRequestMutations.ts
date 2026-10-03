import { Result, Schema } from "effect";
import {
  type ChangeRequestDiffSide,
  type ChangeRequestDraftReviewComment,
  type ChangeRequestInvolvement,
  type ChangeRequestReviewEvent,
  type ChangeRequestSubmitReviewResult,
  type ChangeRequestUpdateAction,
  type SourceControlChangeRequestMergeMethod,
} from "@ryco/contracts";
import { decodeJsonResult, formatSchemaError } from "@ryco/shared/schemaJson";

import { graphQlErrorMessage } from "./gitHubPullRequestActivity.ts";
import { normalizeGitHubReviewState } from "./gitHubPullRequests.ts";

/**
 * Pure request builders and GraphQL documents for GitHub pull request
 * mutations. Everything here is side-effect free so the exact argv and
 * request bodies can be unit-tested; `GitHubCli` executes them. Markdown
 * bodies only ever travel over stdin (`--input -`) or a temp file
 * (`--body-file`), never argv, because argv is visible in process listings
 * and echoed back in process-runner failures.
 */

// ── GraphQL transport ─────────────────────────────────────────────────

export type GitHubGraphQlValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<unknown>
  | Readonly<Record<string, unknown>>;

export type GitHubGraphQlVariables = Readonly<Record<string, GitHubGraphQlValue>>;

/** The stdin document for `gh api graphql --input -`. */
export function encodeGitHubGraphQlRequest(input: {
  readonly query: string;
  readonly variables: GitHubGraphQlVariables;
}): string {
  return JSON.stringify({ query: input.query, variables: input.variables });
}

// ── List involvement ──────────────────────────────────────────────────

const INVOLVEMENT_QUALIFIERS: Record<ChangeRequestInvolvement, string> = {
  authored: "author:@me",
  "review-requested": "review-requested:@me",
  assigned: "assignee:@me",
  mentioned: "mentions:@me",
  involved: "involves:@me",
};

export function gitHubInvolvementQualifier(involvement: ChangeRequestInvolvement): string {
  return INVOLVEMENT_QUALIFIERS[involvement];
}

/**
 * `gh pr list` argv for a search-scoped list. GitHub search combines the
 * free-text query with the involvement qualifier, and `gh` adds the state
 * qualifier for `--state`.
 */
export function buildGitHubPullRequestSearchListArgs(input: {
  readonly involvement?: ChangeRequestInvolvement | undefined;
  readonly query?: string | undefined;
  readonly state: "open" | "closed" | "merged" | "all";
  readonly headSelector?: string | undefined;
  readonly limit: number;
  readonly jsonFields: string;
}): ReadonlyArray<string> {
  const search = [
    input.query?.trim() ?? "",
    input.involvement ? gitHubInvolvementQualifier(input.involvement) : "",
  ]
    .filter((part) => part.length > 0)
    .join(" ");
  const head = input.headSelector?.trim() ?? "";
  return [
    "pr",
    "list",
    "--search",
    search,
    ...(head.length > 0 ? ["--head", head] : []),
    "--state",
    input.state,
    "--limit",
    String(input.limit),
    "--json",
    input.jsonFields,
  ];
}

// ── Review submission ─────────────────────────────────────────────────

type GitHubReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
type GitHubDiffSide = "LEFT" | "RIGHT";

const REVIEW_EVENTS: Record<ChangeRequestReviewEvent, GitHubReviewEvent> = {
  comment: "COMMENT",
  approve: "APPROVE",
  request_changes: "REQUEST_CHANGES",
};

export function toGitHubReviewEvent(event: ChangeRequestReviewEvent): GitHubReviewEvent {
  return REVIEW_EVENTS[event];
}

function toGitHubDiffSide(side: ChangeRequestDiffSide | undefined): GitHubDiffSide {
  return side === "left" ? "LEFT" : "RIGHT";
}

/** One draft comment in GitHub's REST review-comment shape. */
export interface GitHubReviewDraftComment {
  readonly path: string;
  readonly body: string;
  readonly subject_type?: "file";
  readonly line?: number;
  readonly side?: GitHubDiffSide;
  readonly start_line?: number;
  readonly start_side?: GitHubDiffSide;
}

/** `POST repos/{owner}/{repo}/pulls/{number}/reviews` body. */
export interface GitHubReviewSubmissionBody {
  readonly commit_id: string;
  readonly event: GitHubReviewEvent;
  readonly body?: string;
  readonly comments: ReadonlyArray<GitHubReviewDraftComment>;
}

export function buildGitHubReviewDraftComment(
  comment: ChangeRequestDraftReviewComment,
): Result.Result<GitHubReviewDraftComment, string> {
  if (comment.subjectType === "file") {
    return Result.succeed({ path: comment.path, body: comment.body, subject_type: "file" });
  }
  if (comment.line === undefined) {
    return Result.fail(`The line comment on ${comment.path} is missing its line number.`);
  }
  const side = toGitHubDiffSide(comment.side);
  if (comment.startLine === undefined || comment.startLine === comment.line) {
    return Result.succeed({ path: comment.path, body: comment.body, line: comment.line, side });
  }
  if (comment.startLine > comment.line) {
    return Result.fail(
      `The comment range on ${comment.path} starts after it ends (${comment.startLine} > ${comment.line}).`,
    );
  }
  return Result.succeed({
    path: comment.path,
    body: comment.body,
    line: comment.line,
    side,
    start_line: comment.startLine,
    start_side: toGitHubDiffSide(comment.startSide ?? comment.side),
  });
}

/**
 * Validate a review and build its REST body. GitHub requires a summary for
 * "request changes", and a comment review needs a summary or inline comments,
 * unless it submits a pending review the viewer started on GitHub (which
 * already carries comments).
 */
export function buildGitHubReviewSubmissionBody(
  input: {
    readonly event: ChangeRequestReviewEvent;
    readonly body?: string | undefined;
    readonly comments: ReadonlyArray<ChangeRequestDraftReviewComment>;
    readonly expectedHeadSha: string;
  },
  options?: { readonly submitsPendingReview?: boolean },
): Result.Result<GitHubReviewSubmissionBody, string> {
  const body = input.body?.trim() ? input.body : undefined;
  if (input.event === "request_changes" && body === undefined) {
    return Result.fail("Requesting changes needs a review summary.");
  }
  if (
    input.event === "comment" &&
    body === undefined &&
    input.comments.length === 0 &&
    options?.submitsPendingReview !== true
  ) {
    return Result.fail("A comment review needs a summary or at least one inline comment.");
  }
  const comments: GitHubReviewDraftComment[] = [];
  for (const comment of input.comments) {
    const built = buildGitHubReviewDraftComment(comment);
    if (Result.isFailure(built)) return Result.fail(built.failure);
    comments.push(built.success);
  }
  return Result.succeed({
    commit_id: input.expectedHeadSha,
    event: toGitHubReviewEvent(input.event),
    ...(body !== undefined ? { body } : {}),
    comments,
  });
}

const RawReviewSubmissionResponseSchema = Schema.Struct({
  node_id: Schema.optional(Schema.NullOr(Schema.String)),
  id: Schema.optional(Schema.NullOr(Schema.Number)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeReviewSubmissionResponse = decodeJsonResult(RawReviewSubmissionResponseSchema);

export function decodeGitHubReviewSubmissionJson(
  raw: string,
): Result.Result<ChangeRequestSubmitReviewResult, string> {
  const decoded = decodeReviewSubmissionResponse(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(`Invalid GitHub review response: ${formatSchemaError(decoded.failure)}`);
  }
  const reviewId =
    decoded.success.node_id?.trim() ||
    (typeof decoded.success.id === "number" ? String(decoded.success.id) : "");
  const state = normalizeGitHubReviewState(decoded.success.state);
  if (!reviewId || !state) return Result.fail("GitHub returned an incomplete review.");
  const url = decoded.success.html_url?.trim();
  return Result.succeed({ reviewId, state, ...(url ? { url } : {}) });
}

/**
 * The viewer's PENDING review (GitHub allows one per reviewer), the commit it
 * was started on, and the pull request's current head.
 */
export const GITHUB_REVIEW_CONTEXT_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id headRefOid
      reviews(states: [PENDING], first: 1) { nodes { id author { login } commit { oid } } }
    }
  }
}`;

const RawReviewContextResponseSchema = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        viewer: Schema.optional(
          Schema.NullOr(Schema.Struct({ login: Schema.optional(Schema.NullOr(Schema.String)) })),
        ),
        repository: Schema.NullOr(
          Schema.Struct({
            pullRequest: Schema.NullOr(
              Schema.Struct({
                id: Schema.String,
                headRefOid: Schema.String,
                reviews: Schema.optional(
                  Schema.NullOr(
                    Schema.Struct({
                      nodes: Schema.Array(
                        Schema.NullOr(
                          Schema.Struct({
                            id: Schema.String,
                            author: Schema.optional(
                              Schema.NullOr(
                                Schema.Struct({
                                  login: Schema.optional(Schema.NullOr(Schema.String)),
                                }),
                              ),
                            ),
                            commit: Schema.optional(
                              Schema.NullOr(
                                Schema.Struct({
                                  oid: Schema.optional(Schema.NullOr(Schema.String)),
                                }),
                              ),
                            ),
                          }),
                        ),
                      ),
                    }),
                  ),
                ),
              }),
            ),
          }),
        ),
      }),
    ),
  ),
  errors: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.NullOr(Schema.Struct({ message: Schema.optional(Schema.NullOr(Schema.String)) })),
      ),
    ),
  ),
});
const decodeReviewContextResponse = decodeJsonResult(RawReviewContextResponseSchema);

export interface GitHubReviewContext {
  readonly pullRequestId: string;
  readonly headRefOid: string;
  readonly pendingReviewId: string | null;
  /**
   * Commit the pending review was started on. GitHub anchors every thread
   * added to that review (and its verdict) to this commit, not to the head.
   */
  readonly pendingReviewCommitOid: string | null;
}

export function decodeGitHubReviewContextJson(
  raw: string,
): Result.Result<GitHubReviewContext, string> {
  const decoded = decodeReviewContextResponse(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(
      `Invalid GitHub review context response: ${formatSchemaError(decoded.failure)}`,
    );
  }
  const errors = graphQlErrorMessage(decoded.success.errors);
  if (errors) return Result.fail(errors);
  const pullRequest = decoded.success.data?.repository?.pullRequest;
  if (!pullRequest) return Result.fail("GitHub returned no pull request for the review.");
  const login = decoded.success.data?.viewer?.login?.trim().toLowerCase() ?? "";
  const pending = (pullRequest.reviews?.nodes ?? []).find(
    (node) =>
      node !== null && login.length > 0 && node.author?.login?.trim().toLowerCase() === login,
  );
  return Result.succeed({
    pullRequestId: pullRequest.id,
    headRefOid: pullRequest.headRefOid,
    pendingReviewId: pending?.id.trim() || null,
    pendingReviewCommitOid: pending?.commit?.oid?.trim() || null,
  });
}

/** Adds one draft comment to the viewer's existing pending review. */
export const GITHUB_ADD_PENDING_REVIEW_THREAD_MUTATION = `mutation($input: AddPullRequestReviewThreadInput!) {
  addPullRequestReviewThread(input: $input) { thread { id } }
}`;

/** Starts an empty PENDING review (no `event`) anchored to `commitOID`. */
export const GITHUB_START_PENDING_REVIEW_MUTATION = `mutation($pullRequestId: ID!, $commitOID: GitObjectID!) {
  addPullRequestReview(input: { pullRequestId: $pullRequestId, commitOID: $commitOID }) {
    pullRequestReview { id state }
  }
}`;

/** Discards a PENDING review Ryco started but could not finish. */
export const GITHUB_DELETE_PENDING_REVIEW_MUTATION = `mutation($reviewId: ID!) {
  deletePullRequestReview(input: { pullRequestReviewId: $reviewId }) { pullRequestReview { id } }
}`;

const RawStartPendingReviewResponseSchema = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        addPullRequestReview: Schema.NullOr(
          Schema.Struct({
            pullRequestReview: Schema.NullOr(
              Schema.Struct({
                id: Schema.String,
                state: Schema.optional(Schema.NullOr(Schema.String)),
              }),
            ),
          }),
        ),
      }),
    ),
  ),
  errors: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.NullOr(Schema.Struct({ message: Schema.optional(Schema.NullOr(Schema.String)) })),
      ),
    ),
  ),
});
const decodeStartPendingReviewResponse = decodeJsonResult(RawStartPendingReviewResponseSchema);

/** The id of the review `GITHUB_START_PENDING_REVIEW_MUTATION` created; it must be PENDING. */
export function decodeGitHubStartPendingReviewJson(raw: string): Result.Result<string, string> {
  const decoded = decodeStartPendingReviewResponse(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(`Invalid GitHub review response: ${formatSchemaError(decoded.failure)}`);
  }
  const errors = graphQlErrorMessage(decoded.success.errors);
  if (errors) return Result.fail(errors);
  const review = decoded.success.data?.addPullRequestReview?.pullRequestReview;
  const reviewId = review?.id.trim();
  if (!reviewId) return Result.fail("GitHub did not start a pending review.");
  if (review?.state && review.state.trim().toUpperCase() !== "PENDING") {
    return Result.fail("GitHub started a review that is not pending.");
  }
  return Result.succeed(reviewId);
}

export const GITHUB_SUBMIT_PENDING_REVIEW_MUTATION = `mutation($reviewId: ID!, $event: PullRequestReviewEvent!, $body: String) {
  submitPullRequestReview(input: { pullRequestReviewId: $reviewId, event: $event, body: $body }) {
    pullRequestReview { id state url }
  }
}`;

/** GraphQL `AddPullRequestReviewThreadInput` for a draft comment on a pending review. */
export function buildGitHubPendingReviewThreadInput(
  reviewId: string,
  comment: GitHubReviewDraftComment,
): Readonly<Record<string, string | number>> {
  if (comment.subject_type === "file") {
    return {
      pullRequestReviewId: reviewId,
      path: comment.path,
      body: comment.body,
      subjectType: "FILE",
    };
  }
  return {
    pullRequestReviewId: reviewId,
    path: comment.path,
    body: comment.body,
    subjectType: "LINE",
    ...(comment.line !== undefined ? { line: comment.line } : {}),
    ...(comment.side !== undefined ? { side: comment.side } : {}),
    ...(comment.start_line !== undefined ? { startLine: comment.start_line } : {}),
    ...(comment.start_side !== undefined ? { startSide: comment.start_side } : {}),
  };
}

const RawSubmitPendingReviewResponseSchema = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        submitPullRequestReview: Schema.NullOr(
          Schema.Struct({
            pullRequestReview: Schema.NullOr(
              Schema.Struct({
                id: Schema.String,
                state: Schema.optional(Schema.NullOr(Schema.String)),
                url: Schema.optional(Schema.NullOr(Schema.String)),
              }),
            ),
          }),
        ),
      }),
    ),
  ),
  errors: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.NullOr(Schema.Struct({ message: Schema.optional(Schema.NullOr(Schema.String)) })),
      ),
    ),
  ),
});
const decodeSubmitPendingReviewResponse = decodeJsonResult(RawSubmitPendingReviewResponseSchema);

export function decodeGitHubSubmitPendingReviewJson(
  raw: string,
): Result.Result<ChangeRequestSubmitReviewResult, string> {
  const decoded = decodeSubmitPendingReviewResponse(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(`Invalid GitHub review response: ${formatSchemaError(decoded.failure)}`);
  }
  const errors = graphQlErrorMessage(decoded.success.errors);
  if (errors) return Result.fail(errors);
  const review = decoded.success.data?.submitPullRequestReview?.pullRequestReview;
  const state = normalizeGitHubReviewState(review?.state);
  const reviewId = review?.id.trim();
  if (!review || !reviewId || !state) return Result.fail("GitHub returned an incomplete review.");
  const url = review.url?.trim();
  return Result.succeed({ reviewId, state, ...(url ? { url } : {}) });
}

// ── Threads and comments ──────────────────────────────────────────────

export const GITHUB_REVIEW_THREAD_REPLY_MUTATION = `mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
    comment { id }
  }
}`;

export const GITHUB_RESOLVE_REVIEW_THREAD_MUTATION = `mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved resolvedBy { login } } }
}`;

export const GITHUB_UNRESOLVE_REVIEW_THREAD_MUTATION = `mutation($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved resolvedBy { login } } }
}`;

/** The GitHub node type each contract comment kind must resolve to before a mutation. */
export const GITHUB_COMMENT_NODE_TYPES = {
  "issue-comment": "IssueComment",
  "review-comment": "PullRequestReviewComment",
  review: "PullRequestReview",
} as const;

export function gitHubCommentMutationDocument(
  kind: "issue-comment" | "review-comment" | "review",
  action: "edit" | "delete",
): string | null {
  if (action === "edit") {
    switch (kind) {
      case "issue-comment":
        return `mutation($id: ID!, $body: String!) {
  updateIssueComment(input: { id: $id, body: $body }) { issueComment { id } }
}`;
      case "review-comment":
        return `mutation($id: ID!, $body: String!) {
  updatePullRequestReviewComment(input: { pullRequestReviewCommentId: $id, body: $body }) { pullRequestReviewComment { id } }
}`;
      case "review":
        return `mutation($id: ID!, $body: String!) {
  updatePullRequestReview(input: { pullRequestReviewId: $id, body: $body }) { pullRequestReview { id } }
}`;
    }
  }
  switch (kind) {
    case "issue-comment":
      return `mutation($id: ID!) {
  deleteIssueComment(input: { id: $id }) { clientMutationId }
}`;
    case "review-comment":
      return `mutation($id: ID!) {
  deletePullRequestReviewComment(input: { id: $id }) { clientMutationId }
}`;
    case "review":
      return null;
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────

export const GITHUB_UPDATE_PULL_REQUEST_BRANCH_MUTATION = `mutation($pullRequestId: ID!, $expectedHeadOid: GitObjectID!, $updateMethod: PullRequestBranchUpdateMethod!) {
  updatePullRequestBranch(input: { pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid, updateMethod: $updateMethod }) {
    pullRequest { id headRefOid }
  }
}`;

/**
 * GraphQL request for the `auto-merge` lifecycle action. An absent merge
 * method leaves GitHub's default; `expectedHeadOid` makes GitHub refuse to arm
 * auto-merge for a head the viewer has not seen, like a guarded merge.
 */
export function buildGitHubAutoMergeRequest(input: {
  readonly pullRequestId: string;
  readonly action: Extract<ChangeRequestUpdateAction, { readonly kind: "auto-merge" }>;
}): { readonly query: string; readonly variables: GitHubGraphQlVariables } {
  const { action } = input;
  if (!action.enabled) {
    return {
      query: GITHUB_DISABLE_AUTO_MERGE_MUTATION,
      variables: { pullRequestId: input.pullRequestId },
    };
  }
  const declarations = ["$pullRequestId: ID!"];
  const fields = ["pullRequestId: $pullRequestId"];
  const variables: Record<string, GitHubGraphQlValue> = { pullRequestId: input.pullRequestId };
  if (action.mergeMethod) {
    declarations.push("$mergeMethod: PullRequestMergeMethod!");
    fields.push("mergeMethod: $mergeMethod");
    variables.mergeMethod = toGitHubMergeMethod(action.mergeMethod);
  }
  if (action.expectedHeadSha) {
    declarations.push("$expectedHeadOid: GitObjectID!");
    fields.push("expectedHeadOid: $expectedHeadOid");
    variables.expectedHeadOid = action.expectedHeadSha;
  }
  return {
    query: `mutation(${declarations.join(", ")}) {
  enablePullRequestAutoMerge(input: { ${fields.join(", ")} }) {
    pullRequest { id }
  }
}`,
    variables,
  };
}

export const GITHUB_DISABLE_AUTO_MERGE_MUTATION = `mutation($pullRequestId: ID!) {
  disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) {
    pullRequest { id }
  }
}`;

export function toGitHubMergeMethod(
  method: SourceControlChangeRequestMergeMethod,
): "MERGE" | "SQUASH" | "REBASE" {
  switch (method) {
    case "merge":
      return "MERGE";
    case "squash":
      return "SQUASH";
    case "rebase":
      return "REBASE";
  }
}

/**
 * pflag string-slice flags parse each value as CSV, so a label containing a
 * comma or quote must be quoted to stay one item.
 */
export function gitHubCsvFlagValue(value: string): string {
  return /[",]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function listEditArgs(
  addFlag: string,
  removeFlag: string,
  add: ReadonlyArray<string>,
  remove: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return [
    ...add.flatMap((value) => [addFlag, gitHubCsvFlagValue(value)]),
    ...remove.flatMap((value) => [removeFlag, gitHubCsvFlagValue(value)]),
  ];
}

/**
 * `gh` argv for lifecycle actions that map onto `gh pr` subcommands. Every
 * command names the pull request by number plus `--repo host/owner/name`,
 * which also stops `gh pr close --delete-branch` from touching the local
 * checkout. Returns null for actions handled through the API instead.
 */
export function buildGitHubPullRequestLifecycleArgs(input: {
  readonly number: number;
  readonly repo: string;
  readonly action: ChangeRequestUpdateAction;
  readonly bodyFile?: string | undefined;
}): Result.Result<ReadonlyArray<string> | null, string> {
  const target = [String(input.number), "--repo", input.repo];
  const action = input.action;
  switch (action.kind) {
    case "edit": {
      if (action.body !== undefined && !input.bodyFile) {
        return Result.fail("The new description was not staged.");
      }
      const args = [
        ...(action.title !== undefined ? ["--title", action.title] : []),
        ...(action.body !== undefined && input.bodyFile ? ["--body-file", input.bodyFile] : []),
        ...(action.baseRefName !== undefined ? ["--base", action.baseRefName] : []),
      ];
      if (args.length === 0) return Result.fail("Nothing to edit: provide a title, body, or base.");
      return Result.succeed(["pr", "edit", ...target, ...args]);
    }
    case "set-draft":
      return Result.succeed(["pr", "ready", ...target, ...(action.draft ? ["--undo"] : [])]);
    case "close":
      return Result.succeed([
        "pr",
        "close",
        ...target,
        ...(action.deleteBranch ? ["--delete-branch"] : []),
      ]);
    case "reopen":
      return Result.succeed(["pr", "reopen", ...target]);
    case "reviewers":
    case "labels":
    case "assignees": {
      const flag =
        action.kind === "reviewers" ? "reviewer" : action.kind === "labels" ? "label" : "assignee";
      const args = listEditArgs(`--add-${flag}`, `--remove-${flag}`, action.add, action.remove);
      if (args.length === 0) return Result.fail(`No ${action.kind} to add or remove.`);
      return Result.succeed(["pr", "edit", ...target, ...args]);
    }
    case "update-branch":
    case "auto-merge":
    case "delete-branch":
      return Result.succeed(null);
  }
}

/**
 * A repository-relative file path the contents API can address: no empty,
 * `.`, or `..` segments. `encodeURIComponent` leaves dots alone, so a `..`
 * segment would otherwise walk out of `repos/{owner}/{repo}/contents/` and
 * let a caller read arbitrary API endpoints with the host's GitHub token.
 */
export function isGitHubRepositoryFilePath(path: string): boolean {
  return path
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/** URL-encode each path segment of a repository path, keeping the separators. */
export function encodeGitHubPathSegments(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}
