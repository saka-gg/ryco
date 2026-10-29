import { describe, expect, it } from "vite-plus/test";
import { Result } from "effect";

import {
  decodeGitHubPullRequestWatchFingerprintJson,
  GITHUB_PULL_REQUEST_WATCH_FINGERPRINT_QUERY,
} from "./gitHubPullRequestWatchFingerprint.ts";

/**
 * Shaped exactly like GitHub's answer to GITHUB_PULL_REQUEST_WATCH_FINGERPRINT_QUERY
 * (captured read-only from public pull requests on 2026-10-24 and trimmed):
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
  } = {},
) {
  return {
    state: overrides.state ?? "OPEN",
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
const fingerprintOf = (pr: object) => {
  const decoded = decodeGitHubPullRequestWatchFingerprintJson(
    answer({ data: { repository: { pullRequest: pr } } }),
  );
  if (!Result.isSuccess(decoded)) throw new Error(decoded.failure);
  if (decoded.success === null) throw new Error("expected a fingerprint");
  return decoded.success;
};

describe("GITHUB_PULL_REQUEST_WATCH_FINGERPRINT_QUERY", () => {
  it("asks only for state, head, counts and the newest updates", () => {
    const query = GITHUB_PULL_REQUEST_WATCH_FINGERPRINT_QUERY;
    expect(query).toContain("pullRequest(number: $number)");
    // The most recently updated comment stands for every comment.
    expect(query).toContain(
      "comments(first: 1, orderBy: { field: UPDATED_AT, direction: DESC }) { totalCount nodes { updatedAt } }",
    );
    expect(query).toContain("reviews(last: 100) { totalCount nodes { updatedAt } }");
    expect(query).toContain("checkRunCountsByState { state count }");
    expect(query).toContain("statusContextCountsByState { state count }");
    // Never comment bodies or check names: the full reads bring those.
    expect(query).not.toMatch(/\bbody\b|\blogin\b|\bcontext\b/u);
  });
});

describe("decodeGitHubPullRequestWatchFingerprintJson", () => {
  it("joins state, mergeability, head and the nonzero check counts, sorted", () => {
    expect(fingerprintOf(pullRequest({ running: 1, failed: 1 }))).toEqual({
      status:
        "OPEN MERGEABLE 02b209f16e8b9b203165c3fbcf85fc4d4ad770ee FAILURE:1,IN_PROGRESS:1,SKIPPED:2,SUCCESS:4 SUCCESS:1",
      remarks: "1 2026-10-05T23:40:00Z 0  0",
    });
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
    expect(fingerprintOf(sparse)).toEqual({ status: "OPEN  abc123  ", remarks: "3  0  0" });
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

  it("answers null when GitHub resolves no such pull request or repository", () => {
    // Both captured read-only from GitHub on 2026-10-24.
    const missingPullRequest = answer({
      data: { repository: { pullRequest: null } },
      errors: [
        {
          type: "NOT_FOUND",
          path: ["repository", "pullRequest"],
          locations: [{ line: 3, column: 5 }],
          message: "Could not resolve to a PullRequest with the number of 999999.",
        },
      ],
    });
    const missingRepository = answer({
      data: { repository: null },
      errors: [
        {
          type: "NOT_FOUND",
          path: ["repository"],
          message: "Could not resolve to a Repository with the name 'acme/gone'.",
        },
      ],
    });
    expect(decodeGitHubPullRequestWatchFingerprintJson(missingPullRequest)).toEqual(
      Result.succeed(null),
    );
    expect(decodeGitHubPullRequestWatchFingerprintJson(missingRepository)).toEqual(
      Result.succeed(null),
    );
  });

  it("reads a check rollup the token may not see as no checks", () => {
    const { commits: _commits, ...withoutRollup } = pullRequest();
    const rollupPath = ["repository", "pullRequest", "commits", "nodes", 0, "commit"];
    const denied = (error: object) =>
      decodeGitHubPullRequestWatchFingerprintJson(
        answer({
          data: {
            repository: {
              pullRequest: {
                ...withoutRollup,
                commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
              },
            },
          },
          errors: [error],
        }),
      );
    const expected = Result.succeed({
      status: "OPEN MERGEABLE 02b209f16e8b9b203165c3fbcf85fc4d4ad770ee  ",
      remarks: "1 2026-10-05T23:40:00Z 0  0",
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
      Result.isFailure(
        denied({ path: [...rollupPath, "statusCheckRollup"], message: "Something went wrong" }),
      ),
    ).toBe(true);
  });

  it("fails on any other GraphQL error, even beside data", () => {
    const partial = decodeGitHubPullRequestWatchFingerprintJson(
      answer({
        data: { repository: { pullRequest: pullRequest() } },
        errors: [
          {
            type: "FORBIDDEN",
            path: ["repository", "pullRequest", "commits", "nodes", 0, "commit"],
            message: "Resource not accessible by integration",
          },
        ],
      }),
    );
    expect(Result.isFailure(partial)).toBe(true);
    if (Result.isFailure(partial)) expect(partial.failure).toContain("not accessible");

    // A NOT_FOUND below the pull request is not a missing pull request.
    const nested = decodeGitHubPullRequestWatchFingerprintJson(
      answer({
        data: { repository: { pullRequest: pullRequest() } },
        errors: [{ type: "NOT_FOUND", path: ["repository", "pullRequest", "commits"] }],
      }),
    );
    expect(Result.isFailure(nested)).toBe(true);
  });

  it("fails on an answer without data or without the identity fields", () => {
    expect(Result.isFailure(decodeGitHubPullRequestWatchFingerprintJson(answer({})))).toBe(true);
    expect(
      Result.isFailure(decodeGitHubPullRequestWatchFingerprintJson(answer({ data: null }))),
    ).toBe(true);
    const { headRefOid: _headRefOid, ...headless } = pullRequest();
    expect(
      Result.isFailure(
        decodeGitHubPullRequestWatchFingerprintJson(
          answer({ data: { repository: { pullRequest: headless } } }),
        ),
      ),
    ).toBe(true);
    expect(Result.isFailure(decodeGitHubPullRequestWatchFingerprintJson("not json"))).toBe(true);
  });
});
