/**
 * Bitbucket Cloud REST 2.0 calls behind the pull requests page. Built on the
 * authenticated transport of `BitbucketApi.ts` (credentials, JSON decoding,
 * error mapping); the payload mapping lives in `bitbucketPullRequestPage.ts`.
 *
 * Every body travels as JSON over HTTPS (never argv). Pagination follows
 * Bitbucket's opaque `next` links, bounded per read, and only while they stay
 * on the configured API so credentials never leave it.
 */
import { Duration, Effect, Result, Schema, Stream } from "effect";
import { HttpClientRequest, type HttpClientResponse } from "effect/unstable/http";
import {
  CHANGE_REQUEST_FILE_CONTENTS_MAX_BYTES,
  type ChangeRequestActivity,
  type ChangeRequestDraftReviewComment,
  type ChangeRequestFileContents,
  type ChangeRequestInvolvement,
  type ChangeRequestReviewEvent,
  type ChangeRequestReviewThread,
  type ChangeRequestSetThreadResolvedResult,
  type ChangeRequestSubmitReviewResult,
  type ChangeRequestUpdateAction,
  type ChangeRequestUpdateCommentResult,
  type SourceControlAssigneeCandidate,
  type SourceControlChangeRequestMergeMethod,
  type SourceControlMergeChangeRequestResult,
} from "@ryco/contracts";

import { BitbucketApiError } from "./bitbucketApiError.ts";
import * as Page from "./bitbucketPullRequestPage.ts";
import * as BitbucketPullRequests from "./bitbucketPullRequests.ts";
import type { SourceControlProviderContext } from "./SourceControlProvider.ts";

export interface BitbucketRepositoryLocator {
  readonly workspace: string;
  readonly repoSlug: string;
}

/** The authenticated transport `BitbucketApi` provides. */
export interface BitbucketPageHttp {
  readonly apiUrl: (path: string) => string;
  /** The URL is on the configured API (origin and path prefix). */
  readonly isApiUrl: (url: string) => boolean;
  readonly executeJson: <S extends Schema.Top>(
    operation: string,
    request: HttpClientRequest.HttpClientRequest,
    schema: S,
  ) => Effect.Effect<S["Type"], BitbucketApiError, S["DecodingServices"]>;
  readonly executeText: (
    operation: string,
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<string, BitbucketApiError>;
  /** The raw response, whatever its status. */
  readonly executeResponse: (
    operation: string,
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, BitbucketApiError>;
  readonly responseError: (
    operation: string,
    response: HttpClientResponse.HttpClientResponse,
  ) => Effect.Effect<never, BitbucketApiError>;
  readonly resolveRepository: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
  }) => Effect.Effect<BitbucketRepositoryLocator, BitbucketApiError>;
}

interface PullRequestTarget {
  readonly cwd: string;
  readonly context?: SourceControlProviderContext;
  readonly reference: string;
}

export const STALE_HEAD_DETAIL =
  "The pull request's head changed since it was loaded. Refresh and review the new commits, then try again.";

const MERGE_TASK_POLL_LIMIT = 30;
const MERGE_TASK_POLL_INTERVAL = Duration.seconds(2);

function fail(operation: string, detail: string, status?: number): BitbucketApiError {
  return new BitbucketApiError({ operation, detail, ...(status !== undefined ? { status } : {}) });
}

function decodeOrFail<A>(
  operation: string,
  result: Result.Result<A, string>,
): Effect.Effect<A, BitbucketApiError> {
  return Result.isSuccess(result)
    ? Effect.succeed(result.success)
    : Effect.fail(fail(operation, result.failure));
}

function repositoryPath(repository: BitbucketRepositoryLocator): string {
  return `/repositories/${encodeURIComponent(repository.workspace)}/${encodeURIComponent(repository.repoSlug)}`;
}

function locatorFromFullName(
  fullName: string | null | undefined,
): BitbucketRepositoryLocator | null {
  const parts = (fullName ?? "").trim().split("/");
  const workspace = parts[0]?.trim();
  const repoSlug = parts[1]?.trim();
  return parts.length === 2 && workspace && repoSlug ? { workspace, repoSlug } : null;
}

function sameRepository(
  left: BitbucketRepositoryLocator,
  right: BitbucketRepositoryLocator,
): boolean {
  return (
    left.workspace.toLowerCase() === right.workspace.toLowerCase() &&
    left.repoSlug.toLowerCase() === right.repoSlug.toLowerCase()
  );
}

function escapeQueryValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/** Where the head commits live: the source fork, else the destination repository. */
export function bitbucketSourceRepository(
  pullRequest: BitbucketPullRequests.BitbucketPullRequest,
  destination: BitbucketRepositoryLocator,
): BitbucketRepositoryLocator {
  return locatorFromFullName(pullRequest.source.repository?.full_name) ?? destination;
}

export function isBitbucketCrossRepository(
  pullRequest: BitbucketPullRequests.BitbucketPullRequest,
  destination: BitbucketRepositoryLocator,
): boolean {
  return !sameRepository(bitbucketSourceRepository(pullRequest, destination), destination);
}

/** BBQL for an involvement list; Bitbucket has no assignees and no mention filter. */
export function bitbucketInvolvementFilter(
  involvement: ChangeRequestInvolvement,
  viewerUuid: string,
): Result.Result<string, string> {
  const uuid = escapeQueryValue(viewerUuid);
  switch (involvement) {
    case "authored":
      return Result.succeed(`author.uuid = "${uuid}"`);
    case "review-requested":
      return Result.succeed(`reviewers.uuid = "${uuid}"`);
    case "assigned":
    case "mentioned":
    case "involved":
      return Result.fail(`Bitbucket cannot list pull requests by "${involvement}".`);
  }
}

export function bitbucketTitleFilter(query: string): string | null {
  const text = query.trim();
  return text.length > 0 ? `title ~ "${escapeQueryValue(text)}"` : null;
}

function reviewState(event: ChangeRequestReviewEvent) {
  switch (event) {
    case "approve":
      return "approved" as const;
    case "request_changes":
      return "changes_requested" as const;
    case "comment":
      return "commented" as const;
  }
}

export function makeBitbucketPullRequestPageApi(http: BitbucketPageHttp) {
  const pullRequestPath = (repository: BitbucketRepositoryLocator, id: string) =>
    `${repositoryPath(repository)}/pullrequests/${encodeURIComponent(id)}`;

  const requireNumericId = (operation: string, value: string, label: string) => {
    const id = value.trim();
    return /^\d+$/u.test(id) && Number(id) > 0
      ? Effect.succeed(id)
      : Effect.fail(fail(operation, `Invalid Bitbucket ${label}: ${value}`));
  };

  const target = Effect.fn("BitbucketPage.target")(function* (
    operation: string,
    input: PullRequestTarget,
  ) {
    const repository = yield* http.resolveRepository(input);
    const id = yield* requireNumericId(
      operation,
      BitbucketPullRequests.normalizeBitbucketChangeRequestId(input.reference),
      "pull request id",
    );
    return { repository, id, path: pullRequestPath(repository, id) };
  });

  const getPullRequest = (operation: string, path: string) =>
    http.executeJson(
      operation,
      HttpClientRequest.get(http.apiUrl(path)),
      BitbucketPullRequests.BitbucketPullRequestSchema,
    );

  /** Follow `next` links up to `maxPages`; `truncated` when more remained. */
  const collectPages = <A>(input: {
    readonly operation: string;
    readonly first: HttpClientRequest.HttpClientRequest;
    readonly maxPages: number;
    readonly fetch: (
      request: HttpClientRequest.HttpClientRequest,
    ) => Effect.Effect<
      { readonly values: ReadonlyArray<A>; readonly next?: string | null | undefined },
      BitbucketApiError
    >;
  }) =>
    Effect.gen(function* () {
      const values: A[] = [];
      let request: HttpClientRequest.HttpClientRequest | null = input.first;
      let pages = 0;
      let next: string | null = null;
      while (request) {
        const page: {
          readonly values: ReadonlyArray<A>;
          readonly next?: string | null | undefined;
        } = yield* input.fetch(request);
        values.push(...page.values);
        pages += 1;
        next = page.next?.trim() || null;
        if (next && !http.isApiUrl(next)) {
          return yield* fail(input.operation, "Bitbucket returned a pagination link off its API.");
        }
        request = next && pages < input.maxPages ? HttpClientRequest.get(next) : null;
      }
      return { values, truncated: next !== null };
    });

  const listComments = (operation: string, path: string) =>
    collectPages({
      operation,
      // Newest first, so a truncated read keeps the recent conversation.
      first: HttpClientRequest.get(http.apiUrl(`${path}/comments`), {
        urlParams: { pagelen: String(Page.BITBUCKET_PAGE_LEN), sort: "-created_on" },
      }),
      maxPages: Page.BITBUCKET_COMMENTS_MAX_PAGES,
      fetch: (request) =>
        http.executeJson(operation, request, Page.BitbucketPullRequestCommentPageSchema),
    });

  const listCommits = (operation: string, path: string) =>
    collectPages({
      operation,
      first: HttpClientRequest.get(http.apiUrl(`${path}/commits`), {
        urlParams: { pagelen: String(Page.BITBUCKET_PAGE_LEN) },
      }),
      maxPages: Page.BITBUCKET_COMMITS_MAX_PAGES,
      fetch: (request) => http.executeJson(operation, request, Page.BitbucketCommitPageSchema),
    });

  const getViewer = (operation: string) =>
    http.executeJson(
      operation,
      HttpClientRequest.get(http.apiUrl("/user")),
      Page.BitbucketViewerSchema,
    );

  /** The viewer's permission on the repository; null when Bitbucket does not say. */
  const getRepositoryPermission = (operation: string, repository: BitbucketRepositoryLocator) => {
    const fullName = `${repository.workspace}/${repository.repoSlug}`;
    return http
      .executeJson(
        operation,
        HttpClientRequest.get(
          http.apiUrl(
            `/user/workspaces/${encodeURIComponent(repository.workspace)}/permissions/repositories`,
          ),
          {
            urlParams: {
              q: `repository.full_name ~ "${escapeQueryValue(fullName)}"`,
              pagelen: String(Page.BITBUCKET_PAGE_LEN),
            },
          },
        ),
        Page.BitbucketRepositoryPermissionPageSchema,
      )
      .pipe(
        Effect.map((page) => Page.bitbucketRepositoryPermission(page, fullName)),
        Effect.catch(() => Effect.succeed(null)),
      );
  };

  /** The full head hash: from the commit list, else `GET /commit/{hash}`, else as reported. */
  const resolveHeadSha = (
    operation: string,
    pullRequest: BitbucketPullRequests.BitbucketPullRequest,
    repository: BitbucketRepositoryLocator,
    commits: ReadonlyArray<{ readonly hash: string }>,
  ) => {
    const reported = pullRequest.source.commit?.hash?.trim() || null;
    if (!reported) return Effect.succeed(null);
    const listed = Page.resolveBitbucketCommitHash(reported, commits);
    if (listed) return Effect.succeed(listed);
    if (reported.length >= 40) return Effect.succeed(reported);
    const source = bitbucketSourceRepository(pullRequest, repository);
    return http
      .executeJson(
        operation,
        HttpClientRequest.get(
          http.apiUrl(`${repositoryPath(source)}/commit/${encodeURIComponent(reported)}`),
        ),
        Page.BitbucketMergeBaseSchema,
      )
      .pipe(
        Effect.map((commit) =>
          Page.bitbucketCommitsMatch(commit.hash, reported) ? commit.hash : reported,
        ),
        Effect.catch(() => Effect.succeed(reported)),
      );
  };

  const requireHead = (
    operation: string,
    pullRequest: BitbucketPullRequests.BitbucketPullRequest,
    expectedHeadSha: string,
  ) =>
    Page.bitbucketCommitsMatch(pullRequest.source.commit?.hash, expectedHeadSha)
      ? Effect.void
      : Effect.fail(fail(operation, STALE_HEAD_DETAIL));

  /** Optional reads (checks, statuses, mergeability) never fail the page. */
  const optional = <A>(effect: Effect.Effect<A, BitbucketApiError>) =>
    effect.pipe(
      Effect.map((value): A | null => value),
      Effect.catch((error) =>
        Effect.logDebug("Bitbucket optional pull request read failed.", {
          operation: error.operation,
          detail: error.detail,
        }).pipe(Effect.as(null)),
      ),
    );

  // ── Reads ───────────────────────────────────────────────────────────

  const getPullRequestActivity = Effect.fn("BitbucketPage.getPullRequestActivity")(function* (
    input: PullRequestTarget,
  ) {
    const operation = "getPullRequestActivity";
    const { repository, path } = yield* target(operation, input);
    const [pullRequest, viewer, permission, activity, comments, commits] = yield* Effect.all(
      [
        getPullRequest(operation, path),
        optional(getViewer(operation)),
        getRepositoryPermission(operation, repository),
        collectPages({
          operation,
          first: HttpClientRequest.get(http.apiUrl(`${path}/activity`), {
            urlParams: { pagelen: String(Page.BITBUCKET_ACTIVITY_PAGE_LEN) },
          }),
          maxPages: Page.BITBUCKET_ACTIVITY_MAX_PAGES,
          fetch: (request) =>
            http.executeJson(operation, request, Page.BitbucketActivityPageSchema),
        }),
        listComments(operation, path),
        listCommits(operation, path),
      ],
      { concurrency: 4 },
    );
    const headSha = yield* resolveHeadSha(operation, pullRequest, repository, commits.values);
    return Page.assembleBitbucketChangeRequestActivity({
      pullRequest,
      headSha,
      viewer,
      permission,
      activity: activity.values,
      activityTruncated: activity.truncated,
      comments: comments.values,
      commentsTruncated: comments.truncated,
      commits: commits.values,
      commitsTruncated: commits.truncated,
    }) satisfies ChangeRequestActivity;
  });

  /**
   * Detail enrichment: full head hash, commits, reviewer states, merge
   * readiness (mergeability checks, open pull requests only), allowed merge
   * strategies, and build statuses. Each optional read degrades to absent.
   */
  const getPullRequestPageDetail = Effect.fn("BitbucketPage.getPullRequestPageDetail")(function* (
    repository: BitbucketRepositoryLocator,
    path: string,
    pullRequest: BitbucketPullRequests.BitbucketPullRequest,
  ) {
    const operation = "getPullRequestDetail";
    const isOpen = (pullRequest.state?.trim().toUpperCase() ?? "OPEN") === "OPEN";
    const [commits, statuses, checks] = yield* Effect.all(
      [
        optional(listCommits(operation, path)),
        optional(
          collectPages({
            operation,
            first: HttpClientRequest.get(http.apiUrl(`${path}/statuses`), {
              urlParams: { pagelen: String(Page.BITBUCKET_PAGE_LEN), sort: "-created_on" },
            }),
            maxPages: Page.BITBUCKET_STATUSES_MAX_PAGES,
            fetch: (request) =>
              http.executeJson(operation, request, Page.BitbucketCommitStatusPageSchema),
          }),
        ),
        isOpen
          ? optional(
              http.executeJson(
                operation,
                HttpClientRequest.get(http.apiUrl(`${path}/mergeability/checks`)),
                Page.BitbucketMergeabilityChecksSchema,
              ),
            )
          : Effect.succeed(null),
      ],
      { concurrency: 3 },
    );
    const headSha = yield* resolveHeadSha(
      operation,
      pullRequest,
      repository,
      commits?.values ?? [],
    );
    const reviewerStates = Page.bitbucketReviewerStates(pullRequest);
    const isDraft = pullRequest.draft === true;
    const readiness = isOpen
      ? Page.bitbucketMergeReadiness({ checks: checks?.values ?? null, isDraft })
      : null;
    const reviewDecision = Page.bitbucketReviewDecision(reviewerStates, checks?.values ?? null);
    const mergeCapabilities = Page.bitbucketMergeCapabilities(
      pullRequest.destination.branch.merge_strategies,
    );
    const mergedBy =
      pullRequest.state?.trim().toUpperCase() === "MERGED"
        ? Page.bitbucketLogin(pullRequest.closed_by)
        : null;
    const changeRequestCommits = Page.orderBitbucketCommits(commits?.values ?? [])
      .map(Page.toBitbucketChangeRequestCommit)
      .filter((commit) => commit !== null);
    return {
      ...(headSha ? { headSha } : {}),
      ...(commits ? { commits: changeRequestCommits } : {}),
      reviewerStates,
      reviewDecision,
      ...readiness,
      ...(mergeCapabilities ? { mergeCapabilities } : {}),
      ...(statuses ? { checkRollup: Page.bitbucketCheckRollup(statuses.values, headSha) } : {}),
      ...(typeof pullRequest.close_source_branch === "boolean"
        ? { deleteBranchOnMerge: pullRequest.close_source_branch }
        : {}),
      ...(mergedBy ? { mergedBy } : {}),
    };
  });

  const getPullRequestFileContents = Effect.fn("BitbucketPage.getPullRequestFileContents")(
    function* (
      input: PullRequestTarget & {
        readonly path: string;
        readonly previousPath?: string | undefined;
        readonly baseSha?: string | undefined;
        readonly headSha: string;
      },
    ) {
      const operation = "getPullRequestFileContents";
      for (const path of [input.path, input.previousPath]) {
        if (path !== undefined && !Page.isBitbucketRepositoryFilePath(path)) {
          return yield* fail(operation, `Invalid repository file path: ${path}`);
        }
      }
      for (const sha of [input.headSha, input.baseSha]) {
        if (sha !== undefined && !/^[0-9a-f]{7,64}$/iu.test(sha)) {
          return yield* fail(operation, `Invalid commit: ${sha}`);
        }
      }
      const { repository, path } = yield* target(operation, input);
      const pullRequest = yield* getPullRequest(operation, path);
      const source = bitbucketSourceRepository(pullRequest, repository);
      // Like the pull request diff, the old side is the merge base of the
      // destination and the head unless the caller scoped it (one commit).
      const baseSha =
        input.baseSha ??
        (yield* mergeBase(operation, {
          pullRequest,
          repository,
          source,
          headSha: input.headSha,
        }));
      const [oldSide, newSide] = yield* Effect.all(
        [
          fetchFileAtRevision(operation, repository, baseSha, input.previousPath ?? input.path),
          fetchFileAtRevision(operation, source, input.headSha, input.path),
        ],
        { concurrency: 2 },
      );
      return {
        path: input.path,
        oldContents: oldSide.contents,
        newContents: newSide.contents,
        truncated: oldSide.truncated || newSide.truncated,
      } satisfies ChangeRequestFileContents;
    },
  );

  const mergeBase = Effect.fn("BitbucketPage.mergeBase")(function* (
    operation: string,
    input: {
      readonly pullRequest: BitbucketPullRequests.BitbucketPullRequest;
      readonly repository: BitbucketRepositoryLocator;
      readonly source: BitbucketRepositoryLocator;
      readonly headSha: string;
    },
  ) {
    const destination =
      input.pullRequest.destination.commit?.hash?.trim() ||
      input.pullRequest.destination.branch.name;
    const revspec = `${encodeURIComponent(input.headSha)}..${encodeURIComponent(destination)}`;
    const read = (repository: BitbucketRepositoryLocator) =>
      http.executeJson(
        operation,
        HttpClientRequest.get(http.apiUrl(`${repositoryPath(repository)}/merge-base/${revspec}`)),
        Page.BitbucketMergeBaseSchema,
      );
    // A fork's head is not in the destination repository; its own history has both.
    const commit = yield* read(input.repository).pipe(
      Effect.catch((error) =>
        error.status === 404 && !sameRepository(input.source, input.repository)
          ? read(input.source)
          : Effect.fail(error),
      ),
    );
    return commit.hash;
  });

  const fetchFileAtRevision = (
    operation: string,
    repository: BitbucketRepositoryLocator,
    revision: string,
    path: string,
  ) =>
    http
      .executeResponse(
        operation,
        HttpClientRequest.get(
          http.apiUrl(
            `${repositoryPath(repository)}/src/${encodeURIComponent(revision)}/${Page.encodeBitbucketPath(path)}`,
          ),
        ),
      )
      .pipe(
        Effect.flatMap(
          (
            response,
          ): Effect.Effect<
            { readonly contents: string | null; readonly truncated: boolean },
            BitbucketApiError
          > => {
            // Absent on this side: the file was added or deleted by the change.
            if (response.status === 404)
              return Effect.succeed({ contents: null, truncated: false });
            if (response.status < 200 || response.status >= 300) {
              return http.responseError(operation, response);
            }
            return readBounded(operation, response, CHANGE_REQUEST_FILE_CONTENTS_MAX_BYTES).pipe(
              Effect.map(({ bytes, truncated }) =>
                // Binary files cannot be expanded as text.
                bytes.includes(0)
                  ? { contents: null, truncated: false }
                  : { contents: new TextDecoder().decode(bytes), truncated },
              ),
            );
          },
        ),
      );

  const getPullRequestDiff = Effect.fn("BitbucketPage.getPullRequestDiff")(function* (
    input: PullRequestTarget & {
      readonly expectedHeadSha?: string | undefined;
      readonly commitSha?: string | undefined;
    },
  ) {
    const operation = "getPullRequestDiff";
    const { repository, path } = yield* target(operation, input);
    const verifyHead = () =>
      input.expectedHeadSha
        ? getPullRequest(operation, path).pipe(
            Effect.flatMap((pullRequest) =>
              Page.bitbucketCommitsMatch(pullRequest.source.commit?.hash, input.expectedHeadSha)
                ? Effect.void
                : Effect.fail(
                    fail(
                      operation,
                      "Pull request changed while loading the diff. Refresh and try again.",
                    ),
                  ),
            ),
          )
        : Effect.void;
    yield* verifyHead();
    const commitSha = input.commitSha?.trim();
    let diff: string;
    if (commitSha) {
      if (!/^[0-9a-f]{7,64}$/iu.test(commitSha)) {
        return yield* fail(operation, `Invalid commit: ${commitSha}`);
      }
      const [pullRequest, commits] = yield* Effect.all(
        [getPullRequest(operation, path), listCommits(operation, path)],
        { concurrency: 2 },
      );
      if (Page.resolveBitbucketCommitHash(commitSha, commits.values) === null) {
        return yield* fail(operation, `${commitSha} is not one of this pull request's commits.`);
      }
      // A single-commit spec diffs against the commit's first parent.
      const source = bitbucketSourceRepository(pullRequest, repository);
      diff = yield* http.executeText(
        operation,
        HttpClientRequest.get(
          http.apiUrl(`${repositoryPath(source)}/diff/${encodeURIComponent(commitSha)}`),
        ),
      );
    } else {
      diff = yield* http.executeText(operation, HttpClientRequest.get(http.apiUrl(`${path}/diff`)));
    }
    yield* verifyHead();
    return diff;
  });

  // ── Lists ───────────────────────────────────────────────────────────

  /** Extra BBQL for `listChangeRequests{involvement, query}`; null when neither is set. */
  const involvementFilters = Effect.fn("BitbucketPage.involvementFilters")(function* (input: {
    readonly involvement?: ChangeRequestInvolvement | undefined;
    readonly query?: string | undefined;
  }) {
    const operation = "listPullRequests";
    const filters: string[] = [];
    if (input.involvement !== undefined) {
      const viewer = yield* getViewer(operation);
      const uuid = viewer.uuid?.trim();
      if (!uuid) return yield* fail(operation, "Bitbucket did not report the signed-in user's id.");
      filters.push(
        yield* decodeOrFail(operation, bitbucketInvolvementFilter(input.involvement, uuid)),
      );
    }
    const title = input.query ? bitbucketTitleFilter(input.query) : null;
    if (title) filters.push(title);
    return filters;
  });

  const listWorkspaceMembers = Effect.fn("BitbucketPage.listWorkspaceMembers")(function* (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
  }) {
    const operation = "listWorkspaceMembers";
    const repository = yield* http.resolveRepository(input);
    const members = yield* collectPages({
      operation,
      first: HttpClientRequest.get(
        http.apiUrl(`/workspaces/${encodeURIComponent(repository.workspace)}/members`),
        { urlParams: { pagelen: String(Page.BITBUCKET_PAGE_LEN) } },
      ),
      maxPages: Page.BITBUCKET_MEMBERS_MAX_PAGES,
      fetch: (request) =>
        http.executeJson(operation, request, Page.BitbucketWorkspaceMemberPageSchema),
    });
    const seen = new Set<string>();
    const candidates: SourceControlAssigneeCandidate[] = [];
    for (const member of members.values) {
      const actor = Page.bitbucketActor(member.user);
      if (!actor || seen.has(actor.login)) continue;
      seen.add(actor.login);
      candidates.push(actor);
    }
    return {
      candidates,
      accounts: members.values.flatMap((member) => (member.user ? [member.user] : [])),
    };
  });

  // ── Conversation mutations ──────────────────────────────────────────

  const postComment = (operation: string, path: string, body: object) =>
    http.executeJson(
      operation,
      HttpClientRequest.post(http.apiUrl(`${path}/comments`)).pipe(
        HttpClientRequest.bodyJsonUnsafe(body),
      ),
      Page.BitbucketPullRequestCommentSchema,
    );

  const addPullRequestComment = Effect.fn("BitbucketPage.addPullRequestComment")(function* (
    input: PullRequestTarget & { readonly body: string },
  ) {
    const operation = "addPullRequestComment";
    if (input.body.trim().length === 0) return yield* fail(operation, "Comments need a body.");
    const { path } = yield* target(operation, input);
    yield* postComment(operation, path, { content: { raw: input.body } });
  });

  const updatePullRequestComment = Effect.fn("BitbucketPage.updatePullRequestComment")(function* (
    input: PullRequestTarget & {
      readonly commentId: string;
      readonly commentKind: "issue-comment" | "review-comment" | "review";
      readonly action: "edit" | "delete";
      readonly body?: string | undefined;
    },
  ) {
    const operation = "updatePullRequestComment";
    if (input.commentKind === "review") {
      return yield* fail(operation, "Bitbucket reviews have no summary to edit.");
    }
    const commentId = yield* requireNumericId(operation, input.commentId, "comment id");
    const { path } = yield* target(operation, input);
    const url = http.apiUrl(`${path}/comments/${encodeURIComponent(commentId)}`);
    if (input.action === "delete") {
      yield* expectNoContent(operation, HttpClientRequest.delete(url));
    } else {
      if (!input.body || input.body.trim().length === 0) {
        return yield* fail(operation, "Comments need a body.");
      }
      yield* http.executeJson(
        operation,
        HttpClientRequest.put(url).pipe(
          HttpClientRequest.bodyJsonUnsafe({ content: { raw: input.body } }),
        ),
        Page.BitbucketPullRequestCommentSchema,
      );
    }
    return {
      commentId,
      deleted: input.action === "delete",
    } satisfies ChangeRequestUpdateCommentResult;
  });

  const expectNoContent = (operation: string, request: HttpClientRequest.HttpClientRequest) =>
    http
      .executeResponse(operation, request)
      .pipe(
        Effect.flatMap((response) =>
          response.status >= 200 && response.status < 300
            ? Effect.void
            : http.responseError(operation, response),
        ),
      );

  /** The thread `threadId` (a root comment id) as the page shows it. */
  const readThread = Effect.fn("BitbucketPage.readThread")(function* (
    operation: string,
    repository: BitbucketRepositoryLocator,
    path: string,
    threadId: string,
  ) {
    const [pullRequest, viewer, permission, comments] = yield* Effect.all(
      [
        getPullRequest(operation, path),
        optional(getViewer(operation)),
        getRepositoryPermission(operation, repository),
        listComments(operation, path),
      ],
      { concurrency: 4 },
    );
    const activity = Page.assembleBitbucketChangeRequestActivity({
      pullRequest,
      headSha: null,
      viewer,
      permission,
      activity: [],
      activityTruncated: false,
      comments: comments.values,
      commentsTruncated: comments.truncated,
      commits: [],
      commitsTruncated: false,
    });
    return activity.reviewThreads.find((thread) => thread.id === threadId) ?? null;
  });

  const replyToPullRequestThread = Effect.fn("BitbucketPage.replyToPullRequestThread")(function* (
    input: PullRequestTarget & { readonly threadId: string; readonly body: string },
  ) {
    const operation = "replyToReviewThread";
    const threadId = yield* requireNumericId(operation, input.threadId, "thread id");
    if (input.body.trim().length === 0) return yield* fail(operation, "Replies need a body.");
    const { repository, path } = yield* target(operation, input);
    yield* postComment(operation, path, {
      content: { raw: input.body },
      parent: { id: Number(threadId) },
    });
    const thread = yield* readThread(operation, repository, path, threadId);
    if (!thread) {
      return yield* fail(
        operation,
        "The reply was posted, but the thread is outside the comments Ryco reads. Refresh to see it.",
      );
    }
    return thread satisfies ChangeRequestReviewThread;
  });

  const setPullRequestThreadResolved = Effect.fn("BitbucketPage.setPullRequestThreadResolved")(
    function* (
      input: PullRequestTarget & { readonly threadId: string; readonly resolved: boolean },
    ) {
      const operation = "setReviewThreadResolved";
      const threadId = yield* requireNumericId(operation, input.threadId, "thread id");
      const { path } = yield* target(operation, input);
      const commentUrl = http.apiUrl(`${path}/comments/${encodeURIComponent(threadId)}`);
      const readResolution = () =>
        http
          .executeJson(
            operation,
            HttpClientRequest.get(commentUrl),
            Page.BitbucketPullRequestCommentSchema,
          )
          .pipe(Effect.map((comment) => comment.resolution ?? null));
      const response = yield* http.executeResponse(
        operation,
        input.resolved
          ? HttpClientRequest.post(`${commentUrl}/resolve`)
          : HttpClientRequest.delete(`${commentUrl}/resolve`),
      );
      const ok = response.status >= 200 && response.status < 300;
      // Resolving a resolved thread (409) or reopening an open one (404) is the goal state.
      const alreadyThere = input.resolved ? response.status === 409 : response.status === 404;
      if (!ok && !alreadyThere) return yield* http.responseError(operation, response);
      if (!input.resolved) {
        if (!ok) {
          const resolution = yield* readResolution();
          if (resolution) return yield* http.responseError(operation, response);
        }
        return { threadId, isResolved: false } satisfies ChangeRequestSetThreadResolvedResult;
      }
      const resolution = ok
        ? yield* decodeBody(operation, response, Page.BitbucketCommentResolutionSchema)
        : yield* readResolution();
      const resolvedBy = Page.bitbucketLogin(resolution?.user);
      return {
        threadId,
        isResolved: true,
        ...(resolvedBy ? { resolvedBy } : {}),
      } satisfies ChangeRequestSetThreadResolvedResult;
    },
  );

  /**
   * Bitbucket has no review object: the verdict is an approval or a change
   * request, and line comments plus the summary are ordinary comments. The
   * head is checked first (Bitbucket anchors comments to the current diff and
   * takes no commit), then the verdict, so a refused verdict posts nothing.
   */
  const submitPullRequestReview = Effect.fn("BitbucketPage.submitPullRequestReview")(function* (
    input: PullRequestTarget & {
      readonly event: ChangeRequestReviewEvent;
      readonly body?: string | undefined;
      readonly comments: ReadonlyArray<ChangeRequestDraftReviewComment>;
      readonly expectedHeadSha: string;
    },
  ) {
    const operation = "submitPullRequestReview";
    const summary = input.body?.trim() ? input.body : undefined;
    if (input.event === "comment" && summary === undefined && input.comments.length === 0) {
      return yield* fail(
        operation,
        "A comment review needs a summary or at least one inline comment.",
      );
    }
    const bodies = [];
    for (const comment of input.comments) {
      bodies.push(yield* decodeOrFail(operation, Page.buildBitbucketInlineCommentBody(comment)));
    }
    const { path } = yield* target(operation, input);
    const pullRequest = yield* getPullRequest(operation, path);
    yield* requireHead(operation, pullRequest, input.expectedHeadSha);

    let participantId: string | null = null;
    if (input.event !== "comment") {
      const participant = yield* http.executeJson(
        operation,
        HttpClientRequest.post(
          http.apiUrl(`${path}/${input.event === "approve" ? "approve" : "request-changes"}`),
        ),
        Page.BitbucketParticipantSchema,
      );
      participantId =
        participant.user?.uuid?.trim() || participant.user?.account_id?.trim() || null;
    }
    let lastCommentId: string | null = null;
    for (const body of bodies) {
      const created = yield* postComment(operation, path, body);
      lastCommentId = String(created.id);
    }
    const summaryComment = summary
      ? yield* postComment(operation, path, { content: { raw: summary } })
      : null;
    const url = summaryComment?.links?.html?.href?.trim();
    const reviewId =
      (summaryComment ? String(summaryComment.id) : null) ??
      lastCommentId ??
      (participantId ? `${input.event}:${participantId}` : `${input.event}:${pullRequest.id}`);
    return {
      reviewId,
      state: reviewState(input.event),
      ...(url ? { url } : {}),
    } satisfies ChangeRequestSubmitReviewResult;
  });

  // ── Lifecycle ───────────────────────────────────────────────────────

  const putPullRequest = (operation: string, path: string, body: object) =>
    http.executeJson(
      operation,
      HttpClientRequest.put(http.apiUrl(path)).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
      BitbucketPullRequests.BitbucketPullRequestSchema,
    );

  const deleteBranch = (
    operation: string,
    repository: BitbucketRepositoryLocator,
    branch: string,
  ) =>
    http
      .executeResponse(
        operation,
        HttpClientRequest.delete(
          http.apiUrl(`${repositoryPath(repository)}/refs/branches/${encodeURIComponent(branch)}`),
        ),
      )
      .pipe(
        Effect.flatMap((response) =>
          // Already gone (deleted on merge, or a previous attempt) is the goal state.
          (response.status >= 200 && response.status < 300) || response.status === 404
            ? Effect.void
            : http.responseError(operation, response),
        ),
      );

  const updatePullRequest = Effect.fn("BitbucketPage.updatePullRequest")(function* (
    input: PullRequestTarget & { readonly action: ChangeRequestUpdateAction },
  ) {
    const operation = "updatePullRequest";
    const { repository, path } = yield* target(operation, input);
    const action = input.action;
    const pullRequest = yield* getPullRequest(operation, path);
    switch (action.kind) {
      case "edit":
      case "set-draft":
        yield* putPullRequest(
          operation,
          path,
          Page.buildBitbucketPullRequestUpdateBody({ pullRequest, action }),
        );
        return;
      case "reviewers": {
        const known = [
          ...(pullRequest.reviewers ?? []),
          ...(pullRequest.participants ?? []).map((participant) => participant.user),
        ];
        const unknown = action.add.filter(
          (login) => !known.some((account) => Page.bitbucketAccountMatchesLogin(account, login)),
        );
        const members = unknown.length > 0 ? (yield* listWorkspaceMembers(input)).accounts : [];
        const reviewers = yield* decodeOrFail(
          operation,
          Page.resolveBitbucketReviewerSet({
            current: pullRequest.reviewers ?? [],
            candidates: [...known, ...members],
            add: action.add,
            remove: action.remove,
          }),
        );
        if (reviewers.some((reviewer) => Page.sameBitbucketAccount(reviewer, pullRequest.author))) {
          return yield* fail(operation, "The author cannot review their own pull request.");
        }
        yield* putPullRequest(
          operation,
          path,
          Page.buildBitbucketPullRequestUpdateBody({
            pullRequest,
            action: { kind: "reviewers" },
            reviewers,
          }),
        );
        return;
      }
      case "close": {
        yield* http.executeJson(
          operation,
          HttpClientRequest.post(http.apiUrl(`${path}/decline`)),
          BitbucketPullRequests.BitbucketPullRequestSchema,
        );
        if (action.deleteBranch === true) {
          if (isBitbucketCrossRepository(pullRequest, repository)) {
            yield* Effect.logWarning(
              "Declined a Bitbucket pull request from a fork; its branch was left in the fork.",
            );
            return;
          }
          yield* deleteBranch(operation, repository, pullRequest.source.branch.name).pipe(
            // The decline succeeded; a failed cleanup must not report it as failed.
            Effect.catch((error) =>
              Effect.logWarning("Declined pull request but could not delete its branch.", {
                detail: error.detail,
              }),
            ),
          );
        }
        return;
      }
      case "delete-branch": {
        if ((pullRequest.state?.trim().toUpperCase() ?? "OPEN") === "OPEN") {
          return yield* fail(
            operation,
            "Close or merge the pull request before deleting its branch.",
          );
        }
        if (isBitbucketCrossRepository(pullRequest, repository)) {
          return yield* fail(
            operation,
            "The head branch lives in a fork; Ryco only deletes branches in the pull request's own repository.",
          );
        }
        yield* deleteBranch(operation, repository, pullRequest.source.branch.name);
        return;
      }
      case "reopen":
      case "labels":
      case "assignees":
      case "update-branch":
      case "auto-merge":
        return yield* fail(operation, `Bitbucket does not support the ${action.kind} action.`);
    }
  });

  /**
   * Merge with the strategy matching `mergeMethod`. Bitbucket takes no head
   * precondition, so the head is compared right before the call (a narrow race
   * remains); its 409 covers refs that move during the merge. A merge that
   * outlasts Bitbucket's synchronous window (202) is polled through the
   * task-status link; one still running afterwards is reported as enqueued.
   */
  const mergePullRequest = Effect.fn("BitbucketPage.mergePullRequest")(function* (
    input: PullRequestTarget & {
      readonly mergeMethod: SourceControlChangeRequestMergeMethod;
      readonly deleteBranch?: boolean | undefined;
      readonly expectedHeadSha?: string | undefined;
    },
  ) {
    const operation = "mergePullRequest";
    const { path } = yield* target(operation, input);
    const pullRequest = yield* getPullRequest(operation, path);
    if ((pullRequest.state?.trim().toUpperCase() ?? "OPEN") !== "OPEN") {
      return yield* fail(operation, "Only open pull requests can be merged.");
    }
    if (input.expectedHeadSha !== undefined) {
      yield* requireHead(operation, pullRequest, input.expectedHeadSha);
    }
    const strategy = Page.bitbucketMergeStrategy(
      input.mergeMethod,
      pullRequest.destination.branch.merge_strategies,
    );
    if (!strategy) {
      return yield* fail(
        operation,
        `The ${input.mergeMethod} merge method is disabled for ${pullRequest.destination.branch.name}.`,
      );
    }
    const response = yield* http.executeResponse(
      operation,
      HttpClientRequest.post(http.apiUrl(`${path}/merge`)).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyJsonUnsafe({
          merge_strategy: strategy,
          ...(input.deleteBranch !== undefined ? { close_source_branch: input.deleteBranch } : {}),
        }),
      ),
    );
    if (response.status === 409) {
      return yield* fail(
        operation,
        "The pull request's branches changed while merging. Refresh and try again.",
        409,
      );
    }
    if (response.status === 555) {
      return yield* fail(
        operation,
        "Bitbucket timed out merging. Check the pull request, then retry.",
        555,
      );
    }
    if (response.status === 202) {
      const location = response.headers["location"]?.trim();
      if (!location || !http.isApiUrl(location)) {
        return { outcome: "enqueued" } satisfies SourceControlMergeChangeRequestResult;
      }
      return yield* pollMergeTask(operation, location);
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* http.responseError(operation, response);
    }
    const merged = yield* decodeBody(
      operation,
      response,
      BitbucketPullRequests.BitbucketPullRequestSchema,
    );
    return {
      outcome: merged.state?.trim().toUpperCase() === "MERGED" ? "merged" : "enqueued",
    } satisfies SourceControlMergeChangeRequestResult;
  });

  const pollMergeTask = Effect.fn("BitbucketPage.pollMergeTask")(function* (
    operation: string,
    location: string,
  ) {
    for (let attempt = 0; attempt < MERGE_TASK_POLL_LIMIT; attempt += 1) {
      if (attempt > 0) yield* Effect.sleep(MERGE_TASK_POLL_INTERVAL);
      const status = yield* http.executeJson(
        operation,
        HttpClientRequest.get(location),
        Page.BitbucketMergeTaskStatusSchema,
      );
      const state = status.task_status.trim().toUpperCase();
      if (state === "SUCCESS")
        return { outcome: "merged" } satisfies SourceControlMergeChangeRequestResult;
      if (state !== "PENDING") {
        return yield* fail(operation, `Bitbucket reported the merge as ${status.task_status}.`);
      }
    }
    return { outcome: "enqueued" } satisfies SourceControlMergeChangeRequestResult;
  });

  return {
    getPullRequest,
    pullRequestTarget: target,
    getPullRequestPageDetail,
    getPullRequestActivity,
    getPullRequestFileContents,
    getPullRequestDiff,
    involvementFilters,
    listWorkspaceMembers,
    addPullRequestComment,
    updatePullRequestComment,
    replyToPullRequestThread,
    setPullRequestThreadResolved,
    submitPullRequestReview,
    updatePullRequest,
    mergePullRequest,
  };
}

function decodeBody<S extends Schema.Decoder<unknown>>(
  operation: string,
  response: HttpClientResponse.HttpClientResponse,
  schema: S,
): Effect.Effect<S["Type"], BitbucketApiError> {
  return response.json.pipe(
    Effect.flatMap((json) => Schema.decodeUnknownEffect(schema)(json)),
    Effect.mapError(
      (cause) =>
        new BitbucketApiError({
          operation,
          detail: "Bitbucket returned invalid JSON for the requested resource.",
          cause,
        }),
    ),
  );
}

/** Read at most `maxBytes` of a body (plus one chunk), reporting whether more was left. */
function readBounded(
  operation: string,
  response: HttpClientResponse.HttpClientResponse,
  maxBytes: number,
): Effect.Effect<{ readonly bytes: Uint8Array; readonly truncated: boolean }, BitbucketApiError> {
  let total = 0;
  return response.stream.pipe(
    Stream.takeUntil((chunk) => {
      total += chunk.byteLength;
      return total > maxBytes;
    }),
    Stream.runCollect,
    Effect.map((chunks) => {
      const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const joined = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return size > maxBytes
        ? { bytes: joined.subarray(0, maxBytes), truncated: true }
        : { bytes: joined, truncated: false };
    }),
    Effect.mapError(
      (cause) =>
        new BitbucketApiError({
          operation,
          detail: "Failed to read the file from Bitbucket.",
          cause,
        }),
    ),
  );
}
