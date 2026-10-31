import { Exit, Result, Schema } from "effect";
import { decodeJsonResult, formatSchemaError } from "@ryco/shared/schemaJson";

import type { ChangeRequestWatchFingerprint } from "./SourceControlProvider.ts";

/**
 * What a pull request watch needs to notice, for up to twenty-five pull requests
 * in one GraphQL request GitHub prices at one point, where the detail and
 * activity reads it gates take several `gh` calls each. Counts and the newest
 * `updatedAt` cover new comments, reviews (a reply in a review thread is a
 * review), threads, and a bot rewriting its summary (GitHub sets `updatedAt` to
 * the creation time and moves it with every edit). Comments come most recently
 * updated first, so the first one stands for all of them, an edit to an old
 * comment on a long pull request included, and a comment deleted while another
 * is posted still moves it. Reviews have no such order: an edit to a review
 * older than the last hundred waits for the watch's periodic full read, as do
 * edits to comments inside review threads. Check counts by state move whenever
 * a check starts or finishes; two checks re-run to opposite results between two
 * reads keep the counts, and also wait for the periodic full read. The pull
 * request's own `updatedAt` and draft flag move with the title, body, labels,
 * review requests and drafts a row shows.
 *
 * Ported from T3 Code (`buildPullRequestWatchFingerprintsGraphQlQuery` and
 * `decodePullRequestWatchFingerprintsJson`, 758dc290e9, #16270: one aliased
 * lookup per pull request, twenty-five to a request), with `updatedAt` in place
 * of `lastEditedAt`, one comment instead of a hundred, and variables instead of
 * names spliced into the document.
 *
 * Docs:
 * - https://docs.github.com/en/graphql/reference/objects#pullrequest (`mergeable`, `headRefOid`,
 *   `comments`, `reviews`, `reviewThreads`)
 * - https://docs.github.com/en/graphql/reference/objects#statuscheckrollupcontextconnection
 *   (`checkRunCountsByState`, `statusContextCountsByState`)
 * - https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api
 *   (five connections per pull request, so 25 come to 125 requests: one point)
 */
const PULL_REQUEST_WATCH_FINGERPRINT_SELECTION = `state
      isDraft
      updatedAt
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
      }`;

/** Pull requests per request: still one point (see above). */
export const GITHUB_WATCH_FINGERPRINTS_PER_REQUEST = 25;

export interface GitHubWatchFingerprintTarget {
  readonly owner: string;
  readonly name: string;
  readonly number: number;
}

/**
 * One document for pull requests of one host, an alias (`w0`, `w1`, ...) per pull
 * request; owners, names and numbers travel as variables.
 */
export function buildGitHubPullRequestWatchFingerprintsQuery(
  targets: ReadonlyArray<GitHubWatchFingerprintTarget>,
): { readonly query: string; readonly variables: Record<string, string | number> } {
  const parameters: string[] = [];
  const selections: string[] = [];
  const variables: Record<string, string | number> = {};
  for (const [index, target] of targets.entries()) {
    parameters.push(`$o${index}: String!, $n${index}: String!, $p${index}: Int!`);
    selections.push(`  w${index}: repository(owner: $o${index}, name: $n${index}) {
    pullRequest(number: $p${index}) {
      ${PULL_REQUEST_WATCH_FINGERPRINT_SELECTION}
    }
  }`);
    variables[`o${index}`] = target.owner;
    variables[`n${index}`] = target.name;
    variables[`p${index}`] = target.number;
  }
  return {
    query: `query PullRequestWatchFingerprints(${parameters.join(", ")}) {\n${selections.join("\n")}\n}`,
    variables,
  };
}

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
  isDraft: Schema.optional(Schema.NullOr(Schema.Boolean)),
  updatedAt: OptionalString,
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

const RawWatchFingerprintsResponse = Schema.Struct({
  errors: Schema.optional(Schema.NullOr(Schema.Array(Schema.NullOr(RawGraphQlError)))),
  data: Schema.optional(
    Schema.NullOr(
      Schema.Record(
        Schema.String,
        Schema.NullOr(
          Schema.Struct({ pullRequest: Schema.optional(Schema.NullOr(Schema.Unknown)) }),
        ),
      ),
    ),
  ),
});

const decodeWatchFingerprintsResponse = decodeJsonResult(RawWatchFingerprintsResponse);
const decodeWatchedPullRequest = Schema.decodeUnknownExit(RawWatchedPullRequest);

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
 * Parts, so a watch reads only what moved: `status` (state, mergeability, head
 * and check counts) needs the detail read, and `remarks` (comment, review and
 * thread counts plus the newest updates) also needs the activity read. A row
 * compares those and `revision` (`updatedAt` and the draft flag), which moves
 * with the rest it shows.
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
    revision: `${pullRequest.updatedAt ?? ""} ${pullRequest.isDraft === true ? "draft" : "ready"}`,
  };
}

/** Check run and status context states that are not a result yet. */
const RUNNING_CHECK_STATES = new Set([
  "EXPECTED",
  "IN_PROGRESS",
  "PENDING",
  "QUEUED",
  "REQUESTED",
  "WAITING",
]);

/**
 * When the answer starts to count as quiet (T3 #22073: nobody updated the pull request for
 * `quietAfterMs`), or null while it can move without an update: a check is still running or
 * GitHub is still computing mergeability (neither moves `updatedAt`).
 */
function quietFromMs(pullRequest: GitHubWatchedPullRequest, quietAfterMs: number): number | null {
  if (pullRequest.mergeable === "UNKNOWN") return null;
  const contexts = pullRequest.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
  const running = [
    ...(contexts?.checkRunCountsByState ?? []),
    ...(contexts?.statusContextCountsByState ?? []),
  ].some(
    (entry) =>
      entry?.state != null && (entry.count ?? 0) > 0 && RUNNING_CHECK_STATES.has(entry.state),
  );
  if (running) return null;
  const updatedAtMs = Date.parse(pullRequest.updatedAt ?? "");
  return Number.isFinite(updatedAtMs) ? updatedAtMs + quietAfterMs : null;
}

type GraphQlError = typeof RawGraphQlError.Type | null;

/** The alias index an error belongs to, or null for an error about the whole document. */
function aliasIndexOf(error: GraphQlError): number | null {
  const alias = error?.path?.[0];
  const match = typeof alias === "string" ? /^w(\d+)$/u.exec(alias) : null;
  return match ? Number(match[1]) : null;
}

/** GitHub could not resolve the repository or the pull request: nothing to fingerprint. */
function isMissingTarget(error: GraphQlError): boolean {
  const path = error?.path ?? [];
  return (
    error?.type === "NOT_FOUND" &&
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

/** One pull request's part of a batched answer. */
export type GitHubWatchFingerprintAnswer =
  | {
      readonly kind: "found";
      readonly fingerprint: ChangeRequestWatchFingerprint;
      /** See `quietFromMs`; null while something is in flight. */
      readonly quietFromMs: number | null;
    }
  /** GitHub resolved no such repository or pull request (deleted, transferred, no access). */
  | { readonly kind: "gone" }
  /** An error about this pull request alone, or no answer for it. */
  | { readonly kind: "failed"; readonly detail: string };

/**
 * The answers to a `gh api graphql` (or direct) reply to the batched query, in
 * the order of its targets. Errors are attributed by alias: NOT_FOUND on the
 * repository or the pull request answers `gone`, so the watch reads it in full
 * and reports what that read finds; a check rollup the token may not read
 * counts as no checks; any other error fails that pull request alone, since a
 * fingerprint built from a partial answer could stay still while it moves. An
 * error about the document as a whole (a rate limit, a malformed query) fails
 * them all.
 */
export function decodeGitHubPullRequestWatchFingerprintsJson(
  raw: string,
  count: number,
  options: { readonly quietAfterMs: number },
): Result.Result<ReadonlyArray<GitHubWatchFingerprintAnswer>, string> {
  const decoded = decodeWatchFingerprintsResponse(raw);
  if (Result.isFailure(decoded)) {
    return Result.fail(
      `Invalid GitHub pull request watch fingerprints: ${formatSchemaError(decoded.failure)}`,
    );
  }
  const failures = new Map<number, string[]>();
  const gone = new Set<number>();
  const whole: string[] = [];
  for (const error of decoded.success.errors ?? []) {
    const index = aliasIndexOf(error);
    const message = error?.message?.trim() || "GitHub GraphQL returned an error.";
    if (index === null || index >= count) whole.push(message);
    else if (isMissingTarget(error)) gone.add(index);
    else if (!isCheckRollupAccessError(error)) {
      failures.set(index, [...(failures.get(index) ?? []), message]);
    }
  }
  if (whole.length > 0) return Result.fail(`GitHub GraphQL returned errors: ${whole.join("; ")}`);
  const data = decoded.success.data;
  if (!data) return Result.fail("GitHub returned no data for the pull request watch fingerprints.");
  return Result.succeed(
    Array.from({ length: count }, (_, index): GitHubWatchFingerprintAnswer => {
      const failure = failures.get(index);
      if (failure !== undefined) {
        return { kind: "failed", detail: `GitHub GraphQL returned errors: ${failure.join("; ")}` };
      }
      if (gone.has(index)) return { kind: "gone" };
      const alias = data[`w${index}`];
      if (alias === undefined) {
        return { kind: "failed", detail: "GitHub gave no answer for the pull request." };
      }
      if (alias === null || alias.pullRequest == null) return { kind: "gone" };
      const pullRequest = decodeWatchedPullRequest(alias.pullRequest);
      if (Exit.isFailure(pullRequest)) {
        return {
          kind: "failed",
          detail: `Invalid GitHub pull request watch fingerprint: ${formatSchemaError(pullRequest.cause)}`,
        };
      }
      return {
        kind: "found",
        fingerprint: toPullRequestWatchFingerprint(pullRequest.value),
        quietFromMs: quietFromMs(pullRequest.value, options.quietAfterMs),
      };
    }),
  );
}
