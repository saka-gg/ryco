import { Result, Schema } from "effect";
import { decodeJsonResult, formatSchemaError } from "@ryco/shared/schemaJson";

import type { ChangeRequestWatchFingerprint } from "./SourceControlProvider.ts";

/**
 * What a pull request watch needs to notice, in one GraphQL request GitHub
 * prices at one point, where the detail and activity reads it gates take
 * several `gh` calls each. Counts and the newest `updatedAt` cover new
 * comments, reviews (a reply in a review thread is a review), threads, and a
 * bot rewriting its summary (GitHub sets `updatedAt` to the creation time and
 * moves it with every edit). Comments come most recently updated first, so the
 * first one stands for all of them, an edit to an old comment on a long pull
 * request included, and a comment deleted while another is posted still moves
 * it. Reviews have no such order: an edit to a review older than the last
 * hundred waits for the watch's periodic full read, as do edits to comments
 * inside review threads. Check counts by state move whenever a check starts or
 * finishes; two checks re-run to opposite results between two reads keep the
 * counts, and also wait for the periodic full read.
 *
 * Ported from T3 Code (`pullRequestBatches.graphql` `PullRequestWatchFingerprint`
 * and `toPullRequestWatchFingerprint`, 758dc290e9), with `updatedAt` in place
 * of `lastEditedAt` and one comment instead of a hundred.
 *
 * Docs:
 * - https://docs.github.com/en/graphql/reference/objects#pullrequest (`mergeable`, `headRefOid`,
 *   `comments`, `reviews`, `reviewThreads`)
 * - https://docs.github.com/en/graphql/reference/objects#statuscheckrollupcontextconnection
 *   (`checkRunCountsByState`, `statusContextCountsByState`)
 * - https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api
 */
export const GITHUB_PULL_REQUEST_WATCH_FINGERPRINT_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state
      mergeable
      headRefOid
      comments(first: 1, orderBy: { field: UPDATED_AT, direction: DESC }) { totalCount nodes { updatedAt } }
      reviews(last: 100) { totalCount nodes { updatedAt } }
      reviewThreads { totalCount }
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts {
                checkRunCountsByState { state count }
                statusContextCountsByState { state count }
              }
            }
          }
        }
      }
    }
  }
}`;

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));
const OptionalCount = Schema.optional(Schema.NullOr(Schema.Number));

// Lenient below the identity fields: a connection GitHub answers null or leaves
// out without an error (no check reported yet, the nullable `reviews`, a null
// node) reads as empty, so the fingerprint still compares instead of failing.
const RawUpdatedConnection = Schema.NullOr(
  Schema.Struct({
    totalCount: OptionalCount,
    nodes: Schema.optional(
      Schema.NullOr(Schema.Array(Schema.NullOr(Schema.Struct({ updatedAt: OptionalString })))),
    ),
  }),
);

const RawStateCounts = Schema.NullOr(
  Schema.Array(Schema.NullOr(Schema.Struct({ state: OptionalString, count: OptionalCount }))),
);

const RawWatchedPullRequest = Schema.Struct({
  state: Schema.String,
  mergeable: OptionalString,
  headRefOid: Schema.String,
  comments: Schema.optional(RawUpdatedConnection),
  reviews: Schema.optional(RawUpdatedConnection),
  reviewThreads: Schema.optional(Schema.NullOr(Schema.Struct({ totalCount: OptionalCount }))),
  commits: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.optional(
          Schema.NullOr(
            Schema.Array(
              Schema.NullOr(
                Schema.Struct({
                  commit: Schema.optional(
                    Schema.NullOr(
                      Schema.Struct({
                        statusCheckRollup: Schema.optional(
                          Schema.NullOr(
                            Schema.Struct({
                              contexts: Schema.optional(
                                Schema.NullOr(
                                  Schema.Struct({
                                    checkRunCountsByState: Schema.optional(RawStateCounts),
                                    statusContextCountsByState: Schema.optional(RawStateCounts),
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
            ),
          ),
        ),
      }),
    ),
  ),
});

export type GitHubWatchedPullRequest = typeof RawWatchedPullRequest.Type;

const RawGraphQlError = Schema.Struct({
  type: OptionalString,
  message: OptionalString,
  path: Schema.optional(Schema.NullOr(Schema.Array(Schema.Union([Schema.String, Schema.Number])))),
});

const RawWatchFingerprintResponse = Schema.Struct({
  errors: Schema.optional(Schema.NullOr(Schema.Array(Schema.NullOr(RawGraphQlError)))),
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        repository: Schema.optional(
          Schema.NullOr(
            Schema.Struct({ pullRequest: Schema.optional(Schema.NullOr(RawWatchedPullRequest)) }),
          ),
        ),
      }),
    ),
  ),
});

const decodeWatchFingerprintResponse = decodeJsonResult(RawWatchFingerprintResponse);

type UpdatedConnection = typeof RawUpdatedConnection.Type | undefined;
type StateCounts = typeof RawStateCounts.Type | undefined;

// `updatedAt` only ever moves forward, so the newest one stands for them all.
const newestUpdate = (connection: UpdatedConnection) =>
  (connection?.nodes ?? []).reduce<string>(
    (newest, node) =>
      node?.updatedAt != null && node.updatedAt > newest ? node.updatedAt : newest,
    "",
  );

const stateCounts = (counts: StateCounts) =>
  (counts ?? [])
    .flatMap((entry) =>
      entry?.state != null && entry.count != null && entry.count > 0
        ? [`${entry.state}:${entry.count}`]
        : [],
    )
    .toSorted()
    .join(",");

/**
 * Two parts, so a watch reads only what moved: `status` (state, mergeability,
 * head and check counts) needs the detail read, and `remarks` (comment, review
 * and thread counts plus the newest updates) also needs the activity read.
 */
export function toPullRequestWatchFingerprint(
  pullRequest: GitHubWatchedPullRequest,
): ChangeRequestWatchFingerprint {
  const contexts = pullRequest.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
  return {
    status: [
      pullRequest.state,
      pullRequest.mergeable ?? "",
      pullRequest.headRefOid,
      stateCounts(contexts?.checkRunCountsByState),
      stateCounts(contexts?.statusContextCountsByState),
    ].join(" "),
    remarks: [
      pullRequest.comments?.totalCount ?? 0,
      newestUpdate(pullRequest.comments),
      pullRequest.reviews?.totalCount ?? 0,
      newestUpdate(pullRequest.reviews),
      pullRequest.reviewThreads?.totalCount ?? 0,
    ].join(" "),
  };
}

type GraphQlError = typeof RawGraphQlError.Type | null;

/** GitHub could not resolve the repository or the pull request: nothing to fingerprint. */
function isMissingTarget(error: GraphQlError): boolean {
  const path = error?.path ?? [];
  return (
    error?.type === "NOT_FOUND" &&
    path[0] === "repository" &&
    (path.length === 1 || (path.length === 2 && path[1] === "pullRequest"))
  );
}

/**
 * A token without check or commit status access (a fine-grained token, a GitHub
 * App) gets the pull request with a null rollup and this error. The detail read
 * drops checks for the same error (`isStatusCheckRollupAccessError`), so a
 * fingerprint without check counts still covers everything that read reports.
 */
function isCheckRollupAccessError(error: GraphQlError): boolean {
  return (
    (error?.path ?? []).includes("statusCheckRollup") &&
    (error?.type === "FORBIDDEN" ||
      /not accessible|permission|forbidden/iu.test(error?.message ?? ""))
  );
}

/**
 * The fingerprint of a `gh api graphql` answer to the query above, or null when
 * GitHub resolved no such repository or pull request (deleted, transferred, no
 * access), so the watch reads it in full and reports what that read finds. A
 * check rollup the token may not read counts as no checks. Any other GraphQL
 * error fails the read: a fingerprint built from a partial answer could stay
 * still while the pull request moves.
 */
export function decodeGitHubPullRequestWatchFingerprintJson(
  raw: string,
): Result.Result<ChangeRequestWatchFingerprint | null, string> {
  const decoded = decodeWatchFingerprintResponse(raw);
  if (Result.isFailure(decoded)) {
    return Result.fail(
      `Invalid GitHub pull request watch fingerprint: ${formatSchemaError(decoded.failure)}`,
    );
  }
  const fatal = (decoded.success.errors ?? []).flatMap((error) =>
    isMissingTarget(error) || isCheckRollupAccessError(error)
      ? []
      : [error?.message?.trim() || "GitHub GraphQL returned an error."],
  );
  if (fatal.length > 0) return Result.fail(`GitHub GraphQL returned errors: ${fatal.join("; ")}`);
  const data = decoded.success.data;
  if (!data) return Result.fail("GitHub returned no data for the pull request watch fingerprint.");
  const pullRequest = data.repository?.pullRequest;
  return Result.succeed(pullRequest ? toPullRequestWatchFingerprint(pullRequest) : null);
}
