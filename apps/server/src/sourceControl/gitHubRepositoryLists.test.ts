import { assert, describe, it } from "@effect/vitest";
import { Option, Result } from "effect";

import {
  buildGitHubPullRequestInvolvementSearch,
  buildGitHubPullRequestListQuery,
  buildGitHubPullRequestStatesQuery,
  decodeGitHubPullRequestStatesJson,
  decodeGitHubIssueListPageJson,
  decodeGitHubPullRequestListPageJson,
  gitHubPullRequestListStates,
  isGitHubStackFieldUnsupportedDetail,
} from "./gitHubRepositoryLists.ts";

const repository = { host: "github.com", owner: "owner", name: "repo" };

const node = (overrides: Record<string, unknown> = {}) => ({
  number: 12,
  title: "Add lists",
  url: "https://github.com/owner/repo/pull/12",
  baseRefName: "main",
  headRefName: "feature/lists",
  headRefOid: "abc123",
  mergeable: "MERGEABLE",
  state: "OPEN",
  updatedAt: "2026-10-01T10:00:00Z",
  createdAt: "2026-09-30T10:00:00Z",
  reviewDecision: "APPROVED",
  additions: 10,
  deletions: 2,
  changedFiles: 3,
  isCrossRepository: false,
  isDraft: false,
  author: { login: "octocat" },
  assignees: { nodes: [{ login: "hubot" }] },
  labels: { nodes: [{ name: "perf", color: "ededed", description: null }] },
  comments: { totalCount: 42 },
  headRepository: { nameWithOwner: "owner/repo" },
  headRepositoryOwner: { login: "owner" },
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            contexts: {
              nodes: [
                {
                  __typename: "CheckRun",
                  name: "test",
                  checkSuite: { workflowRun: { workflow: { name: "CI" } } },
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                  startedAt: "2026-10-01T10:00:00Z",
                  completedAt: "2026-10-01T10:05:00Z",
                  detailsUrl: "https://github.com/owner/repo/runs/1",
                },
                {
                  __typename: "StatusContext",
                  context: "deploy",
                  state: "PENDING",
                  targetUrl: "https://example.com/deploy",
                  createdAt: "2026-10-01T10:01:00Z",
                },
              ],
            },
          },
        },
      },
    ],
  },
  stackEntry: { position: 2 },
  stack: { number: 5, size: 3, baseRefName: "main" },
  ...overrides,
});

const page = (nodes: ReadonlyArray<unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    data: {
      repository: {
        pullRequests: { pageInfo: { hasNextPage: true, endCursor: "next" }, nodes },
      },
    },
    ...extra,
  });

describe("gitHubRepositoryLists", () => {
  it("asks for comment counts, never comment bodies", () => {
    for (const search of [false, true]) {
      const query = buildGitHubPullRequestListQuery({ search, checks: true, stack: true });
      assert.include(query, "comments { totalCount }");
      assert.notInclude(query, "body");
      assert.include(query, "stackEntry { position }");
      assert.include(query, "statusCheckRollup");
    }
    const lean = buildGitHubPullRequestListQuery({ search: false, checks: false, stack: false });
    assert.notInclude(lean, "statusCheckRollup");
    assert.notInclude(lean, "stackEntry");
  });

  it("maps states and involvement searches the way gh pr list does", () => {
    assert.deepStrictEqual(gitHubPullRequestListStates("closed"), ["CLOSED", "MERGED"]);
    assert.deepStrictEqual(gitHubPullRequestListStates("all"), ["OPEN", "CLOSED", "MERGED"]);
    assert.strictEqual(
      buildGitHubPullRequestInvolvementSearch({
        repository,
        involvement: "authored",
        state: "open",
      }),
      "author:@me state:open repo:owner/repo type:pr",
    );
    assert.strictEqual(
      buildGitHubPullRequestInvolvementSearch({
        repository,
        involvement: "review-requested",
        state: "all",
        headSelector: "feature/x",
      }),
      "review-requested:@me head:feature/x repo:owner/repo type:pr",
    );
  });

  it("flattens rows into the list shape: counts, checks and stack summary", () => {
    const decoded = decodeGitHubPullRequestListPageJson(page([node()]), { search: false });
    assert.isTrue(Result.isSuccess(decoded));
    if (!Result.isSuccess(decoded)) return;
    assert.isTrue(decoded.success.hasNextPage);
    assert.strictEqual(decoded.success.endCursor, "next");
    const [row] = decoded.success.items;
    assert.strictEqual(row?.record.commentsCount, 42);
    assert.deepStrictEqual(row?.record.assignees, ["hubot"]);
    assert.deepStrictEqual(row?.record.labels, [{ name: "perf", color: "ededed" }]);
    assert.strictEqual(row?.record.mergeability, "mergeable");
    assert.strictEqual(row?.record.reviewDecision, "approved");
    assert.strictEqual(row?.record.headSha, "abc123");
    assert.strictEqual(row?.record.checkRollup?.length, 2);
    assert.strictEqual(row?.record.checkRollup?.[0]?.workflowName, "CI");
    assert.strictEqual(row?.record.checkRollup?.[0]?.kind, "check-run");
    assert.strictEqual(row?.record.checkRollup?.[1]?.name, "deploy");
    assert.isTrue(Option.isSome(row!.record.checkRollup![1]!.startedAt));
    assert.deepStrictEqual(row?.stackSummary, {
      number: 5,
      size: 3,
      position: 2,
      baseRefName: "main",
    });
  });

  it("reports bot authors the way gh does", () => {
    const decoded = decodeGitHubPullRequestListPageJson(
      page([node({ author: { __typename: "Bot", login: "dependabot" } })]),
      { search: false },
    );
    assert.isTrue(Result.isSuccess(decoded));
    if (Result.isSuccess(decoded)) {
      assert.strictEqual(decoded.success.items[0]?.record.author, "app/dependabot");
    }
  });

  it("reports no checks without a head commit and no stack for standalone rows", () => {
    const decoded = decodeGitHubPullRequestListPageJson(
      page([node({ commits: { nodes: [] }, stackEntry: null, stack: null })]),
      { search: false },
    );
    assert.isTrue(Result.isSuccess(decoded));
    if (!Result.isSuccess(decoded)) return;
    assert.strictEqual(decoded.success.items[0]?.record.checkRollup, undefined);
    assert.strictEqual(decoded.success.items[0]?.stackSummary, null);
  });

  it("skips non-pull-request search nodes and malformed rows", () => {
    const decoded = decodeGitHubPullRequestListPageJson(
      JSON.stringify({
        data: {
          search: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{}, node({ title: "" }), node({ number: 13 })],
          },
        },
      }),
      { search: true },
    );
    assert.isTrue(Result.isSuccess(decoded));
    if (!Result.isSuccess(decoded)) return;
    assert.deepStrictEqual(
      decoded.success.items.map((row) => row.record.number),
      [13],
    );
  });

  it("drops checks from every row when the host refuses the rollup, as the old retry did", () => {
    const decoded = decodeGitHubPullRequestListPageJson(
      page([node({ commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }), node()], {
        errors: [
          {
            message: "Resource not accessible by personal access token",
            path: [
              "repository",
              "pullRequests",
              "nodes",
              0,
              "commits",
              "nodes",
              0,
              "commit",
              "statusCheckRollup",
            ],
          },
        ],
      }),
      { search: false },
    );
    assert.isTrue(Result.isSuccess(decoded));
    if (!Result.isSuccess(decoded)) return;
    for (const row of decoded.success.items) assert.strictEqual(row.record.checkRollup, undefined);
  });

  it("tolerates per-row stack errors but fails on any other error", () => {
    const stackError = decodeGitHubPullRequestListPageJson(
      page([node({ stack: null, stackEntry: null })], {
        errors: [
          {
            message: "stack unavailable",
            path: ["repository", "pullRequests", "nodes", 0, "stack"],
          },
        ],
      }),
      { search: false },
    );
    assert.isTrue(Result.isSuccess(stackError));

    const otherError = decodeGitHubPullRequestListPageJson(
      JSON.stringify({
        data: { repository: null },
        errors: [{ message: "Could not resolve to a Repository", path: ["repository"] }],
      }),
      { search: false },
    );
    assert.isTrue(Result.isFailure(otherError));
    if (Result.isFailure(otherError)) assert.include(otherError.failure, "Could not resolve");
  });

  it("decodes issue rows with counts and refuses repositories without issues", () => {
    const decoded = decodeGitHubIssueListPageJson(
      JSON.stringify({
        data: {
          repository: {
            hasIssuesEnabled: true,
            issues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  number: 3,
                  title: "Slow list",
                  url: "https://github.com/owner/repo/issues/3",
                  state: "CLOSED",
                  updatedAt: "2026-10-01T10:00:00Z",
                  author: null,
                  labels: { nodes: [] },
                  assignees: { nodes: [] },
                  comments: { totalCount: 4 },
                },
              ],
            },
          },
        },
      }),
      repository,
    );
    assert.isTrue(Result.isSuccess(decoded));
    if (Result.isSuccess(decoded)) {
      assert.strictEqual(decoded.success.items[0]?.state, "closed");
      assert.strictEqual(decoded.success.items[0]?.commentsCount, 4);
    }

    const disabled = decodeGitHubIssueListPageJson(
      JSON.stringify({ data: { repository: { hasIssuesEnabled: false, issues: null } } }),
      repository,
    );
    assert.isTrue(Result.isFailure(disabled));
  });

  it("recognizes a schema without native stacks", () => {
    assert.isTrue(
      isGitHubStackFieldUnsupportedDetail(
        "gh: Field 'stackEntry' doesn't exist on type 'PullRequest'",
      ),
    );
    assert.isFalse(isGitHubStackFieldUnsupportedDetail("Field 'title' doesn't exist on type 'X'"));
  });
});

describe("pull request states by number", () => {
  it("asks for every number in one document and decodes states, skipping unresolved ones", () => {
    const query = buildGitHubPullRequestStatesQuery([12, 7, 0, -1]);
    assert.include(query, "p12: pullRequest(number: 12)");
    assert.include(query, "p7: pullRequest(number: 7)");
    assert.notInclude(query, "number: 0");
    const decoded = decodeGitHubPullRequestStatesJson(
      JSON.stringify({
        data: {
          repository: {
            p12: {
              number: 12,
              state: "MERGED",
              isDraft: false,
              closedAt: "2026-10-01T00:00:00Z",
              mergedAt: "2026-10-01T00:00:00Z",
            },
            p7: null,
            p9: { number: 9, state: "OPEN", isDraft: true, closedAt: null, mergedAt: null },
          },
        },
        errors: [{ message: "Could not resolve to a PullRequest", path: ["repository", "p7"] }],
      }),
    );
    assert.isTrue(Result.isSuccess(decoded));
    if (!Result.isSuccess(decoded)) return;
    assert.deepStrictEqual(
      [...decoded.success],
      [
        [
          12,
          {
            state: "merged",
            isDraft: false,
            closedAt: "2026-10-01T00:00:00Z",
            mergedAt: "2026-10-01T00:00:00Z",
          },
        ],
        [9, { state: "open", isDraft: true, closedAt: null, mergedAt: null }],
      ],
    );
    const failed = decodeGitHubPullRequestStatesJson(
      JSON.stringify({ data: null, errors: [{ message: "Bad credentials", path: null }] }),
    );
    assert.isTrue(Result.isFailure(failed));
  });
});
