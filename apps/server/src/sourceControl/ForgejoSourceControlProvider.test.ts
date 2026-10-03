import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Option } from "effect";

import * as ForgejoApi from "./ForgejoApi.ts";
import { ForgejoApiError } from "./forgejoApiError.ts";
import * as ForgejoSourceControlProvider from "./ForgejoSourceControlProvider.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
import type { NormalizedForgejoPullRequestDetail } from "./forgejoPullRequests.ts";

function makeProvider(forgejo: Partial<ForgejoApi.ForgejoApiShape>) {
  return ForgejoSourceControlProvider.make().pipe(
    Effect.provide(
      Layer.mock(ForgejoApi.ForgejoApi)({
        detectProviderFromRemoteUrl: () => null,
        ...forgejo,
      }),
    ),
  );
}

it.effect("maps Forgejo PR summaries into provider-neutral change requests", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getPullRequest: () =>
        Effect.succeed({
          number: 42,
          title: "Add Forgejo provider",
          url: "https://codeberg.org/pingdotgg/ryco/pulls/42",
          baseRefName: "main",
          headRefName: "feature/source-control",
          headLabel: "fork:feature/source-control",
          state: "open",
          updatedAt: Option.none(),
          isCrossRepository: true,
          isDraft: false,
          author: "alice",
          commentsCount: 2,
          headRepositoryNameWithOwner: "fork/ryco",
          headRepositoryOwnerLogin: "fork",
          headRepositoryCloneUrl: "https://codeberg.org/fork/ryco.git",
          headRepositorySshUrl: "git@codeberg.org:fork/ryco.git",
        }),
    });

    const changeRequest = yield* provider.getChangeRequest({
      cwd: "/repo",
      reference: "42",
    });

    assert.deepStrictEqual(changeRequest, {
      provider: "forgejo",
      number: 42,
      title: "Add Forgejo provider",
      url: "https://codeberg.org/pingdotgg/ryco/pulls/42",
      baseRefName: "main",
      headRefName: "feature/source-control",
      state: "open",
      updatedAt: Option.none(),
      isCrossRepository: true,
      isDraft: false,
      author: "alice",
      commentsCount: 2,
      headRepositoryNameWithOwner: "fork/ryco",
      headRepositoryOwnerLogin: "fork",
    });
  }),
);

it.effect("creates Forgejo PRs through provider-neutral input names", () =>
  Effect.gen(function* () {
    let createInput: Parameters<ForgejoApi.ForgejoApiShape["createPullRequest"]>[0] | null = null;
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
      source: {
        owner: "owner",
        refName: "feature/provider",
      },
      title: "Provider PR",
      bodyFile: "/tmp/body.md",
    });
  }),
);

it.effect("listIssues maps Forgejo issue summaries to provider: forgejo", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      listIssues: () =>
        Effect.succeed([
          {
            number: 42,
            title: "Bug",
            url: "https://codeberg.org/owner/repo/issues/42",
            state: "open" as const,
            author: "alice",
            updatedAt: Option.some("2026-01-02T00:00:00.000Z"),
            labels: [{ name: "bug", color: "cc0000" }],
            assignees: ["bob"],
            commentsCount: 3,
          },
        ]),
    });

    const issues = yield* provider.listIssues({ cwd: "/repo", state: "open" });

    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0]?.provider, "forgejo");
    assert.strictEqual(issues[0]?.number, 42);
    assert.strictEqual(issues[0]?.author, "alice");
    assert.deepStrictEqual(issues[0]?.labels, [{ name: "bug", color: "cc0000" }]);
    assert.deepStrictEqual(issues[0]?.assignees, ["bob"]);
    assert.deepStrictEqual(
      issues[0]?.updatedAt,
      Option.some(DateTime.fromDateUnsafe(new Date("2026-01-02T00:00:00.000Z"))),
    );
  }),
);

it.effect("getChangeRequestDetail returns Forgejo body, comments, commits, and files", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getPullRequestDetail: () =>
        Effect.succeed({
          number: 99,
          title: "Add feature",
          url: "https://codeberg.org/owner/repo/pulls/99",
          baseRefName: "main",
          headRefName: "feature/add",
          headLabel: "owner:feature/add",
          state: "open" as const,
          updatedAt: Option.none(),
          author: "alice",
          commentsCount: 1,
          headRepositoryNameWithOwner: "owner/repo",
          headRepositoryOwnerLogin: "owner",
          headRepositoryCloneUrl: "https://codeberg.org/owner/repo.git",
          headRepositorySshUrl: "git@codeberg.org:owner/repo.git",
          body: "PR body text",
          comments: [{ author: "reviewer", body: "looks good", createdAt: "2026-03-01T10:00:00Z" }],
          commits: [
            {
              oid: "abcdef1234567890",
              shortOid: "abcdef123456",
              messageHeadline: "Add support",
              author: "alice",
            },
          ],
          additions: 10,
          deletions: 2,
          changedFiles: 1,
          files: [{ path: "src/forgejo.ts", additions: 10, deletions: 2 }],
        }),
    });

    const detail = yield* provider.getChangeRequestDetail({ cwd: "/repo", reference: "99" });

    assert.strictEqual(detail.provider, "forgejo");
    assert.strictEqual(detail.number, 99);
    assert.strictEqual(detail.body, "PR body text");
    assert.strictEqual(detail.comments[0]?.author, "reviewer");
    assert.strictEqual(detail.commits?.[0]?.shortOid, "abcdef123456");
    assert.strictEqual(detail.additions, 10);
    assert.strictEqual(detail.deletions, 2);
    assert.strictEqual(detail.changedFiles, 1);
    assert.deepStrictEqual(detail.files, [{ path: "src/forgejo.ts", additions: 10, deletions: 2 }]);
  }),
);

it.effect("getChangeRequestDiff forwards Forgejo diffs", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getPullRequestDiff: () => Effect.succeed("diff --git a/file b/file\n"),
    });

    const diff = yield* provider.getChangeRequestDiff({ cwd: "/repo", reference: "99" });

    assert.strictEqual(diff, "diff --git a/file b/file\n");
  }),
);

describe("ForgejoSourceControlProvider stubs (Phase 1 of issue creation)", () => {
  it.effect("createIssue fails with 'Not implemented' SourceControlProviderError", () =>
    Effect.gen(function* () {
      const provider = yield* makeProvider({});
      const result = yield* provider
        .createIssue({ cwd: "/repo", title: "x", body: "" })
        .pipe(Effect.flip);
      assert.strictEqual(result.operation, "createIssue");
      assert.include(result.detail, "Not implemented");
    }),
  );
});

const detailRecord: NormalizedForgejoPullRequestDetail = {
  number: 42,
  title: "Add Forgejo review page",
  url: "https://codeberg.test/pingdotgg/ryco/pulls/42",
  baseRefName: "main",
  headRefName: "feature/review-page",
  headLabel: "feature/review-page",
  state: "open",
  updatedAt: Option.none(),
  isCrossRepository: false,
  isDraft: false,
  author: "alice",
  commentsCount: 1,
  headRepositoryNameWithOwner: "pingdotgg/ryco",
  headRepositoryOwnerLogin: "pingdotgg",
  headRepositoryCloneUrl: "https://codeberg.test/pingdotgg/ryco.git",
  headRepositorySshUrl: "git@codeberg.test:pingdotgg/ryco.git",
  headSha: "4f2a9c1e0b7d63a85e9f10c2d4b6a8e0f1c3d5e7",
  labels: [{ name: "enhancement", color: "84b6eb" }],
  assignees: ["bob"],
  requestedReviewers: ["erin"],
  requestedTeams: ["core"],
  createdAt: DateTime.makeUnsafe("2026-03-10T09:00:00Z"),
  readiness: {
    mergeability: "mergeable",
    mergeStateStatus: "blocked",
    reviewDecision: "approved",
    reviewerStates: [{ login: "bob", kind: "user", state: "approved" }],
    checkRollup: [],
    mergeCapabilities: { merge: true, squash: false, rebase: true },
  },
  body: "Body",
  comments: [
    {
      id: "902",
      author: "bob",
      body: "Looks good.\n\n<!-- ryco-comment-id:0000000000000000000000000000000000000000000000000000000000000000 -->",
      createdAt: "2026-03-11T08:00:00Z",
    },
  ],
  commits: [],
  additions: 30,
  deletions: 4,
  changedFiles: 3,
  files: [],
};

describe("pull request page", () => {
  it.effect("maps readiness, people and labels into rows and details", () =>
    Effect.gen(function* () {
      const provider = yield* makeProvider({
        getPullRequestDetail: () => Effect.succeed(detailRecord),
      });
      const detail = yield* provider.getChangeRequestDetail({
        cwd: "/repo",
        reference: "42",
        fullContent: true,
      });
      assert.deepInclude(detail, {
        headSha: "4f2a9c1e0b7d63a85e9f10c2d4b6a8e0f1c3d5e7",
        mergeability: "mergeable",
        mergeStateStatus: "blocked",
        reviewDecision: "approved",
        assignees: ["bob"],
        reviewers: ["erin", "core"],
        mergeCapabilities: { merge: true, squash: false, rebase: true },
      });
      assert.deepStrictEqual(detail.labels, [{ name: "enhancement", color: "84b6eb" }]);
      assert.deepStrictEqual(detail.reviewerStates, [
        { login: "bob", kind: "user", state: "approved" },
      ]);
      assert.deepStrictEqual(detail.checkRollup, []);
      // Comment ids round-trip into edits and reactions; Ryco's marker never reaches the page.
      assert.strictEqual(detail.comments[0]?.id, "902");
      assert.strictEqual(detail.comments[0]?.body, "Looks good.");
    }),
  );

  it.effect("routes involvement lists to the involvement read", () =>
    Effect.gen(function* () {
      let received: Parameters<ForgejoApi.ForgejoApiShape["listInvolvedPullRequests"]>[0] | null =
        null;
      const provider = yield* makeProvider({
        listInvolvedPullRequests: (input) => {
          received = input;
          return Effect.succeed([detailRecord]);
        },
      });
      const rows = yield* provider.listChangeRequests({
        cwd: "/repo",
        headSelector: "",
        state: "open",
        involvement: "review-requested",
        query: "page",
        limit: 20,
      });
      assert.deepStrictEqual(received, {
        cwd: "/repo",
        involvement: "review-requested",
        state: "open",
        query: "page",
        limit: 20,
      });
      assert.strictEqual(rows[0]?.reviewDecision, "approved");
      assert.strictEqual(rows[0]?.mergeability, "mergeable");
    }),
  );

  it.effect(
    "passes single-commit and head-checked diffs and drafts through the option guards",
    () =>
      Effect.gen(function* () {
        let diffInput: Parameters<ForgejoApi.ForgejoApiShape["getPullRequestDiff"]>[0] | null =
          null;
        let createInput: Parameters<ForgejoApi.ForgejoApiShape["createPullRequest"]>[0] | null =
          null;
        const provider = yield* makeProvider({
          getPullRequestDiff: (input) => {
            diffInput = input;
            return Effect.succeed("diff");
          },
          createPullRequest: (input) => {
            createInput = input;
            return Effect.void;
          },
        });
        yield* provider.getChangeRequestDiff({
          cwd: "/repo",
          reference: "42",
          commitSha: "abc1234",
          expectedHeadSha: "def5678",
        });
        yield* provider.createChangeRequest({
          cwd: "/repo",
          baseRefName: "main",
          headSelector: "feature/x",
          title: "T",
          bodyFile: "/tmp/body.md",
          draft: true,
        });
        assert.deepStrictEqual(diffInput, {
          cwd: "/repo",
          reference: "42",
          expectedHeadSha: "def5678",
          commitSha: "abc1234",
        });
        assert.strictEqual(createInput?.["draft"], true);
      }),
  );

  it.effect("returns the fresh, uncapped detail after lifecycle actions and comments", () =>
    Effect.gen(function* () {
      const actions: Array<string> = [];
      const provider = yield* makeProvider({
        updatePullRequest: (input) => {
          actions.push(input.action.kind);
          return Effect.void;
        },
        addPullRequestComment: () => Effect.void,
        togglePullRequestCommentReaction: () => Effect.void,
        getPullRequestDetail: () => Effect.succeed({ ...detailRecord, body: "x".repeat(20_000) }),
      });
      const updated = yield* provider.updateChangeRequest!({
        cwd: "/repo",
        reference: "42",
        action: { kind: "close" },
      });
      assert.deepStrictEqual(actions, ["close"]);
      assert.strictEqual(updated.detail.truncated, false);
      assert.strictEqual(updated.detail.body.length, 20_000);
      const commented = yield* provider.addChangeRequestComment({
        cwd: "/repo",
        reference: "42",
        body: "hi",
      });
      assert.strictEqual(commented.truncated, false);
      const reacted = yield* provider.addChangeRequestCommentReaction({
        cwd: "/repo",
        reference: "42",
        commentId: "902",
        content: "heart",
      });
      assert.strictEqual(reacted.number, 42);
    }),
  );

  it.effect("forwards the page methods and maps their errors", () =>
    Effect.gen(function* () {
      const failure = new ForgejoApiError({
        operation: "mergePullRequest",
        status: 409,
        detail: "head changed",
      });
      const provider = yield* makeProvider({
        mergePullRequest: () => Effect.fail(failure),
        submitPullRequestReview: () =>
          Effect.succeed({ reviewId: "120", state: "approved" as const }),
        replyToPullRequestReviewThread: () =>
          Effect.succeed({
            id: "101/301",
            path: "src/app.ts",
            subjectType: "line" as const,
            side: "right" as const,
            line: 12,
            isResolved: false,
            isOutdated: false,
            viewerCanReply: true,
            viewerCanResolve: false,
            viewerCanUnresolve: false,
            comments: [],
            totalComments: 0,
          }),
        listLabels: () => Effect.succeed([{ name: "bug" }]),
        listAssignees: () => Effect.succeed([{ login: "bob" }]),
        getPullRequest: () => Effect.succeed({ ...detailRecord, state: "merged" as const }),
      });
      const error = yield* provider.mergeChangeRequest!({
        cwd: "/repo",
        reference: "42",
        mergeMethod: "merge",
      }).pipe(Effect.flip);
      assert.deepInclude(error, {
        provider: "forgejo",
        operation: "mergeChangeRequest",
        detail: "head changed",
      });
      const review = yield* provider.submitChangeRequestReview!({
        cwd: "/repo",
        reference: "42",
        event: "approve",
        comments: [],
        expectedHeadSha: "abc1234",
      });
      assert.strictEqual(review.reviewId, "120");
      const reply = yield* provider.replyToReviewThread!({
        cwd: "/repo",
        reference: "42",
        threadId: "101/301",
        body: "ok",
      });
      assert.strictEqual(reply.thread.id, "101/301");
      assert.deepStrictEqual(yield* provider.listLabels({ cwd: "/repo" }), [{ name: "bug" }]);
      assert.deepStrictEqual(yield* provider.listAssignees({ cwd: "/repo" }), [{ login: "bob" }]);
      assert.deepStrictEqual(yield* provider.getPullRequestState({ cwd: "/repo", number: 42 }), {
        state: "merged",
        isDraft: false,
      });
      // Forgejo's API cannot resolve conversations.
      assert.strictEqual(provider.setReviewThreadResolved, undefined);
    }),
  );
});

it.effect("is reachable through the registry's lazy provider with the remote context bound", () =>
  Effect.gen(function* () {
    const contexts: Array<unknown> = [];
    const context = {
      provider: { kind: "forgejo" as const, name: "Codeberg", baseUrl: "https://codeberg.test" },
      remoteName: "origin",
      remoteUrl: "git@codeberg.test:pingdotgg/ryco.git",
    };
    const lazy = yield* SourceControlProviderRegistry.makeLazyProvider(
      "forgejo",
      makeProvider({
        getPullRequestActivity: (input) => {
          contexts.push(input.context);
          return Effect.succeed({
            provider: "forgejo" as const,
            number: 42,
            headSha: null,
            viewer: null,
            timeline: [],
            timelineTruncated: false,
            reviewThreads: [],
            reviewThreadsTruncated: false,
            pendingReview: null,
          });
        },
        mergePullRequest: (input) => {
          contexts.push(input.context);
          return Effect.succeed({ outcome: "merged" as const });
        },
      }),
    );
    const bound = SourceControlProviderRegistry.bindProviderContext(lazy, context);
    const activity = yield* bound.getChangeRequestActivity!({ cwd: "/repo", reference: "42" });
    assert.strictEqual(activity.number, 42);
    const merged = yield* bound.mergeChangeRequest!({
      cwd: "/repo",
      reference: "42",
      mergeMethod: "merge",
    });
    assert.deepStrictEqual(merged, { outcome: "merged" });
    assert.deepStrictEqual(contexts, [context, context]);
    // No resolve endpoint: the registry reports the operation as unsupported.
    const resolve = yield* lazy.setReviewThreadResolved!({
      cwd: "/repo",
      reference: "42",
      threadId: "101/301",
      resolved: true,
    }).pipe(Effect.flip);
    assert.include(resolve.detail, "does not support resolving review threads");
  }),
);
