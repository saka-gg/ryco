import { assert, describe, expect, it } from "@effect/vitest";
import { Result } from "effect";
import type { ChangeRequestInvolvement } from "@ryco/contracts";

import * as Mutations from "./gitHubPullRequestMutations.ts";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

describe("buildGitHubReviewSubmissionBody", () => {
  it("builds the REST review body with GitHub sides, ranges, and file comments", () => {
    const result = Mutations.buildGitHubReviewSubmissionBody({
      event: "request_changes",
      body: "Please fix",
      expectedHeadSha: HEAD,
      comments: [
        { path: "src/a.ts", body: "single", line: 4 },
        { path: "src/a.ts", body: "old side", line: 9, side: "left" },
        { path: "src/b.ts", body: "range", line: 12, startLine: 10, side: "right" },
        { path: "src/b.ts", body: "same line", line: 3, startLine: 3 },
        { path: "src/c.ts", body: "whole file", subjectType: "file", line: 99 },
      ],
    });
    assert(Result.isSuccess(result));
    expect(result.success).toEqual({
      commit_id: HEAD,
      event: "REQUEST_CHANGES",
      body: "Please fix",
      comments: [
        { path: "src/a.ts", body: "single", line: 4, side: "RIGHT" },
        { path: "src/a.ts", body: "old side", line: 9, side: "LEFT" },
        {
          path: "src/b.ts",
          body: "range",
          line: 12,
          side: "RIGHT",
          start_line: 10,
          start_side: "RIGHT",
        },
        { path: "src/b.ts", body: "same line", line: 3, side: "RIGHT" },
        { path: "src/c.ts", body: "whole file", subject_type: "file" },
      ],
    });
  });

  it("maps every review event and omits a blank summary", () => {
    for (const [event, expected] of [
      ["comment", "COMMENT"],
      ["approve", "APPROVE"],
      ["request_changes", "REQUEST_CHANGES"],
    ] as const) {
      expect(Mutations.toGitHubReviewEvent(event)).toBe(expected);
    }
    const approve = Mutations.buildGitHubReviewSubmissionBody({
      event: "approve",
      body: "   ",
      comments: [],
      expectedHeadSha: HEAD,
    });
    assert(Result.isSuccess(approve));
    expect(approve.success).toEqual({ commit_id: HEAD, event: "APPROVE", comments: [] });
  });

  it("rejects reviews GitHub would refuse, before any request is made", () => {
    const cases = [
      { event: "request_changes" as const, comments: [] },
      { event: "comment" as const, comments: [] },
      { event: "comment" as const, comments: [{ path: "a.ts", body: "x" }] },
      { event: "comment" as const, comments: [{ path: "a.ts", body: "x", line: 2, startLine: 5 }] },
    ];
    for (const input of cases) {
      const result = Mutations.buildGitHubReviewSubmissionBody({
        ...input,
        expectedHeadSha: HEAD,
      });
      expect(Result.isFailure(result)).toBe(true);
    }
  });

  it("lets an empty comment review submit the viewer's pending review", () => {
    const empty = { event: "comment" as const, comments: [], expectedHeadSha: HEAD };
    expect(Result.isFailure(Mutations.buildGitHubReviewSubmissionBody(empty))).toBe(true);
    const pending = Mutations.buildGitHubReviewSubmissionBody(empty, {
      submitsPendingReview: true,
    });
    assert(Result.isSuccess(pending));
    expect(pending.success).toEqual({ commit_id: HEAD, event: "COMMENT", comments: [] });
    // Requesting changes still needs a summary.
    const requestChanges = Mutations.buildGitHubReviewSubmissionBody(
      { ...empty, event: "request_changes" },
      { submitsPendingReview: true },
    );
    expect(Result.isFailure(requestChanges)).toBe(true);
  });

  it("builds pending-review thread inputs for GraphQL", () => {
    expect(
      Mutations.buildGitHubPendingReviewThreadInput("PRR_1", {
        path: "a.ts",
        body: "x",
        line: 4,
        side: "LEFT",
        start_line: 2,
        start_side: "LEFT",
      }),
    ).toEqual({
      pullRequestReviewId: "PRR_1",
      path: "a.ts",
      body: "x",
      subjectType: "LINE",
      line: 4,
      side: "LEFT",
      startLine: 2,
      startSide: "LEFT",
    });
    expect(
      Mutations.buildGitHubPendingReviewThreadInput("PRR_1", {
        path: "a.ts",
        body: "x",
        subject_type: "file",
      }),
    ).toEqual({ pullRequestReviewId: "PRR_1", path: "a.ts", body: "x", subjectType: "FILE" });
  });
});

describe("review response decoders", () => {
  it("decodes REST and GraphQL review submissions", () => {
    const rest = Mutations.decodeGitHubReviewSubmissionJson(
      JSON.stringify({
        id: 5393402423,
        node_id: "PRR_kwDO",
        state: "CHANGES_REQUESTED",
        html_url: "https://github.com/acme/repo/pull/7#pullrequestreview-5393402423",
      }),
    );
    assert(Result.isSuccess(rest));
    expect(rest.success).toEqual({
      reviewId: "PRR_kwDO",
      state: "changes_requested",
      url: "https://github.com/acme/repo/pull/7#pullrequestreview-5393402423",
    });

    const graphql = Mutations.decodeGitHubSubmitPendingReviewJson(
      JSON.stringify({
        data: {
          submitPullRequestReview: { pullRequestReview: { id: "PRR_2", state: "APPROVED" } },
        },
      }),
    );
    assert(Result.isSuccess(graphql));
    expect(graphql.success).toEqual({ reviewId: "PRR_2", state: "approved" });
  });

  it("only treats the viewer's own pending review as absorbable", () => {
    const context = (author: string) =>
      Mutations.decodeGitHubReviewContextJson(
        JSON.stringify({
          data: {
            viewer: { login: "Alice" },
            repository: {
              pullRequest: {
                id: "PR_7",
                headRefOid: HEAD,
                reviews: {
                  nodes: [
                    { id: "PRR_pending", author: { login: author }, commit: { oid: "abc123" } },
                  ],
                },
              },
            },
          },
        }),
      );
    const own = context("alice");
    assert(Result.isSuccess(own));
    expect(own.success).toEqual({
      pullRequestId: "PR_7",
      headRefOid: HEAD,
      pendingReviewId: "PRR_pending",
      pendingReviewCommitOid: "abc123",
    });
    const other = context("mallory");
    assert(Result.isSuccess(other));
    expect(other.success.pendingReviewId).toBeNull();
    expect(other.success.pendingReviewCommitOid).toBeNull();
  });
});

describe("buildGitHubAutoMergeRequest", () => {
  it("only declares the variables the action carries", () => {
    const plain = Mutations.buildGitHubAutoMergeRequest({
      pullRequestId: "PR_7",
      action: { kind: "auto-merge", enabled: true },
    });
    expect(plain.variables).toEqual({ pullRequestId: "PR_7" });
    expect(plain.query).not.toContain("$mergeMethod");
    expect(plain.query).not.toContain("$expectedHeadOid");

    const guarded = Mutations.buildGitHubAutoMergeRequest({
      pullRequestId: "PR_7",
      action: { kind: "auto-merge", enabled: true, mergeMethod: "rebase", expectedHeadSha: "abc" },
    });
    expect(guarded.variables).toEqual({
      pullRequestId: "PR_7",
      mergeMethod: "REBASE",
      expectedHeadOid: "abc",
    });
    expect(guarded.query).toContain(
      "mutation($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!, $expectedHeadOid: GitObjectID!)",
    );

    const disable = Mutations.buildGitHubAutoMergeRequest({
      pullRequestId: "PR_7",
      action: { kind: "auto-merge", enabled: false, expectedHeadSha: "abc" },
    });
    expect(disable).toEqual({
      query: Mutations.GITHUB_DISABLE_AUTO_MERGE_MUTATION,
      variables: { pullRequestId: "PR_7" },
    });
  });
});

describe("decodeGitHubStartPendingReviewJson", () => {
  it("returns the id of the pending review GitHub started", () => {
    const started = Mutations.decodeGitHubStartPendingReviewJson(
      JSON.stringify({
        data: { addPullRequestReview: { pullRequestReview: { id: "PRR_1", state: "PENDING" } } },
      }),
    );
    assert(Result.isSuccess(started));
    expect(started.success).toBe("PRR_1");
  });

  it("refuses a review that is not pending or missing", () => {
    expect(
      Result.isFailure(
        Mutations.decodeGitHubStartPendingReviewJson(
          JSON.stringify({
            data: {
              addPullRequestReview: { pullRequestReview: { id: "PRR_1", state: "COMMENTED" } },
            },
          }),
        ),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        Mutations.decodeGitHubStartPendingReviewJson(
          JSON.stringify({ data: { addPullRequestReview: null } }),
        ),
      ),
    ).toBe(true);
  });
});

describe("isGitHubRepositoryFilePath", () => {
  it("accepts repository-relative paths and rejects dot or empty segments", () => {
    expect(Mutations.isGitHubRepositoryFilePath("src/a b/#x.ts")).toBe(true);
    expect(Mutations.isGitHubRepositoryFilePath(".github/workflows/ci.yml")).toBe(true);
    expect(Mutations.isGitHubRepositoryFilePath("../user")).toBe(false);
    expect(Mutations.isGitHubRepositoryFilePath("src/./a.ts")).toBe(false);
    expect(Mutations.isGitHubRepositoryFilePath("/src/a.ts")).toBe(false);
    expect(Mutations.isGitHubRepositoryFilePath("src//a.ts")).toBe(false);
  });
});

describe("buildGitHubPullRequestSearchListArgs", () => {
  it("adds the involvement qualifier for every involvement", () => {
    const expected: Record<ChangeRequestInvolvement, string> = {
      authored: "author:@me",
      "review-requested": "review-requested:@me",
      assigned: "assignee:@me",
      mentioned: "mentions:@me",
      involved: "involves:@me",
    };
    for (const [involvement, qualifier] of Object.entries(expected)) {
      expect(
        Mutations.buildGitHubPullRequestSearchListArgs({
          involvement: involvement as ChangeRequestInvolvement,
          state: "open",
          limit: 20,
          jsonFields: "number",
        }),
      ).toEqual([
        "pr",
        "list",
        "--search",
        qualifier,
        "--state",
        "open",
        "--limit",
        "20",
        "--json",
        "number",
      ]);
    }
  });

  it("combines the free-text query, state, and head with the involvement", () => {
    expect(
      Mutations.buildGitHubPullRequestSearchListArgs({
        involvement: "review-requested",
        query: "  flaky test  ",
        state: "all",
        headSelector: "feature/x",
        limit: 50,
        jsonFields: "number,title",
      }),
    ).toEqual([
      "pr",
      "list",
      "--search",
      "flaky test review-requested:@me",
      "--head",
      "feature/x",
      "--state",
      "all",
      "--limit",
      "50",
      "--json",
      "number,title",
    ]);
  });
});

describe("buildGitHubPullRequestLifecycleArgs", () => {
  const build = (
    action: Parameters<typeof Mutations.buildGitHubPullRequestLifecycleArgs>[0]["action"],
    bodyFile?: string,
  ) =>
    Mutations.buildGitHubPullRequestLifecycleArgs({
      number: 7,
      repo: "github.com/acme/repo",
      action,
      bodyFile,
    });
  const target = ["7", "--repo", "github.com/acme/repo"];

  it("maps CLI-backed actions to gh pr subcommands addressed by number and --repo", () => {
    expect(
      build({ kind: "edit", title: "New", body: "Body", baseRefName: "main" }, "/tmp/b.md"),
    ).toEqual(
      Result.succeed([
        "pr",
        "edit",
        ...target,
        "--title",
        "New",
        "--body-file",
        "/tmp/b.md",
        "--base",
        "main",
      ]),
    );
    expect(build({ kind: "set-draft", draft: true })).toEqual(
      Result.succeed(["pr", "ready", ...target, "--undo"]),
    );
    expect(build({ kind: "set-draft", draft: false })).toEqual(
      Result.succeed(["pr", "ready", ...target]),
    );
    expect(build({ kind: "close", deleteBranch: true })).toEqual(
      Result.succeed(["pr", "close", ...target, "--delete-branch"]),
    );
    expect(build({ kind: "reopen" })).toEqual(Result.succeed(["pr", "reopen", ...target]));
    expect(build({ kind: "reviewers", add: ["bob", "acme/core"], remove: ["carol"] })).toEqual(
      Result.succeed([
        "pr",
        "edit",
        ...target,
        "--add-reviewer",
        "bob",
        "--add-reviewer",
        "acme/core",
        "--remove-reviewer",
        "carol",
      ]),
    );
    expect(build({ kind: "labels", add: ['needs "triage", soon'], remove: [] })).toEqual(
      Result.succeed(["pr", "edit", ...target, "--add-label", '"needs ""triage"", soon"']),
    );
    expect(build({ kind: "assignees", add: [], remove: ["alice"] })).toEqual(
      Result.succeed(["pr", "edit", ...target, "--remove-assignee", "alice"]),
    );
  });

  it("leaves API-backed actions to the caller and rejects empty edits", () => {
    expect(build({ kind: "update-branch", method: "rebase", expectedHeadSha: "abc" })).toEqual(
      Result.succeed(null),
    );
    expect(build({ kind: "auto-merge", enabled: true })).toEqual(Result.succeed(null));
    expect(build({ kind: "delete-branch" })).toEqual(Result.succeed(null));
    expect(Result.isFailure(build({ kind: "edit" }))).toBe(true);
    expect(Result.isFailure(build({ kind: "edit", body: "unstaged" }))).toBe(true);
    expect(Result.isFailure(build({ kind: "labels", add: [], remove: [] }))).toBe(true);
  });
});

describe("comment mutation documents", () => {
  it("picks the GraphQL mutation for each comment kind and refuses review deletion", () => {
    expect(Mutations.gitHubCommentMutationDocument("issue-comment", "edit")).toContain(
      "updateIssueComment",
    );
    expect(Mutations.gitHubCommentMutationDocument("review-comment", "edit")).toContain(
      "updatePullRequestReviewComment",
    );
    expect(Mutations.gitHubCommentMutationDocument("review", "edit")).toContain(
      "updatePullRequestReview",
    );
    expect(Mutations.gitHubCommentMutationDocument("issue-comment", "delete")).toContain(
      "deleteIssueComment",
    );
    expect(Mutations.gitHubCommentMutationDocument("review-comment", "delete")).toContain(
      "deletePullRequestReviewComment",
    );
    expect(Mutations.gitHubCommentMutationDocument("review", "delete")).toBeNull();
  });

  it("keeps bodies out of argv by encoding them into the stdin document", () => {
    const document = Mutations.encodeGitHubGraphQlRequest({
      query: Mutations.GITHUB_REVIEW_THREAD_REPLY_MUTATION,
      variables: { threadId: "PRRT_1", body: "secret `$(rm -rf)` text" },
    });
    expect(JSON.parse(document)).toEqual({
      query: Mutations.GITHUB_REVIEW_THREAD_REPLY_MUTATION,
      variables: { threadId: "PRRT_1", body: "secret `$(rm -rf)` text" },
    });
  });

  it("encodes repository paths segment by segment", () => {
    expect(Mutations.encodeGitHubPathSegments("src/a b/#x.ts")).toBe("src/a%20b/%23x.ts");
  });
});
