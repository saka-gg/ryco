import { afterEach, assert, describe, expect, it, vi } from "@effect/vitest";
import { Clock, Effect, Fiber, Layer } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubCli from "./GitHubCli.ts";
import {
  GITHUB_FINGERPRINT_QUIET_AFTER_MS,
  GITHUB_FINGERPRINT_REUSE_MS,
  GITHUB_FINGERPRINT_SETTLE_MS,
  GITHUB_QUIET_FINGERPRINT_REUSE_MS,
} from "./gitHubPullRequestFingerprintBoard.ts";
import { buildGitHubPullRequestWatchFingerprintsQuery } from "./gitHubPullRequestWatchFingerprint.ts";

const output = (
  stdout: string,
  options: { readonly exitCode?: number; readonly stderr?: string } = {},
): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(options.exitCode ?? 0),
  stdout,
  stderr: options.stderr ?? "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const watchedPullRequest = {
  state: "OPEN",
  isDraft: false,
  updatedAt: "1970-01-01T00:00:00Z",
  mergeable: "MERGEABLE",
  headRefOid: "abc123",
  comments: { totalCount: 2, nodes: [{ updatedAt: "2026-10-05T23:47:43Z" }] },
  reviews: { totalCount: 1, nodes: [{ updatedAt: "2026-10-04T10:00:00Z" }] },
  reviewThreads: { totalCount: 1 },
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            contexts: {
              checkRunCountsByState: [
                { state: "IN_PROGRESS", count: 1 },
                { state: "SUCCESS", count: 3 },
              ],
              statusContextCountsByState: [],
            },
          },
        },
      },
    ],
  },
};

/** Nobody updated it for half an hour (at the clock's start) and nothing is in flight. */
const quietPullRequest = {
  ...watchedPullRequest,
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            contexts: {
              checkRunCountsByState: [{ state: "SUCCESS", count: 3 }],
              statusContextCountsByState: [],
            },
          },
        },
      },
    ],
  },
};

const mockRun = vi.fn<VcsProcess.VcsProcessShape["run"]>();
const layer = GitHubCli.layer.pipe(
  Layer.provide(Layer.mock(VcsProcess.VcsProcess)({ run: mockRun })),
);

afterEach(() => mockRun.mockReset());

const lookup = {
  cwd: "/repo",
  host: "github.example.com",
  repository: "acme/widgets",
  number: 42,
} as const;

/** The batch window: reads that start within it share a document. */
const settle = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect);
    yield* TestClock.adjust("10 millis");
    return yield* Fiber.join(fiber);
  });

/** A gh answer for the batched document, `w0`, `w1`, ... in order. */
const batchAnswer = (pullRequests: ReadonlyArray<object | null>, errors?: ReadonlyArray<object>) =>
  output(
    JSON.stringify({
      data: Object.fromEntries(
        pullRequests.map((pullRequest, index) => [`w${index}`, { pullRequest }]),
      ),
      ...(errors ? { errors } : {}),
    }),
    errors ? { exitCode: 1 } : {},
  );

const requestOf = (call: number) => {
  const input = mockRun.mock.calls[call]?.[0];
  return {
    args: input?.args,
    body: JSON.parse(input?.stdin ?? "{}") as {
      readonly query?: string;
      readonly variables?: Record<string, unknown>;
    },
  };
};

describe("GitHubCli pull request watch fingerprint", () => {
  it.effect("reads one pull request on its own host in one GraphQL request", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(batchAnswer([watchedPullRequest])));

      const gh = yield* GitHubCli.GitHubCli;
      const fingerprint = yield* settle(gh.getPullRequestWatchFingerprint(lookup));

      assert.deepStrictEqual(fingerprint, {
        status: "OPEN MERGEABLE abc123 IN_PROGRESS:1,SUCCESS:3 ",
        remarks: "2 2026-10-05T23:47:43Z 1 2026-10-04T10:00:00Z 1",
        revision: "1970-01-01T00:00:00Z ready",
      });
      assert.equal(mockRun.mock.calls.length, 1);
      const request = requestOf(0);
      expect(request.args).toEqual([
        "api",
        "graphql",
        "--hostname",
        "github.example.com",
        "--input",
        "-",
      ]);
      assert.equal(
        request.body.query,
        buildGitHubPullRequestWatchFingerprintsQuery([
          { owner: "acme", name: "widgets", number: 42 },
        ]).query,
      );
      // `number` travels as a GraphQL Int, not a string.
      assert.deepStrictEqual(request.body.variables, { o0: "acme", n0: "widgets", p0: 42 });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads pull requests of one host that start together in one request", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          batchAnswer(
            [watchedPullRequest, null, { ...watchedPullRequest, headRefOid: "def456" }],
            [
              {
                type: "NOT_FOUND",
                path: ["w1", "pullRequest"],
                message: "Could not resolve to a PullRequest with the number of 8.",
              },
            ],
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const [seven, eight, nine] = yield* settle(
        Effect.forEach(
          [
            { ...lookup, number: 7 },
            { ...lookup, number: 8 },
            { ...lookup, repository: "acme/api", number: 9 },
          ],
          (input) => gh.getPullRequestWatchFingerprint(input),
          { concurrency: "unbounded" },
        ),
      );

      assert.equal(mockRun.mock.calls.length, 1);
      assert.include(seven?.status ?? "", "abc123");
      // GitHub resolved no #8: its watch reads it in full.
      assert.isNull(eight);
      assert.include(nine?.status ?? "", "def456");
      assert.deepStrictEqual(requestOf(0).body.variables, {
        o0: "acme",
        n0: "widgets",
        p0: 7,
        o1: "acme",
        n1: "widgets",
        p1: 8,
        o2: "acme",
        n2: "api",
        p2: 9,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("sends twenty-five pull requests to a request", () =>
    Effect.gen(function* () {
      mockRun.mockImplementation((input) => {
        const count = Object.keys(JSON.parse(input.stdin ?? "{}").variables ?? {}).length / 3;
        return Effect.succeed(batchAnswer(Array.from({ length: count }, () => watchedPullRequest)));
      });

      const gh = yield* GitHubCli.GitHubCli;
      const fingerprints = yield* settle(
        Effect.forEach(
          Array.from({ length: 30 }, (_, index) => ({ ...lookup, number: index + 1 })),
          (input) => gh.getPullRequestWatchFingerprint(input),
          { concurrency: "unbounded" },
        ),
      );

      assert.equal(fingerprints.filter((fingerprint) => fingerprint !== null).length, 30);
      assert.equal(mockRun.mock.calls.length, 2);
      const sizes = [0, 1]
        .map((call) => Object.keys(requestOf(call).body.variables ?? {}).length / 3)
        .toSorted((left, right) => right - left);
      assert.deepStrictEqual(sizes, [25, 5]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("lets a recent answer stand in only for a reader that allows it", () =>
    Effect.gen(function* () {
      mockRun.mockImplementation(() => Effect.succeed(batchAnswer([watchedPullRequest])));
      const gh = yield* GitHubCli.GitHubCli;

      yield* settle(gh.getPullRequestWatchFingerprint(lookup));
      assert.equal(mockRun.mock.calls.length, 1);
      // Within the window, an answer given since the reader's time stands in.
      yield* TestClock.adjust(GITHUB_FINGERPRINT_REUSE_MS - 1_000);
      yield* settle(gh.getPullRequestWatchFingerprint({ ...lookup, reuseSinceMs: 0 }));
      assert.equal(mockRun.mock.calls.length, 1);
      // A reader that must see a change made after the answer (a push) asks again.
      yield* settle(gh.getPullRequestWatchFingerprint({ ...lookup, reuseSinceMs: 5 }));
      assert.equal(mockRun.mock.calls.length, 2);
      // So does one that allows no reuse at all.
      yield* settle(gh.getPullRequestWatchFingerprint(lookup));
      assert.equal(mockRun.mock.calls.length, 3);
      // Past the window, the answer no longer stands in.
      yield* TestClock.adjust(GITHUB_FINGERPRINT_REUSE_MS);
      yield* settle(gh.getPullRequestWatchFingerprint({ ...lookup, reuseSinceMs: 0 }));
      assert.equal(mockRun.mock.calls.length, 4);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("fills a request with the other pull requests readers asked about lately", () =>
    Effect.gen(function* () {
      mockRun.mockImplementation((input) => {
        const count = Object.keys(JSON.parse(input.stdin ?? "{}").variables ?? {}).length / 3;
        return Effect.succeed(batchAnswer(Array.from({ length: count }, () => watchedPullRequest)));
      });
      const gh = yield* GitHubCli.GitHubCli;
      const rows = [1, 2, 3].map((number) =>
        Object.assign({}, lookup, { number, reuseSinceMs: 0 }),
      );

      // Three rows, polling on their own timers.
      yield* settle(gh.getPullRequestWatchFingerprint(rows[0]!));
      yield* TestClock.adjust(5_000);
      yield* settle(gh.getPullRequestWatchFingerprint(rows[1]!));
      yield* TestClock.adjust(5_000);
      yield* settle(gh.getPullRequestWatchFingerprint(rows[2]!));
      assert.equal(mockRun.mock.calls.length, 3);

      // The first row's next poll finds its answer too old; its request carries the others,
      // past half their window, so their polls find a fresh answer.
      yield* TestClock.adjust(GITHUB_FINGERPRINT_REUSE_MS);
      yield* settle(gh.getPullRequestWatchFingerprint(rows[0]!));
      assert.equal(mockRun.mock.calls.length, 4);
      assert.deepStrictEqual(
        Object.entries(requestOf(3).body.variables ?? {}).flatMap(([name, value]) =>
          name.startsWith("p") ? [value] : [],
        ),
        [1, 2, 3],
      );
      yield* TestClock.adjust(2_000);
      yield* settle(gh.getPullRequestWatchFingerprint(rows[1]!));
      yield* settle(gh.getPullRequestWatchFingerprint(rows[2]!));
      assert.equal(mockRun.mock.calls.length, 4);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reuses a quiet pull request's answer for five minutes", () =>
    Effect.gen(function* () {
      mockRun.mockImplementation(() => Effect.succeed(batchAnswer([quietPullRequest])));
      const gh = yield* GitHubCli.GitHubCli;
      const row = { ...lookup, reuseSinceMs: 0 };

      yield* TestClock.adjust(GITHUB_FINGERPRINT_QUIET_AFTER_MS);
      yield* settle(gh.getPullRequestWatchFingerprint(row));
      yield* TestClock.adjust(GITHUB_QUIET_FINGERPRINT_REUSE_MS - 1_000);
      yield* settle(gh.getPullRequestWatchFingerprint(row));
      assert.equal(mockRun.mock.calls.length, 1);
      yield* TestClock.adjust(1_000);
      yield* settle(gh.getPullRequestWatchFingerprint(row));
      assert.equal(mockRun.mock.calls.length, 2);

      // A running check (or a fresh update) keeps the short window.
      mockRun.mockImplementation(() => Effect.succeed(batchAnswer([watchedPullRequest])));
      yield* settle(gh.getPullRequestWatchFingerprint(lookup));
      yield* TestClock.adjust(GITHUB_FINGERPRINT_REUSE_MS);
      yield* settle(gh.getPullRequestWatchFingerprint(row));
      assert.equal(mockRun.mock.calls.length, 4);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "keeps the short window for an answer given right after the change a reader waits for",
    () =>
      Effect.gen(function* () {
        mockRun.mockImplementation(() => Effect.succeed(batchAnswer([quietPullRequest])));
        const gh = yield* GitHubCli.GitHubCli;
        yield* TestClock.adjust(GITHUB_FINGERPRINT_QUIET_AFTER_MS);
        // A push: GitHub may show the new head only seconds later, in an answer that still
        // looks quiet.
        const row = { ...lookup, reuseSinceMs: yield* Clock.currentTimeMillis };
        yield* TestClock.adjust(5_000);
        yield* settle(gh.getPullRequestWatchFingerprint(row));
        yield* TestClock.adjust(GITHUB_FINGERPRINT_REUSE_MS);
        yield* settle(gh.getPullRequestWatchFingerprint(row));
        assert.equal(mockRun.mock.calls.length, 2);

        // An answer a minute after the change gets the quiet window again.
        yield* TestClock.adjust(GITHUB_FINGERPRINT_SETTLE_MS);
        yield* settle(gh.getPullRequestWatchFingerprint(row));
        assert.equal(mockRun.mock.calls.length, 3);
        yield* TestClock.adjust(GITHUB_QUIET_FINGERPRINT_REUSE_MS - 1_000);
        yield* settle(gh.getPullRequestWatchFingerprint(row));
        assert.equal(mockRun.mock.calls.length, 3);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("fails only the pull request whose part of the answer failed", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          batchAnswer(
            [watchedPullRequest, watchedPullRequest],
            [
              {
                type: "FORBIDDEN",
                path: ["w1", "pullRequest", "commits"],
                message: "Resource not accessible by integration",
              },
            ],
          ),
        ),
      );
      const gh = yield* GitHubCli.GitHubCli;
      const [ok, denied] = yield* settle(
        Effect.forEach(
          [1, 2],
          (number) => gh.getPullRequestWatchFingerprint({ ...lookup, number }).pipe(Effect.result),
          { concurrency: "unbounded" },
        ),
      );
      assert.equal(ok?._tag, "Success");
      assert.equal(denied?._tag, "Failure");
      if (denied?._tag === "Failure") {
        assert.equal(denied.failure.operation, "getPullRequestWatchFingerprint");
        assert.include(denied.failure.detail, "permission");
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("answers null for a pull request GitHub cannot resolve", () =>
    Effect.gen(function* () {
      // `gh` exits 1 on a GraphQL error and still prints the answer.
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              data: { w0: { pullRequest: null } },
              errors: [
                {
                  type: "NOT_FOUND",
                  path: ["w0", "pullRequest"],
                  message: "Could not resolve to a PullRequest with the number of 42.",
                },
              ],
            }),
            {
              exitCode: 1,
              stderr: "gh: Could not resolve to a PullRequest with the number of 42.",
            },
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      assert.isNull(yield* settle(gh.getPullRequestWatchFingerprint(lookup)));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads a pull request whose check rollup the token may not see", () =>
    Effect.gen(function* () {
      // `gh` exits 1 on the field error and still prints the pull request.
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              data: {
                w0: {
                  pullRequest: {
                    ...watchedPullRequest,
                    commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
                  },
                },
              },
              errors: [
                {
                  type: "FORBIDDEN",
                  path: ["w0", "pullRequest", "commits", "nodes", 0, "commit", "statusCheckRollup"],
                  message: "Resource not accessible by personal access token",
                },
              ],
            }),
            { exitCode: 1, stderr: "gh: Resource not accessible by personal access token" },
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      assert.deepStrictEqual(yield* settle(gh.getPullRequestWatchFingerprint(lookup)), {
        status: "OPEN MERGEABLE abc123  ",
        remarks: "2 2026-10-05T23:47:43Z 1 2026-10-04T10:00:00Z 1",
        revision: "1970-01-01T00:00:00Z ready",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("fails with GitHub's rate limit wording when GitHub refuses the read", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              data: null,
              errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded for user." }],
            }),
            { exitCode: 1, stderr: "gh: API rate limit exceeded for user." },
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* settle(gh.getPullRequestWatchFingerprint(lookup).pipe(Effect.flip));
      assert.equal(error.operation, "getPullRequestWatchFingerprint");
      assert.match(error.detail, /rate limit/iu);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("fails on any other GraphQL error, even beside data", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              data: { w0: { pullRequest: watchedPullRequest } },
              errors: [
                {
                  type: "FORBIDDEN",
                  path: ["w0", "pullRequest", "commits"],
                  message: "Resource not accessible by integration",
                },
              ],
            }),
            { exitCode: 1 },
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* settle(gh.getPullRequestWatchFingerprint(lookup).pipe(Effect.flip));
      assert.equal(error.operation, "getPullRequestWatchFingerprint");
      assert.include(error.detail, "permission");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses a repository or number GraphQL cannot name without running gh", () =>
    Effect.gen(function* () {
      const gh = yield* GitHubCli.GitHubCli;
      const repository = yield* gh
        .getPullRequestWatchFingerprint({ ...lookup, repository: "widgets" })
        .pipe(Effect.flip);
      assert.include(repository.detail, "owner/repository");
      for (const number of [0, -1, 1.5, 2 ** 31]) {
        const error = yield* gh
          .getPullRequestWatchFingerprint({ ...lookup, number })
          .pipe(Effect.flip);
        assert.include(error.detail, "out of range");
      }
      assert.equal(mockRun.mock.calls.length, 0);
    }).pipe(Effect.provide(layer)),
  );
});
