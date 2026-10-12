import { assert, it, afterEach, describe, expect, vi } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { VcsProcessExitError } from "@ryco/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubCli from "./GitHubCli.ts";

const processOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const mockRun = vi.fn<VcsProcess.VcsProcessShape["run"]>();

const layer = GitHubCli.layer.pipe(
  Layer.provide(
    Layer.mock(VcsProcess.VcsProcess)({
      run: mockRun,
    }),
  ),
);

const prSummaryJsonFields = GitHubCli.formatGitHubJsonFields(
  GitHubCli.GITHUB_PULL_REQUEST_SUMMARY_JSON_FIELDS,
);
const prSummaryJsonFieldsWithoutCheckRollup = GitHubCli.formatGitHubJsonFields(
  GitHubCli.withoutStatusCheckRollupJsonField(GitHubCli.GITHUB_PULL_REQUEST_SUMMARY_JSON_FIELDS),
);
const prDetailJsonFields = GitHubCli.formatGitHubJsonFields(
  GitHubCli.GITHUB_PULL_REQUEST_DETAIL_JSON_FIELDS,
);

afterEach(() => {
  mockRun.mockReset();
});

describe("GitHubCli.layer", () => {
  it.effect("parses pull request view output", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              number: 42,
              title: "Add PR thread creation",
              url: "https://github.com/pingdotgg/codething-mvp/pull/42",
              baseRefName: "main",
              headRefName: "feature/pr-threads",
              mergeable: "MERGEABLE",
              state: "OPEN",
              mergedAt: null,
              isCrossRepository: true,
              headRepository: {
                nameWithOwner: "octocat/codething-mvp",
              },
              headRepositoryOwner: {
                login: "octocat",
              },
            }),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.getPullRequest({
        cwd: "/repo",
        reference: "#42",
      });

      assert.deepStrictEqual(result, {
        number: 42,
        title: "Add PR thread creation",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseRefName: "main",
        headRefName: "feature/pr-threads",
        state: "open",
        mergeability: "mergeable",
        author: null,
        assignees: [],
        labels: [],
        commentsCount: null,
        isCrossRepository: true,
        headRepositoryNameWithOwner: "octocat/codething-mvp",
        headRepositoryOwnerLogin: "octocat",
      });
      expect(mockRun).toHaveBeenCalledWith({
        operation: "GitHubCli.execute",
        command: "gh",
        args: ["pr", "view", "#42", "--json", prSummaryJsonFields],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("retries PR view without check rollup when GitHub denies that field", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.fail(
          new VcsProcessExitError({
            operation: "GitHubCli.execute",
            command: "gh pr view",
            cwd: "/repo",
            exitCode: 1,
            detail:
              "GraphQL: Resource not accessible by integration (repository.pullRequest.statusCheckRollup)",
          }),
        ),
      );
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              number: 42,
              title: "Add PR thread creation",
              url: "https://github.com/pingdotgg/codething-mvp/pull/42",
              baseRefName: "main",
              headRefName: "feature/pr-threads",
              headRefOid: "abc123",
              state: "OPEN",
              mergedAt: null,
            }),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.getPullRequest({
        cwd: "/repo",
        reference: "#42",
      });

      assert.equal(result.headSha, "abc123");
      expect(mockRun).toHaveBeenNthCalledWith(1, {
        operation: "GitHubCli.execute",
        command: "gh",
        args: ["pr", "view", "#42", "--json", prSummaryJsonFields],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
      expect(mockRun).toHaveBeenNthCalledWith(2, {
        operation: "GitHubCli.execute",
        command: "gh",
        args: ["pr", "view", "#42", "--json", prSummaryJsonFieldsWithoutCheckRollup],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("trims pull request fields decoded from gh json", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              number: 42,
              title: "  Add PR thread creation  \n",
              url: " https://github.com/pingdotgg/codething-mvp/pull/42 ",
              baseRefName: " main ",
              headRefName: "\tfeature/pr-threads\t",
              state: "OPEN",
              mergedAt: null,
              isCrossRepository: true,
              headRepository: {
                nameWithOwner: " octocat/codething-mvp ",
              },
              headRepositoryOwner: {
                login: " octocat ",
              },
            }),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.getPullRequest({
        cwd: "/repo",
        reference: "#42",
      });

      assert.deepStrictEqual(result, {
        number: 42,
        title: "Add PR thread creation",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseRefName: "main",
        headRefName: "feature/pr-threads",
        state: "open",
        author: null,
        assignees: [],
        labels: [],
        commentsCount: null,
        isCrossRepository: true,
        headRepositoryNameWithOwner: "octocat/codething-mvp",
        headRepositoryOwnerLogin: "octocat",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("skips invalid entries when parsing pr lists", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify([
              {
                number: 0,
                title: "invalid",
                url: "https://github.com/pingdotgg/codething-mvp/pull/0",
                baseRefName: "main",
                headRefName: "feature/invalid",
              },
              {
                number: 43,
                title: "  Valid PR  ",
                url: " https://github.com/pingdotgg/codething-mvp/pull/43 ",
                baseRefName: " main ",
                headRefName: " feature/pr-list ",
                headRepository: {
                  nameWithOwner: "   ",
                },
                headRepositoryOwner: {
                  login: "   ",
                },
              },
            ]),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.listOpenPullRequests({
        cwd: "/repo",
        headSelector: "feature/pr-list",
      });

      assert.deepStrictEqual(result, [
        {
          number: 43,
          title: "Valid PR",
          url: "https://github.com/pingdotgg/codething-mvp/pull/43",
          baseRefName: "main",
          headRefName: "feature/pr-list",
          state: "open",
          author: null,
          assignees: [],
          labels: [],
          commentsCount: null,
        },
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads repository clone URLs", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              nameWithOwner: "octocat/codething-mvp",
              url: "https://github.com/octocat/codething-mvp",
              sshUrl: "git@github.com:octocat/codething-mvp.git",
            }),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.getRepositoryCloneUrls({
        cwd: "/repo",
        repository: "octocat/codething-mvp",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/codething-mvp",
        url: "https://github.com/octocat/codething-mvp",
        sshUrl: "git@github.com:octocat/codething-mvp.git",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("creates repositories and parses clone URLs from create output", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            "✓ Created repository octocat/codething-mvp on github.com\nhttps://github.com/octocat/codething-mvp\n",
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.createRepository({
        cwd: "/repo",
        repository: "octocat/codething-mvp",
        visibility: "private",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/codething-mvp",
        url: "https://github.com/octocat/codething-mvp",
        sshUrl: "git@github.com:octocat/codething-mvp.git",
      });
      expect(mockRun).toHaveBeenCalledTimes(1);
      expect(mockRun).toHaveBeenNthCalledWith(1, {
        operation: "GitHubCli.execute",
        command: "gh",
        args: ["repo", "create", "octocat/codething-mvp", "--private"],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("falls back to constructed URLs when create output omits a URL", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("")));

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.createRepository({
        cwd: "/repo",
        repository: "octocat/codething-mvp",
        visibility: "private",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/codething-mvp",
        url: "https://github.com/octocat/codething-mvp",
        sshUrl: "git@github.com:octocat/codething-mvp.git",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("surfaces a friendly error when the pull request is not found", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.fail(
          new VcsProcessExitError({
            operation: "GitHubCli.execute",
            command: "gh pr view",
            cwd: "/repo",
            exitCode: 1,
            detail:
              "GraphQL: Could not resolve to a PullRequest with the number of 4888. (repository.pullRequest)",
          }),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .getPullRequest({
          cwd: "/repo",
          reference: "4888",
        })
        .pipe(Effect.flip);

      assert.equal(error.message.includes("Pull request not found"), true);
    }).pipe(Effect.provide(layer)),
  );

  describe("getPullRequestDetail", () => {
    it.effect("fetches PR body + comments with extended --json fields", () =>
      Effect.gen(function* () {
        mockRun.mockReturnValueOnce(
          Effect.succeed(
            processOutput(
              JSON.stringify({
                number: 42,
                title: "My PR",
                url: "https://github.com/owner/repo/pull/42",
                baseRefName: "main",
                headRefName: "feature/my-pr",
                state: "OPEN",
                mergedAt: null,
                isCrossRepository: false,
                headRepository: null,
                headRepositoryOwner: null,
                body: "PR body text",
                comments: [
                  {
                    author: { login: "alice" },
                    body: "looks good",
                    createdAt: "2026-03-14T10:00:00Z",
                  },
                ],
              }),
            ),
          ),
        );

        const gh = yield* GitHubCli.GitHubCli;
        const detail = yield* gh.getPullRequestDetail({ cwd: "/tmp", reference: "42" });
        assert.equal(detail.body, "PR body text");
        assert.equal(detail.comments[0]?.author, "alice");
        expect(mockRun).toHaveBeenCalledWith({
          operation: "GitHubCli.execute",
          command: "gh",
          args: ["pr", "view", "42", "--json", prDetailJsonFields],
          cwd: "/tmp",
          timeoutMs: 30_000,
        });
      }).pipe(Effect.provide(layer)),
    );
  });

  describe("searchIssues", () => {
    it.effect("invokes gh issue list --search with correct args", () =>
      Effect.gen(function* () {
        mockRun.mockReturnValueOnce(
          Effect.succeed(
            processOutput(
              JSON.stringify([{ number: 5, title: "Bug fix", url: "https://x/5", state: "OPEN" }]),
            ),
          ),
        );

        const gh = yield* GitHubCli.GitHubCli;
        const issues = yield* gh.searchIssues({ cwd: "/tmp", query: "bug" });
        assert.equal(issues.length, 1);
        expect(mockRun).toHaveBeenCalledWith({
          operation: "GitHubCli.execute",
          command: "gh",
          args: [
            "issue",
            "list",
            "--search",
            "bug",
            "--limit",
            "20",
            "--json",
            "number,title,url,state,updatedAt,author,labels,assignees,comments",
          ],
          cwd: "/tmp",
          timeoutMs: 30_000,
        });
      }).pipe(Effect.provide(layer)),
    );
  });

  describe("searchPullRequests", () => {
    it.effect("invokes gh pr list --search with correct args", () =>
      Effect.gen(function* () {
        mockRun.mockReturnValueOnce(
          Effect.succeed(
            processOutput(
              JSON.stringify([
                {
                  number: 7,
                  title: "Fix bug",
                  url: "https://x/7",
                  baseRefName: "main",
                  headRefName: "fix/bug",
                  state: "OPEN",
                  mergedAt: null,
                  isCrossRepository: false,
                  headRepository: null,
                  headRepositoryOwner: null,
                },
              ]),
            ),
          ),
        );

        const gh = yield* GitHubCli.GitHubCli;
        const prs = yield* gh.searchPullRequests({ cwd: "/tmp", query: "fix" });
        assert.equal(prs.length, 1);
        expect(mockRun).toHaveBeenCalledWith({
          operation: "GitHubCli.execute",
          command: "gh",
          args: ["pr", "list", "--search", "fix", "--limit", "20", "--json", prSummaryJsonFields],
          cwd: "/tmp",
          timeoutMs: 30_000,
        });
      }).pipe(Effect.provide(layer)),
    );
  });

  describe("getIssue", () => {
    it.effect("fetches body + comments by number reference", () =>
      Effect.gen(function* () {
        mockRun.mockReturnValueOnce(
          Effect.succeed(
            processOutput(
              JSON.stringify({
                number: 42,
                title: "t",
                url: "https://x/42",
                state: "OPEN",
                body: "BODY",
                comments: [
                  { author: { login: "bob" }, body: "hi", createdAt: "2026-03-14T10:00:00Z" },
                ],
              }),
            ),
          ),
        );

        const gh = yield* GitHubCli.GitHubCli;
        const detail = yield* gh.getIssue({ cwd: "/tmp", reference: "42" });
        assert.equal(detail.body, "BODY");
        assert.equal(detail.comments[0]?.author, "bob");
        expect(mockRun).toHaveBeenCalledWith({
          operation: "GitHubCli.execute",
          command: "gh",
          args: [
            "issue",
            "view",
            "42",
            "--json",
            "number,title,url,state,updatedAt,author,labels,assignees,body,comments",
          ],
          cwd: "/tmp",
          timeoutMs: 30_000,
        });
      }).pipe(Effect.provide(layer)),
    );

    it.effect("passes URL as-is for cross-repo references", () =>
      Effect.gen(function* () {
        mockRun.mockReturnValueOnce(
          Effect.succeed(
            processOutput(
              JSON.stringify({
                number: 9,
                title: "x",
                url: "https://github.com/foo/bar/issues/9",
                state: "CLOSED",
                body: "",
                comments: [],
              }),
            ),
          ),
        );

        const gh = yield* GitHubCli.GitHubCli;
        yield* gh.getIssue({ cwd: "/tmp", reference: "https://github.com/foo/bar/issues/9" });
        const calledArgs = mockRun.mock.calls[0]?.[0];
        assert.equal(calledArgs?.args[2], "https://github.com/foo/bar/issues/9");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("hydrates comment reactions with viewer state from GraphQL", () =>
      Effect.gen(function* () {
        mockRun.mockReturnValueOnce(
          Effect.succeed(
            processOutput(
              JSON.stringify({
                number: 42,
                title: "t",
                url: "https://x/42",
                state: "OPEN",
                body: "BODY",
                comments: [
                  {
                    id: "IC_kwDOA1B2C84AAAAB",
                    author: { login: "bob" },
                    body: "hi",
                    createdAt: "2026-03-14T10:00:00Z",
                  },
                ],
              }),
            ),
          ),
        );
        mockRun.mockReturnValueOnce(
          Effect.succeed(
            processOutput(
              JSON.stringify({
                data: {
                  nodes: [
                    {
                      id: "IC_kwDOA1B2C84AAAAB",
                      reactionGroups: [
                        {
                          content: "THUMBS_UP",
                          viewerHasReacted: true,
                          reactors: { totalCount: 2 },
                        },
                        {
                          content: "ROCKET",
                          viewerHasReacted: false,
                          reactors: { totalCount: 1 },
                        },
                      ],
                    },
                  ],
                },
              }),
            ),
          ),
        );

        const gh = yield* GitHubCli.GitHubCli;
        const detail = yield* gh.getIssue({ cwd: "/tmp", reference: "42" });

        assert.deepStrictEqual(detail.comments[0]?.reactions, [
          { content: "thumbs-up", count: 2, viewerHasReacted: true },
          { content: "rocket", count: 1, viewerHasReacted: false },
        ]);
        expect(mockRun).toHaveBeenNthCalledWith(2, {
          operation: "GitHubCli.execute",
          command: "gh",
          args: [
            "api",
            "graphql",
            "-f",
            "query=query($ids:[ID!]!){nodes(ids:$ids){id ... on Reactable{reactionGroups{content viewerHasReacted reactors{totalCount} users{totalCount}}}}}",
            "-F",
            "ids[]=IC_kwDOA1B2C84AAAAB",
          ],
          cwd: "/tmp",
          timeoutMs: 30_000,
        });
      }).pipe(Effect.provide(layer)),
    );
  });

  describe("repository lists", () => {
    const repositoryView = processOutput(
      JSON.stringify({ nameWithOwner: "owner/repo", url: "https://github.com/owner/repo" }),
    );
    const graphQlCalls = () =>
      mockRun.mock.calls
        .map(([input]) => input)
        .filter((input) => input.args[0] === "api" && input.args[1] === "graphql");
    const variablesOf = (input: { readonly stdin?: string | undefined }) =>
      (JSON.parse(input.stdin ?? "{}") as { variables: Record<string, unknown> }).variables;
    const queryOf = (input: { readonly stdin?: string | undefined }) =>
      (JSON.parse(input.stdin ?? "{}") as { query: string }).query;
    const pullRequestPage = (
      numbers: ReadonlyArray<number>,
      pageInfo: { hasNextPage: boolean; endCursor: string | null } = {
        hasNextPage: false,
        endCursor: null,
      },
    ) =>
      processOutput(
        JSON.stringify({
          data: {
            repository: {
              pullRequests: {
                pageInfo,
                nodes: numbers.map((number) => ({
                  number,
                  title: `PR ${number}`,
                  url: `https://github.com/owner/repo/pull/${number}`,
                  baseRefName: "main",
                  headRefName: `feature/${number}`,
                  state: "OPEN",
                  comments: { totalCount: 2 },
                })),
              },
            },
          },
        }),
      );

    it.effect("lists issues in one GraphQL request with comment counts, not bodies", () =>
      Effect.gen(function* () {
        mockRun.mockReturnValueOnce(Effect.succeed(repositoryView));
        mockRun.mockReturnValueOnce(
          Effect.succeed(
            processOutput(
              JSON.stringify({
                data: {
                  repository: {
                    hasIssuesEnabled: true,
                    issues: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [
                        {
                          number: 42,
                          title: "Bug",
                          url: "https://github.com/owner/repo/issues/42",
                          state: "OPEN",
                          labels: { nodes: [{ name: "bug", color: "d73a4a" }] },
                          assignees: { nodes: [{ login: "octocat" }] },
                          comments: { totalCount: 7 },
                        },
                      ],
                    },
                  },
                },
              }),
            ),
          ),
        );

        const gh = yield* GitHubCli.GitHubCli;
        const issues = yield* gh.listIssues({ cwd: "/tmp", state: "open", limit: 20 });
        assert.equal(issues.length, 1);
        assert.equal(issues[0]?.number, 42);
        assert.equal(issues[0]?.commentsCount, 7);
        assert.deepStrictEqual(issues[0]?.assignees, ["octocat"]);
        expect(mockRun.mock.calls[0]?.[0].args).toEqual([
          "repo",
          "view",
          "--json",
          "nameWithOwner,url",
        ]);
        const [call] = graphQlCalls();
        expect(call?.args).toEqual(["api", "graphql", "--hostname", "github.com", "--input", "-"]);
        expect(variablesOf(call!)).toEqual({
          owner: "owner",
          name: "repo",
          first: 20,
          after: null,
          states: ["OPEN"],
        });
        expect(queryOf(call!)).toContain("comments { totalCount }");
        expect(queryOf(call!)).not.toContain("body");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("uses default limit of 50 and gh's wording for disabled issues", () =>
      Effect.gen(function* () {
        mockRun.mockReturnValueOnce(Effect.succeed(repositoryView));
        mockRun.mockReturnValueOnce(
          Effect.succeed(
            processOutput(
              JSON.stringify({
                data: {
                  repository: {
                    hasIssuesEnabled: false,
                    issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
                  },
                },
              }),
            ),
          ),
        );

        const gh = yield* GitHubCli.GitHubCli;
        const error = yield* gh.listIssues({ cwd: "/tmp", state: "open" }).pipe(Effect.flip);
        expect(variablesOf(graphQlCalls()[0]!).first).toBe(50);
        expect(error.message).toContain("the 'owner/repo' repository has disabled issues");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("resolves the repository once per checkout and pages past 100 rows", () =>
      Effect.gen(function* () {
        mockRun.mockReturnValueOnce(Effect.succeed(repositoryView));
        mockRun.mockReturnValueOnce(
          Effect.succeed(
            pullRequestPage(
              Array.from({ length: 100 }, (_, index) => index + 1),
              { hasNextPage: true, endCursor: "cursor-1" },
            ),
          ),
        );
        mockRun.mockReturnValueOnce(Effect.succeed(pullRequestPage([101, 102])));
        mockRun.mockReturnValueOnce(Effect.succeed(pullRequestPage([7])));

        const gh = yield* GitHubCli.GitHubCli;
        const many = yield* gh.listPullRequests({ cwd: "/repo", state: "closed", limit: 150 });
        const again = yield* gh.listPullRequests({
          cwd: "/repo",
          state: "open",
          headSelector: "feature/7",
        });

        assert.equal(many.length, 102);
        assert.equal(many[0]?.summary.commentsCount, 2);
        assert.equal(again[0]?.summary.number, 7);
        // `gh repo view` ran once; every page and list after it is one GraphQL call.
        expect(mockRun.mock.calls.filter(([input]) => input.args[0] === "repo")).toHaveLength(1);
        const calls = graphQlCalls();
        expect(calls.map(variablesOf)).toEqual([
          {
            owner: "owner",
            name: "repo",
            first: 100,
            after: null,
            states: ["CLOSED", "MERGED"],
            head: null,
          },
          {
            owner: "owner",
            name: "repo",
            first: 50,
            after: "cursor-1",
            states: ["CLOSED", "MERGED"],
            head: null,
          },
          {
            owner: "owner",
            name: "repo",
            first: 20,
            after: null,
            states: ["OPEN"],
            head: "feature/7",
          },
        ]);
        expect(queryOf(calls[0]!)).toContain("stack { number size baseRefName }");
        expect(queryOf(calls[0]!)).toContain("comments { totalCount }");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("runs involvement lists as the search gh pr list --search would", () =>
      Effect.gen(function* () {
        mockRun.mockReturnValueOnce(Effect.succeed(repositoryView));
        mockRun.mockReturnValueOnce(
          Effect.succeed(
            processOutput(
              JSON.stringify({
                data: {
                  search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{}] },
                },
              }),
            ),
          ),
        );

        const gh = yield* GitHubCli.GitHubCli;
        const rows = yield* gh.listPullRequests({
          cwd: "/repo",
          state: "merged",
          involvement: "review-requested",
          limit: 100,
          includeStackSummary: false,
        });

        assert.deepStrictEqual(rows, []);
        const [call] = graphQlCalls();
        expect(variablesOf(call!)).toEqual({
          q: "review-requested:@me is:merged repo:owner/repo type:pr",
          first: 100,
          after: null,
        });
        expect(queryOf(call!)).toContain("search(query: $q, type: ISSUE");
        expect(queryOf(call!)).not.toContain("stackEntry");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("drops stack fields on hosts without native stacks and remembers it", () =>
      Effect.gen(function* () {
        mockRun.mockReturnValueOnce(Effect.succeed(repositoryView));
        mockRun.mockReturnValueOnce(
          Effect.succeed({
            ...processOutput(
              JSON.stringify({
                errors: [{ message: "Field 'stack' doesn't exist on type 'PullRequest'" }],
              }),
            ),
            exitCode: ChildProcessSpawner.ExitCode(1),
          }),
        );
        mockRun.mockReturnValueOnce(Effect.succeed(pullRequestPage([1])));
        mockRun.mockReturnValueOnce(Effect.succeed(pullRequestPage([2])));

        const gh = yield* GitHubCli.GitHubCli;
        const first = yield* gh.listPullRequests({ cwd: "/repo", state: "open" });
        const second = yield* gh.listPullRequests({ cwd: "/repo", state: "open" });

        assert.equal(first[0]?.summary.number, 1);
        assert.equal(second[0]?.summary.number, 2);
        const queries = graphQlCalls().map(queryOf);
        expect(queries).toHaveLength(3);
        expect(queries[0]).toContain("stackEntry");
        expect(queries[1]).not.toContain("stackEntry");
        expect(queries[2]).not.toContain("stackEntry");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("retries without checks when the token may not read the check rollup", () =>
      Effect.gen(function* () {
        mockRun.mockReturnValueOnce(Effect.succeed(repositoryView));
        mockRun.mockReturnValueOnce(
          Effect.succeed({
            ...processOutput(""),
            stderr:
              "GraphQL: Resource not accessible by integration (repository.pullRequests.nodes.0.commits.nodes.0.commit.statusCheckRollup)",
            exitCode: ChildProcessSpawner.ExitCode(1),
          }),
        );
        mockRun.mockReturnValueOnce(Effect.succeed(pullRequestPage([1])));

        const gh = yield* GitHubCli.GitHubCli;
        const rows = yield* gh.listPullRequests({ cwd: "/repo", state: "open" });

        assert.equal(rows[0]?.summary.number, 1);
        assert.equal(rows[0]?.summary.checkRollup, undefined);
        const queries = graphQlCalls().map(queryOf);
        expect(queries[0]).toContain("statusCheckRollup");
        expect(queries[1]).not.toContain("statusCheckRollup");
      }).pipe(Effect.provide(layer)),
    );
  });

  describe("add comments", () => {
    it.effect("posts issue comments from a body file", () =>
      Effect.gen(function* () {
        mockRun.mockReturnValueOnce(Effect.succeed(processOutput("")));

        const gh = yield* GitHubCli.GitHubCli;
        yield* gh.addIssueComment({
          cwd: "/tmp",
          reference: "42",
          bodyFile: "/tmp/comment.md",
        });

        expect(mockRun).toHaveBeenCalledWith({
          operation: "GitHubCli.execute",
          command: "gh",
          args: ["issue", "comment", "42", "--body-file", "/tmp/comment.md"],
          cwd: "/tmp",
          timeoutMs: 30_000,
        });
      }).pipe(Effect.provide(layer)),
    );

    it.effect("posts pull request comments from a body file", () =>
      Effect.gen(function* () {
        mockRun.mockReturnValueOnce(Effect.succeed(processOutput("")));

        const gh = yield* GitHubCli.GitHubCli;
        yield* gh.addPullRequestComment({
          cwd: "/tmp",
          reference: "7",
          bodyFile: "/tmp/comment.md",
        });

        expect(mockRun).toHaveBeenCalledWith({
          operation: "GitHubCli.execute",
          command: "gh",
          args: ["pr", "comment", "7", "--body-file", "/tmp/comment.md"],
          cwd: "/tmp",
          timeoutMs: 30_000,
        });
      }).pipe(Effect.provide(layer)),
    );

    it.effect("adds a reaction to a comment node", () =>
      Effect.gen(function* () {
        mockRun.mockReturnValueOnce(Effect.succeed(processOutput("{}")));

        const gh = yield* GitHubCli.GitHubCli;
        yield* gh.addReaction({
          cwd: "/tmp",
          subjectId: "IC_kwDOA1B2C84AAAAB",
          content: "thumbs-up",
        });

        expect(mockRun).toHaveBeenCalledWith({
          operation: "GitHubCli.execute",
          command: "gh",
          args: [
            "api",
            "graphql",
            "-f",
            "query=mutation($subjectId:ID!,$content:ReactionContent!){addReaction(input:{subjectId:$subjectId,content:$content}){reaction{content}}}",
            "-f",
            "subjectId=IC_kwDOA1B2C84AAAAB",
            "-f",
            "content=THUMBS_UP",
          ],
          cwd: "/tmp",
          timeoutMs: 30_000,
        });
      }).pipe(Effect.provide(layer)),
    );

    it.effect("removes a reaction from a comment node", () =>
      Effect.gen(function* () {
        mockRun.mockReturnValueOnce(Effect.succeed(processOutput("{}")));

        const gh = yield* GitHubCli.GitHubCli;
        yield* gh.removeReaction({
          cwd: "/tmp",
          subjectId: "IC_kwDOA1B2C84AAAAB",
          content: "heart",
        });

        expect(mockRun).toHaveBeenCalledWith({
          operation: "GitHubCli.execute",
          command: "gh",
          args: [
            "api",
            "graphql",
            "-f",
            "query=mutation($subjectId:ID!,$content:ReactionContent!){removeReaction(input:{subjectId:$subjectId,content:$content}){reaction{content}}}",
            "-f",
            "subjectId=IC_kwDOA1B2C84AAAAB",
            "-f",
            "content=HEART",
          ],
          cwd: "/tmp",
          timeoutMs: 30_000,
        });
      }).pipe(Effect.provide(layer)),
    );
  });

  describe("workflow reruns", () => {
    it.effect("requests rerun of failed jobs for a workflow run", () =>
      Effect.gen(function* () {
        mockRun.mockReturnValueOnce(Effect.succeed(processOutput("")));

        const gh = yield* GitHubCli.GitHubCli;
        yield* gh.rerunFailedWorkflowJobs({ cwd: "/tmp", runId: "12345" });

        expect(mockRun).toHaveBeenCalledWith({
          operation: "GitHubCli.execute",
          command: "gh",
          args: ["api", "-X", "POST", "repos/{owner}/{repo}/actions/runs/12345/rerun-failed-jobs"],
          cwd: "/tmp",
          timeoutMs: 45_000,
        });
      }).pipe(Effect.provide(layer)),
    );

    it.effect("requests rerun of a workflow job", () =>
      Effect.gen(function* () {
        mockRun.mockReturnValueOnce(Effect.succeed(processOutput("")));

        const gh = yield* GitHubCli.GitHubCli;
        yield* gh.rerunWorkflowJob({ cwd: "/tmp", jobId: "67890" });

        expect(mockRun).toHaveBeenCalledWith({
          operation: "GitHubCli.execute",
          command: "gh",
          args: ["api", "-X", "POST", "repos/{owner}/{repo}/actions/jobs/67890/rerun"],
          cwd: "/tmp",
          timeoutMs: 45_000,
        });
      }).pipe(Effect.provide(layer)),
    );

    it.effect("surfaces not-rerunnable workflow rerun errors clearly", () =>
      Effect.gen(function* () {
        mockRun.mockReturnValueOnce(
          Effect.fail(
            new VcsProcessExitError({
              operation: "GitHubCli.execute",
              command: "gh api",
              cwd: "/repo",
              exitCode: 1,
              detail: "HTTP 422: Unprocessable Entity",
            }),
          ),
        );

        const gh = yield* GitHubCli.GitHubCli;
        const error = yield* gh
          .rerunFailedWorkflowJobs({ cwd: "/repo", runId: "123" })
          .pipe(Effect.flip);

        assert.equal(error.operation, "rerunFailedWorkflowJobs");
        assert.equal(error.detail.includes("cannot rerun"), true);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("does not report non-rerun 422 errors as rerun failures", () =>
      Effect.gen(function* () {
        mockRun.mockReturnValueOnce(
          Effect.fail(
            new VcsProcessExitError({
              operation: "GitHubCli.execute",
              command: "gh api",
              cwd: "/repo",
              exitCode: 1,
              detail: "HTTP 422: Unprocessable Entity",
            }),
          ),
        );

        const gh = yield* GitHubCli.GitHubCli;
        const error = yield* gh.listWorkflowRuns({ cwd: "/repo" }).pipe(Effect.flip);

        assert.equal(error.detail.includes("HTTP 422"), true);
        assert.equal(error.detail.includes("cannot rerun"), false);
      }).pipe(Effect.provide(layer)),
    );
  });
});

describe("pull request viewed files", () => {
  const identity = {
    id: "PR_42",
    headRefOid: "head",
    url: "https://github.example/acme/repo/pull/42",
  };
  const respond = (value: unknown) =>
    mockRun.mockReturnValueOnce(Effect.succeed(processOutput(JSON.stringify(value))));
  const page = (
    nodes: ReadonlyArray<{ path: string; viewerViewedState: string }>,
    hasNextPage = false,
    endCursor: string | null = null,
    headRefOid = "head",
  ) => ({ data: { node: { headRefOid, files: { nodes, pageInfo: { hasNextPage, endCursor } } } } });

  it.effect("paginates native review state and uses the resolved enterprise host", () =>
    Effect.gen(function* () {
      respond(identity);
      respond(page([{ path: "one.ts", viewerViewedState: "VIEWED" }], true, "next"));
      respond(
        page([
          { path: "two.ts", viewerViewedState: "DISMISSED" },
          { path: "three.ts", viewerViewedState: "UNVIEWED" },
        ]),
      );
      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.getPullRequestFilesViewed({ cwd: "/repo", reference: "42" });
      expect(result).toEqual({
        provider: "github",
        capability: { storage: "host" },
        headSha: "head",
        files: [
          { path: "one.ts", state: "viewed" },
          { path: "two.ts", state: "stale" },
          { path: "three.ts", state: "unviewed" },
        ],
      });
      expect(mockRun.mock.calls[1]?.[0].args).toContain("github.example");
      expect(mockRun.mock.calls[2]?.[0].args).toContain("cursor=next");
      expect(mockRun.mock.calls.some(([input]) => input.args.includes("diff"))).toBe(false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects incomplete pagination rather than returning partial progress", () =>
    Effect.gen(function* () {
      respond(identity);
      respond(page([], true, null));
      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .getPullRequestFilesViewed({ cwd: "/repo", reference: "42" })
        .pipe(Effect.flip);
      expect(error.detail).toContain("pagination");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects unknown native states", () =>
    Effect.gen(function* () {
      respond(identity);
      respond(page([{ path: "a", viewerViewedState: "UNKNOWN" }]));
      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .getPullRequestFilesViewed({ cwd: "/repo", reference: "42" })
        .pipe(Effect.flip);
      expect(error.detail).toContain("Invalid viewed file response");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects a push during pagination", () =>
    Effect.gen(function* () {
      respond(identity);
      respond(page([], false, null, "new-head"));
      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .getPullRequestFilesViewed({ cwd: "/repo", reference: "42" })
        .pipe(Effect.flip);
      expect(error.detail).toContain("changed while loading");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses to mark a stale displayed diff", () =>
    Effect.gen(function* () {
      respond(identity);
      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .setPullRequestFileViewed({
          cwd: "/repo",
          reference: "42",
          path: "a",
          viewed: true,
          expectedHeadSha: "old",
        })
        .pipe(Effect.flip);
      expect(error.detail).toContain("Refresh the diff");
      expect(mockRun).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(layer)),
  );

  for (const viewed of [true, false]) {
    it.effect(`persists ${viewed ? "viewed" : "unviewed"} without retrieving a diff`, () =>
      Effect.gen(function* () {
        respond(identity);
        const mutation = viewed ? "markFileAsViewed" : "unmarkFileAsViewed";
        respond({ data: { [mutation]: { pullRequest: identity } } });
        const gh = yield* GitHubCli.GitHubCli;
        const result = yield* gh.setPullRequestFileViewed({
          cwd: "/repo",
          reference: "42",
          path: " a $file.ts ",
          viewed,
          expectedHeadSha: "head",
        });
        expect(result).toEqual({
          path: " a $file.ts ",
          state: viewed ? "viewed" : "unviewed",
          headSha: "head",
        });
        expect(mockRun.mock.calls[1]?.[0].args).toContain("path= a $file.ts ");
        expect(mockRun).toHaveBeenCalledTimes(2);
      }).pipe(Effect.provide(layer)),
    );
  }

  it.effect("undoes a mark raced by a push", () =>
    Effect.gen(function* () {
      respond(identity);
      respond({ data: { markFileAsViewed: { pullRequest: { ...identity, headRefOid: "new" } } } });
      respond({ data: { unmarkFileAsViewed: { pullRequest: { id: identity.id } } } });
      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .setPullRequestFileViewed({
          cwd: "/repo",
          reference: "42",
          path: "a",
          viewed: true,
          expectedHeadSha: "head",
        })
        .pipe(Effect.flip);
      expect(error.detail).toContain("changed while updating");
      expect(mockRun.mock.calls[2]?.[0].args.join(" ")).toContain("unmarkFileAsViewed");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("discards a diff if its head changed during retrieval", () =>
    Effect.gen(function* () {
      respond(identity);
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("diff contents")));
      respond({ ...identity, headRefOid: "new" });
      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .getPullRequestDiff({ cwd: "/repo", reference: "42", expectedHeadSha: "head" })
        .pipe(Effect.flip);
      expect(error.detail).toContain("changed while loading the diff");
    }).pipe(Effect.provide(layer)),
  );
});
