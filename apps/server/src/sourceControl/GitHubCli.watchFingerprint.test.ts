import { afterEach, assert, describe, expect, it, vi } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/process";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubCli from "./GitHubCli.ts";
import { GITHUB_PULL_REQUEST_WATCH_FINGERPRINT_QUERY } from "./gitHubPullRequestWatchFingerprint.ts";

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
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          output(JSON.stringify({ data: { repository: { pullRequest: watchedPullRequest } } })),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const fingerprint = yield* gh.getPullRequestWatchFingerprint(lookup);

      assert.deepStrictEqual(fingerprint, {
        status: "OPEN MERGEABLE abc123 IN_PROGRESS:1,SUCCESS:3 ",
        remarks: "2 2026-10-05T23:47:43Z 1 2026-10-04T10:00:00Z 1",
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
      assert.equal(request.body.query, GITHUB_PULL_REQUEST_WATCH_FINGERPRINT_QUERY);
      // `number` travels as a GraphQL Int, not a string.
      assert.deepStrictEqual(request.body.variables, {
        owner: "acme",
        name: "widgets",
        number: 42,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("answers null for a pull request GitHub cannot resolve", () =>
    Effect.gen(function* () {
      // `gh` exits 1 on a GraphQL error and still prints the answer.
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              data: { repository: { pullRequest: null } },
              errors: [
                {
                  type: "NOT_FOUND",
                  path: ["repository", "pullRequest"],
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
      assert.isNull(yield* gh.getPullRequestWatchFingerprint(lookup));
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
                repository: {
                  pullRequest: {
                    ...watchedPullRequest,
                    commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
                  },
                },
              },
              errors: [
                {
                  type: "FORBIDDEN",
                  path: [
                    "repository",
                    "pullRequest",
                    "commits",
                    "nodes",
                    0,
                    "commit",
                    "statusCheckRollup",
                  ],
                  message: "Resource not accessible by personal access token",
                },
              ],
            }),
            { exitCode: 1, stderr: "gh: Resource not accessible by personal access token" },
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      assert.deepStrictEqual(yield* gh.getPullRequestWatchFingerprint(lookup), {
        status: "OPEN MERGEABLE abc123  ",
        remarks: "2 2026-10-05T23:47:43Z 1 2026-10-04T10:00:00Z 1",
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
      const error = yield* gh.getPullRequestWatchFingerprint(lookup).pipe(Effect.flip);
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
              data: { repository: { pullRequest: watchedPullRequest } },
              errors: [
                {
                  type: "FORBIDDEN",
                  path: ["repository", "pullRequest", "commits"],
                  message: "Resource not accessible by integration",
                },
              ],
            }),
            { exitCode: 1 },
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh.getPullRequestWatchFingerprint(lookup).pipe(Effect.flip);
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
