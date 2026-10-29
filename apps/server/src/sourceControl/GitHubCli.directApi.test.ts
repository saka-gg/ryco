import { afterEach, assert, describe, it, vi } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubCli from "./GitHubCli.ts";
import * as GitHubApi from "./gitHubApi.ts";
import {
  fakeGitHub,
  type FakeGitHubHandler,
  type FakeGitHubRequest,
} from "./gitHubApiTestServer.ts";
import * as GitHubRepositoryLists from "./gitHubRepositoryLists.ts";

const SENTINEL = "ghp_TEST_SENTINEL";

const output = (
  stdout: string,
  options?: { readonly exitCode?: number; readonly stderr?: string },
): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(options?.exitCode ?? 0),
  stdout,
  stderr: options?.stderr ?? "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const REPO_VIEW = ["repo", "view", "--json", "nameWithOwner,url"];
const GH_GRAPHQL = ["api", "graphql", "--hostname", "github.com", "--input", "-"];

const mockRun = vi.fn<VcsProcess.VcsProcessShape["run"]>();

afterEach(() => {
  mockRun.mockReset();
});

/** gh answers `repo view`; `gh auth token` and `gh api graphql` answer as given (or fail the test). */
function scriptGh(options?: {
  readonly authToken?: VcsProcess.VcsProcessOutput;
  readonly graphql?: (stdin: string) => VcsProcess.VcsProcessOutput;
}) {
  mockRun.mockImplementation((input) => {
    const args = [...input.args];
    if (args.join(" ") === REPO_VIEW.join(" ")) {
      return Effect.succeed(
        output(JSON.stringify({ nameWithOwner: "acme/web", url: "https://github.com/acme/web" })),
      );
    }
    if (args[0] === "auth" && args[1] === "token" && options?.authToken) {
      return Effect.succeed(options.authToken);
    }
    if (args.join(" ") === GH_GRAPHQL.join(" ") && options?.graphql) {
      return Effect.succeed(options.graphql(input.stdin ?? ""));
    }
    return Effect.die(`unexpected gh call: gh ${args.join(" ")}`);
  });
}

const ghCalls = () => mockRun.mock.calls.map(([input]) => [...input.args]);

/** The link-state document's aliases, answered the way GitHub answers them. */
function linkStatesAnswer(query: string, missing: ReadonlySet<number> = new Set()) {
  const repository: Record<string, unknown> = {};
  const errors: unknown[] = [];
  for (const [, kind, number] of query.matchAll(/([pi])(\d+): (?:pullRequest|issue)/gu)) {
    const value = Number(number);
    const alias = `${kind}${number}`;
    if (missing.has(value)) {
      repository[alias] = null;
      errors.push({
        type: "NOT_FOUND",
        path: ["repository", alias],
        message: `Could not resolve to a PullRequest with the number of ${number}.`,
      });
      continue;
    }
    repository[alias] =
      kind === "p"
        ? {
            number: value,
            state: value % 2 === 0 ? "MERGED" : "OPEN",
            isDraft: false,
            closedAt: value % 2 === 0 ? "2026-10-01T00:00:00Z" : null,
            mergedAt: value % 2 === 0 ? "2026-10-01T00:00:00Z" : null,
          }
        : { number: value, state: "CLOSED" };
  }
  return { data: { repository }, ...(errors.length > 0 ? { errors } : {}) };
}

const queryOf = (request: FakeGitHubRequest | string) =>
  (JSON.parse(typeof request === "string" ? request : request.body) as { query: string }).query;

const directLayer = (urls: GitHubApi.GitHubApiUrls, env: Readonly<Record<string, string>>) =>
  GitHubCli.layerDirectApi({ env, endpoints: () => urls }).pipe(
    Layer.provide(
      Layer.mergeAll(Layer.mock(VcsProcess.VcsProcess)({ run: mockRun }), FetchHttpClient.layer),
    ),
  );

const ghOnlyLayer = GitHubCli.layer.pipe(
  Layer.provide(Layer.mock(VcsProcess.VcsProcess)({ run: mockRun })),
);

const readViaGhOnly = (input: Parameters<GitHubCli.GitHubCliShape["getLinkStates"]>[0]) =>
  Effect.gen(function* () {
    return yield* (yield* GitHubCli.GitHubCli).getLinkStates(input);
  }).pipe(Effect.provide(ghOnlyLayer));

const withDirectApi = <A, E>(
  handler: FakeGitHubHandler,
  env: Readonly<Record<string, string>>,
  use: (
    gh: GitHubCli.GitHubCliShape,
    server: { readonly requests: ReadonlyArray<FakeGitHubRequest> },
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const server = yield* fakeGitHub(handler);
    return yield* Effect.gen(function* () {
      return yield* use(yield* GitHubCli.GitHubCli, server);
    }).pipe(Effect.provide(directLayer(server.urls, env)));
  });

describe("GitHubCli over the direct API", () => {
  it.effect("reads link states over HTTPS without starting gh for the documents", () =>
    withDirectApi(
      (request) => ({ body: linkStatesAnswer(queryOf(request)) }),
      { GH_TOKEN: SENTINEL },
      (gh, server) =>
        Effect.gen(function* () {
          scriptGh();
          const states = yield* gh.getLinkStates({
            cwd: "/repo",
            pullRequests: Array.from({ length: 60 }, (_, index) => index + 1),
            issues: [7],
          });
          assert.strictEqual(states.pullRequests.size, 60);
          assert.strictEqual(states.pullRequests.get(2)?.state, "merged");
          assert.strictEqual(states.issues.get(7), "closed");
          // 61 numbers, 50 per document.
          assert.lengthOf(server.requests, 2);
          for (const request of server.requests) {
            assert.strictEqual(request.headers.authorization, `token ${SENTINEL}`);
            assert.strictEqual(request.headers["x-github-api-version"], "2022-11-28");
            assert.deepStrictEqual(JSON.parse(request.body).variables, {
              owner: "acme",
              name: "web",
            });
          }
          // gh resolved the repository and nothing else.
          assert.deepStrictEqual(ghCalls(), [REPO_VIEW]);
        }),
    ),
  );

  it.effect("falls back to the exact gh call without a credential", () =>
    Effect.gen(function* () {
      const ghAnswer = (stdin: string) => output(JSON.stringify(linkStatesAnswer(queryOf(stdin))));
      // The gh-only client.
      scriptGh({ graphql: ghAnswer });
      const ghOnly = yield* readViaGhOnly({ cwd: "/repo", pullRequests: [3], issues: [] });
      assert.strictEqual(ghOnly.pullRequests.get(3)?.state, "open");
      assert.deepStrictEqual(ghCalls(), [REPO_VIEW, GH_GRAPHQL]);
      const ghOnlyStdin = mockRun.mock.calls[1]![0].stdin;
      assert.deepStrictEqual(JSON.parse(ghOnlyStdin ?? "{}"), {
        query: GitHubRepositoryLists.buildGitHubLinkStatesQuery({ pullRequests: [3], issues: [] }),
        variables: { owner: "acme", name: "web" },
      });

      // The direct client with no environment token and no gh login.
      mockRun.mockReset();
      scriptGh({
        authToken: output("", { exitCode: 1, stderr: "no oauth token found for github.com" }),
        graphql: ghAnswer,
      });
      const fallback = yield* withDirectApi(
        () => ({ status: 500 }),
        {},
        (gh, server) =>
          gh
            .getLinkStates({ cwd: "/repo", pullRequests: [3], issues: [] })
            .pipe(Effect.tap(() => Effect.sync(() => assert.lengthOf(server.requests, 0)))),
      );
      assert.strictEqual(fallback.pullRequests.get(3)?.state, "open");
      assert.deepStrictEqual(ghCalls(), [
        REPO_VIEW,
        ["auth", "token", "--hostname", "github.com"],
        GH_GRAPHQL,
      ]);
      assert.strictEqual(mockRun.mock.calls[2]![0].stdin, ghOnlyStdin);
    }),
  );

  it.effect("gives the same results and error details as gh for the same GitHub answers", () =>
    Effect.gen(function* () {
      const query = GitHubRepositoryLists.buildGitHubLinkStatesQuery({
        pullRequests: [4, 5],
        issues: [],
      });
      const cases: ReadonlyArray<{
        readonly name: string;
        readonly status: number;
        readonly body: unknown;
        /** What `gh api graphql` prints for that answer. */
        readonly gh: VcsProcess.VcsProcessOutput;
      }> = [
        {
          name: "data with a per-alias NOT_FOUND error",
          status: 200,
          body: linkStatesAnswer(query, new Set([5])),
          gh: output(JSON.stringify(linkStatesAnswer(query, new Set([5]))), {
            exitCode: 1,
            stderr: "gh: Could not resolve to a PullRequest with the number of 5.\n",
          }),
        },
        {
          name: "a fatal GraphQL error",
          status: 200,
          body: { data: null, errors: [{ message: "Something went wrong while executing" }] },
          gh: output(
            JSON.stringify({
              data: null,
              errors: [{ message: "Something went wrong while executing" }],
            }),
            { exitCode: 1, stderr: "gh: Something went wrong while executing\n" },
          ),
        },
        {
          name: "the primary rate limit",
          status: 403,
          body: { message: "API rate limit exceeded for user ID 1." },
          gh: output(JSON.stringify({ message: "API rate limit exceeded for user ID 1." }), {
            exitCode: 1,
            stderr: "gh: API rate limit exceeded for user ID 1. (HTTP 403)\n",
          }),
        },
        {
          name: "a bad gateway with a message",
          status: 502,
          body: { message: "Server Error" },
          gh: output(JSON.stringify({ message: "Server Error" }), {
            exitCode: 1,
            stderr: "gh: Server Error (HTTP 502)\n",
          }),
        },
        {
          name: "a bad gateway without one",
          status: 502,
          body: "<html>Bad gateway</html>",
          gh: output("<html>Bad gateway</html>", { exitCode: 1, stderr: "gh: HTTP 502\n" }),
        },
      ];
      for (const testCase of cases) {
        mockRun.mockReset();
        scriptGh({ graphql: () => testCase.gh });
        const viaGh = yield* readViaGhOnly({
          cwd: "/repo",
          pullRequests: [4, 5],
          issues: [],
        }).pipe(Effect.result);
        mockRun.mockReset();
        scriptGh();
        const viaApi = yield* withDirectApi(
          () => ({ status: testCase.status, body: testCase.body }),
          { GH_TOKEN: SENTINEL },
          (gh) => gh.getLinkStates({ cwd: "/repo", pullRequests: [4, 5], issues: [] }),
        ).pipe(Effect.result);
        assert.strictEqual(viaApi._tag, viaGh._tag, testCase.name);
        if (viaGh._tag === "Success" && viaApi._tag === "Success") {
          assert.deepStrictEqual(viaApi.success, viaGh.success, testCase.name);
        } else if (viaGh._tag === "Failure" && viaApi._tag === "Failure") {
          assert.strictEqual(viaApi.failure.detail, viaGh.failure.detail, testCase.name);
          assert.strictEqual(viaApi.failure.operation, viaGh.failure.operation, testCase.name);
        }
      }
    }),
  );

  it.effect("gives gh's rate-limit wording for a rate-limited answer", () =>
    withDirectApi(
      () => ({ status: 403, body: { message: "API rate limit exceeded for user ID 1." } }),
      { GH_TOKEN: SENTINEL },
      (gh) =>
        Effect.gen(function* () {
          scriptGh();
          const error = yield* gh
            .getLinkStates({ cwd: "/repo", pullRequests: [1], issues: [] })
            .pipe(Effect.flip);
          assert.strictEqual(
            error.detail,
            "GitHub API rate limit exceeded. Wait for the reset window and retry.",
          );
        }),
    ),
  );

  it.effect("fails a read GitHub does not finish in 30 seconds, without retrying through gh", () =>
    withDirectApi(
      () => ({ stallAfterHeaders: true }),
      { GH_TOKEN: SENTINEL },
      (gh, server) =>
        Effect.gen(function* () {
          scriptGh();
          const fiber = yield* gh
            .getLinkStates({ cwd: "/repo", pullRequests: [1], issues: [] })
            .pipe(Effect.flip, Effect.forkChild);
          while (server.requests.length === 0) yield* Effect.promise(() => sleepReal(5));
          yield* TestClock.adjust("31 seconds");
          const error = yield* Fiber.join(fiber);
          assert.strictEqual(error.detail, "GitHub did not answer within 30 seconds.");
          assert.deepStrictEqual(ghCalls(), [REPO_VIEW]);
        }),
    ),
  );

  it.effect("uses gh while the API is unreachable, then tries HTTPS again after 5 minutes", () =>
    Effect.gen(function* () {
      let fetches = 0;
      const refusing = (() => {
        fetches += 1;
        return Promise.reject(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }));
      }) as unknown as typeof globalThis.fetch;
      scriptGh({ graphql: (stdin) => output(JSON.stringify(linkStatesAnswer(queryOf(stdin)))) });
      yield* withDirectApi(
        () => ({ status: 500 }),
        { GH_TOKEN: SENTINEL },
        (gh) =>
          Effect.gen(function* () {
            const read = gh
              .getLinkStates({ cwd: "/repo", pullRequests: [1], issues: [] })
              .pipe(Effect.provideService(FetchHttpClient.Fetch, refusing));
            assert.strictEqual((yield* read).pullRequests.get(1)?.state, "open");
            assert.strictEqual(fetches, 1);
            yield* TestClock.adjust("4 minutes");
            yield* read;
            assert.strictEqual(fetches, 1);
            yield* TestClock.adjust("61 seconds");
            yield* read;
            assert.strictEqual(fetches, 2);
            assert.deepStrictEqual(ghCalls(), [REPO_VIEW, GH_GRAPHQL, GH_GRAPHQL, GH_GRAPHQL]);
          }),
      );
    }),
  );
});

const sleepReal = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
