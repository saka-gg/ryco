import { createHash } from "node:crypto";
import * as fs from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Option } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { SOURCE_CONTROL_DETAIL_BODY_MAX_BYTES } from "@ryco/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubCli from "./GitHubCli.ts";
import { parseGitHubAuthStatus } from "./gitHubAuthStatus.ts";
import type * as GitHubPullRequests from "./gitHubPullRequests.ts";
import * as GitHubSourceControlProvider from "./GitHubSourceControlProvider.ts";

const processResult = (
  stdout: string,
  options?: {
    readonly stderr?: string;
    readonly exitCode?: ChildProcessSpawner.ExitCode;
  },
): VcsProcess.VcsProcessOutput => ({
  exitCode: options?.exitCode ?? ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: options?.stderr ?? "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const prListJsonFields = GitHubCli.formatGitHubJsonFields(
  GitHubCli.GITHUB_PULL_REQUEST_LIST_JSON_FIELDS,
);
const prListJsonFieldsWithoutCheckRollup = GitHubCli.formatGitHubJsonFields(
  GitHubCli.withoutStatusCheckRollupJsonField(GitHubCli.GITHUB_PULL_REQUEST_LIST_JSON_FIELDS),
);

function mutationMarker(clientMutationId: string): string {
  return `<!-- ryco-comment-id:${createHash("sha256").update(clientMutationId).digest("hex")} -->`;
}

function makeProvider(github: Partial<GitHubCli.GitHubCliShape>) {
  return GitHubSourceControlProvider.make().pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(GitHubCli.GitHubCli)({
          getPullRequestStack: () => Effect.succeed(null),
          getPullRequestStackSummaries: () => Effect.succeed(new Map()),
          getRepositoryMergeCapabilities: () =>
            Effect.fail(
              new GitHubCli.GitHubCliError({
                operation: "getRepositoryMergeCapabilities",
                detail: "not configured in this test",
              }),
            ),
          getPullRequestRequiredChecks: () =>
            Effect.fail(
              new GitHubCli.GitHubCliError({
                operation: "getPullRequestRequiredChecks",
                detail: "not configured in this test",
              }),
            ),
          ...github,
        }),
        NodeServices.layer,
      ),
    ),
  );
}

const stack = {
  number: 7,
  size: 3,
  position: 2,
  baseRefName: "main",
  entries: [
    {
      position: 1,
      number: 41,
      title: "Foundation",
      url: "https://github.com/owner/repo/pull/41",
      headRefName: "feature/41",
      baseRefName: "main",
      state: "open" as const,
      isDraft: false,
      mergeability: "mergeable" as const,
      mergeStateStatus: "CLEAN",
    },
    {
      position: 2,
      number: 42,
      title: "Middle",
      url: "https://github.com/owner/repo/pull/42",
      headRefName: "feature/42",
      baseRefName: "feature/41",
      state: "open" as const,
      isDraft: false,
      mergeability: "mergeable" as const,
      mergeStateStatus: "CLEAN",
    },
    {
      position: 3,
      number: 43,
      title: "Top",
      url: "https://github.com/owner/repo/pull/43",
      headRefName: "feature/43",
      baseRefName: "feature/42",
      state: "open" as const,
      isDraft: false,
      mergeability: "unknown" as const,
      mergeStateStatus: "UNKNOWN",
    },
  ],
};

const githubPullRequestDetail = {
  number: 42,
  title: "Middle",
  url: "https://github.com/owner/repo/pull/42",
  baseRefName: "feature/41",
  headRefName: "feature/42",
  state: "open" as const,
  isDraft: false,
  author: "alice",
  assignees: [],
  labels: [],
  commentsCount: 0,
  body: "Body",
  comments: [],
  linkedIssueNumbers: [],
  reviewers: [],
  commits: [],
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  files: [],
} satisfies GitHubCli.GitHubPullRequestDetail;

it("parses structured gh auth status hosts output", () => {
  const status = parseGitHubAuthStatus(
    JSON.stringify({
      hosts: {
        "github.com": [
          {
            state: "success",
            active: false,
            host: "github.com",
            login: "octocat",
          },
          {
            state: "success",
            active: true,
            host: "github.com",
            login: "hubot",
          },
        ],
      },
    }),
  );

  assert.strictEqual(status.parsed, true);
  assert.deepStrictEqual(
    status.accounts.map((account) => ({
      host: account.host,
      account: account.account,
      authenticated: account.authenticated,
      active: account.active,
    })),
    [
      {
        host: "github.com",
        account: "octocat",
        authenticated: true,
        active: false,
      },
      {
        host: "github.com",
        account: "hubot",
        authenticated: true,
        active: true,
      },
    ],
  );
});

it("prefers the active authenticated GitHub account", () => {
  const auth = GitHubSourceControlProvider.discovery.parseAuth(
    processResult(
      JSON.stringify({
        hosts: {
          "github.com": [
            {
              state: "success",
              active: false,
              host: "github.com",
              login: "octocat",
            },
            {
              state: "success",
              active: true,
              host: "github.com",
              login: "hubot",
            },
          ],
        },
      }),
    ),
  );

  assert.strictEqual(auth.status, "authenticated");
  assert.deepStrictEqual(auth.account, Option.some("hubot"));
  assert.deepStrictEqual(auth.host, Option.some("github.com"));
});

it("falls back to any successful GitHub account when none is active", () => {
  const auth = GitHubSourceControlProvider.discovery.parseAuth(
    processResult(
      JSON.stringify({
        hosts: {
          "github.example.test": [
            {
              state: "success",
              active: false,
              host: "github.example.test",
              login: "octocat",
            },
          ],
        },
      }),
    ),
  );

  assert.strictEqual(auth.status, "authenticated");
  assert.deepStrictEqual(auth.account, Option.some("octocat"));
  assert.deepStrictEqual(auth.host, Option.some("github.example.test"));
});

it("returns unauthenticated when structured GitHub auth has no successful account", () => {
  const auth = GitHubSourceControlProvider.discovery.parseAuth(
    processResult(
      JSON.stringify({
        hosts: {
          "github.com": [
            {
              state: "failed",
              error: "token expired",
              active: true,
              host: "github.com",
              login: "octocat",
            },
          ],
        },
      }),
      {
        exitCode: ChildProcessSpawner.ExitCode(1),
      },
    ),
  );

  assert.strictEqual(auth.status, "unauthenticated");
  assert.deepStrictEqual(auth.host, Option.some("github.com"));
  assert.deepStrictEqual(auth.detail, Option.some("token expired"));
});

it.effect("maps GitHub PR summaries into provider-neutral change requests", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getPullRequest: () =>
        Effect.succeed({
          number: 42,
          title: "Add GitHub provider",
          url: "https://github.com/pingdotgg/ryco/pull/42",
          baseRefName: "main",
          headRefName: "feature/source-control",
          state: "open",
          mergeability: "conflicting",
          isCrossRepository: true,
          headRepositoryNameWithOwner: "fork/ryco",
          headRepositoryOwnerLogin: "fork",
        }),
    });

    const changeRequest = yield* provider.getChangeRequest({
      cwd: "/repo",
      reference: "42",
    });

    assert.deepStrictEqual(changeRequest, {
      provider: "github",
      number: 42,
      title: "Add GitHub provider",
      url: "https://github.com/pingdotgg/ryco/pull/42",
      baseRefName: "main",
      headRefName: "feature/source-control",
      state: "open",
      updatedAt: Option.none(),
      mergeability: "conflicting",
      isCrossRepository: true,
      headRepositoryNameWithOwner: "fork/ryco",
      headRepositoryOwnerLogin: "fork",
    });
  }),
);

it.effect("uses gh json listing for non-open change request state queries", () =>
  Effect.gen(function* () {
    let executeArgs: ReadonlyArray<string> = [];
    const provider = yield* makeProvider({
      execute: (input) => {
        executeArgs = input.args;
        return Effect.succeed(
          processResult(
            JSON.stringify([
              {
                number: 7,
                title: "Merged work",
                url: "https://github.com/pingdotgg/ryco/pull/7",
                baseRefName: "main",
                headRefName: "feature/merged",
                state: "merged",
                updatedAt: "2026-01-02T00:00:00.000Z",
              },
            ]),
          ),
        );
      },
    });

    const changeRequests = yield* provider.listChangeRequests({
      cwd: "/repo",
      headSelector: "feature/merged",
      state: "all",
      limit: 10,
    });

    assert.deepStrictEqual(executeArgs, [
      "pr",
      "list",
      "--head",
      "feature/merged",
      "--state",
      "all",
      "--limit",
      "10",
      "--json",
      prListJsonFields,
    ]);
    assert.strictEqual(changeRequests[0]?.provider, "github");
    assert.strictEqual(changeRequests[0]?.state, "merged");
    assert.deepStrictEqual(
      changeRequests[0]?.updatedAt,
      Option.some(DateTime.makeUnsafe("2026-01-02T00:00:00.000Z")),
    );
  }),
);

it.effect("retries non-open PR listings without check rollup when GitHub denies that field", () =>
  Effect.gen(function* () {
    const executeArgs: ReadonlyArray<string>[] = [];
    const provider = yield* makeProvider({
      execute: (input) => {
        executeArgs.push(input.args);
        if (executeArgs.length === 1) {
          return Effect.fail(
            new GitHubCli.GitHubCliError({
              operation: "execute",
              detail:
                "GraphQL: Resource not accessible by integration (repository.pullRequest.statusCheckRollup)",
            }),
          );
        }
        return Effect.succeed(
          processResult(
            JSON.stringify([
              {
                number: 7,
                title: "Merged work",
                url: "https://github.com/pingdotgg/ryco/pull/7",
                baseRefName: "main",
                headRefName: "feature/merged",
                state: "merged",
                updatedAt: "2026-01-02T00:00:00.000Z",
              },
            ]),
          ),
        );
      },
    });

    const changeRequests = yield* provider.listChangeRequests({
      cwd: "/repo",
      headSelector: "feature/merged",
      state: "all",
      limit: 10,
    });

    assert.deepStrictEqual(
      executeArgs.map((args) => args.at(-1)),
      [prListJsonFields, prListJsonFieldsWithoutCheckRollup],
    );
    assert.strictEqual(changeRequests[0]?.number, 7);
    assert.strictEqual(changeRequests[0]?.checkRollup, undefined);
  }),
);

it.effect("treats empty non-open change request listing output as no results", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      execute: () => Effect.succeed(processResult("")),
    });

    const changeRequests = yield* provider.listChangeRequests({
      cwd: "/repo",
      headSelector: "feature/empty",
      state: "all",
      limit: 10,
    });

    assert.deepStrictEqual(changeRequests, []);
  }),
);

it.effect("creates GitHub PRs through provider-neutral input names", () =>
  Effect.gen(function* () {
    let createInput: Parameters<GitHubCli.GitHubCliShape["createPullRequest"]>[0] | null = null;
    const provider = yield* makeProvider({
      createPullRequest: (input) => {
        createInput = input;
        return Effect.void;
      },
    });

    yield* provider.createChangeRequest({
      cwd: "/repo",
      baseRefName: "main",
      headSelector: "owner:feature/provider",
      title: "Provider PR",
      bodyFile: "/tmp/body.md",
    });

    assert.deepStrictEqual(createInput, {
      cwd: "/repo",
      baseBranch: "main",
      headSelector: "owner:feature/provider",
      title: "Provider PR",
      bodyFile: "/tmp/body.md",
    });
  }),
);

it.effect("listIssues returns summaries with provider: github", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      listIssues: () =>
        Effect.succeed([
          {
            number: 42,
            title: "Bug report",
            url: "https://github.com/owner/repo/issues/42",
            state: "open" as const,
            author: "alice",
            updatedAt: Option.some("2026-01-02T00:00:00.000Z"),
            labels: [{ name: "bug" }],
            assignees: [],
            commentsCount: 0,
          },
        ]),
    });

    const issues = yield* provider.listIssues({ cwd: "/repo", state: "open" });

    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0]?.provider, "github");
    assert.strictEqual(issues[0]?.number, 42);
    assert.strictEqual(issues[0]?.title, "Bug report");
    assert.strictEqual(issues[0]?.state, "open");
    assert.strictEqual(issues[0]?.author, "alice");
    assert.deepStrictEqual(
      issues[0]?.updatedAt,
      Option.some(DateTime.fromDateUnsafe(new Date("2026-01-02T00:00:00.000Z"))),
    );
  }),
);

it.effect("getIssue returns truncated details when body exceeds 8 KB", () =>
  Effect.gen(function* () {
    const bigBody = "x".repeat(SOURCE_CONTROL_DETAIL_BODY_MAX_BYTES + 100);
    const provider = yield* makeProvider({
      getIssue: () =>
        Effect.succeed({
          number: 7,
          title: "Large issue",
          url: "https://github.com/owner/repo/issues/7",
          state: "open" as const,
          author: "bob",
          updatedAt: Option.none(),
          labels: [],
          assignees: [],
          commentsCount: 0,
          body: bigBody,
          comments: [],
        }),
    });

    const detail = yield* provider.getIssue({ cwd: "/repo", reference: "7" });

    assert.strictEqual(detail.truncated, true);
    assert.strictEqual(detail.provider, "github");
    assert.ok(Buffer.byteLength(detail.body, "utf8") <= SOURCE_CONTROL_DETAIL_BODY_MAX_BYTES);
  }),
);

it.effect("getIssue classifies author and repository participant comment roles", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getIssue: () =>
        Effect.succeed({
          number: 7,
          title: "Role issue",
          url: "https://github.com/owner/repo/issues/7",
          state: "open" as const,
          author: "owner",
          updatedAt: Option.none(),
          labels: [],
          assignees: [],
          commentsCount: 4,
          body: "Body",
          comments: [
            {
              author: "owner",
              body: "I opened this and own the repo.",
              createdAt: "2026-03-01T10:00:00Z",
              authorAssociation: "OWNER",
            },
            {
              author: "maintainer",
              body: "I can help.",
              createdAt: "2026-03-01T11:00:00Z",
              authorAssociation: "COLLABORATOR",
            },
            {
              author: "bob",
              body: "Ordinary comment.",
              createdAt: "2026-03-01T12:00:00Z",
              authorAssociation: "NONE",
            },
          ],
        }),
    });

    const detail = yield* provider.getIssue({ cwd: "/repo", reference: "7", fullContent: true });

    assert.deepStrictEqual(
      detail.comments.map((comment) => comment.authorRole),
      [
        {
          primary: "author",
          isOriginalAuthor: true,
          isRepositoryOwner: true,
          isRepositoryMaintainer: false,
        },
        {
          primary: "maintainer",
          isOriginalAuthor: false,
          isRepositoryOwner: false,
          isRepositoryMaintainer: true,
        },
        {
          primary: "participant",
          isOriginalAuthor: false,
          isRepositoryOwner: false,
          isRepositoryMaintainer: false,
        },
      ],
    );
  }),
);

it.effect("searchIssues passes query through to cli.searchIssues", () =>
  Effect.gen(function* () {
    let capturedQuery: string | undefined;
    const provider = yield* makeProvider({
      searchIssues: (input) => {
        capturedQuery = input.query;
        return Effect.succeed([]);
      },
    });

    yield* provider.searchIssues({ cwd: "/repo", query: "memory leak" });

    assert.strictEqual(capturedQuery, "memory leak");
  }),
);

it.effect("searchChangeRequests passes query through to cli.searchPullRequests", () =>
  Effect.gen(function* () {
    let capturedQuery: string | undefined;
    const provider = yield* makeProvider({
      searchPullRequests: (input) => {
        capturedQuery = input.query;
        return Effect.succeed([]);
      },
    });

    yield* provider.searchChangeRequests({ cwd: "/repo", query: "fix memory" });

    assert.strictEqual(capturedQuery, "fix memory");
  }),
);

it.effect("rerunWorkflow delegates failed-jobs reruns to GitHub Actions", () =>
  Effect.gen(function* () {
    let capturedRunId: string | undefined;
    const provider = yield* makeProvider({
      rerunFailedWorkflowJobs: (input) => {
        capturedRunId = input.runId;
        return Effect.void;
      },
    });

    const rerunWorkflow = provider.rerunWorkflow;
    assert.ok(rerunWorkflow);
    const result = yield* rerunWorkflow({
      cwd: "/repo",
      runId: "123",
      target: "failed-jobs",
    });

    assert.strictEqual(capturedRunId, "123");
    assert.deepStrictEqual(result, {
      provider: "github",
      runId: "123",
      target: "failed-jobs",
    });
  }),
);

it.effect("rerunWorkflow delegates job reruns to GitHub Actions", () =>
  Effect.gen(function* () {
    let capturedJobId: string | undefined;
    const provider = yield* makeProvider({
      rerunWorkflowJob: (input) => {
        capturedJobId = input.jobId;
        return Effect.void;
      },
    });

    const rerunWorkflow = provider.rerunWorkflow;
    assert.ok(rerunWorkflow);
    const result = yield* rerunWorkflow({
      cwd: "/repo",
      runId: "123",
      target: "job",
      jobId: "456",
    });

    assert.strictEqual(capturedJobId, "456");
    assert.deepStrictEqual(result, {
      provider: "github",
      runId: "123",
      target: "job",
      jobId: "456",
    });
  }),
);

it.effect("getChangeRequestDetail returns body and comments", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getPullRequestDetail: () =>
        Effect.succeed({
          number: 99,
          title: "Add feature",
          url: "https://github.com/owner/repo/pull/99",
          baseRefName: "main",
          headRefName: "feature/add",
          state: "open" as const,
          isCrossRepository: false,
          author: null,
          assignees: [],
          labels: [],
          commentsCount: 1,
          body: "PR body text",
          comments: [
            { author: "reviewer", body: "Looks good!", createdAt: "2026-03-01T10:00:00Z" },
          ],
          linkedIssueNumbers: [],
          reviewers: [],
          commits: [],
          additions: 0,
          deletions: 0,
          changedFiles: 0,
          files: [],
        }),
    });

    const detail = yield* provider.getChangeRequestDetail({ cwd: "/repo", reference: "99" });

    assert.strictEqual(detail.provider, "github");
    assert.strictEqual(detail.number, 99);
    assert.strictEqual(detail.body, "PR body text");
    assert.strictEqual(detail.comments.length, 1);
    assert.strictEqual(detail.comments[0]?.author, "reviewer");
    assert.strictEqual(detail.comments[0]?.body, "Looks good!");
    assert.strictEqual(detail.truncated, false);
  }),
);

it.effect("enriches pull request lists with stack summaries", () =>
  Effect.gen(function* () {
    let summaryInput:
      | Parameters<GitHubCli.GitHubCliShape["getPullRequestStackSummaries"]>[0]
      | null = null;
    const provider = yield* makeProvider({
      listOpenPullRequests: () => Effect.succeed([githubPullRequestDetail]),
      getPullRequestStackSummaries: (input) => {
        summaryInput = input;
        return Effect.succeed(
          new Map([[42, { number: 7, size: 3, position: 2, baseRefName: "main" }]]),
        );
      },
    });

    const items = yield* provider.listChangeRequests({
      cwd: "/repo",
      state: "open",
      headSelector: "feature/42",
    });

    assert.deepStrictEqual(summaryInput, {
      cwd: "/repo",
      host: "github.com",
      repository: "owner/repo",
      numbers: [42],
    });
    assert.deepStrictEqual(items[0]?.stackSummary, {
      number: 7,
      size: 3,
      position: 2,
      baseRefName: "main",
    });
  }),
);

for (const state of ["open", "all"] as const) {
  it.effect(`skips stack summary calls for lightweight ${state} branch lookups`, () =>
    Effect.gen(function* () {
      let summaryCalls = 0;
      const provider = yield* makeProvider({
        listOpenPullRequests: () => Effect.succeed([githubPullRequestDetail]),
        execute: () =>
          Effect.succeed(
            processResult(
              JSON.stringify([
                {
                  number: 42,
                  title: "Middle",
                  url: "https://github.com/owner/repo/pull/42",
                  baseRefName: "feature/41",
                  headRefName: "feature/42",
                  state: "open",
                  updatedAt: "2026-01-02T00:00:00.000Z",
                },
              ]),
            ),
          ),
        getPullRequestStackSummaries: () => {
          summaryCalls += 1;
          return Effect.succeed(new Map());
        },
      });
      const items = yield* provider.listChangeRequests({
        cwd: "/repo",
        state,
        headSelector: "feature/42",
        includeStackSummary: false,
      });
      assert.equal(items[0]?.number, 42);
      assert.equal(items[0]?.stackSummary, undefined);
      assert.equal(summaryCalls, 0);
    }),
  );
}

it.effect("preserves pull request list and search results when stack enrichment fails", () =>
  Effect.gen(function* () {
    const enrichmentFailure = () =>
      Effect.fail(
        new GitHubCli.GitHubCliError({
          operation: "getPullRequestStackSummaries",
          detail: "preview unavailable",
        }),
      );
    const provider = yield* makeProvider({
      listOpenPullRequests: () => Effect.succeed([githubPullRequestDetail]),
      searchPullRequests: () => Effect.succeed([githubPullRequestDetail]),
      getPullRequestStackSummaries: enrichmentFailure,
    });

    const listed = yield* provider.listChangeRequests({
      cwd: "/repo",
      state: "open",
      headSelector: "feature/42",
    });
    const searched = yield* provider.searchChangeRequests({ cwd: "/repo", query: "Middle" });

    assert.equal(listed[0]?.number, 42);
    assert.equal(listed[0]?.stackSummary, undefined);
    assert.equal(searched[0]?.number, 42);
    assert.equal(searched[0]?.stackSummary, undefined);
  }),
);

it.effect("loads full stack and merge capabilities into pull request detail", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getPullRequestDetail: () => Effect.succeed(githubPullRequestDetail),
      getPullRequestStack: () => Effect.succeed(stack),
      getRepositoryMergeCapabilities: () =>
        Effect.succeed({ merge: true, squash: true, rebase: false }),
    });

    const detail = yield* provider.getChangeRequestDetail({ cwd: "/repo", reference: "42" });
    assert.deepStrictEqual(detail.stack, stack);
    assert.equal(detail.stackMetadataIncomplete, false);
    assert.deepStrictEqual(detail.mergeCapabilities, {
      merge: true,
      squash: true,
      rebase: false,
    });
  }),
);

it.effect("keeps core detail readable when stack metadata lookup fails", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getPullRequestDetail: () => Effect.succeed(githubPullRequestDetail),
      getPullRequestStack: () =>
        Effect.fail(
          new GitHubCli.GitHubCliError({
            operation: "getPullRequestStack",
            detail: "preview permission denied",
          }),
        ),
      getRepositoryMergeCapabilities: () =>
        Effect.succeed({ merge: true, squash: false, rebase: false }),
    });

    const detail = yield* provider.getChangeRequestDetail({ cwd: "/repo", reference: "42" });
    assert.equal(detail.number, 42);
    assert.equal(detail.stack, undefined);
    assert.equal(detail.stackMetadataIncomplete, true);
    assert.deepStrictEqual(detail.mergeCapabilities, {
      merge: true,
      squash: false,
      rebase: false,
    });
  }),
);

const rollupItem = (
  kind: "check-run" | "status-context",
  name: string,
  url: string,
): GitHubPullRequests.NormalizedGitHubCheckRollupItem => ({
  kind,
  name,
  status: Option.some("COMPLETED"),
  conclusion: Option.some("FAILURE"),
  url: Option.some(url),
  startedAt: Option.none(),
  completedAt: Option.none(),
});

const detailWithChecks = {
  ...githubPullRequestDetail,
  headSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  checkRollup: [
    rollupItem("check-run", "Typecheck", "https://github.com/owner/repo/actions/runs/1/job/11"),
    rollupItem("check-run", "Bundle", "https://github.com/owner/repo/actions/runs/1/job/12"),
    rollupItem("status-context", "deploy/preview", "https://deploy.example.com/42"),
  ],
} satisfies GitHubCli.GitHubPullRequestDetail;

it.effect("marks the detail's required checks on the head commit", () =>
  Effect.gen(function* () {
    let requiredInput:
      | Parameters<GitHubCli.GitHubCliShape["getPullRequestRequiredChecks"]>[0]
      | null = null;
    const provider = yield* makeProvider({
      getPullRequestDetail: () => Effect.succeed(detailWithChecks),
      getPullRequestRequiredChecks: (input) => {
        requiredInput = input;
        return Effect.succeed([
          {
            kind: "check-run",
            name: "Typecheck",
            url: "https://github.com/owner/repo/actions/runs/1/job/11",
            isRequired: true,
          },
          {
            kind: "check-run",
            name: "Bundle",
            url: "https://github.com/owner/repo/actions/runs/1/job/12",
            isRequired: false,
          },
        ]);
      },
    });

    const detail = yield* provider.getChangeRequestDetail({ cwd: "/repo", reference: "42" });
    assert.deepStrictEqual(requiredInput, {
      cwd: "/repo",
      host: "github.com",
      repository: "owner/repo",
      number: 42,
      headSha: detailWithChecks.headSha,
    });
    assert.deepStrictEqual(
      detail.checkRollup?.map((item) => [item.name, item.isRequired]),
      [
        ["Typecheck", true],
        ["Bundle", false],
        // Not in the lookup: unknown, not optional.
        ["deploy/preview", undefined],
      ],
    );
  }),
);

it.effect("leaves checks unmarked when the required-checks lookup fails", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getPullRequestDetail: () => Effect.succeed(detailWithChecks),
    });
    const detail = yield* provider.getChangeRequestDetail({ cwd: "/repo", reference: "42" });
    assert.equal(detail.checkRollup?.length, 3);
    assert.isTrue(detail.checkRollup?.every((item) => item.isRequired === undefined));
  }),
);

it.effect("skips the required-checks lookup without checks or a head", () =>
  Effect.gen(function* () {
    let lookups = 0;
    const { headSha: _headSha, ...detailWithoutHead } = detailWithChecks;
    const provider = yield* makeProvider({
      getPullRequestDetail: (input) =>
        Effect.succeed(
          input.reference === "42"
            ? { ...githubPullRequestDetail, headSha: "a1b2c3d4e5f6" }
            : detailWithoutHead,
        ),
      getPullRequestRequiredChecks: () => {
        lookups += 1;
        return Effect.succeed([]);
      },
    });
    yield* provider.getChangeRequestDetail({ cwd: "/repo", reference: "42" });
    yield* provider.getChangeRequestDetail({ cwd: "/repo", reference: "43" });
    assert.equal(lookups, 0);
  }),
);

it.effect("revalidates stack membership and allowed method before merging", () =>
  Effect.gen(function* () {
    let asyncInput: Parameters<GitHubCli.GitHubCliShape["mergePullRequestAsync"]>[0] | null = null;
    let stackLookups = 0;
    const provider = yield* makeProvider({
      getPullRequest: () => Effect.succeed(githubPullRequestDetail),
      getPullRequestStack: () => {
        stackLookups += 1;
        return Effect.succeed(stack);
      },
      getRepositoryMergeCapabilities: () =>
        Effect.succeed({ merge: false, squash: true, rebase: false }),
      mergePullRequestAsync: (input) => {
        asyncInput = input;
        return Effect.succeed({ outcome: "enqueued" });
      },
    });
    const merge = provider.mergeChangeRequest;
    assert.ok(merge);
    const result = yield* merge({ cwd: "/repo", reference: "42", mergeMethod: "squash" });
    assert.equal(result.outcome, "enqueued");
    assert.equal(stackLookups, 1);
    assert.deepStrictEqual(asyncInput, {
      cwd: "/repo",
      host: "github.com",
      repository: "owner/repo",
      number: 42,
      mergeMethod: "squash",
      stackMembership: "stacked",
    });

    const unsupported = yield* merge({ cwd: "/repo", reference: "42", mergeMethod: "rebase" }).pipe(
      Effect.flip,
    );
    assert.include(unsupported.detail, "disabled");
  }),
);

it.effect("getChangeRequestDetail classifies PR conversation and review comment roles", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getPullRequestDetail: () =>
        Effect.succeed({
          number: 99,
          title: "Add feature",
          url: "https://github.com/owner/repo/pull/99",
          baseRefName: "main",
          headRefName: "feature/add",
          state: "open" as const,
          isCrossRepository: false,
          author: "alice",
          assignees: [],
          labels: [],
          commentsCount: 2,
          body: "PR body text",
          comments: [
            {
              author: "alice",
              body: "Author follow-up",
              createdAt: "2026-03-01T10:00:00Z",
              authorAssociation: "CONTRIBUTOR",
            },
            {
              author: "reviewer",
              body: "Review summary",
              createdAt: "2026-03-01T11:00:00Z",
              authorAssociation: "MEMBER",
              reviewState: "approved",
            },
          ],
          linkedIssueNumbers: [],
          reviewers: [],
          commits: [],
          additions: 0,
          deletions: 0,
          changedFiles: 0,
          files: [],
        }),
    });

    const detail = yield* provider.getChangeRequestDetail({
      cwd: "/repo",
      reference: "99",
      fullContent: true,
    });

    assert.deepStrictEqual(
      detail.comments.map((comment) => comment.authorRole),
      [
        {
          primary: "author",
          isOriginalAuthor: true,
          isRepositoryOwner: false,
          isRepositoryMaintainer: false,
        },
        {
          primary: "maintainer",
          isOriginalAuthor: false,
          isRepositoryOwner: false,
          isRepositoryMaintainer: true,
        },
      ],
    );
    assert.strictEqual(detail.comments[1]?.reviewState, "approved");
  }),
);

it.effect("createIssue writes body to temp file and returns issue summary", () =>
  Effect.gen(function* () {
    let capturedCwd: string | null = null;
    let capturedTitle: string | null = null;
    let capturedBodyFile: string | null = null;
    let capturedLabels: ReadonlyArray<string> | null = null;
    let capturedAssignees: ReadonlyArray<string> | null = null;
    let capturedGetIssueRef: string | null = null;

    const provider = yield* makeProvider({
      createIssue: (input) => {
        capturedCwd = input.cwd;
        capturedTitle = input.title;
        capturedBodyFile = input.bodyFile;
        capturedLabels = input.labels ?? null;
        capturedAssignees = input.assignees ?? null;
        return Effect.succeed({ url: "https://github.com/owner/repo/issues/55", number: 55 });
      },
      getIssue: (input) => {
        capturedGetIssueRef = input.reference;
        return Effect.succeed({
          number: 55,
          title: "New bug",
          url: "https://github.com/owner/repo/issues/55",
          state: "open" as const,
          author: "carol",
          updatedAt: Option.none(),
          labels: [{ name: "bug" }],
          assignees: ["dave"],
          commentsCount: 0,
          body: "Bug description",
          comments: [],
        });
      },
    });

    const summary = yield* provider.createIssue({
      cwd: "/repo",
      title: "New bug",
      body: "Bug description",
      labels: ["bug"],
      assignees: ["dave"],
    });

    assert.strictEqual(capturedCwd, "/repo");
    assert.strictEqual(capturedTitle, "New bug");
    assert.ok(capturedBodyFile !== null && capturedBodyFile !== "");
    assert.deepStrictEqual(capturedLabels, ["bug"]);
    assert.deepStrictEqual(capturedAssignees, ["dave"]);
    assert.strictEqual(capturedGetIssueRef, "55");
    assert.strictEqual(summary.provider, "github");
    assert.strictEqual(summary.number, 55);
    assert.strictEqual(summary.title, "New bug");
  }),
);

it.effect("createIssue maps GitHubCliError to SourceControlProviderError", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      createIssue: () =>
        Effect.fail(
          new GitHubCli.GitHubCliError({
            operation: "createIssue",
            detail: "gh: unauthorized",
          }),
        ),
    });

    const result = yield* provider
      .createIssue({ cwd: "/repo", title: "Bug", body: "desc" })
      .pipe(Effect.flip);

    assert.strictEqual(result.operation, "createIssue");
    assert.strictEqual(result.provider, "github");
    assert.ok(result.detail.includes("gh: unauthorized"));
  }),
);

it.effect("addIssueComment posts through gh and returns refreshed detail", () =>
  Effect.gen(function* () {
    const capturedAddInputs: Parameters<GitHubCli.GitHubCliShape["addIssueComment"]>[0][] = [];
    let getCalls = 0;
    const marker = mutationMarker("mutation-1");

    const provider = yield* makeProvider({
      getIssue: () => {
        getCalls += 1;
        return Effect.succeed({
          number: 55,
          title: "Bug",
          url: "https://github.com/owner/repo/issues/55",
          state: "open" as const,
          author: "carol",
          updatedAt: Option.none(),
          labels: [],
          assignees: [],
          commentsCount: getCalls > 1 ? 1 : 0,
          body: "Bug description",
          comments:
            getCalls > 1
              ? [
                  {
                    author: "dave",
                    body: `Thanks\n\n${marker}`,
                    createdAt: "2026-03-14T10:00:00Z",
                  },
                ]
              : [],
        });
      },
      addIssueComment: (input) => {
        capturedAddInputs.push(input);
        return Effect.void;
      },
    });

    const detail = yield* provider.addIssueComment({
      cwd: "/repo",
      reference: "55",
      body: "Thanks",
      clientMutationId: "mutation-1",
    });

    assert.strictEqual(capturedAddInputs[0]?.cwd, "/repo");
    assert.strictEqual(capturedAddInputs[0]?.reference, "55");
    assert.ok(capturedAddInputs[0]?.bodyFile);
    assert.strictEqual(getCalls, 2);
    assert.strictEqual(detail.comments[0]?.body, "Thanks");
  }),
);

it.effect("addIssueCommentReaction posts through gh and returns refreshed detail", () =>
  Effect.gen(function* () {
    const capturedReactionInputs: Parameters<GitHubCli.GitHubCliShape["addReaction"]>[0][] = [];
    const provider = yield* makeProvider({
      getIssue: () =>
        Effect.succeed({
          number: 55,
          title: "Bug",
          url: "https://github.com/owner/repo/issues/55",
          state: "open" as const,
          author: "carol",
          updatedAt: Option.none(),
          labels: [],
          assignees: [],
          commentsCount: 1,
          body: "Bug description",
          comments: [
            {
              id: "IC_kwDOA1B2C84AAAAB",
              author: "dave",
              body: "Thanks",
              createdAt: "2026-03-14T10:00:00Z",
              reactions: [{ content: "heart", count: 1, viewerHasReacted: true }],
            },
          ],
        }),
      getCommentReactionGroups: () =>
        Effect.succeed([
          {
            id: "IC_kwDOA1B2C84AAAAB",
            reactions: [{ content: "heart", count: 0, viewerHasReacted: false }],
          },
        ]),
      addReaction: (input) => {
        capturedReactionInputs.push(input);
        return Effect.void;
      },
    });

    const detail = yield* provider.addIssueCommentReaction({
      cwd: "/repo",
      reference: "55",
      commentId: "IC_kwDOA1B2C84AAAAB",
      content: "heart",
    });

    assert.deepStrictEqual(capturedReactionInputs, [
      {
        cwd: "/repo",
        subjectId: "IC_kwDOA1B2C84AAAAB",
        content: "heart",
      },
    ]);
    assert.deepStrictEqual(detail.comments[0]?.reactions, [
      { content: "heart", count: 1, viewerHasReacted: true },
    ]);
  }),
);

it.effect("addIssueCommentReaction removes an existing viewer reaction", () =>
  Effect.gen(function* () {
    const capturedRemoveInputs: Parameters<GitHubCli.GitHubCliShape["removeReaction"]>[0][] = [];
    const provider = yield* makeProvider({
      getCommentReactionGroups: () =>
        Effect.succeed([
          {
            id: "IC_kwDOA1B2C84AAAAB",
            reactions: [{ content: "heart", count: 1, viewerHasReacted: true }],
          },
        ]),
      removeReaction: (input) => {
        capturedRemoveInputs.push(input);
        return Effect.void;
      },
      getIssue: () =>
        Effect.succeed({
          number: 55,
          title: "Bug",
          url: "https://github.com/owner/repo/issues/55",
          state: "open" as const,
          author: "carol",
          updatedAt: Option.none(),
          labels: [],
          assignees: [],
          commentsCount: 1,
          body: "Bug description",
          comments: [
            {
              id: "IC_kwDOA1B2C84AAAAB",
              author: "dave",
              body: "Thanks",
              createdAt: "2026-03-14T10:00:00Z",
              reactions: [],
            },
          ],
        }),
    });

    const detail = yield* provider.addIssueCommentReaction({
      cwd: "/repo",
      reference: "55",
      commentId: "IC_kwDOA1B2C84AAAAB",
      content: "heart",
    });

    assert.deepStrictEqual(capturedRemoveInputs, [
      {
        cwd: "/repo",
        subjectId: "IC_kwDOA1B2C84AAAAB",
        content: "heart",
      },
    ]);
    assert.strictEqual(detail.comments[0]?.reactions, undefined);
  }),
);

it.effect("addChangeRequestComment dedupes an already-posted client mutation", () =>
  Effect.gen(function* () {
    let addCalled = false;
    const marker = mutationMarker("mutation-1");
    const provider = yield* makeProvider({
      getPullRequestDetail: () =>
        Effect.succeed({
          number: 7,
          title: "PR",
          url: "https://github.com/owner/repo/pull/7",
          baseRefName: "main",
          headRefName: "feature/pr",
          state: "open",
          author: "alice",
          assignees: [],
          labels: [],
          commentsCount: 1,
          body: "PR description",
          comments: [
            {
              author: "bob",
              body: `Already posted\n\n${marker}`,
              createdAt: "2026-03-14T10:00:00Z",
            },
          ],
          linkedIssueNumbers: [],
          reviewers: [],
          commits: [],
          additions: 0,
          deletions: 0,
          changedFiles: 0,
          files: [],
        }),
      addPullRequestComment: () => {
        addCalled = true;
        return Effect.void;
      },
    });

    const detail = yield* provider.addChangeRequestComment({
      cwd: "/repo",
      reference: "7",
      body: "Already posted",
      clientMutationId: "mutation-1",
    });

    assert.strictEqual(addCalled, false);
    assert.strictEqual(detail.comments[0]?.body, "Already posted");
  }),
);

it.effect("addChangeRequestCommentReaction posts through gh and returns refreshed detail", () =>
  Effect.gen(function* () {
    const capturedReactionInputs: Parameters<GitHubCli.GitHubCliShape["addReaction"]>[0][] = [];
    const provider = yield* makeProvider({
      getPullRequestDetail: () =>
        Effect.succeed({
          number: 7,
          title: "PR",
          url: "https://github.com/owner/repo/pull/7",
          baseRefName: "main",
          headRefName: "feature/pr",
          state: "open" as const,
          author: "alice",
          assignees: [],
          labels: [],
          commentsCount: 1,
          body: "PR description",
          comments: [
            {
              id: "PRRC_kwDOA1B2C84AAAAC",
              author: "bob",
              body: "Looks good",
              createdAt: "2026-03-14T10:00:00Z",
              reactions: [{ content: "thumbs-up", count: 3, viewerHasReacted: true }],
            },
          ],
          linkedIssueNumbers: [],
          reviewers: [],
          commits: [],
          additions: 0,
          deletions: 0,
          changedFiles: 0,
          files: [],
        }),
      getCommentReactionGroups: () =>
        Effect.succeed([
          {
            id: "PRRC_kwDOA1B2C84AAAAC",
            reactions: [{ content: "thumbs-up", count: 2, viewerHasReacted: false }],
          },
        ]),
      addReaction: (input) => {
        capturedReactionInputs.push(input);
        return Effect.void;
      },
    });

    const detail = yield* provider.addChangeRequestCommentReaction({
      cwd: "/repo",
      reference: "7",
      commentId: "PRRC_kwDOA1B2C84AAAAC",
      content: "thumbs-up",
    });

    assert.deepStrictEqual(capturedReactionInputs, [
      {
        cwd: "/repo",
        subjectId: "PRRC_kwDOA1B2C84AAAAC",
        content: "thumbs-up",
      },
    ]);
    assert.deepStrictEqual(detail.comments[0]?.reactions, [
      { content: "thumbs-up", count: 3, viewerHasReacted: true },
    ]);
  }),
);

it.effect("addChangeRequestCommentReaction removes an existing viewer reaction", () =>
  Effect.gen(function* () {
    const capturedRemoveInputs: Parameters<GitHubCli.GitHubCliShape["removeReaction"]>[0][] = [];
    const provider = yield* makeProvider({
      getCommentReactionGroups: () =>
        Effect.succeed([
          {
            id: "PRRC_kwDOA1B2C84AAAAC",
            reactions: [{ content: "thumbs-up", count: 2, viewerHasReacted: true }],
          },
        ]),
      removeReaction: (input) => {
        capturedRemoveInputs.push(input);
        return Effect.void;
      },
      getPullRequestDetail: () =>
        Effect.succeed({
          number: 7,
          title: "PR",
          url: "https://github.com/owner/repo/pull/7",
          baseRefName: "main",
          headRefName: "feature/pr",
          state: "open" as const,
          author: "alice",
          assignees: [],
          labels: [],
          commentsCount: 1,
          body: "PR description",
          comments: [
            {
              id: "PRRC_kwDOA1B2C84AAAAC",
              author: "bob",
              body: "Looks good",
              createdAt: "2026-03-14T10:00:00Z",
              reactions: [{ content: "thumbs-up", count: 1, viewerHasReacted: false }],
            },
          ],
          linkedIssueNumbers: [],
          reviewers: [],
          commits: [],
          additions: 0,
          deletions: 0,
          changedFiles: 0,
          files: [],
        }),
    });

    const detail = yield* provider.addChangeRequestCommentReaction({
      cwd: "/repo",
      reference: "7",
      commentId: "PRRC_kwDOA1B2C84AAAAC",
      content: "thumbs-up",
    });

    assert.deepStrictEqual(capturedRemoveInputs, [
      {
        cwd: "/repo",
        subjectId: "PRRC_kwDOA1B2C84AAAAC",
        content: "thumbs-up",
      },
    ]);
    assert.deepStrictEqual(detail.comments[0]?.reactions, [
      { content: "thumbs-up", count: 1, viewerHasReacted: false },
    ]);
  }),
);

it.effect("listWorkflowRuns filters directly by commit SHA", () =>
  Effect.gen(function* () {
    let capturedInput: Parameters<GitHubCli.GitHubCliShape["listWorkflowRuns"]>[0] | null = null;
    const provider = yield* makeProvider({
      listWorkflowRuns: (input) => {
        capturedInput = input;
        return Effect.succeed([
          {
            runId: "123",
            workflowName: "CI",
            branch: "feature/status",
            commit: {
              oid: "abcdef1234567890",
              shortOid: "abcdef123456",
              messageHeadline: "Add status timeline",
            },
            actor: "alice",
            status: "completed",
            conclusion: "success",
            startedAt: "2026-05-20T10:00:00Z",
            updatedAt: "2026-05-20T10:03:00Z",
            url: "https://github.com/owner/repo/actions/runs/123",
            repositoryNameWithOwner: "owner/repo",
          },
        ]);
      },
    });

    const listWorkflowRuns = provider.listWorkflowRuns;
    assert.ok(listWorkflowRuns);
    const result = yield* listWorkflowRuns({
      cwd: "/repo",
      commitSha: "abcdef1234567890",
      limit: 5,
    });

    assert.deepStrictEqual(capturedInput, {
      cwd: "/repo",
      headSha: "abcdef1234567890",
      limit: 5,
    });
    assert.strictEqual(result.runs.length, 1);
    assert.strictEqual(Option.isSome(result.headSha), true);
    assert.strictEqual(Option.getOrNull(result.headSha), "abcdef1234567890");
    assert.strictEqual(Option.isNone(result.pullRequestNumber), true);
  }),
);

it.effect("listWorkflowRuns scopes a branch to its newest commit", () =>
  Effect.gen(function* () {
    let capturedInput: Parameters<GitHubCli.GitHubCliShape["listWorkflowRuns"]>[0] | null = null;
    const makeRun = (runId: string, oid: string, startedAt: string, workflowName: string) => ({
      runId,
      workflowName,
      branch: "main",
      commit: { oid, shortOid: oid.slice(0, 12), messageHeadline: "msg" },
      actor: "alice",
      status: "completed",
      conclusion: "success",
      startedAt,
      updatedAt: startedAt,
      url: `https://github.com/owner/repo/actions/runs/${runId}`,
      repositoryNameWithOwner: "owner/repo",
    });
    const provider = yield* makeProvider({
      listWorkflowRuns: (input) => {
        capturedInput = input;
        // Returned newest-first, spanning two commits on the branch.
        return Effect.succeed([
          makeRun("300", "newsha1111111111", "2026-05-21T10:05:00Z", "Lint"),
          makeRun("301", "newsha1111111111", "2026-05-21T10:00:00Z", "CI"),
          makeRun("299", "oldsha0000000000", "2026-05-20T10:00:00Z", "CI"),
        ]);
      },
    });

    const listWorkflowRuns = provider.listWorkflowRuns;
    assert.ok(listWorkflowRuns);
    const result = yield* listWorkflowRuns({ cwd: "/repo", branch: "main", limit: 20 });

    assert.deepStrictEqual(capturedInput, { cwd: "/repo", branch: "main", limit: 20 });
    // Only the two runs on the newest commit survive.
    assert.strictEqual(result.runs.length, 2);
    assert.strictEqual(Option.getOrNull(result.headSha), "newsha1111111111");
    assert.strictEqual(Option.isNone(result.pullRequestNumber), true);
    assert.deepStrictEqual(
      result.runs.map((run) => run.runId),
      ["300", "301"],
    );
  }),
);

it.effect("listLabels returns labels from cli", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      listLabels: () =>
        Effect.succeed([
          { name: "bug", color: "d73a4a" },
          { name: "enhancement", color: "a2eeef", description: "New feature" },
        ]),
    });

    const labels = yield* provider.listLabels({ cwd: "/repo" });

    assert.strictEqual(labels.length, 2);
    assert.strictEqual(labels[0]?.name, "bug");
    assert.strictEqual(labels[0]?.color, "d73a4a");
    assert.strictEqual(labels[1]?.name, "enhancement");
    assert.strictEqual(labels[1]?.description, "New feature");
  }),
);

it.effect("listLabels maps GitHubCliError to SourceControlProviderError", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      listLabels: () =>
        Effect.fail(
          new GitHubCli.GitHubCliError({
            operation: "listLabels",
            detail: "network error",
          }),
        ),
    });

    const result = yield* provider.listLabels({ cwd: "/repo" }).pipe(Effect.flip);

    assert.strictEqual(result.operation, "listLabels");
    assert.strictEqual(result.provider, "github");
  }),
);

it.effect("listAssignees returns candidates from cli", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      listAssignees: () =>
        Effect.succeed([
          { login: "alice", name: "Alice Smith", avatarUrl: "https://example.com/alice.png" },
          { login: "bob" },
        ]),
    });

    const assignees = yield* provider.listAssignees({ cwd: "/repo" });

    assert.strictEqual(assignees.length, 2);
    assert.strictEqual(assignees[0]?.login, "alice");
    assert.strictEqual(assignees[0]?.displayName, "Alice Smith");
    assert.strictEqual(assignees[0]?.avatarUrl, "https://example.com/alice.png");
    assert.strictEqual(assignees[1]?.login, "bob");
    assert.strictEqual(assignees[1]?.displayName, undefined);
  }),
);

it.effect("listAssignees maps GitHubCliError to SourceControlProviderError", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      listAssignees: () =>
        Effect.fail(
          new GitHubCli.GitHubCliError({
            operation: "listAssignees",
            detail: "api rate limit",
          }),
        ),
    });

    const result = yield* provider.listAssignees({ cwd: "/repo" }).pipe(Effect.flip);

    assert.strictEqual(result.operation, "listAssignees");
    assert.strictEqual(result.provider, "github");
  }),
);

it.effect("lists involvement-scoped pull requests through gh search qualifiers", () =>
  Effect.gen(function* () {
    const calls: Array<ReadonlyArray<string>> = [];
    const provider = yield* makeProvider({
      execute: (input) => {
        calls.push(input.args);
        return Effect.succeed(
          processResult(
            JSON.stringify([
              {
                number: 9,
                title: "Mine",
                url: "https://github.com/owner/repo/pull/9",
                baseRefName: "main",
                headRefName: "feature/9",
                state: "OPEN",
                createdAt: "2026-10-01T10:00:00Z",
                updatedAt: "2026-10-02T10:00:00Z",
                reviewDecision: "CHANGES_REQUESTED",
                additions: 12,
                deletions: 3,
              },
            ]),
          ),
        );
      },
    });
    const items = yield* provider.listChangeRequests({
      cwd: "/repo",
      headSelector: "",
      state: "merged",
      involvement: "review-requested",
      query: "flaky",
      limit: 25,
      includeStackSummary: false,
    });
    assert.deepStrictEqual(calls[0], [
      "pr",
      "list",
      "--search",
      "flaky review-requested:@me",
      "--state",
      "merged",
      "--limit",
      "25",
      "--json",
      prListJsonFields,
    ]);
    assert.equal(items[0]?.reviewDecision, "changes_requested");
    assert.equal(items[0]?.additions, 12);
    assert.equal(items[0]?.deletions, 3);
    assert.equal(items[0]?.createdAt?.toString().includes("2026-10-01T10:00:00"), true);
    assert.equal(Option.isSome(items[0]!.updatedAt), true);
  }),
);

it.effect("enriches detail with reviewer states, merge state, and branch auto-delete", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getPullRequestDetail: () =>
        Effect.succeed({
          ...githubPullRequestDetail,
          reviewerStates: [
            { login: "acme/core", kind: "team" as const, state: "requested" as const },
          ],
          mergeStateStatus: "behind" as const,
          autoMerge: null,
          mergedBy: "carol",
        }),
      getRepositoryMergeCapabilities: () =>
        Effect.succeed({ merge: true, squash: false, rebase: true, deleteBranchOnMerge: true }),
    });
    const detail = yield* provider.getChangeRequestDetail({ cwd: "/repo", reference: "42" });
    assert.deepStrictEqual(detail.reviewerStates, [
      { login: "acme/core", kind: "team", state: "requested" },
    ]);
    assert.equal(detail.mergeStateStatus, "behind");
    assert.equal(detail.autoMerge, null);
    assert.equal(detail.mergedBy, "carol");
    assert.equal(detail.deleteBranchOnMerge, true);
    // The repository flag is reported separately, not leaked into the capability struct.
    assert.deepStrictEqual(detail.mergeCapabilities, { merge: true, squash: false, rebase: true });
  }),
);

it.effect("merges with the expected head and deletes the same-repo head branch", () =>
  Effect.gen(function* () {
    const deleted: Array<string> = [];
    let asyncInput: Parameters<GitHubCli.GitHubCliShape["mergePullRequestAsync"]>[0] | null = null;
    const provider = yield* makeProvider({
      getPullRequest: () => Effect.succeed({ ...githubPullRequestDetail, headSha: "abc" }),
      getRepositoryMergeCapabilities: () =>
        Effect.succeed({ merge: true, squash: true, rebase: true }),
      mergePullRequestAsync: (input) => {
        asyncInput = input;
        return Effect.succeed({ outcome: "merged" as const });
      },
      deleteBranch: (input) => {
        deleted.push(`${input.repository}:${input.branch}`);
        return Effect.void;
      },
    });
    const merge = provider.mergeChangeRequest;
    assert.ok(merge);

    const stale = yield* merge({
      cwd: "/repo",
      reference: "42",
      mergeMethod: "merge",
      expectedHeadSha: "old",
    }).pipe(Effect.flip);
    assert.include(stale.detail, "head changed");
    assert.equal(asyncInput, null);

    yield* merge({
      cwd: "/repo",
      reference: "42",
      mergeMethod: "merge",
      expectedHeadSha: "abc",
      deleteBranch: true,
    });
    assert.equal(asyncInput!.expectedHeadSha, "abc");
    assert.deepStrictEqual(deleted, ["owner/repo:feature/42"]);
  }),
);

it.effect("deletes every landed layer's branch after a stacked merge", () =>
  Effect.gen(function* () {
    const deleted: Array<string> = [];
    const provider = yield* makeProvider({
      getPullRequest: () => Effect.succeed({ ...githubPullRequestDetail, headSha: "abc" }),
      // #42 sits on #41 (open), with #43 above it.
      getPullRequestStack: () => Effect.succeed(stack),
      getRepositoryMergeCapabilities: () =>
        Effect.succeed({ merge: true, squash: true, rebase: true }),
      mergePullRequestAsync: () => Effect.succeed({ outcome: "merged" as const }),
      deleteBranch: (input) => {
        deleted.push(`${input.repository}:${input.branch}`);
        return Effect.void;
      },
    });
    const merge = provider.mergeChangeRequest;
    assert.ok(merge);
    yield* merge({ cwd: "/repo", reference: "42", mergeMethod: "squash", deleteBranch: true });
    // Merging #42 landed #41 with it; #43 is still open on top.
    assert.deepStrictEqual(deleted, ["owner/repo:feature/42", "owner/repo:feature/41"]);
  }),
);

it("names a fork's landed lower layers but never the fork head itself", () => {
  assert.deepStrictEqual(
    GitHubSourceControlProvider.landedHeadBranches({
      pullRequest: { number: 42, headRefName: "main", isCrossRepository: true },
      stack,
    }),
    ["feature/41"],
  );
  assert.deepStrictEqual(
    GitHubSourceControlProvider.landedHeadBranches({
      pullRequest: { number: 42, headRefName: "feature/42" },
      stack: null,
    }),
    ["feature/42"],
  );
});

it.effect("returns a fresh uncapped detail after a lifecycle update", () =>
  Effect.gen(function* () {
    let bodyFileContents: string | null = null;
    const provider = yield* makeProvider({
      updatePullRequest: (input) =>
        Effect.sync(() => {
          assert.equal(input.action.kind, "edit");
          bodyFileContents = input.bodyFile ? fs.readFileSync(input.bodyFile, "utf8") : null;
        }),
      getPullRequestDetail: () =>
        Effect.succeed({ ...githubPullRequestDetail, body: "x".repeat(20_000) }),
    });
    const updateChangeRequest = provider.updateChangeRequest;
    assert.ok(updateChangeRequest);
    const result = yield* updateChangeRequest({
      cwd: "/repo",
      reference: "42",
      action: { kind: "edit", body: "New description" },
    });
    assert.equal(bodyFileContents, "New description");
    assert.equal(result.detail.body.length, 20_000);
    assert.equal(result.detail.truncated, false);
  }),
);
