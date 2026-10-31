import { describe, expect, it } from "vite-plus/test";
import { Result } from "effect";

import {
  buildGitHubPullRequestWatchFingerprintsQuery,
  decodeGitHubPullRequestWatchFingerprintsJson,
  type GitHubWatchFingerprintAnswer,
} from "./gitHubPullRequestWatchFingerprint.ts";

const QUIET_AFTER_MS = 30 * 60_000;

/**
 * Shaped exactly like GitHub's answer for one pull request of the batched
 * fingerprint query (captured read-only from public pull requests on 2026-10-24
 * and trimmed):
 * GitHub lists every state, zero counts included, and `updatedAt` is the
 * creation time until an edit moves it.
 */
function pullRequest(
  overrides: {
    readonly state?: string;
    readonly mergeable?: string | null;
    readonly headRefOid?: string;
    readonly running?: number;
    readonly failed?: number;
    readonly passed?: number;
    readonly statuses?: number;
    readonly comments?: number;
    readonly commentUpdatedAt?: string;
    readonly reviews?: number;
    readonly reviewUpdatedAt?: string;
    readonly threads?: number;
    readonly updatedAt?: string;
    readonly isDraft?: boolean;
  } = {},
) {
  return {
    state: overrides.state ?? "OPEN",
    isDraft: overrides.isDraft ?? false,
    updatedAt: overrides.updatedAt ?? "2026-10-05T23:40:00Z",
    mergeable: overrides.mergeable === undefined ? "MERGEABLE" : overrides.mergeable,
    headRefOid: overrides.headRefOid ?? "02b209f16e8b9b203165c3fbcf85fc4d4ad770ee",
    comments: {
      totalCount: overrides.comments ?? 1,
      nodes: [{ updatedAt: overrides.commentUpdatedAt ?? "2026-10-05T23:40:00Z" }],
    },
    reviews: {
      totalCount: overrides.reviews ?? 0,
      nodes: overrides.reviewUpdatedAt ? [{ updatedAt: overrides.reviewUpdatedAt }] : [],
    },
    reviewThreads: { totalCount: overrides.threads ?? 0 },
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: {
                checkRunCountsByState: [
                  { state: "FAILURE", count: overrides.failed ?? 0 },
                  { state: "IN_PROGRESS", count: overrides.running ?? 0 },
                  { state: "SKIPPED", count: 2 },
                  { state: "SUCCESS", count: overrides.passed ?? 4 },
                ],
                statusContextCountsByState: [
                  { state: "PENDING", count: 0 },
                  { state: "SUCCESS", count: overrides.statuses ?? 1 },
                ],
              },
            },
          },
        },
      ],
    },
  };
}

const answer = (body: object) => JSON.stringify(body);
const decode = (body: object | string, count = 1) =>
  decodeGitHubPullRequestWatchFingerprintsJson(
    typeof body === "string" ? body : answer(body),
    count,
    { quietAfterMs: QUIET_AFTER_MS },
  );
/** The one pull request of a one-entry batch, or the batch's failure. */
const decodeOne = (body: object | string): Result.Result<GitHubWatchFingerprintAnswer, string> =>
  Result.map(decode(body), (answers) => answers[0]!);
const fingerprintOf = (pr: object) => {
  const decoded = decodeOne({ data: { w0: { pullRequest: pr } } });
  if (!Result.isSuccess(decoded)) throw new Error(decoded.failure);
  if (decoded.success.kind !== "found")
    throw new Error(`expected a fingerprint: ${decoded.success.kind}`);
  return decoded.success.fingerprint;
};
const failed = (decoded: Result.Result<GitHubWatchFingerprintAnswer, string>) =>
  Result.isSuccess(decoded) && decoded.success.kind === "failed";

describe("buildGitHubPullRequestWatchFingerprintsQuery", () => {
  it("asks only for state, head, counts and the newest updates, an alias per pull request", () => {
    const { query, variables } = buildGitHubPullRequestWatchFingerprintsQuery([
      { owner: "acme", name: "web", number: 7 },
      { owner: "acme", name: "api", number: 8 },
    ]);
    expect(query).toContain("$o0: String!, $n0: String!, $p0: Int!");
    expect(query).toContain("w0: repository(owner: $o0, name: $n0)");
    expect(query).toContain("w1: repository(owner: $o1, name: $n1)");
    expect(query).toContain("pullRequest(number: $p1)");
    // Names travel as variables, never inside the document; numbers as GraphQL Ints.
    expect(query).not.toContain("acme");
    expect(variables).toEqual({ o0: "acme", n0: "web", p0: 7, o1: "acme", n1: "api", p1: 8 });
    // The most recently updated comment stands for every comment.
    expect(query).toContain(
      "comments(first: 1, orderBy: { field: UPDATED_AT, direction: DESC }) { totalCount nodes { updatedAt } }",
    );
    expect(query).toContain("reviews(last: 100) { totalCount nodes { updatedAt } }");
    expect(query).toContain("checkRunCountsByState { state count }");
    expect(query).toContain("statusContextCountsByState { state count }");
    expect(query).toMatch(/\bupdatedAt\b[\s\S]*\bisDraft\b|\bisDraft\b[\s\S]*\bupdatedAt\b/u);
    // Never comment bodies or check names: the full reads bring those.
    expect(query).not.toMatch(/\bbody\b|\blogin\b|\bcontext\b/u);
  });
});

describe("decodeGitHubPullRequestWatchFingerprintsJson", () => {
  it("joins state, mergeability, head and the nonzero check counts, sorted", () => {
    expect(fingerprintOf(pullRequest({ running: 1, failed: 1 }))).toEqual({
      status:
        "OPEN MERGEABLE 02b209f16e8b9b203165c3fbcf85fc4d4ad770ee FAILURE:1,IN_PROGRESS:1,SKIPPED:2,SUCCESS:4 SUCCESS:1",
      remarks: "1 2026-10-05T23:40:00Z 0  0",
      revision: "2026-10-05T23:40:00Z ready",
    });
  });

  it("moves the revision with the pull request's own updates and drafts, nothing else", () => {
    const before = fingerprintOf(pullRequest());
    const retitled = fingerprintOf(pullRequest({ updatedAt: "2026-10-06T09:00:00Z" }));
    const drafted = fingerprintOf(pullRequest({ isDraft: true }));
    for (const moved of [retitled, drafted]) {
      expect(moved.revision).not.toBe(before.revision);
      expect(moved.status).toBe(before.status);
      expect(moved.remarks).toBe(before.remarks);
    }
    expect(fingerprintOf(pullRequest({ running: 1 })).revision).toBe(before.revision);
  });

  it("moves status with checks and remarks with comments, each without the other", () => {
    const before = fingerprintOf(pullRequest({ running: 2 }));
    const checkFinished = fingerprintOf(pullRequest({ running: 1, failed: 1 }));
    const statusPosted = fingerprintOf(pullRequest({ running: 2, statuses: 2 }));
    const pushed = fingerprintOf(pullRequest({ running: 2, headRefOid: "f".repeat(40) }));
    const conflicting = fingerprintOf(pullRequest({ running: 2, mergeable: "CONFLICTING" }));
    const merged = fingerprintOf(pullRequest({ running: 2, state: "MERGED" }));
    const summaryEdited = fingerprintOf(
      pullRequest({ running: 2, commentUpdatedAt: "2026-10-05T23:47:43Z" }),
    );
    const commented = fingerprintOf(
      pullRequest({ running: 2, comments: 2, commentUpdatedAt: "2026-10-06T07:00:00Z" }),
    );
    // One comment deleted while another is posted: the count stays, the newest update moves.
    const swapped = fingerprintOf(
      pullRequest({ running: 2, comments: 1, commentUpdatedAt: "2026-10-06T07:00:00Z" }),
    );
    const replied = fingerprintOf(pullRequest({ running: 2, reviews: 1 }));
    const reviewEdited = fingerprintOf(
      pullRequest({ running: 2, reviewUpdatedAt: "2026-10-06T08:00:00Z" }),
    );
    const threadOpened = fingerprintOf(pullRequest({ running: 2, threads: 1 }));

    for (const moved of [checkFinished, statusPosted, pushed, conflicting, merged]) {
      expect(moved.status).not.toBe(before.status);
      expect(moved.remarks).toBe(before.remarks);
    }
    for (const moved of [summaryEdited, commented, swapped, replied, reviewEdited, threadOpened]) {
      expect(moved.remarks).not.toBe(before.remarks);
      expect(moved.status).toBe(before.status);
    }
  });

  it("keeps the newest review update, whatever order the reviews come in", () => {
    const updates = (dates: ReadonlyArray<string | null>) => ({
      ...pullRequest(),
      reviews: {
        totalCount: dates.length,
        nodes: dates.map((updatedAt) => ({ updatedAt })),
      },
    });
    const forward = fingerprintOf(updates(["2026-10-01T00:00:00Z", null, "2026-10-03T00:00:00Z"]));
    const backward = fingerprintOf(updates(["2026-10-03T00:00:00Z", "2026-10-01T00:00:00Z", null]));
    expect(forward.remarks).toBe(backward.remarks);
    expect(forward.remarks).toContain("2026-10-03T00:00:00Z");
  });

  it("does not move when GitHub reorders its state counts", () => {
    const reordered = pullRequest({ running: 1 });
    const contexts = reordered.commits.nodes[0]!.commit.statusCheckRollup.contexts;
    const shuffled = {
      ...reordered,
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                contexts: {
                  checkRunCountsByState: contexts.checkRunCountsByState.toReversed(),
                  statusContextCountsByState: contexts.statusContextCountsByState.toReversed(),
                },
              },
            },
          },
        ],
      },
    };
    expect(fingerprintOf(shuffled)).toEqual(fingerprintOf(reordered));
  });

  it("reads null or missing connections as empty instead of failing", () => {
    const sparse = {
      state: "OPEN",
      mergeable: null,
      headRefOid: "abc123",
      comments: { totalCount: 3, nodes: [null] },
      reviews: null,
      commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    };
    expect(fingerprintOf(sparse)).toEqual({
      status: "OPEN  abc123  ",
      remarks: "3  0  0",
      revision: " ready",
    });
    expect(
      fingerprintOf({
        ...sparse,
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: {
                    checkRunCountsByState: [null, { state: "SUCCESS", count: null }],
                    statusContextCountsByState: null,
                  },
                },
              },
            },
          ],
        },
      }).status,
    ).toBe("OPEN  abc123  ");
  });

  it("answers gone when GitHub resolves no such pull request or repository", () => {
    // Both captured read-only from GitHub on 2026-10-24 (alias paths as in a batched answer).
    const missingPullRequest = {
      data: { w0: { pullRequest: null } },
      errors: [
        {
          type: "NOT_FOUND",
          path: ["w0", "pullRequest"],
          locations: [{ line: 3, column: 5 }],
          message: "Could not resolve to a PullRequest with the number of 999999.",
        },
      ],
    };
    const missingRepository = {
      data: { w0: null },
      errors: [
        {
          type: "NOT_FOUND",
          path: ["w0"],
          message: "Could not resolve to a Repository with the name 'acme/gone'.",
        },
      ],
    };
    expect(decodeOne(missingPullRequest)).toEqual(Result.succeed({ kind: "gone" }));
    expect(decodeOne(missingRepository)).toEqual(Result.succeed({ kind: "gone" }));
  });

  it("answers each pull request of a batch on its own when one of them is gone", () => {
    const decoded = decode(
      {
        data: {
          w0: { pullRequest: pullRequest({ comments: 1 }) },
          w1: { pullRequest: null },
          w2: { pullRequest: pullRequest({ comments: 3 }) },
        },
        errors: [
          {
            type: "NOT_FOUND",
            path: ["w1", "pullRequest"],
            message: "Could not resolve to a PullRequest with the number of 8.",
          },
        ],
      },
      3,
    );
    if (!Result.isSuccess(decoded)) throw new Error(decoded.failure);
    expect(decoded.success.map((entry) => entry.kind)).toEqual(["found", "gone", "found"]);
    const [first, , third] = decoded.success;
    expect(first?.kind === "found" && first.fingerprint.remarks.startsWith("1 ")).toBe(true);
    expect(third?.kind === "found" && third.fingerprint.remarks.startsWith("3 ")).toBe(true);
  });

  it("fails one pull request alone for its own error, and the whole batch for the document's", () => {
    const decoded = decode(
      {
        data: { w0: { pullRequest: pullRequest() }, w1: { pullRequest: pullRequest() } },
        errors: [
          {
            type: "FORBIDDEN",
            path: ["w1", "pullRequest", "commits"],
            message: "Resource not accessible by integration",
          },
        ],
      },
      2,
    );
    if (!Result.isSuccess(decoded)) throw new Error(decoded.failure);
    expect(decoded.success[0]?.kind).toBe("found");
    expect(decoded.success[1]).toEqual({
      kind: "failed",
      detail: "GitHub GraphQL returned errors: Resource not accessible by integration",
    });
    // A rate limit names no alias: every pull request of the document fails with it.
    const limited = decode(
      { data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded." }] },
      2,
    );
    expect(Result.isFailure(limited)).toBe(true);
    if (Result.isFailure(limited)) expect(limited.failure).toContain("rate limit");
    // An alias GitHub left out of the answer gets no fingerprint.
    const short = decode({ data: { w0: { pullRequest: pullRequest() } } }, 2);
    expect(Result.isSuccess(short) && short.success[1]?.kind).toBe("failed");
  });

  it("dates when a settled pull request turns quiet, and never while something is in flight", () => {
    const quietFrom = (pr: object) => {
      const decoded = decodeOne({ data: { w0: { pullRequest: pr } } });
      if (!Result.isSuccess(decoded) || decoded.success.kind !== "found") throw new Error("found");
      return decoded.success.quietFromMs;
    };
    expect(quietFrom(pullRequest({ updatedAt: "2026-10-05T23:40:00Z" }))).toBe(
      Date.parse("2026-10-05T23:40:00Z") + QUIET_AFTER_MS,
    );
    expect(quietFrom(pullRequest({ running: 1 }))).toBeNull();
    expect(quietFrom(pullRequest({ mergeable: "UNKNOWN" }))).toBeNull();
    const pendingStatus = pullRequest();
    pendingStatus.commits.nodes[0]!.commit.statusCheckRollup.contexts.statusContextCountsByState = [
      { state: "PENDING", count: 1 },
    ];
    expect(quietFrom(pendingStatus)).toBeNull();
  });

  it("reads a check rollup the token may not see as no checks", () => {
    const { commits: _commits, ...withoutRollup } = pullRequest();
    const rollupPath = ["w0", "pullRequest", "commits", "nodes", 0, "commit"];
    const denied = (error: object) =>
      decodeOne({
        data: {
          w0: {
            pullRequest: {
              ...withoutRollup,
              commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
            },
          },
        },
        errors: [error],
      });
    const expected = Result.succeed({
      kind: "found",
      fingerprint: {
        status: "OPEN MERGEABLE 02b209f16e8b9b203165c3fbcf85fc4d4ad770ee  ",
        remarks: "1 2026-10-05T23:40:00Z 0  0",
        revision: "2026-10-05T23:40:00Z ready",
      },
      quietFromMs: Date.parse("2026-10-05T23:40:00Z") + QUIET_AFTER_MS,
    });
    // A fine-grained token: typed FORBIDDEN.
    expect(
      denied({
        type: "FORBIDDEN",
        path: [...rollupPath, "statusCheckRollup"],
        message: "Resource not accessible by personal access token",
      }),
    ).toEqual(expected);
    // A GitHub App token: only the message says so.
    expect(
      denied({
        path: [...rollupPath, "statusCheckRollup", "contexts"],
        message: "Resource not accessible by integration",
      }),
    ).toEqual(expected);
    // Any other rollup error still fails the read.
    expect(
      failed(
        denied({ path: [...rollupPath, "statusCheckRollup"], message: "Something went wrong" }),
      ),
    ).toBe(true);
  });

  it("fails on any other GraphQL error, even beside data", () => {
    const partial = decodeOne({
      data: { w0: { pullRequest: pullRequest() } },
      errors: [
        {
          type: "FORBIDDEN",
          path: ["w0", "pullRequest", "commits", "nodes", 0, "commit"],
          message: "Resource not accessible by integration",
        },
      ],
    });
    expect(failed(partial)).toBe(true);
    if (Result.isSuccess(partial) && partial.success.kind === "failed") {
      expect(partial.success.detail).toContain("not accessible");
    }

    // A NOT_FOUND below the pull request is not a missing pull request.
    const nested = decodeOne({
      data: { w0: { pullRequest: pullRequest() } },
      errors: [{ type: "NOT_FOUND", path: ["w0", "pullRequest", "commits"] }],
    });
    expect(failed(nested)).toBe(true);
  });

  it("fails on an answer without data or without the identity fields", () => {
    expect(Result.isFailure(decodeOne({}))).toBe(true);
    expect(Result.isFailure(decodeOne({ data: null }))).toBe(true);
    const { headRefOid: _headRefOid, ...headless } = pullRequest();
    expect(failed(decodeOne({ data: { w0: { pullRequest: headless } } }))).toBe(true);
    expect(Result.isFailure(decodeOne("not json"))).toBe(true);
  });
});
