import { Clock, DateTime, Deferred, Effect, Result, Schema } from "effect";
import {
  CHANGE_REQUEST_FILE_CONTENTS_MAX_BYTES,
  type ChangeRequestActivity,
  type ChangeRequestDraftReviewComment,
  type ChangeRequestFileContents,
  type ChangeRequestInvolvement,
  type ChangeRequestReviewEvent,
  type ChangeRequestReviewThread,
  type ChangeRequestSubmitReviewResult,
  type ChangeRequestUpdateAction,
  type ChangeRequestUpdateCommentInput,
  type ChangeRequestUpdateCommentResult,
  type SourceControlAssigneeCandidate,
  type SourceControlChangeRequestMergeMethod,
  type SourceControlCommentReaction,
  type SourceControlCommentReactionContent,
  type SourceControlLabel,
  type SourceControlMergeChangeRequestResult,
} from "@ryco/contracts";

import {
  appendCommentMutationMarker,
  hasCommentMutationMarker,
} from "./gitHubCommentMutationMarker.ts";
import { ForgejoApiError, forgejoStaleHeadError } from "./forgejoApiError.ts";
import type { SourceControlProviderContext } from "./SourceControlProvider.ts";
import { indexForgejoDiffLines, type ForgejoDiffLineIndex } from "./forgejoDiffLines.ts";
import { ForgejoCommentSchema, ForgejoLabelSchema, ForgejoUserSchema } from "./forgejoIssues.ts";
import {
  FORGEJO_COMMIT_MAX_PAGES,
  FORGEJO_PAGE_LIMIT,
  FORGEJO_REACTION_READS_MAX,
  FORGEJO_REVIEW_COMMENT_READS_MAX,
  FORGEJO_REVIEW_MAX_PAGES,
  FORGEJO_TIMELINE_MAX_PAGES,
  ForgejoPullReviewCommentSchema,
  ForgejoPullReviewSchema,
  ForgejoReactionSchema,
  ForgejoTimelineEventSchema,
  buildForgejoReviewThreads,
  decodeForgejoEntries,
  deriveForgejoViewerCapabilities,
  forgejoLogin,
  forgejoPendingReview,
  forgejoThreadsNeedCurrentDiff,
  forgejoViewerContext,
  isForgejoPendingReview,
  normalizeForgejoTimeline,
  parseForgejoCommentId,
  parseForgejoThreadId,
  parseForgejoTime,
  sameForgejoCommit,
  sameForgejoLogin,
  summarizeForgejoReactions,
  toForgejoReactionContent,
  type ForgejoPullReviewComment,
  type ForgejoReviewWithComments,
} from "./forgejoPullRequestActivity.ts";
import {
  buildForgejoMergeBody,
  buildForgejoReviewSubmissionBody,
  encodeForgejoPathSegments,
  forgejoSubmitReviewResult,
  forgejoWorkInProgressTitle,
  isForgejoRepositoryFilePath,
  nextForgejoAssignees,
  resolveForgejoLabelIds,
  splitForgejoReviewers,
} from "./forgejoPullRequestMutations.ts";
import {
  ForgejoBranchSchema,
  ForgejoCombinedStatusSchema,
  deriveForgejoReadiness,
  forgejoMergeCapabilities,
  type ForgejoBranch,
  type ForgejoCombinedStatus,
} from "./forgejoPullRequestReadiness.ts";
import {
  ForgejoCommitSchema,
  ForgejoPullRequestSchema,
  ForgejoRepositorySchema,
  normalizeForgejoPullRequestRecord,
  type ForgejoCommit,
  type ForgejoPullRequest,
  type ForgejoRepository,
  type NormalizedForgejoPullRequestRecord,
} from "./forgejoPullRequests.ts";

/**
 * Forgejo REST v1 calls behind the pull request page (activity, review
 * mutations, lifecycle actions, merges, involvement lists, readiness). The
 * transport (auth, base URL, error mapping) is `ForgejoApi`'s; this module
 * only composes requests. Every request body is JSON, never argv.
 */

/** Where a repository lives on which instance (resolved by `ForgejoApi`). */
export interface ForgejoPageRepository {
  readonly owner: string;
  readonly repo: string;
  readonly instance: { readonly baseUrl: string };
}

export interface ForgejoRequestSpec {
  readonly method?: "GET" | "POST" | "PATCH" | "DELETE";
  /** Path under `/repos/{owner}/{repo}`, or under `/api/v1` when `absolute`. */
  readonly path: string;
  readonly absolute?: boolean;
  readonly urlParams?: Readonly<Record<string, string>>;
  /** Sent as a JSON body. */
  readonly body?: unknown;
}

export interface ForgejoPageHttp<Repository extends ForgejoPageRepository> {
  /** A 2xx JSON response decoded with `schema`. */
  readonly json: <S extends Schema.Top>(
    operation: string,
    repository: Repository,
    spec: ForgejoRequestSpec,
    schema: S,
  ) => Effect.Effect<S["Type"], ForgejoApiError, S["DecodingServices"]>;
  /** A 2xx response; null when it has no body (204). */
  readonly jsonOrEmpty: <S extends Schema.Top>(
    operation: string,
    repository: Repository,
    spec: ForgejoRequestSpec,
    schema: S,
  ) => Effect.Effect<S["Type"] | null, ForgejoApiError, S["DecodingServices"]>;
  /** A 2xx text body. */
  readonly text: (
    operation: string,
    repository: Repository,
    spec: ForgejoRequestSpec,
  ) => Effect.Effect<string, ForgejoApiError>;
  /** A 2xx response whose body is ignored. */
  readonly send: (
    operation: string,
    repository: Repository,
    spec: ForgejoRequestSpec,
  ) => Effect.Effect<void, ForgejoApiError>;
  /** The 2xx body, read up to `maxBytes`. */
  readonly bytes: (
    operation: string,
    repository: Repository,
    spec: ForgejoRequestSpec,
    maxBytes: number,
  ) => Effect.Effect<{ readonly bytes: Uint8Array; readonly truncated: boolean }, ForgejoApiError>;
  /** The authenticated user's login on the repository's instance; null without a token. */
  readonly viewerLogin: (repository: Repository) => Effect.Effect<string | null, ForgejoApiError>;
}

export interface ForgejoPullRequestInput {
  readonly cwd: string;
  readonly reference: string;
}

/** The pull request number in a reference (`42`, `#42`, or a pull request URL). */
export function forgejoPullRequestIndex(reference: string): string {
  const trimmed = reference.trim().replace(/^#/, "");
  const urlMatch = /(?:pulls?|pull-requests?|pullrequests?|pr)\/(\d+)(?:\D.*)?$/iu.exec(trimmed);
  return urlMatch?.[1] ?? trimmed;
}

/** Ceiling for one commit's diff; larger diffs fail clearly instead of truncating mid-hunk. */
const COMMIT_DIFF_MAX_BYTES = 8 * 1024 * 1024;
/** Ceiling for the change request diff read to place review threads. */
const THREAD_DIFF_MAX_BYTES = 8 * 1024 * 1024;
/** Concurrent requests one page read issues. */
const READ_CONCURRENCY = 6;

const UnknownList = Schema.Array(Schema.Unknown);

const ForgejoIssueRefSchema = Schema.Struct({
  number: Schema.Number,
  updated_at: Schema.optional(Schema.NullOr(Schema.String)),
  pull_request: Schema.optional(Schema.Unknown),
  repository: Schema.optional(
    Schema.NullOr(Schema.Struct({ full_name: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
});
type ForgejoIssueRef = typeof ForgejoIssueRefSchema.Type;

const pullPath = (index: string) => `/pulls/${encodeURIComponent(index)}`;
const issuePath = (index: string) => `/issues/${encodeURIComponent(index)}`;

function timeMillis(value: string | null | undefined): number {
  const time = parseForgejoTime(value);
  return time ? DateTime.toEpochMillis(time) : 0;
}

function isNotFound(error: ForgejoApiError): boolean {
  return error.status === 404;
}

// ── Reads shared across list polls ───────────────────────────────────

/** How long a list row's reads are reused: the page's lists poll together. */
const ROW_READ_TTL_MS = 20_000;
/** Entries kept per shared read (oldest dropped first). */
const ROW_READ_CACHE_MAX = 500;
/** Open rows per list whose head status is read; older rows keep what the list said. */
export const FORGEJO_ROW_STATUS_MAX = 50;

/**
 * Keyed reads reused for `ROW_READ_TTL_MS`, including one still in flight, so
 * the page's state, authored and review-requested lists (polled together, and
 * overlapping) read each fact once. `null` means unread and is not kept.
 */
function makeSharedReads<A, E = never>() {
  const entries = new Map<
    string,
    { readonly at: number; readonly value: Deferred.Deferred<A | null, E> }
  >();
  const prune = (now: number) => {
    for (const [key, entry] of entries) if (now - entry.at >= ROW_READ_TTL_MS) entries.delete(key);
    while (entries.size >= ROW_READ_CACHE_MAX) {
      const oldest = entries.keys().next();
      if (oldest.done === true) break;
      entries.delete(oldest.value);
    }
  };
  const read = (key: string, effect: Effect.Effect<A | null, E>): Effect.Effect<A | null, E> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const hit = entries.get(key);
      if (hit && now - hit.at < ROW_READ_TTL_MS) return yield* Deferred.await(hit.value);
      prune(now);
      const value = yield* Deferred.make<A | null, E>();
      entries.set(key, { at: now, value });
      yield* Deferred.into(effect, value);
      return yield* Deferred.await(value).pipe(
        Effect.tap((result) =>
          result === null ? Effect.sync(() => entries.delete(key)) : Effect.void,
        ),
        // A failed or interrupted read is not kept.
        Effect.onError(() => Effect.sync(() => entries.delete(key))),
      );
    });
  /** Store a value another read already returned. */
  const remember = (key: string, known: A): Effect.Effect<void> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      prune(now);
      const value = yield* Deferred.make<A | null, E>();
      yield* Deferred.succeed(value, known);
      entries.set(key, { at: now, value });
    });
  return { read, remember };
}

function failWith(operation: string, detail: string, status?: number): ForgejoApiError {
  return new ForgejoApiError({ operation, detail, ...(status !== undefined ? { status } : {}) });
}

export function makeForgejoPullRequestPageApi<Repository extends ForgejoPageRepository>(input: {
  readonly http: ForgejoPageHttp<Repository>;
  readonly resolveRepository: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext | undefined;
  }) => Effect.Effect<Repository, ForgejoApiError>;
}) {
  const { http } = input;
  const resolveRepository = <
    I extends { readonly cwd: string; readonly context?: SourceControlProviderContext | undefined },
  >(
    request: I,
  ) => input.resolveRepository(request);

  // ── Reads ───────────────────────────────────────────────────────────

  const readPages = <S extends Schema.Codec<unknown, unknown, never, never>>(
    operation: string,
    repository: Repository,
    spec: ForgejoRequestSpec,
    entry: S,
    maxPages: number,
  ) =>
    Effect.gen(function* () {
      const entries: Array<S["Type"]> = [];
      for (let page = 1; page <= maxPages; page += 1) {
        const raw = yield* http.json(
          operation,
          repository,
          {
            ...spec,
            urlParams: { ...spec.urlParams, page: String(page), limit: String(FORGEJO_PAGE_LIMIT) },
          },
          UnknownList,
        );
        entries.push(...decodeForgejoEntries(entry, raw));
        if (raw.length < FORGEJO_PAGE_LIMIT) return { entries, complete: true };
      }
      return { entries, complete: false };
    });

  const getPullRequest = (operation: string, repository: Repository, index: string) =>
    http.json(operation, repository, { path: pullPath(index) }, ForgejoPullRequestSchema);

  const getRepository = (operation: string, repository: Repository) =>
    http.json(operation, repository, { path: "" }, ForgejoRepositorySchema);

  /** The base branch with its protection facts; null when it cannot be read. */
  const getBranch = (operation: string, repository: Repository, branch: string) =>
    http
      .json(
        operation,
        repository,
        { path: `/branches/${encodeForgejoPathSegments(branch)}` },
        ForgejoBranchSchema,
      )
      .pipe(Effect.catch(() => Effect.succeed<ForgejoBranch | null>(null)));

  const listReviews = (
    operation: string,
    repository: Repository,
    index: string,
    maxPages: number,
  ) =>
    readPages(
      operation,
      repository,
      { path: `${pullPath(index)}/reviews` },
      ForgejoPullReviewSchema,
      maxPages,
    );

  /** A review's code comments (Forgejo returns them all at once). */
  const listReviewComments = (
    operation: string,
    repository: Repository,
    index: string,
    reviewId: number,
  ) =>
    http
      .json(
        operation,
        repository,
        { path: `${pullPath(index)}/reviews/${reviewId}/comments` },
        UnknownList,
      )
      .pipe(Effect.map((raw) => decodeForgejoEntries(ForgejoPullReviewCommentSchema, raw)));

  /** The pull request's commits, newest first (without per-commit files or signatures). */
  const listCommits = (operation: string, repository: Repository, index: string) =>
    readPages(
      operation,
      repository,
      {
        path: `${pullPath(index)}/commits`,
        urlParams: { verification: "false", files: "false" },
      },
      ForgejoCommitSchema,
      FORGEJO_COMMIT_MAX_PAGES,
    );

  const readText = (
    operation: string,
    repository: Repository,
    spec: ForgejoRequestSpec,
    maxBytes: number,
    tooLarge: string,
  ) =>
    http
      .bytes(operation, repository, spec, maxBytes)
      .pipe(
        Effect.flatMap(({ bytes, truncated }) =>
          truncated
            ? Effect.fail(failWith(operation, tooLarge))
            : Effect.succeed(new TextDecoder().decode(bytes)),
        ),
      );

  const pullRequestDiff = (operation: string, repository: Repository, index: string) =>
    readText(
      operation,
      repository,
      { path: `/pulls/${encodeURIComponent(index)}.diff` },
      THREAD_DIFF_MAX_BYTES,
      "This pull request's diff is too large to read.",
    );

  const reviewerContext = (operation: string, repository: Repository) =>
    Effect.all(
      {
        login: http.viewerLogin(repository),
        repositoryInfo: getRepository(operation, repository),
      },
      { concurrency: 2 },
    ).pipe(
      Effect.map(({ login, repositoryInfo }) => ({
        repositoryInfo,
        viewer: forgejoViewerContext({ login, permissions: repositoryInfo.permissions }),
      })),
    );

  /** Reactions per comment id for the newest comments; a failed read leaves a comment without. */
  const readReactions = (
    operation: string,
    repository: Repository,
    comments: ReadonlyArray<{ readonly id: number; readonly createdAt: string | null | undefined }>,
    viewerLogin: string | null,
  ) => {
    const newest = comments
      .toSorted(
        (left, right) =>
          timeMillis(right.createdAt) - timeMillis(left.createdAt) || right.id - left.id,
      )
      .slice(0, FORGEJO_REACTION_READS_MAX);
    return Effect.forEach(
      newest,
      (comment) =>
        http
          .json(
            operation,
            repository,
            { path: `/issues/comments/${comment.id}/reactions` },
            UnknownList,
          )
          .pipe(
            Effect.map(
              (raw) =>
                [
                  comment.id,
                  summarizeForgejoReactions(
                    decodeForgejoEntries(ForgejoReactionSchema, raw),
                    viewerLogin,
                  ),
                ] as const,
            ),
            Effect.catch(() =>
              Effect.succeed([
                comment.id,
                [] as ReadonlyArray<SourceControlCommentReaction>,
              ] as const),
            ),
          ),
      { concurrency: READ_CONCURRENCY },
    ).pipe(Effect.map((entries) => new Map(entries)));
  };

  /** The current diff's lines when a thread needs them; null when unread or unreadable. */
  const threadDiff = (
    operation: string,
    repository: Repository,
    index: string,
    reviews: ReadonlyArray<ForgejoReviewWithComments>,
    headSha: string | null,
  ): Effect.Effect<ForgejoDiffLineIndex | null> =>
    forgejoThreadsNeedCurrentDiff(reviews, headSha)
      ? pullRequestDiff(operation, repository, index).pipe(
          Effect.map(indexForgejoDiffLines),
          Effect.catch(() => Effect.succeed(null)),
        )
      : Effect.succeed(null);

  // ── Readiness ───────────────────────────────────────────────────────

  /**
   * Reviews, the head's commit statuses and the base branch for one pull
   * request. Each read degrades on its own: what fails is left out, never
   * guessed.
   */
  const readReadiness = (input: {
    readonly operation: string;
    readonly repository: Repository;
    readonly record: NormalizedForgejoPullRequestRecord;
    readonly repositoryInfo: ForgejoRepository | null;
    readonly branch: Effect.Effect<ForgejoBranch | null>;
    readonly reviewPages: number;
  }) =>
    Effect.all(
      {
        reviews: listReviews(
          input.operation,
          input.repository,
          String(input.record.number),
          input.reviewPages,
        ).pipe(
          Effect.map((page) => page.entries),
          Effect.catch(() => Effect.succeed(null)),
        ),
        status: input.record.headSha
          ? http
              .json(
                input.operation,
                input.repository,
                {
                  path: `/commits/${encodeURIComponent(input.record.headSha)}/status`,
                  urlParams: { limit: String(FORGEJO_PAGE_LIMIT) },
                },
                ForgejoCombinedStatusSchema,
              )
              .pipe(Effect.catch(() => Effect.succeed(null)))
          : Effect.succeed(null),
        branch: input.branch,
      },
      { concurrency: 3 },
    ).pipe(
      Effect.map(({ reviews, status, branch }) =>
        deriveForgejoReadiness({
          record: input.record,
          reviews,
          status,
          branch,
          repository: input.repositoryInfo,
        }),
      ),
    );

  /** Readiness for one pull request's detail. */
  const readDetailReadiness = (
    request: { readonly cwd: string; readonly context?: SourceControlProviderContext | undefined },
    record: NormalizedForgejoPullRequestRecord,
  ) =>
    Effect.gen(function* () {
      const operation = "getPullRequestReadiness";
      const repository = yield* resolveRepository(request);
      const repositoryInfo = yield* getRepository(operation, repository).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      return yield* readReadiness({
        operation,
        repository,
        record,
        repositoryInfo,
        branch: getBranch(operation, repository, record.baseRefName),
        reviewPages: 2,
      });
    });

  /** A detail with its readiness facts. */
  const withDetailReadiness = <Detail extends NormalizedForgejoPullRequestRecord>(
    request: { readonly cwd: string; readonly context?: SourceControlProviderContext | undefined },
    detail: Detail,
  ) =>
    Effect.gen(function* () {
      const readiness = yield* readDetailReadiness(request, detail);
      return { ...detail, readiness };
    });

  // ── List rows ───────────────────────────────────────────────────────
  //
  // A row carries only what is cheap: the list's own mergeability and draft
  // state plus its head's combined status (one read per head, shared across
  // the page's lists). Reviews, branch rules and merge settings are the
  // detail's (`listReadiness: "blockers"`), so a list poll stays at about one
  // read per open head instead of four.

  const repositoryKey = (repository: Repository) =>
    `${repository.instance.baseUrl}\u0000${repository.owner}/${repository.repo}`.toLowerCase();
  const sharedHeadStatus = makeSharedReads<ForgejoCombinedStatus>();
  const sharedPullRequest = makeSharedReads<NormalizedForgejoPullRequestRecord, ForgejoApiError>();
  const pullRequestKey = (repository: Repository, number: number, updatedAtMs: number) =>
    `${repositoryKey(repository)}\u0000${number}\u0000${updatedAtMs}`;
  const recordUpdatedAtMs = (record: NormalizedForgejoPullRequestRecord) =>
    record.updatedAt._tag === "Some" ? DateTime.toEpochMillis(record.updatedAt.value) : 0;

  const headStatus = (operation: string, repository: Repository, sha: string) =>
    sharedHeadStatus.read(
      `${repositoryKey(repository)}\u0000${sha.toLowerCase()}`,
      http
        .json(
          operation,
          repository,
          {
            path: `/commits/${encodeURIComponent(sha)}/status`,
            urlParams: { limit: String(FORGEJO_PAGE_LIMIT) },
          },
          ForgejoCombinedStatusSchema,
        )
        .pipe(Effect.catch(() => Effect.succeed(null))),
    );

  /**
   * Page list rows carry the facts above for open pull requests (closed and
   * merged ones state themselves). The newest `FORGEJO_ROW_STATUS_MAX` open
   * rows get their head's status; a row whose read fails keeps what the list
   * said. The rows are also remembered, so another list naming the same pull
   * request at the same update does not re-read it.
   */
  const withRowReadiness = (
    operation: string,
    repository: Repository,
    records: ReadonlyArray<NormalizedForgejoPullRequestRecord>,
  ) =>
    Effect.gen(function* () {
      yield* Effect.forEach(
        records,
        (record) =>
          sharedPullRequest.remember(
            pullRequestKey(repository, record.number, recordUpdatedAtMs(record)),
            record,
          ),
        { discard: true },
      );
      const open = records.filter((record) => record.state === "open");
      if (open.length === 0) return records;
      const read = open
        .filter((record) => record.headSha)
        .toSorted((left, right) => recordUpdatedAtMs(right) - recordUpdatedAtMs(left))
        .slice(0, FORGEJO_ROW_STATUS_MAX);
      const statuses = new Map(
        yield* Effect.forEach(
          read,
          (record) =>
            headStatus(operation, repository, record.headSha!).pipe(
              Effect.map((status) => [record.number, status] as const),
            ),
          { concurrency: READ_CONCURRENCY },
        ),
      );
      return records.map((record) =>
        record.state === "open"
          ? {
              ...record,
              readiness: deriveForgejoReadiness({
                record,
                reviews: null,
                status: statuses.get(record.number) ?? null,
                branch: null,
                repository: null,
              }),
            }
          : record,
      );
    });

  /**
   * Open each listed pull request (the issue endpoints carry no branches),
   * reusing a row another list just read at the same update.
   */
  const pullRequestsForNumbers = (
    operation: string,
    repository: Repository,
    refs: ReadonlyArray<{ readonly number: number; readonly updatedAtMs: number }>,
  ) =>
    Effect.forEach(
      refs,
      (ref) =>
        sharedPullRequest.read(
          pullRequestKey(repository, ref.number, ref.updatedAtMs),
          getPullRequest(operation, repository, String(ref.number)).pipe(
            Effect.map((raw) => normalizeForgejoPullRequestRecord(raw)),
            // Deleted between the list and the read: drop it.
            Effect.catch((error) =>
              isNotFound(error) ? Effect.succeed(null) : Effect.fail(error),
            ),
          ),
        ),
      { concurrency: READ_CONCURRENCY },
    ).pipe(Effect.map((records) => records.flatMap((record) => (record ? [record] : []))));

  const matchesState = (
    record: NormalizedForgejoPullRequestRecord,
    state: "open" | "closed" | "merged" | "all",
  ) =>
    state === "all" ||
    (state === "open" && record.state === "open") ||
    (state === "closed" && record.state !== "open") ||
    (state === "merged" && record.state === "merged");

  const issueState = (state: "open" | "closed" | "merged" | "all") =>
    state === "merged" ? "closed" : state;

  // ── Lists ───────────────────────────────────────────────────────────

  /**
   * Pull requests involving the viewer. Authored, assigned and mentioned use
   * the repository's issue filters (`created_by`, `assigned_by`,
   * `mentioned_by`); review requests only exist on the cross-repository issue
   * search (`review_requested`), which is narrowed to this repository.
   * `involved` is the union of the four.
   */
  const listInvolvedPullRequests = (request: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext | undefined;
    readonly involvement: ChangeRequestInvolvement;
    readonly state: "open" | "closed" | "merged" | "all";
    readonly query?: string | undefined;
    readonly limit: number;
  }) =>
    Effect.gen(function* () {
      const operation = "listInvolvedPullRequests";
      const repository = yield* resolveRepository(request);
      const login = yield* http.viewerLogin(repository);
      if (!login) {
        return yield* failWith(
          operation,
          "Sign in to Forgejo (RYCO_FORGEJO_TOKEN or `fj auth login`) to filter pull requests by involvement.",
        );
      }
      const query = request.query?.trim() ?? "";
      const common = {
        type: "pulls",
        state: issueState(request.state),
        sort: "recentupdate",
        limit: String(FORGEJO_PAGE_LIMIT),
        ...(query.length > 0 ? { q: query } : {}),
      };
      const kinds: ReadonlyArray<Exclude<ChangeRequestInvolvement, "involved">> =
        request.involvement === "involved"
          ? ["authored", "review-requested", "assigned", "mentioned"]
          : [request.involvement];
      const fullName = `${repository.owner}/${repository.repo}`.toLowerCase();
      const lists = yield* Effect.forEach(
        kinds,
        (kind): Effect.Effect<ReadonlyArray<ForgejoIssueRef>, ForgejoApiError> => {
          if (kind === "review-requested") {
            return readPages(
              operation,
              repository,
              {
                path: "/repos/issues/search",
                absolute: true,
                urlParams: { ...common, review_requested: "true", owner: repository.owner },
              },
              ForgejoIssueRefSchema,
              3,
            ).pipe(
              Effect.map((page) =>
                page.entries.filter(
                  (issue) => issue.repository?.full_name?.toLowerCase() === fullName,
                ),
              ),
            );
          }
          const filter =
            kind === "authored"
              ? "created_by"
              : kind === "assigned"
                ? "assigned_by"
                : "mentioned_by";
          return http
            .json(
              operation,
              repository,
              { path: "/issues", urlParams: { ...common, [filter]: login } },
              UnknownList,
            )
            .pipe(Effect.map((raw) => decodeForgejoEntries(ForgejoIssueRefSchema, raw)));
        },
        { concurrency: 4 },
      );
      const byNumber = new Map<number, number>();
      for (const issue of lists.flat()) {
        const updated = timeMillis(issue.updated_at);
        byNumber.set(issue.number, Math.max(byNumber.get(issue.number) ?? 0, updated));
      }
      const refs = [...byNumber.entries()]
        .toSorted((left, right) => right[1] - left[1] || right[0] - left[0])
        .map(([number, updatedAtMs]) => ({ number, updatedAtMs }))
        .slice(0, request.limit);
      const records = (yield* pullRequestsForNumbers(operation, repository, refs)).filter(
        (record) => matchesState(record, request.state),
      );
      return yield* withRowReadiness(operation, repository, records);
    });

  /** The host's search over pull request titles, bodies and comments (plus `#n`). */
  const searchPullRequests = (request: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext | undefined;
    readonly query: string;
    readonly limit: number;
  }) =>
    Effect.gen(function* () {
      const operation = "searchPullRequests";
      const repository = yield* resolveRepository(request);
      const query = request.query.trim();
      const direct = /^#?(\d+)$/u.exec(query)?.[1];
      const issues =
        query.length === 0
          ? []
          : yield* http
              .json(
                operation,
                repository,
                {
                  path: "/issues",
                  urlParams: {
                    type: "pulls",
                    state: "all",
                    sort: "recentupdate",
                    q: query,
                    limit: String(Math.min(request.limit, FORGEJO_PAGE_LIMIT)),
                  },
                },
                UnknownList,
              )
              .pipe(Effect.map((raw) => decodeForgejoEntries(ForgejoIssueRefSchema, raw)));
      const updatedAt = new Map(
        issues.map((issue) => [issue.number, timeMillis(issue.updated_at)]),
      );
      const refs = [
        ...new Set([...(direct ? [Number(direct)] : []), ...issues.map((issue) => issue.number)]),
      ]
        .slice(0, request.limit)
        .map((number) => ({ number, updatedAtMs: updatedAt.get(number) ?? 0 }));
      const records = yield* pullRequestsForNumbers(operation, repository, refs);
      return yield* withRowReadiness(operation, repository, records);
    });

  // ── Activity ────────────────────────────────────────────────────────

  const getPullRequestActivity = (
    request: ForgejoPullRequestInput & {
      readonly context?: SourceControlProviderContext | undefined;
    },
  ): Effect.Effect<ChangeRequestActivity, ForgejoApiError> =>
    Effect.gen(function* () {
      const operation = "getPullRequestActivity";
      const repository = yield* resolveRepository(request);
      const index = forgejoPullRequestIndex(request.reference);
      const { pullRequest, context } = yield* Effect.all(
        {
          pullRequest: getPullRequest(operation, repository, index),
          context: reviewerContext(operation, repository),
        },
        { concurrency: 2 },
      );
      const record = normalizeForgejoPullRequestRecord(pullRequest);
      const { viewer } = context;
      const { branch, timeline, reviews, commits } = yield* Effect.all(
        {
          branch: getBranch(operation, repository, record.baseRefName),
          timeline: readPages(
            operation,
            repository,
            { path: `${issuePath(index)}/timeline` },
            ForgejoTimelineEventSchema,
            FORGEJO_TIMELINE_MAX_PAGES,
          ),
          reviews: listReviews(operation, repository, index, FORGEJO_REVIEW_MAX_PAGES),
          commits: listCommits(operation, repository, index).pipe(
            Effect.catch((error) =>
              isNotFound(error)
                ? Effect.succeed({ entries: [] as ReadonlyArray<ForgejoCommit>, complete: true })
                : Effect.fail(error),
            ),
          ),
        },
        { concurrency: 4 },
      );

      // Site admins are shown everyone's pending reviews; only the viewer's own are theirs to see.
      const visibleReviews = reviews.entries.filter(
        (review) =>
          !isForgejoPendingReview(review) ||
          sameForgejoLogin(forgejoLogin(review.user), viewer?.login),
      );
      // Newest reviews first: their conversations matter most when the read is capped.
      const withComments = visibleReviews
        .filter((review) => (review.comments_count ?? 1) > 0)
        .toSorted(
          (left, right) =>
            timeMillis(right.submitted_at) - timeMillis(left.submitted_at) || right.id - left.id,
        );
      const commentReads = withComments.slice(0, FORGEJO_REVIEW_COMMENT_READS_MAX);
      const commentsByReview = new Map(
        yield* Effect.forEach(
          commentReads,
          (review) =>
            listReviewComments(operation, repository, index, review.id).pipe(
              Effect.map((comments) => [review.id, comments] as const),
              Effect.catch((error) =>
                isNotFound(error)
                  ? Effect.succeed([
                      review.id,
                      [] as ReadonlyArray<ForgejoPullReviewComment>,
                    ] as const)
                  : Effect.fail(error),
              ),
            ),
          { concurrency: 4 },
        ),
      );
      const reviewsWithComments: ReadonlyArray<ForgejoReviewWithComments> = visibleReviews.map(
        (review) => ({ review, comments: commentsByReview.get(review.id) ?? [] }),
      );

      const reactionsByCommentId = yield* readReactions(
        operation,
        repository,
        [
          ...timeline.entries
            .filter((event) => event.type === "comment")
            .map((event) => ({ id: event.id, createdAt: event.created_at })),
          ...reviewsWithComments.flatMap(({ comments }) =>
            comments.map((comment) => ({ id: comment.id, createdAt: comment.created_at })),
          ),
        ],
        viewer?.login ?? null,
      );

      const headSha = record.headSha ?? null;
      const diff = yield* threadDiff(operation, repository, index, reviewsWithComments, headSha);
      const viewerCapabilities = deriveForgejoViewerCapabilities({
        viewer,
        authorLogin: record.author,
        isLocked: record.isLocked === true,
        isCrossRepository: record.isCrossRepository === true,
        allowMaintainerEdit: record.allowMaintainerEdit === true,
        userCanMergeBase:
          typeof branch?.user_can_merge === "boolean" ? branch.user_can_merge : null,
      });
      const threads = buildForgejoReviewThreads({
        reviews: reviewsWithComments,
        anchor: { headSha, diff },
        viewer,
        viewerCanReply: viewerCapabilities?.canReview === true,
        reactionsByCommentId,
      });
      const items = normalizeForgejoTimeline({
        events: timeline.entries,
        commits: commits.entries,
        reviewsById: new Map(reviews.entries.map((review) => [review.id, review])),
        threadIdsByReviewId: threads.threadIdsByReviewId,
        reactionsByCommentId,
        viewer,
        baseRefName: record.baseRefName,
      });
      return {
        provider: "forgejo",
        number: record.number,
        headSha,
        viewer: viewerCapabilities,
        timeline: items.items,
        timelineTruncated: items.truncated || !timeline.complete,
        reviewThreads: threads.threads,
        reviewThreadsTruncated:
          !reviews.complete || withComments.length > FORGEJO_REVIEW_COMMENT_READS_MAX,
        pendingReview: forgejoPendingReview(reviewsWithComments, viewer),
      } satisfies ChangeRequestActivity;
    });

  // ── Files ───────────────────────────────────────────────────────────

  const readFileAt = (operation: string, repository: Repository, path: string, ref: string) =>
    http
      .bytes(
        operation,
        repository,
        {
          path: `/raw/${encodeForgejoPathSegments(path)}`,
          urlParams: { ref },
        },
        CHANGE_REQUEST_FILE_CONTENTS_MAX_BYTES,
      )
      .pipe(
        Effect.map(({ bytes, truncated }) =>
          // Binary files cannot be expanded as text.
          bytes.includes(0)
            ? { contents: null, truncated: false }
            : { contents: new TextDecoder().decode(bytes), truncated },
        ),
        // Absent on this side: the file was added or deleted by the change.
        Effect.catch((error) =>
          isNotFound(error)
            ? Effect.succeed({ contents: null, truncated: false })
            : Effect.fail(error),
        ),
      );

  const getPullRequestFileContents = (request: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext | undefined;
    readonly reference: string;
    readonly path: string;
    readonly previousPath?: string | undefined;
    readonly baseSha?: string | undefined;
    readonly headSha: string;
  }): Effect.Effect<ChangeRequestFileContents, ForgejoApiError> =>
    Effect.gen(function* () {
      const operation = "getPullRequestFileContents";
      for (const path of [request.path, request.previousPath]) {
        if (path !== undefined && !isForgejoRepositoryFilePath(path)) {
          return yield* failWith(operation, `Invalid repository file path: ${path}`);
        }
      }
      const repository = yield* resolveRepository(request);
      // The whole change request diffs against the merge base Forgejo recorded.
      let baseSha = request.baseSha;
      if (baseSha === undefined) {
        const pullRequest = yield* getPullRequest(
          operation,
          repository,
          forgejoPullRequestIndex(request.reference),
        );
        baseSha = normalizeForgejoPullRequestRecord(pullRequest).mergeBase;
      }
      if (!baseSha) {
        return yield* failWith(
          operation,
          "Forgejo did not report a merge base for this pull request.",
        );
      }
      const [oldSide, newSide] = yield* Effect.all(
        [
          readFileAt(operation, repository, request.previousPath ?? request.path, baseSha),
          readFileAt(operation, repository, request.path, request.headSha),
        ],
        { concurrency: 2 },
      );
      return {
        path: request.path,
        oldContents: oldSide.contents,
        newContents: newSide.contents,
        truncated: oldSide.truncated || newSide.truncated,
      };
    });

  /**
   * One commit's diff, only for commits of this pull request (its commit
   * list, newest 250), so a commit from elsewhere is never shown as part of it.
   */
  const getPullRequestCommitDiff = (
    operation: string,
    repository: Repository,
    index: string,
    commitSha: string,
  ) =>
    Effect.gen(function* () {
      const commits = yield* listCommits(operation, repository, index);
      const wanted = commitSha.toLowerCase();
      const matches = commits.entries
        .flatMap((commit) => (commit.sha ? [commit.sha] : []))
        .filter((sha) =>
          wanted.length >= 7 ? sha.toLowerCase().startsWith(wanted) : sha.toLowerCase() === wanted,
        );
      const sha = matches.length === 1 ? matches[0] : undefined;
      if (!sha) {
        return yield* failWith(
          operation,
          `Commit ${commitSha} is not part of pull request #${index}.`,
        );
      }
      return yield* readText(
        operation,
        repository,
        { path: `/git/commits/${encodeURIComponent(sha)}.diff` },
        COMMIT_DIFF_MAX_BYTES,
        "This commit's diff is too large to display.",
      );
    });

  /**
   * The change request diff (or one commit's), refusing when the head moved
   * while it loaded so the page never pairs a diff with the wrong head.
   */
  const getPullRequestDiff = (request: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext | undefined;
    readonly reference: string;
    readonly expectedHeadSha?: string | undefined;
    readonly commitSha?: string | undefined;
  }) =>
    Effect.gen(function* () {
      const operation = "getPullRequestDiff";
      const repository = yield* resolveRepository(request);
      const index = forgejoPullRequestIndex(request.reference);
      const verifyHead = () =>
        getPullRequest(operation, repository, index).pipe(
          Effect.flatMap((pull) =>
            sameForgejoCommit(pull.head.sha, request.expectedHeadSha)
              ? Effect.void
              : Effect.fail(
                  failWith(
                    operation,
                    "Pull request changed while loading the diff. Refresh and try again.",
                  ),
                ),
          ),
        );
      if (request.expectedHeadSha) yield* verifyHead();
      const commitSha = request.commitSha?.trim();
      const diff = commitSha
        ? yield* getPullRequestCommitDiff(operation, repository, index, commitSha)
        : yield* http.text(operation, repository, {
            path: `/pulls/${encodeURIComponent(index)}.diff`,
          });
      if (request.expectedHeadSha) yield* verifyHead();
      return diff;
    });

  // ── Comments and reactions ──────────────────────────────────────────

  const addPullRequestComment = (request: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext | undefined;
    readonly reference: string;
    readonly body: string;
    readonly clientMutationId?: string | undefined;
  }) =>
    Effect.gen(function* () {
      const operation = "addPullRequestComment";
      const repository = yield* resolveRepository(request);
      const index = forgejoPullRequestIndex(request.reference);
      if (request.clientMutationId) {
        // A retried request must not post the same comment twice.
        const comments = yield* http
          .json(operation, repository, { path: `${issuePath(index)}/comments` }, UnknownList)
          .pipe(Effect.map((raw) => decodeForgejoEntries(ForgejoCommentSchema, raw)));
        if (
          hasCommentMutationMarker(
            comments.map((comment) => ({ body: comment.body ?? "" })),
            request.clientMutationId,
          )
        ) {
          return;
        }
      }
      yield* http.send(operation, repository, {
        method: "POST",
        path: `${issuePath(index)}/comments`,
        body: { body: appendCommentMutationMarker(request.body, request.clientMutationId) },
      });
    });

  /** Add the viewer's reaction, or remove it when they already reacted with it. */
  const togglePullRequestCommentReaction = (request: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext | undefined;
    readonly reference: string;
    readonly commentId: string;
    readonly content: SourceControlCommentReactionContent;
  }) =>
    Effect.gen(function* () {
      const operation = "togglePullRequestCommentReaction";
      const parsed = parseForgejoCommentId(request.commentId);
      if (!parsed)
        return yield* failWith(operation, `Unknown Forgejo comment id: ${request.commentId}`);
      const repository = yield* resolveRepository(request);
      const login = yield* http.viewerLogin(repository);
      if (!login) return yield* failWith(operation, "Sign in to Forgejo to react to comments.");
      const path = `/issues/comments/${parsed.commentId}/reactions`;
      const content = toForgejoReactionContent(request.content);
      const reactions = yield* http
        .json(operation, repository, { path }, UnknownList)
        .pipe(Effect.map((raw) => decodeForgejoEntries(ForgejoReactionSchema, raw)));
      const reacted = reactions.some(
        (reaction) =>
          sameForgejoLogin(forgejoLogin(reaction.user), login) &&
          reaction.content?.trim().toLowerCase() === content,
      );
      yield* http.send(operation, repository, {
        method: reacted ? "DELETE" : "POST",
        path,
        body: { content },
      });
    });

  const updatePullRequestComment = (
    request: ChangeRequestUpdateCommentInput,
  ): Effect.Effect<ChangeRequestUpdateCommentResult, ForgejoApiError> =>
    Effect.gen(function* () {
      const operation = "updatePullRequestComment";
      if (request.commentKind === "review") {
        return yield* failWith(operation, "Forgejo review summaries cannot be edited from Ryco.");
      }
      const parsed = parseForgejoCommentId(request.commentId);
      if (!parsed)
        return yield* failWith(operation, `Unknown Forgejo comment id: ${request.commentId}`);
      const repository = yield* resolveRepository(request);
      if (request.action === "edit") {
        // Forgejo edits plain and code comments alike; it answers 204 (no edit)
        // for comment types without content.
        const edited = yield* http.jsonOrEmpty(
          operation,
          repository,
          {
            method: "PATCH",
            path: `/issues/comments/${parsed.commentId}`,
            body: { body: request.body },
          },
          Schema.Unknown,
        );
        if (edited === null)
          return yield* failWith(operation, "Forgejo did not edit this comment.");
        return { commentId: request.commentId, deleted: false };
      }
      if (request.commentKind === "review-comment") {
        if (parsed.kind !== "review-comment") {
          return yield* failWith(
            operation,
            `Unknown Forgejo review comment id: ${request.commentId}`,
          );
        }
        yield* http.send(operation, repository, {
          method: "DELETE",
          path: `${pullPath(forgejoPullRequestIndex(request.reference))}/reviews/${parsed.reviewId}/comments/${parsed.commentId}`,
        });
      } else {
        yield* http.send(operation, repository, {
          method: "DELETE",
          path: `/issues/comments/${parsed.commentId}`,
        });
      }
      return { commentId: request.commentId, deleted: true };
    });

  // ── Reviews ─────────────────────────────────────────────────────────

  /**
   * Submit a review on the head the drafts were written against. Forgejo
   * gathers the viewer's pending review (started on the web) into it, but
   * takes `commit_id` without checking it is the head, so the head is checked
   * first.
   */
  const submitPullRequestReview = (request: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext | undefined;
    readonly reference: string;
    readonly event: ChangeRequestReviewEvent;
    readonly body?: string | undefined;
    readonly comments: ReadonlyArray<ChangeRequestDraftReviewComment>;
    readonly expectedHeadSha: string;
  }): Effect.Effect<ChangeRequestSubmitReviewResult, ForgejoApiError> =>
    Effect.gen(function* () {
      const operation = "submitPullRequestReview";
      const submission = buildForgejoReviewSubmissionBody(request);
      if (Result.isFailure(submission)) return yield* failWith(operation, submission.failure);
      const repository = yield* resolveRepository(request);
      const index = forgejoPullRequestIndex(request.reference);
      const pullRequest = yield* getPullRequest(operation, repository, index);
      if (!sameForgejoCommit(pullRequest.head.sha, request.expectedHeadSha)) {
        return yield* forgejoStaleHeadError(operation);
      }
      const review = yield* http.json(
        operation,
        repository,
        { method: "POST", path: `${pullPath(index)}/reviews`, body: submission.success },
        ForgejoPullReviewSchema,
      );
      const result = forgejoSubmitReviewResult(review);
      return Result.isSuccess(result) ? result.success : yield* failWith(operation, result.failure);
    });

  /** A thread re-read after a change: its review, comments and the current head. */
  const readThread = (
    operation: string,
    repository: Repository,
    index: string,
    threadId: string,
    reviewId: number,
  ) =>
    Effect.gen(function* () {
      const { pullRequest, review, comments, context } = yield* Effect.all(
        {
          pullRequest: getPullRequest(operation, repository, index),
          review: http.json(
            operation,
            repository,
            { path: `${pullPath(index)}/reviews/${reviewId}` },
            ForgejoPullReviewSchema,
          ),
          comments: listReviewComments(operation, repository, index, reviewId),
          context: reviewerContext(operation, repository),
        },
        { concurrency: 4 },
      );
      const headSha = pullRequest.head.sha?.trim() || null;
      const reviews = [{ review, comments }];
      const diff = yield* threadDiff(operation, repository, index, reviews, headSha);
      const thread = buildForgejoReviewThreads({
        reviews,
        anchor: { headSha, diff },
        viewer: context.viewer,
        viewerCanReply: context.viewer !== null,
      }).threads.find((candidate) => candidate.id === threadId);
      return thread ?? null;
    });

  /**
   * Reply into the conversation: a code comment on the same path and line,
   * added to the review that opened it (Forgejo's own reply), so the host
   * threads it the same way.
   */
  const replyToPullRequestReviewThread = (request: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext | undefined;
    readonly reference: string;
    readonly threadId: string;
    readonly body: string;
    readonly clientMutationId?: string | undefined;
  }): Effect.Effect<ChangeRequestReviewThread, ForgejoApiError> =>
    Effect.gen(function* () {
      const operation = "replyToPullRequestReviewThread";
      const ids = parseForgejoThreadId(request.threadId);
      if (!ids)
        return yield* failWith(operation, `Unknown Forgejo review thread: ${request.threadId}`);
      const repository = yield* resolveRepository(request);
      const index = forgejoPullRequestIndex(request.reference);
      const comments = yield* listReviewComments(operation, repository, index, ids.reviewId);
      const opener = comments.find((comment) => comment.id === ids.firstCommentId);
      const path = opener?.path?.trim();
      if (!opener || !path) {
        return yield* failWith(operation, "This conversation no longer exists on Forgejo.", 404);
      }
      const onSameLine = comments.filter(
        (comment) =>
          comment.path?.trim() === path &&
          (comment.position ?? 0) === (opener.position ?? 0) &&
          (comment.original_position ?? 0) === (opener.original_position ?? 0),
      );
      const alreadyPosted = hasCommentMutationMarker(
        onSameLine.map((comment) => ({ body: comment.body ?? "" })),
        request.clientMutationId,
      );
      if (!alreadyPosted) {
        const newSide = (opener.position ?? 0) > 0;
        yield* http.send(operation, repository, {
          method: "POST",
          path: `${pullPath(index)}/reviews/${ids.reviewId}/comments`,
          body: {
            path,
            body: appendCommentMutationMarker(request.body, request.clientMutationId),
            ...(newSide
              ? { new_position: opener.position }
              : { old_position: opener.original_position ?? 0 }),
          },
        });
      }
      const thread = yield* readThread(
        operation,
        repository,
        index,
        request.threadId,
        ids.reviewId,
      );
      return thread ?? (yield* failWith(operation, "Forgejo did not return the conversation."));
    });

  // ── Lifecycle ───────────────────────────────────────────────────────

  const listAllLabels = (operation: string, repository: Repository) =>
    Effect.all(
      {
        repo: readPages(operation, repository, { path: "/labels" }, ForgejoLabelSchema, 10),
        // Organization labels apply to its repositories; a user owner has none (404).
        org: readPages(
          operation,
          repository,
          { path: `/orgs/${encodeURIComponent(repository.owner)}/labels`, absolute: true },
          ForgejoLabelSchema,
          10,
        ).pipe(
          Effect.catch((error) =>
            isNotFound(error)
              ? Effect.succeed({ entries: [], complete: true })
              : Effect.fail(error),
          ),
        ),
      },
      { concurrency: 2 },
    ).pipe(Effect.map(({ repo, org }) => [...repo.entries, ...org.entries]));

  const listLabels = (request: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext | undefined;
  }) =>
    resolveRepository(request).pipe(
      Effect.flatMap((repository) => listAllLabels("listLabels", repository)),
      Effect.map((labels): ReadonlyArray<SourceControlLabel> => {
        const seen = new Set<string>();
        return labels.flatMap((label) => {
          if (seen.has(label.name)) return [];
          seen.add(label.name);
          const color = label.color?.trim().replace(/^#/u, "");
          const description = label.description?.trim();
          return [
            {
              name: label.name,
              ...(color ? { color } : {}),
              ...(description ? { description } : {}),
            },
          ];
        });
      }),
    );

  /** Users with write access (`GET /repos/{owner}/{repo}/assignees`): assignees and reviewers alike. */
  const listAssignees = (request: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext | undefined;
  }) =>
    resolveRepository(request).pipe(
      Effect.flatMap((repository) =>
        http.json("listAssignees", repository, { path: "/assignees" }, UnknownList),
      ),
      Effect.map((raw): ReadonlyArray<SourceControlAssigneeCandidate> =>
        decodeForgejoEntries(ForgejoUserSchema, raw).flatMap((user) => {
          const login = user.login?.trim() || user.username?.trim();
          if (!login) return [];
          const displayName = user.full_name?.trim();
          const avatarUrl = user.avatar_url?.trim();
          return [
            {
              login,
              ...(displayName ? { displayName } : {}),
              ...(avatarUrl ? { avatarUrl } : {}),
            },
          ];
        }),
      ),
    );

  /**
   * Delete a merged or closed pull request's head branch, in its own
   * repository only (a fork's branches are not Ryco's to delete). A branch
   * that is already gone is the goal state.
   */
  const deleteHeadBranch = (
    operation: string,
    repository: Repository,
    record: NormalizedForgejoPullRequestRecord,
  ) =>
    record.isCrossRepository === true
      ? Effect.fail(
          failWith(
            operation,
            "The head branch lives in a fork; Ryco only deletes branches in the pull request's own repository.",
          ),
        )
      : http
          .send(operation, repository, {
            method: "DELETE",
            path: `/branches/${encodeForgejoPathSegments(record.headRefName)}`,
          })
          .pipe(Effect.catch((error) => (isNotFound(error) ? Effect.void : Effect.fail(error))));

  /** Cleanup after a merge or close: report, but never fail the action that already happened. */
  const deleteHeadBranchAfter = (
    operation: string,
    repository: Repository,
    record: NormalizedForgejoPullRequestRecord,
  ) =>
    deleteHeadBranch(operation, repository, record).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          "Forgejo pull request action succeeded but the head branch was not deleted.",
          {
            branch: record.headRefName,
            detail: error.detail,
          },
        ),
      ),
    );

  const patchPullRequest = (
    operation: string,
    repository: Repository,
    index: string,
    body: unknown,
  ) =>
    http.json(
      operation,
      repository,
      { method: "PATCH", path: pullPath(index), body },
      ForgejoPullRequestSchema,
    );

  const editRequestedReviewers = (
    operation: string,
    repository: Repository,
    index: string,
    method: "POST" | "DELETE",
    logins: ReadonlyArray<string>,
  ) => {
    const split = splitForgejoReviewers(logins);
    return split.reviewers.length === 0 && split.team_reviewers.length === 0
      ? Effect.void
      : http.send(operation, repository, {
          method,
          path: `${pullPath(index)}/requested_reviewers`,
          body: split,
        });
  };

  const updatePullRequest = (request: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext | undefined;
    readonly reference: string;
    readonly action: ChangeRequestUpdateAction;
  }) =>
    Effect.gen(function* () {
      const operation = "updatePullRequest";
      const repository = yield* resolveRepository(request);
      const index = forgejoPullRequestIndex(request.reference);
      const action = request.action;
      switch (action.kind) {
        case "edit": {
          const body = {
            ...(action.title !== undefined ? { title: action.title } : {}),
            ...(action.body !== undefined ? { body: action.body } : {}),
            ...(action.baseRefName !== undefined ? { base: action.baseRefName } : {}),
          };
          if (Object.keys(body).length === 0) return;
          yield* patchPullRequest(operation, repository, index, body);
          return;
        }
        case "set-draft": {
          const current = yield* getPullRequest(operation, repository, index);
          const title = forgejoWorkInProgressTitle(current.title, action.draft);
          if (title === current.title && (current.draft ?? false) === action.draft) return;
          const updated = yield* patchPullRequest(operation, repository, index, { title });
          if (updated.draft !== undefined && updated.draft !== action.draft) {
            // The instance uses other work-in-progress prefixes: put the title back.
            yield* patchPullRequest(operation, repository, index, { title: current.title }).pipe(
              Effect.ignore,
            );
            return yield* failWith(
              operation,
              "This Forgejo instance does not use the `WIP:` title prefix for drafts, so Ryco cannot change the draft state.",
            );
          }
          return;
        }
        case "close": {
          const updated = yield* patchPullRequest(operation, repository, index, {
            state: "closed",
          });
          if (action.deleteBranch === true) {
            yield* deleteHeadBranchAfter(
              operation,
              repository,
              normalizeForgejoPullRequestRecord(updated),
            );
          }
          return;
        }
        case "reopen":
          yield* patchPullRequest(operation, repository, index, { state: "open" });
          return;
        case "reviewers":
          yield* editRequestedReviewers(operation, repository, index, "POST", action.add);
          yield* editRequestedReviewers(operation, repository, index, "DELETE", action.remove);
          return;
        case "labels": {
          if (action.add.length === 0 && action.remove.length === 0) return;
          const labels = (yield* listAllLabels(operation, repository)).flatMap((label) =>
            typeof label.id === "number" ? [{ id: label.id, name: label.name }] : [],
          );
          const add = resolveForgejoLabelIds(action.add, labels);
          if (Result.isFailure(add)) return yield* failWith(operation, add.failure);
          const remove = resolveForgejoLabelIds(action.remove, labels);
          if (Result.isFailure(remove)) return yield* failWith(operation, remove.failure);
          if (add.success.length > 0) {
            yield* http.send(operation, repository, {
              method: "POST",
              path: `${issuePath(index)}/labels`,
              body: { labels: add.success },
            });
          }
          for (const id of remove.success) {
            yield* http
              .send(operation, repository, {
                method: "DELETE",
                path: `${issuePath(index)}/labels/${id}`,
              })
              .pipe(
                Effect.catch((error) => (isNotFound(error) ? Effect.void : Effect.fail(error))),
              );
          }
          return;
        }
        case "assignees": {
          const current = normalizeForgejoPullRequestRecord(
            yield* getPullRequest(operation, repository, index),
          );
          yield* patchPullRequest(operation, repository, index, {
            assignees: nextForgejoAssignees({
              current: current.assignees ?? [],
              add: action.add,
              remove: action.remove,
            }),
          });
          return;
        }
        case "update-branch": {
          // Forgejo has no head precondition here, so check it right before.
          const current = yield* getPullRequest(operation, repository, index);
          if (!sameForgejoCommit(current.head.sha, action.expectedHeadSha)) {
            return yield* forgejoStaleHeadError(operation);
          }
          yield* http.send(operation, repository, {
            method: "POST",
            path: `${pullPath(index)}/update`,
            urlParams: { style: action.method },
          });
          return;
        }
        case "delete-branch": {
          const record = normalizeForgejoPullRequestRecord(
            yield* getPullRequest(operation, repository, index),
          );
          if (record.state === "open") {
            return yield* failWith(
              operation,
              "Close or merge the pull request before deleting its branch.",
            );
          }
          yield* deleteHeadBranch(operation, repository, record);
          return;
        }
        case "auto-merge":
          return yield* failWith(operation, "Forgejo auto-merge is not available from Ryco.");
      }
    });

  // ── Merge ───────────────────────────────────────────────────────────

  const mergePullRequest = (request: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext | undefined;
    readonly reference: string;
    readonly mergeMethod: SourceControlChangeRequestMergeMethod;
    readonly deleteBranch?: boolean | undefined;
    readonly expectedHeadSha?: string | undefined;
  }): Effect.Effect<SourceControlMergeChangeRequestResult, ForgejoApiError> =>
    Effect.gen(function* () {
      const operation = "mergePullRequest";
      const repository = yield* resolveRepository(request);
      const index = forgejoPullRequestIndex(request.reference);
      const { pullRequest, repositoryInfo } = yield* Effect.all(
        {
          pullRequest: getPullRequest(operation, repository, index),
          repositoryInfo: getRepository(operation, repository),
        },
        { concurrency: 2 },
      );
      const record = normalizeForgejoPullRequestRecord(pullRequest);
      if (record.state !== "open") {
        return yield* failWith(operation, `Pull request #${record.number} is not open.`);
      }
      if (request.expectedHeadSha && !sameForgejoCommit(record.headSha, request.expectedHeadSha)) {
        return yield* forgejoStaleHeadError(operation);
      }
      if (!forgejoMergeCapabilities(repositoryInfo)[request.mergeMethod]) {
        return yield* failWith(
          operation,
          `The ${request.mergeMethod} merge method is disabled for this repository.`,
        );
      }
      yield* http
        .send(operation, repository, {
          method: "POST",
          path: `${pullPath(index)}/merge`,
          body: buildForgejoMergeBody({
            mergeMethod: request.mergeMethod,
            expectedHeadSha: request.expectedHeadSha,
          }),
        })
        .pipe(
          Effect.mapError((error) =>
            error.status === 409 && /head out of date/iu.test(error.detail)
              ? forgejoStaleHeadError(operation)
              : error,
          ),
        );
      if (request.deleteBranch === true) {
        yield* deleteHeadBranchAfter(operation, repository, record);
      }
      return { outcome: "merged" as const };
    });

  // ── Create ──────────────────────────────────────────────────────────

  /** Check that a pull request opened as a draft is one (Forgejo drafts are title prefixes). */
  const verifyCreatedDraft = (operation: string, created: ForgejoPullRequest) =>
    created.draft === false
      ? Effect.fail(
          failWith(
            operation,
            `Opened #${created.number}, but this Forgejo instance does not treat the \`WIP:\` title prefix as a draft, so it is open for review.`,
          ),
        )
      : Effect.void;

  return {
    getPullRequestActivity,
    getPullRequestFileContents,
    getPullRequestDiff,
    withDetailReadiness,
    withRowReadiness: (
      request: {
        readonly cwd: string;
        readonly context?: SourceControlProviderContext | undefined;
      },
      records: ReadonlyArray<NormalizedForgejoPullRequestRecord>,
    ) =>
      resolveRepository(request).pipe(
        Effect.flatMap((repository) => withRowReadiness("listPullRequests", repository, records)),
      ),
    listInvolvedPullRequests,
    searchPullRequests,
    addPullRequestComment,
    togglePullRequestCommentReaction,
    updatePullRequestComment,
    submitPullRequestReview,
    replyToPullRequestReviewThread,
    updatePullRequest,
    mergePullRequest,
    listLabels,
    listAssignees,
    verifyCreatedDraft,
  };
}

export type ForgejoPullRequestPageApi = ReturnType<typeof makeForgejoPullRequestPageApi>;
