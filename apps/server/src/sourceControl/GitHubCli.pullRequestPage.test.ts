import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { CHANGE_REQUEST_FILE_CONTENTS_MAX_BYTES, VcsProcessExitError } from "@ryco/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubCli from "./GitHubCli.ts";
import * as GitHubPullRequestActivity from "./gitHubPullRequestActivity.ts";
import * as GitHubPullRequestMutations from "./gitHubPullRequestMutations.ts";

const output = (
  stdout: string,
  options: {
    readonly exitCode?: number;
    readonly stderr?: string;
    readonly truncated?: boolean;
  } = {},
): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(options.exitCode ?? 0),
  stdout,
  stderr: options.stderr ?? "",
  stdoutTruncated: options.truncated ?? false,
  stderrTruncated: false,
});

const mockRun = vi.fn<VcsProcess.VcsProcessShape["run"]>();
const layer = GitHubCli.layer.pipe(
  Layer.provide(Layer.mock(VcsProcess.VcsProcess)({ run: mockRun })),
);
afterEach(() => {
  mockRun.mockReset();
});

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const target = (overrides: Record<string, unknown> = {}) => ({
  id: "PR_7",
  number: 7,
  url: "https://github.example/acme/repo/pull/7",
  state: "OPEN",
  headRefOid: HEAD,
  headRefName: "feature/x",
  baseRefName: "main",
  isCrossRepository: false,
  mergedAt: null,
  ...overrides,
});
const respond = (stdout: string | object, options?: Parameters<typeof output>[1]) =>
  mockRun.mockReturnValueOnce(
    Effect.succeed(output(typeof stdout === "string" ? stdout : JSON.stringify(stdout), options)),
  );
const callArgs = (index: number) => mockRun.mock.calls[index]?.[0].args ?? [];
const callStdin = (index: number) => mockRun.mock.calls[index]?.[0].stdin;
const exitError = (detail: string) =>
  new VcsProcessExitError({
    operation: "GitHubCli.execute",
    command: "gh",
    cwd: "/repo",
    exitCode: 1,
    detail,
  });

describe("GitHub CLI error normalization", () => {
  it("keeps Actions guidance for Actions calls only", () => {
    expect(GitHubCli.gitHubCliErrorDomain(["run", "view", "1"])).toBe("actions");
    expect(
      GitHubCli.gitHubCliErrorDomain(["api", "repos/{owner}/{repo}/actions/runs?per_page=20"]),
    ).toBe("actions");
    expect(GitHubCli.gitHubCliErrorDomain(["pr", "edit", "7"])).toBe("general");

    const actions = GitHubCli.normalizeGitHubCliError(
      "execute",
      exitError("gh: Resource not accessible by integration (HTTP 403)"),
      "actions",
    );
    expect(actions.detail).toContain("GitHub Actions is not accessible");

    const general = GitHubCli.normalizeGitHubCliError(
      "execute",
      exitError("gh: Must have admin rights to Repository. (HTTP 403)"),
      "general",
    );
    expect(general.detail).toContain("GitHub denied permission for this action");
    expect(general.detail).toContain("Must have admin rights to Repository");
    expect(general.detail).not.toContain("Actions");
  });

  it("describes not-found, stale-head, and validation failures accurately", () => {
    const notFound = GitHubCli.normalizeGitHubCliError(
      "execute",
      exitError("GraphQL: Could not resolve to a node with the global id of 'PRRT_x' (node)"),
    );
    expect(notFound.detail).toContain("GitHub could not find what this action refers to");
    expect(notFound.detail).not.toContain("Actions");

    const pr = GitHubCli.normalizeGitHubCliError(
      "execute",
      exitError("GraphQL: Could not resolve to a PullRequest with the number of 4888."),
    );
    expect(pr.detail).toContain("Pull request not found");

    const stale = GitHubCli.normalizeGitHubCliError(
      "execute",
      exitError("gh: Head branch was modified. Review and try the merge again. (HTTP 409)"),
    );
    expect(stale.detail).toContain("head changed since it was loaded");

    const validation = GitHubCli.normalizeGitHubCliError(
      "execute",
      exitError(
        "gh: Validation Failed: pull_request_review_thread.line must be part of the diff (HTTP 422)",
      ),
    );
    expect(validation.detail).toBe(
      "GitHub rejected the request: Validation Failed: pull_request_review_thread.line must be part of the diff (HTTP 422).",
    );
  });

  it("extracts GitHub's message from REST and GraphQL error bodies", () => {
    expect(
      GitHubCli.gitHubApiErrorBodyMessage(
        JSON.stringify({
          message: "Validation Failed",
          errors: [{ resource: "PullRequestReview", code: "custom", message: "line is outside" }],
        }),
      ),
    ).toBe("Validation Failed: line is outside");
    expect(
      GitHubCli.gitHubApiErrorBodyMessage(JSON.stringify({ errors: [{ message: "Bad thread" }] })),
    ).toBe("Bad thread");
    expect(GitHubCli.gitHubApiErrorBodyMessage("plain text")).toBeNull();
  });
});

describe("pull request activity", () => {
  it.effect("resolves the repository from the pull request URL and pages over stdin", () =>
    Effect.gen(function* () {
      respond(target());
      respond({
        data: {
          viewer: { login: "alice" },
          repository: {
            viewerPermission: "WRITE",
            pullRequest: {
              id: "PR_7",
              number: 7,
              state: "OPEN",
              headRefOid: HEAD,
              timelineItems: { pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [] },
              reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
            },
          },
        },
      });
      const gh = yield* GitHubCli.GitHubCli;
      const activity = yield* gh.getPullRequestActivity({ cwd: "/repo", reference: "7" });
      expect(activity).toMatchObject({ provider: "github", number: 7, headSha: HEAD });
      expect(callArgs(0)).toEqual([
        "pr",
        "view",
        "7",
        "--json",
        GitHubCli.GITHUB_PULL_REQUEST_TARGET_JSON_FIELDS,
      ]);
      expect(callArgs(1)).toEqual([
        "api",
        "graphql",
        "--hostname",
        "github.example",
        "--input",
        "-",
      ]);
      expect(JSON.parse(callStdin(1) ?? "{}")).toEqual({
        query: GitHubPullRequestActivity.GITHUB_PULL_REQUEST_ACTIVITY_QUERY,
        variables: { owner: "acme", name: "repo", number: 7 },
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("surfaces the GraphQL error body when gh exits non-zero", () =>
    Effect.gen(function* () {
      respond(target());
      respond(JSON.stringify({ errors: [{ message: "Something went wrong while executing" }] }), {
        exitCode: 1,
        stderr: "gh: Something went wrong while executing",
      });
      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .getPullRequestActivity({ cwd: "/repo", reference: "7" })
        .pipe(Effect.flip);
      expect(error.detail).toContain("Something went wrong while executing");
    }).pipe(Effect.provide(layer)),
  );
});

describe("partial GraphQL responses", () => {
  it.effect("keeps the conversation when only commit check rollups are forbidden", () =>
    Effect.gen(function* () {
      respond(target());
      respond(
        {
          data: {
            viewer: { login: "alice" },
            repository: {
              viewerPermission: "READ",
              pullRequest: {
                id: "PR_7",
                number: 7,
                state: "OPEN",
                headRefOid: HEAD,
                timelineItems: {
                  pageInfo: { hasPreviousPage: false, startCursor: null },
                  nodes: [
                    {
                      __typename: "PullRequestCommit",
                      id: "PURC_1",
                      commit: {
                        oid: HEAD,
                        abbreviatedOid: "0123456",
                        messageHeadline: "Change",
                        committedDate: "2026-10-01T10:00:00Z",
                        statusCheckRollup: null,
                      },
                    },
                  ],
                },
                reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
              },
            },
          },
          errors: [
            {
              type: "FORBIDDEN",
              message: "Resource not accessible by integration",
              path: [
                "repository",
                "pullRequest",
                "timelineItems",
                "nodes",
                0,
                "commit",
                "statusCheckRollup",
              ],
            },
          ],
        },
        { exitCode: 1, stderr: "gh: Resource not accessible by integration" },
      );
      const gh = yield* GitHubCli.GitHubCli;
      const activity = yield* gh.getPullRequestActivity({ cwd: "/repo", reference: "7" });
      expect(activity.timeline.map((item) => item.kind)).toEqual(["commit"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("still fails when other fields are forbidden", () =>
    Effect.gen(function* () {
      respond(target());
      respond(
        {
          data: { viewer: { login: "alice" }, repository: null },
          errors: [{ message: "Resource not accessible by integration", path: ["repository"] }],
        },
        { exitCode: 1, stderr: "gh: Resource not accessible by integration" },
      );
      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .getPullRequestActivity({ cwd: "/repo", reference: "7" })
        .pipe(Effect.flip);
      expect(error.detail).toContain("Resource not accessible by integration");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("never treats a mutation's GraphQL errors as success", () =>
    Effect.gen(function* () {
      respond(target());
      respond({
        data: {
          node: {
            __typename: "PullRequestReviewThread",
            id: "PRRT_1",
            pullRequest: { number: 7, repository: { nameWithOwner: "acme/repo" } },
          },
        },
      });
      respond({ data: null, errors: [{ message: "Could not resolve to a node" }] });
      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .setPullRequestReviewThreadResolved({
          cwd: "/repo",
          reference: "7",
          threadId: "PRRT_1",
          resolved: false,
        })
        .pipe(Effect.flip);
      expect(error.detail).toContain("Could not resolve to a node");
    }).pipe(Effect.provide(layer)),
  );
});

describe("review threads", () => {
  const marker = `<!-- ryco-comment-id:${createHash("sha256").update("reply-1").digest("hex")} -->`;
  const threadResponse = (bodies: ReadonlyArray<string>, number = 7) => ({
    data: {
      node: {
        __typename: "PullRequestReviewThread",
        pullRequest: { number, repository: { nameWithOwner: "acme/repo" } },
        id: "PRRT_1",
        path: "src/a.ts",
        line: 3,
        diffSide: "RIGHT",
        subjectType: "LINE",
        isResolved: false,
        isOutdated: false,
        viewerCanReply: true,
        viewerCanResolve: true,
        viewerCanUnresolve: false,
        comments: {
          totalCount: bodies.length,
          nodes: bodies.map((body, index) => ({
            id: `PRRC_${index}`,
            author: { login: "bob" },
            body,
            createdAt: "2026-10-01T10:00:00Z",
          })),
        },
      },
    },
  });

  it.effect("skips a reply that a retried request already posted", () =>
    Effect.gen(function* () {
      respond(target());
      respond(threadResponse(["first", `again\n\n${marker}`]));
      const gh = yield* GitHubCli.GitHubCli;
      const thread = yield* gh.replyToPullRequestReviewThread({
        cwd: "/repo",
        reference: "7",
        threadId: "PRRT_1",
        body: "again",
        clientMutationId: "reply-1",
      });
      expect(thread.comments.map((comment) => comment.body)).toEqual(["first", "again"]);
      expect(mockRun).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("posts the reply over stdin with its idempotency marker, then re-reads", () =>
    Effect.gen(function* () {
      respond(target());
      respond(threadResponse(["first"]));
      respond({ data: { addPullRequestReviewThreadReply: { comment: { id: "PRRC_new" } } } });
      respond(threadResponse(["first", `thanks\n\n${marker}`]));
      const gh = yield* GitHubCli.GitHubCli;
      const thread = yield* gh.replyToPullRequestReviewThread({
        cwd: "/repo",
        reference: "7",
        threadId: "PRRT_1",
        body: "thanks",
        clientMutationId: "reply-1",
      });
      expect(thread.comments).toHaveLength(2);
      const request = JSON.parse(callStdin(2) ?? "{}");
      expect(request.query).toBe(GitHubPullRequestMutations.GITHUB_REVIEW_THREAD_REPLY_MUTATION);
      expect(request.variables).toEqual({ threadId: "PRRT_1", body: `thanks\n\n${marker}` });
      expect(callArgs(2).join(" ")).not.toContain("thanks");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses threads that belong to another pull request", () =>
    Effect.gen(function* () {
      respond(target());
      respond(threadResponse(["first"], 8));
      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .replyToPullRequestReviewThread({
          cwd: "/repo",
          reference: "7",
          threadId: "PRRT_1",
          body: "hi",
        })
        .pipe(Effect.flip);
      expect(error.detail).toContain("does not belong to pull request #7");
      expect(mockRun).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("resolves a thread after checking its scope", () =>
    Effect.gen(function* () {
      respond(target());
      respond({
        data: {
          node: {
            __typename: "PullRequestReviewThread",
            id: "PRRT_1",
            pullRequest: { number: 7, repository: { nameWithOwner: "acme/repo" } },
          },
        },
      });
      respond({
        data: {
          resolveReviewThread: {
            thread: { id: "PRRT_1", isResolved: true, resolvedBy: { login: "alice" } },
          },
        },
      });
      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.setPullRequestReviewThreadResolved({
        cwd: "/repo",
        reference: "7",
        threadId: "PRRT_1",
        resolved: true,
      });
      expect(result).toEqual({ threadId: "PRRT_1", isResolved: true, resolvedBy: "alice" });
      expect(JSON.parse(callStdin(2) ?? "{}").query).toBe(
        GitHubPullRequestMutations.GITHUB_RESOLVE_REVIEW_THREAD_MUTATION,
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects editing a node of the wrong kind", () =>
    Effect.gen(function* () {
      respond(target());
      respond({
        data: {
          node: {
            __typename: "IssueComment",
            id: "IC_1",
            pullRequest: { number: 7, repository: { nameWithOwner: "acme/repo" } },
          },
        },
      });
      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .updatePullRequestComment({
          cwd: "/repo",
          reference: "7",
          commentId: "IC_1",
          commentKind: "review-comment",
          action: "delete",
        })
        .pipe(Effect.flip);
      expect(error.detail).toContain("was not found");
      expect(mockRun).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(layer)),
  );
});

describe("submitPullRequestReview", () => {
  const reviewInput = {
    cwd: "/repo",
    reference: "7",
    event: "comment" as const,
    body: "Summary",
    comments: [{ path: "src/a.ts", body: "inline", line: 4 }],
    expectedHeadSha: HEAD,
  };
  const context = (pendingReviewId: string | null, pendingCommitOid: string = HEAD) => ({
    data: {
      viewer: { login: "alice" },
      repository: {
        pullRequest: {
          id: "PR_7",
          headRefOid: HEAD,
          reviews: {
            nodes: pendingReviewId
              ? [
                  {
                    id: pendingReviewId,
                    author: { login: "alice" },
                    commit: { oid: pendingCommitOid },
                  },
                ]
              : [],
          },
        },
      },
    },
  });

  it.effect("refuses to fold drafts into a pending review started on an older commit", () =>
    Effect.gen(function* () {
      respond(target());
      respond(context("PRR_pending", "ffffffffffffffffffffffffffffffffffffffff"));
      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh.submitPullRequestReview(reviewInput).pipe(Effect.flip);
      expect(error.detail).toContain(
        "pending review on GitHub that was started on an older commit",
      );
      // Nothing was added to or submitted with the stale pending review.
      expect(mockRun).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses to anchor comments to a head that moved", () =>
    Effect.gen(function* () {
      respond(target({ headRefOid: "ffffffffffffffffffffffffffffffffffffffff" }));
      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh.submitPullRequestReview(reviewInput).pipe(Effect.flip);
      expect(error.detail).toContain("head changed since it was loaded");
      expect(mockRun).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("submits a whole review through REST with the body on stdin", () =>
    Effect.gen(function* () {
      respond(target());
      respond(context(null));
      respond({ node_id: "PRR_new", state: "COMMENTED", html_url: "https://x/review" });
      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.submitPullRequestReview(reviewInput);
      expect(result).toEqual({ reviewId: "PRR_new", state: "commented", url: "https://x/review" });
      expect(callArgs(2)).toEqual([
        "api",
        "--hostname",
        "github.example",
        "--method",
        "POST",
        "repos/acme/repo/pulls/7/reviews",
        "--input",
        "-",
      ]);
      expect(JSON.parse(callStdin(2) ?? "{}")).toEqual({
        commit_id: HEAD,
        event: "COMMENT",
        body: "Summary",
        comments: [{ path: "src/a.ts", body: "inline", line: 4, side: "RIGHT" }],
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("folds drafts into the viewer's existing pending review", () =>
    Effect.gen(function* () {
      respond(target());
      respond(context("PRR_pending"));
      respond({ data: { addPullRequestReviewThread: { thread: { id: "PRRT_new" } } } });
      respond({
        data: {
          submitPullRequestReview: { pullRequestReview: { id: "PRR_pending", state: "COMMENTED" } },
        },
      });
      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.submitPullRequestReview(reviewInput);
      expect(result).toEqual({ reviewId: "PRR_pending", state: "commented" });
      expect(JSON.parse(callStdin(2) ?? "{}").variables).toEqual({
        input: {
          pullRequestReviewId: "PRR_pending",
          path: "src/a.ts",
          body: "inline",
          subjectType: "LINE",
          line: 4,
          side: "RIGHT",
        },
      });
      expect(JSON.parse(callStdin(3) ?? "{}").variables).toEqual({
        reviewId: "PRR_pending",
        event: "COMMENT",
        body: "Summary",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("submits a pending review started on GitHub with no new comments or summary", () =>
    Effect.gen(function* () {
      respond(target());
      respond(context("PRR_pending"));
      respond({
        data: {
          submitPullRequestReview: { pullRequestReview: { id: "PRR_pending", state: "COMMENTED" } },
        },
      });
      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.submitPullRequestReview({
        ...reviewInput,
        body: undefined,
        comments: [],
      });
      expect(result).toEqual({ reviewId: "PRR_pending", state: "commented" });
      expect(JSON.parse(callStdin(2) ?? "{}").variables).toEqual({
        reviewId: "PRR_pending",
        event: "COMMENT",
        body: null,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses an empty comment review when there is no pending review", () =>
    Effect.gen(function* () {
      respond(target());
      respond(context(null));
      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .submitPullRequestReview({ ...reviewInput, body: undefined, comments: [] })
        .pipe(Effect.flip);
      expect(error.detail).toContain("needs a summary or at least one inline comment");
      // Only the target and the review context were read; nothing was posted.
      expect(mockRun).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(layer)),
  );
});

describe("submitPullRequestReview with file-level comments", () => {
  const fileReview = {
    cwd: "/repo",
    reference: "7",
    event: "request_changes" as const,
    body: "Needs work",
    comments: [
      { path: "src/a.ts", body: "whole file", subjectType: "file" as const },
      { path: "src/b.ts", body: "inline", line: 2 },
    ],
    expectedHeadSha: HEAD,
  };
  const noPendingContext = {
    data: {
      viewer: { login: "alice" },
      repository: { pullRequest: { id: "PR_7", headRefOid: HEAD, reviews: { nodes: [] } } },
    },
  };

  it.effect("stages a pending review on the expected head instead of REST", () =>
    Effect.gen(function* () {
      respond(target());
      respond(noPendingContext);
      respond({
        data: { addPullRequestReview: { pullRequestReview: { id: "PRR_new", state: "PENDING" } } },
      });
      respond({ data: { addPullRequestReviewThread: { thread: { id: "PRRT_1" } } } });
      respond({ data: { addPullRequestReviewThread: { thread: { id: "PRRT_2" } } } });
      respond({
        data: {
          submitPullRequestReview: {
            pullRequestReview: { id: "PRR_new", state: "CHANGES_REQUESTED" },
          },
        },
      });
      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.submitPullRequestReview(fileReview);
      expect(result).toEqual({ reviewId: "PRR_new", state: "changes_requested" });
      expect(mockRun).toHaveBeenCalledTimes(6);
      expect(callArgs(2)).toEqual([
        "api",
        "graphql",
        "--hostname",
        "github.example",
        "--input",
        "-",
      ]);
      expect(JSON.parse(callStdin(2) ?? "{}").variables).toEqual({
        pullRequestId: "PR_7",
        commitOID: HEAD,
      });
      expect(JSON.parse(callStdin(3) ?? "{}").variables.input).toEqual({
        pullRequestReviewId: "PRR_new",
        path: "src/a.ts",
        body: "whole file",
        subjectType: "FILE",
      });
      expect(JSON.parse(callStdin(5) ?? "{}").variables).toEqual({
        reviewId: "PRR_new",
        event: "REQUEST_CHANGES",
        body: "Needs work",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("discards the staged review when a draft is rejected", () =>
    Effect.gen(function* () {
      respond(target());
      respond(noPendingContext);
      respond({
        data: { addPullRequestReview: { pullRequestReview: { id: "PRR_new", state: "PENDING" } } },
      });
      respond(JSON.stringify({ errors: [{ message: "Path could not be resolved" }] }), {
        exitCode: 1,
        stderr: "gh: Path could not be resolved",
      });
      respond({ data: { deletePullRequestReview: { pullRequestReview: { id: "PRR_new" } } } });
      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh.submitPullRequestReview(fileReview).pipe(Effect.flip);
      expect(error.detail).toContain("Path could not be resolved");
      expect(mockRun).toHaveBeenCalledTimes(5);
      expect(JSON.parse(callStdin(4) ?? "{}")).toMatchObject({
        query: GitHubPullRequestMutations.GITHUB_DELETE_PENDING_REVIEW_MUTATION,
        variables: { reviewId: "PRR_new" },
      });
    }).pipe(Effect.provide(layer)),
  );
});

describe("updatePullRequest", () => {
  it.effect("runs gh pr subcommands against the resolved repository", () =>
    Effect.gen(function* () {
      respond(target());
      respond("");
      const gh = yield* GitHubCli.GitHubCli;
      yield* gh.updatePullRequest({
        cwd: "/repo",
        reference: "https://github.example/acme/repo/pull/7",
        action: { kind: "close", deleteBranch: true },
      });
      expect(callArgs(1)).toEqual([
        "pr",
        "close",
        "7",
        "--repo",
        "github.example/acme/repo",
        "--delete-branch",
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("updates the branch through GraphQL with the expected head", () =>
    Effect.gen(function* () {
      respond(target());
      respond({
        data: { updatePullRequestBranch: { pullRequest: { id: "PR_7", headRefOid: "x" } } },
      });
      const gh = yield* GitHubCli.GitHubCli;
      yield* gh.updatePullRequest({
        cwd: "/repo",
        reference: "7",
        action: { kind: "update-branch", method: "rebase", expectedHeadSha: HEAD },
      });
      expect(JSON.parse(callStdin(1) ?? "{}").variables).toEqual({
        pullRequestId: "PR_7",
        expectedHeadOid: HEAD,
        updateMethod: "REBASE",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("arms auto-merge only for the head the viewer saw", () =>
    Effect.gen(function* () {
      const gh = yield* GitHubCli.GitHubCli;
      respond(target({ headRefOid: "ffffffffffffffffffffffffffffffffffffffff" }));
      const stale = yield* gh
        .updatePullRequest({
          cwd: "/repo",
          reference: "7",
          action: { kind: "auto-merge", enabled: true, expectedHeadSha: HEAD },
        })
        .pipe(Effect.flip);
      expect(stale.detail).toContain("head changed since it was loaded");
      expect(mockRun).toHaveBeenCalledTimes(1);

      respond(target());
      respond({ data: { enablePullRequestAutoMerge: { pullRequest: { id: "PR_7" } } } });
      yield* gh.updatePullRequest({
        cwd: "/repo",
        reference: "7",
        action: { kind: "auto-merge", enabled: true, mergeMethod: "squash", expectedHeadSha: HEAD },
      });
      const request = JSON.parse(callStdin(2) ?? "{}");
      expect(request.query).toContain("expectedHeadOid: $expectedHeadOid");
      expect(request.variables).toEqual({
        pullRequestId: "PR_7",
        mergeMethod: "SQUASH",
        expectedHeadOid: HEAD,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("only deletes same-repository head branches of finished pull requests", () =>
    Effect.gen(function* () {
      const gh = yield* GitHubCli.GitHubCli;
      respond(target());
      const open = yield* gh
        .updatePullRequest({ cwd: "/repo", reference: "7", action: { kind: "delete-branch" } })
        .pipe(Effect.flip);
      expect(open.detail).toContain("Close or merge");

      respond(target({ state: "MERGED", isCrossRepository: true }));
      const fork = yield* gh
        .updatePullRequest({ cwd: "/repo", reference: "7", action: { kind: "delete-branch" } })
        .pipe(Effect.flip);
      expect(fork.detail).toContain("fork");

      respond(target({ state: "CLOSED", headRefName: "feature/a b" }));
      respond("", { exitCode: 1, stderr: "gh: Reference does not exist (HTTP 422)" });
      yield* gh.updatePullRequest({
        cwd: "/repo",
        reference: "7",
        action: { kind: "delete-branch" },
      });
      expect(callArgs(3)).toContain("repos/acme/repo/git/refs/heads/feature/a%20b");
      expect(callArgs(3)).toContain("DELETE");
    }).pipe(Effect.provide(layer)),
  );
});

describe("getPullRequestFileContents", () => {
  const MERGE_BASE = "fedcba9876543210fedcba9876543210fedcba98";

  it.effect("rejects paths that would escape the contents endpoint", () =>
    Effect.gen(function* () {
      const gh = yield* GitHubCli.GitHubCli;
      for (const [path, previousPath] of [
        ["../../../user", undefined],
        ["src/./a.ts", undefined],
        ["src//a.ts", undefined],
        ["src/a.ts", "../../user/emails"],
      ] as const) {
        const error = yield* gh
          .getPullRequestFileContents({
            cwd: "/repo",
            reference: "7",
            path,
            ...(previousPath ? { previousPath } : {}),
            headSha: HEAD,
          })
          .pipe(Effect.flip);
        expect(error.detail).toContain("Invalid repository file path");
      }
      expect(mockRun).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("resolves the merge base and reads both sides with the raw media type", () =>
    Effect.gen(function* () {
      respond(target());
      respond(`${MERGE_BASE}\n`);
      respond("", { exitCode: 1, stderr: "gh: Not Found (HTTP 404)" });
      respond("export const value = 1;\n");
      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.getPullRequestFileContents({
        cwd: "/repo",
        reference: "7",
        path: "src/new name.ts",
        previousPath: "src/old.ts",
        headSha: HEAD,
      });
      expect(result).toEqual({
        path: "src/new name.ts",
        oldContents: null,
        newContents: "export const value = 1;\n",
        truncated: false,
      });
      expect(callArgs(1)).toContain(`repos/acme/repo/compare/main...${HEAD}?per_page=1`);
      const sides = [callArgs(2), callArgs(3)].map((args) => args.at(-1));
      expect(sides).toContain(`repos/acme/repo/contents/src/old.ts?ref=${MERGE_BASE}`);
      expect(sides).toContain(`repos/acme/repo/contents/src/new%20name.ts?ref=${HEAD}`);
      expect(callArgs(2)).toContain("Accept: application/vnd.github.raw");
      expect(mockRun.mock.calls[2]?.[0].maxOutputBytes).toBe(
        CHANGE_REQUEST_FILE_CONTENTS_MAX_BYTES,
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("diffs merged pull requests against the recorded base tip", () =>
    Effect.gen(function* () {
      const BASE_TIP = "1111111111111111111111111111111111111111";
      respond(target({ state: "MERGED", baseRefOid: BASE_TIP }));
      respond(`${MERGE_BASE}\n`);
      respond("old");
      respond("new");
      const gh = yield* GitHubCli.GitHubCli;
      yield* gh.getPullRequestFileContents({
        cwd: "/repo",
        reference: "7",
        path: "src/a.ts",
        headSha: HEAD,
      });
      expect(callArgs(1)).toContain(`repos/acme/repo/compare/${BASE_TIP}...${HEAD}?per_page=1`);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("treats binary files as absent and flags truncated text", () =>
    Effect.gen(function* () {
      respond(target());
      respond("PNG\u0000\u0001binary");
      respond("a".repeat(16), { truncated: true });
      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.getPullRequestFileContents({
        cwd: "/repo",
        reference: "7",
        path: "asset.bin",
        baseSha: MERGE_BASE,
        headSha: HEAD,
      });
      expect(result).toEqual({
        path: "asset.bin",
        oldContents: null,
        newContents: "a".repeat(16),
        truncated: true,
      });
      // An explicit base skips the merge-base lookup.
      expect(mockRun).toHaveBeenCalledTimes(3);
    }).pipe(Effect.provide(layer)),
  );
});

describe("getPullRequestDiff with commitSha", () => {
  it.effect("only serves commits that belong to the pull request", () =>
    Effect.gen(function* () {
      respond(target());
      respond(`${HEAD}\n`);
      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .getPullRequestDiff({ cwd: "/repo", reference: "7", commitSha: "deadbeefdeadbeef" })
        .pipe(Effect.flip);
      expect(error.detail).toContain("is not part of pull request #7");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads a commit diff by unique prefix with the diff media type", () =>
    Effect.gen(function* () {
      respond(target());
      respond(`${HEAD}\nfedcba9876543210fedcba9876543210fedcba98\n`);
      respond("diff --git a/x b/x\n");
      const gh = yield* GitHubCli.GitHubCli;
      const diff = yield* gh.getPullRequestDiff({
        cwd: "/repo",
        reference: "7",
        commitSha: "0123456",
      });
      expect(diff).toBe("diff --git a/x b/x\n");
      expect(callArgs(1)).toContain("repos/acme/repo/pulls/7/commits?per_page=100");
      expect(callArgs(2)).toEqual([
        "api",
        "--hostname",
        "github.example",
        "-H",
        "Accept: application/vnd.github.diff",
        `repos/acme/repo/commits/${HEAD}`,
      ]);
    }).pipe(Effect.provide(layer)),
  );
});

describe("merge and create options", () => {
  it.effect("pins the async merge to the expected head", () =>
    Effect.gen(function* () {
      respond({ status: "merged", details: {} });
      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.mergePullRequestAsync({
        cwd: "/repo",
        repository: "acme/repo",
        host: "github.example",
        number: 7,
        mergeMethod: "squash",
        stackMembership: "standalone",
        expectedHeadSha: HEAD,
      });
      expect(result).toEqual({ outcome: "merged" });
      expect(JSON.parse(callStdin(0) ?? "{}")).toEqual({
        merge_method: "squash",
        merge_action: "default",
        sha: HEAD,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("passes --match-head-commit to the legacy merge fallback", () =>
    Effect.gen(function* () {
      respond("", { exitCode: 1, stderr: "gh: Not Found (HTTP 404)" });
      respond("");
      const gh = yield* GitHubCli.GitHubCli;
      yield* gh.mergePullRequestAsync({
        cwd: "/repo",
        repository: "acme/repo",
        host: "github.example",
        number: 7,
        mergeMethod: "merge",
        stackMembership: "standalone",
        expectedHeadSha: HEAD,
      });
      expect(callArgs(1)).toEqual([
        "pr",
        "merge",
        "7",
        "--repo",
        "github.example/acme/repo",
        "--merge",
        "--match-head-commit",
        HEAD,
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("opens drafts with --draft", () =>
    Effect.gen(function* () {
      respond("https://github.example/acme/repo/pull/8\n");
      const gh = yield* GitHubCli.GitHubCli;
      yield* gh.createPullRequest({
        cwd: "/repo",
        baseBranch: "main",
        headSelector: "feature/x",
        title: "Title",
        bodyFile: "/tmp/body.md",
        draft: true,
      });
      expect(callArgs(0).at(-1)).toBe("--draft");
    }).pipe(Effect.provide(layer)),
  );
});
