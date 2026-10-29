import { afterEach, assert, describe, expect, it, vi } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { VcsProcessExitError } from "@ryco/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubCli from "./GitHubCli.ts";

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

const mockRun = vi.fn<VcsProcess.VcsProcessShape["run"]>();
const layer = GitHubCli.layer.pipe(
  Layer.provide(Layer.mock(VcsProcess.VcsProcess)({ run: mockRun })),
);

afterEach(() => mockRun.mockReset());

const repositoryView = (host = "github.com") =>
  output(JSON.stringify({ nameWithOwner: "acme/app", url: `https://${host}/acme/app` }));

const row = (number: number, repository = "acme/app") => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/${repository}/pull/${number}`,
  baseRefName: "main",
  headRefName: `feature/${number}`,
  state: "OPEN",
  updatedAt: "2026-10-27T10:00:00Z",
  author: { login: "octocat" },
  comments: { totalCount: 1 },
});

const searchResult = (
  nodes: ReadonlyArray<unknown>,
  options: { readonly hasNextPage?: boolean; readonly errors?: ReadonlyArray<unknown> } = {},
) =>
  JSON.stringify({
    data: {
      viewer: { login: "octocat" },
      search: { pageInfo: { hasNextPage: options.hasNextPage ?? false }, nodes },
    },
    ...(options.errors ? { errors: options.errors } : {}),
  });

const graphQlCalls = () =>
  mockRun.mock.calls
    .map(([input]) => input)
    .filter((input) => input.args[0] === "api" && input.args[1] === "graphql");
const variablesOf = (input: { readonly stdin?: string | undefined }) =>
  (JSON.parse(input.stdin ?? "{}") as { variables: Record<string, unknown> }).variables;
const queryOf = (input: { readonly stdin?: string | undefined }) =>
  (JSON.parse(input.stdin ?? "{}") as { query: string }).query;

describe("GitHubCli.searchInvolvedPullRequests", () => {
  it.effect("searches every repository on github.com in one GraphQL document, no repo view", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(output(searchResult([row(12), row(7, "other/lib")], { hasNextPage: true }))),
      );
      const gh = yield* GitHubCli.GitHubCli;
      const page = yield* gh.searchInvolvedPullRequests({
        cwd: "/repo",
        host: "github.com",
        involvement: "review-requested",
        state: "open",
      });

      assert.strictEqual(page.host, "github.com");
      assert.strictEqual(page.viewerLogin, "octocat");
      assert.isTrue(page.truncated);
      assert.strictEqual(page.skippedRows, 0);
      assert.deepStrictEqual(
        page.items.map((item) => item.summary.url),
        ["https://github.com/acme/app/pull/12", "https://github.com/other/lib/pull/7"],
      );
      const calls = graphQlCalls();
      expect(calls).toHaveLength(1);
      // github.com needs no `gh repo view`: one stale checkout cannot hold the search back.
      expect(mockRun.mock.calls).toHaveLength(1);
      expect(calls[0]?.args).toEqual([
        "api",
        "graphql",
        "--hostname",
        "github.com",
        "--input",
        "-",
      ]);
      expect(variablesOf(calls[0]!)).toEqual({
        q: "review-requested:@me state:open archived:false type:pr sort:updated-desc",
        first: 100,
      });
      expect(queryOf(calls[0]!)).toContain("viewer { login }");
      expect(queryOf(calls[0]!)).not.toContain("stackEntry");
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "still searches the remote's host when gh cannot resolve the checkout's repository",
    () =>
      Effect.gen(function* () {
        mockRun.mockImplementation((input) =>
          input.args[0] === "repo"
            ? Effect.fail(
                new VcsProcessExitError({
                  operation: "GitHubCli.execute",
                  command: "gh repo view",
                  cwd: "/repo",
                  exitCode: 1,
                  detail: "GraphQL: Could not resolve to a Repository with the name 'acme/gone'.",
                }),
              )
            : Effect.succeed(output(searchResult([row(3)]))),
        );
        const gh = yield* GitHubCli.GitHubCli;
        const page = yield* gh.searchInvolvedPullRequests({
          cwd: "/repo",
          host: "ghe.example.com",
          involvement: "authored",
          state: "open",
        });

        assert.strictEqual(page.host, "ghe.example.com");
        assert.deepStrictEqual(
          page.items.map((item) => item.summary.number),
          [3],
        );
        expect(graphQlCalls()[0]?.args).toContain("ghe.example.com");
      }).pipe(Effect.provide(layer)),
  );

  it.effect("searches the host gh resolves for the checkout (SSH host aliases)", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(repositoryView("github.com")));
      mockRun.mockReturnValueOnce(Effect.succeed(output(searchResult([]))));
      const gh = yield* GitHubCli.GitHubCli;
      const page = yield* gh.searchInvolvedPullRequests({
        cwd: "/repo",
        host: "github.com-work",
        involvement: "authored",
        state: "open",
      });
      assert.strictEqual(page.host, "github.com");
      expect(graphQlCalls()[0]?.args).toContain("github.com");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps the rows gh exits non-zero for when one organization's rows are refused", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          output(
            searchResult([row(1), null], {
              errors: [
                {
                  type: "FORBIDDEN",
                  path: ["search", "nodes", 1],
                  message: "Resource protected by organization SAML enforcement.",
                },
              ],
            }),
            {
              exitCode: 1,
              stderr: "GraphQL: Resource protected by organization SAML enforcement.",
            },
          ),
        ),
      );
      const gh = yield* GitHubCli.GitHubCli;
      const page = yield* gh.searchInvolvedPullRequests({
        cwd: "/repo",
        host: "github.com",
        involvement: "review-requested",
        state: "open",
      });
      assert.deepStrictEqual(
        page.items.map((item) => item.summary.number),
        [1],
      );
      assert.strictEqual(page.skippedRows, 1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads again without checks when the token may not read the check rollup", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          output("", {
            exitCode: 1,
            stderr:
              "GraphQL: Resource not accessible by integration (search.nodes.0.commits.nodes.0.commit.statusCheckRollup)",
          }),
        ),
      );
      mockRun.mockReturnValueOnce(Effect.succeed(output(searchResult([row(1)]))));
      const gh = yield* GitHubCli.GitHubCli;
      const page = yield* gh.searchInvolvedPullRequests({
        cwd: "/repo",
        host: "github.com",
        involvement: "review-requested",
        state: "open",
      });
      assert.strictEqual(page.items[0]?.summary.number, 1);
      const queries = graphQlCalls().map(queryOf);
      expect(queries).toHaveLength(2);
      expect(queries[0]).toContain("statusCheckRollup");
      expect(queries[1]).not.toContain("statusCheckRollup");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("fails on an error outside the rows", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              data: { viewer: { login: "octocat" }, search: null },
              errors: [{ message: "Something went wrong while executing your query." }],
            }),
          ),
        ),
      );
      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .searchInvolvedPullRequests({
          cwd: "/repo",
          host: "github.com",
          involvement: "authored",
          state: "open",
        })
        .pipe(Effect.flip);
      assert.strictEqual(error.operation, "searchInvolvedPullRequests");
      assert.include(error.detail, "Something went wrong");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("clamps the page size to one GraphQL page", () =>
    Effect.gen(function* () {
      mockRun.mockImplementation((input) =>
        Effect.succeed(input.args[0] === "repo" ? repositoryView() : output(searchResult([]))),
      );
      const gh = yield* GitHubCli.GitHubCli;
      for (const limit of [500, 0, 20]) {
        yield* gh.searchInvolvedPullRequests({
          cwd: "/repo",
          host: "github.com",
          involvement: "authored",
          state: "all",
          limit,
        });
      }
      expect(graphQlCalls().map((call) => variablesOf(call).first)).toEqual([100, 1, 20]);
      expect(variablesOf(graphQlCalls()[0]!).q).toBe(
        "author:@me archived:false type:pr sort:updated-desc",
      );
    }).pipe(Effect.provide(layer)),
  );
});
