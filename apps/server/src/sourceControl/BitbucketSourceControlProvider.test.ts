import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Option } from "effect";
import { SOURCE_CONTROL_DETAIL_BODY_MAX_BYTES } from "@ryco/contracts";

import * as BitbucketApi from "./BitbucketApi.ts";
import type * as BitbucketPullRequests from "./bitbucketPullRequests.ts";
import * as BitbucketSourceControlProvider from "./BitbucketSourceControlProvider.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
import { makeLayer as makeBitbucketApiLayer } from "./bitbucketApiTestLayer.ts";

function makeProvider(bitbucket: Partial<BitbucketApi.BitbucketApiShape>) {
  return BitbucketSourceControlProvider.make().pipe(
    Effect.provide(Layer.mock(BitbucketApi.BitbucketApi)(bitbucket)),
  );
}

it.effect("maps Bitbucket PR summaries into provider-neutral change requests", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getPullRequest: () =>
        Effect.succeed({
          number: 42,
          title: "Add Bitbucket provider",
          url: "https://bitbucket.org/pingdotgg/ryco/pull-requests/42",
          baseRefName: "main",
          headRefName: "feature/source-control",
          state: "open",
          updatedAt: Option.none(),
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
      provider: "bitbucket",
      number: 42,
      title: "Add Bitbucket provider",
      url: "https://bitbucket.org/pingdotgg/ryco/pull-requests/42",
      baseRefName: "main",
      headRefName: "feature/source-control",
      state: "open",
      updatedAt: Option.none(),
      isCrossRepository: true,
      headRepositoryNameWithOwner: "fork/ryco",
      headRepositoryOwnerLogin: "fork",
    });
  }),
);

it.effect("lists Bitbucket PRs through provider-neutral input names", () =>
  Effect.gen(function* () {
    let listInput: Parameters<BitbucketApi.BitbucketApiShape["listPullRequests"]>[0] | null = null;
    const provider = yield* makeProvider({
      listPullRequests: (input) => {
        listInput = input;
        return Effect.succeed([]);
      },
    });

    yield* provider.listChangeRequests({
      cwd: "/repo",
      headSelector: "feature/provider",
      state: "all",
      limit: 10,
    });

    assert.deepStrictEqual(listInput, {
      cwd: "/repo",
      headSelector: "feature/provider",
      state: "all",
      limit: 10,
    });
  }),
);

it.effect("creates Bitbucket PRs through provider-neutral input names", () =>
  Effect.gen(function* () {
    let createInput: Parameters<BitbucketApi.BitbucketApiShape["createPullRequest"]>[0] | null =
      null;
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

it.effect("uses Bitbucket API repository detection for default branch lookup", () =>
  Effect.gen(function* () {
    let cwdInput: string | null = null;
    const provider = yield* makeProvider({
      getDefaultBranch: (input) => {
        cwdInput = input.cwd;
        return Effect.succeed("main");
      },
    });

    const defaultBranch = yield* provider.getDefaultBranch({ cwd: "/repo" });

    assert.strictEqual(defaultBranch, "main");
    assert.strictEqual(cwdInput, "/repo");
  }),
);

it.effect("listIssues maps bitbucket issue summaries to provider: bitbucket", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      listIssues: () =>
        Effect.succeed([
          {
            number: 42,
            title: "Bug",
            url: "https://bitbucket.org/owner/repo/issues/42",
            state: "open" as const,
            author: "alice",
            updatedAt: Option.some("2026-01-02T00:00:00.000Z"),
            labels: ["bug"],
          },
        ]),
    });
    const issues = yield* provider.listIssues({ cwd: "/repo", state: "open" });
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0]?.provider, "bitbucket");
    assert.strictEqual(issues[0]?.number, 42);
    assert.strictEqual(issues[0]?.title, "Bug");
    assert.strictEqual(issues[0]?.state, "open");
    assert.strictEqual(issues[0]?.author, "alice");
    assert.deepStrictEqual(
      issues[0]?.updatedAt,
      Option.some(DateTime.fromDateUnsafe(new Date("2026-01-02T00:00:00.000Z"))),
    );
  }),
);

it.effect("getIssue truncates body when over 8 KB", () =>
  Effect.gen(function* () {
    const bigBody = "x".repeat(SOURCE_CONTROL_DETAIL_BODY_MAX_BYTES + 100);
    const provider = yield* makeProvider({
      getIssue: () =>
        Effect.succeed({
          number: 7,
          title: "Big",
          url: "https://bitbucket.org/owner/repo/issues/7",
          state: "open" as const,
          author: "bob",
          updatedAt: Option.none(),
          labels: [],
          body: bigBody,
          comments: [],
        }),
    });
    const detail = yield* provider.getIssue({ cwd: "/repo", reference: "7" });
    assert.strictEqual(detail.truncated, true);
    assert.strictEqual(detail.provider, "bitbucket");
    assert.ok(Buffer.byteLength(detail.body, "utf8") <= SOURCE_CONTROL_DETAIL_BODY_MAX_BYTES);
  }),
);

it.effect("searchIssues forwards query to api.searchIssues", () =>
  Effect.gen(function* () {
    let captured: string | undefined;
    const provider = yield* makeProvider({
      searchIssues: (input) => {
        captured = input.query;
        return Effect.succeed([]);
      },
    });
    yield* provider.searchIssues({ cwd: "/repo", query: "memory leak" });
    assert.strictEqual(captured, "memory leak");
  }),
);

it.effect("searchChangeRequests forwards query to api.searchPullRequests", () =>
  Effect.gen(function* () {
    let captured: string | undefined;
    const provider = yield* makeProvider({
      searchPullRequests: (input) => {
        captured = input.query;
        return Effect.succeed([]);
      },
    });
    yield* provider.searchChangeRequests({ cwd: "/repo", query: "fix" });
    assert.strictEqual(captured, "fix");
  }),
);

it.effect("getChangeRequestDetail returns body and comments", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getPullRequestDetail: () =>
        Effect.succeed({
          number: 99,
          title: "Add feature",
          url: "https://bitbucket.org/owner/repo/pull-requests/99",
          baseRefName: "main",
          headRefName: "feature/add",
          state: "open" as const,
          updatedAt: Option.none(),
          author: "alice",
          commentsCount: 2,
          body: "PR body text",
          comments: [{ author: "reviewer", body: "looks good", createdAt: "2026-03-01T10:00:00Z" }],
          reviewers: ["reviewer"],
          participants: [{ displayName: "reviewer", role: "REVIEWER", approved: true }],
          tasksCount: 1,
          linkedWorkItemKeys: ["RYCO-123"],
        }),
    });
    const detail = yield* provider.getChangeRequestDetail({ cwd: "/repo", reference: "99" });
    assert.strictEqual(detail.provider, "bitbucket");
    assert.strictEqual(detail.number, 99);
    assert.strictEqual(detail.body, "PR body text");
    assert.strictEqual(detail.comments.length, 1);
    assert.strictEqual(detail.comments[0]?.author, "reviewer");
    assert.strictEqual(detail.comments[0]?.body, "looks good");
    assert.strictEqual(detail.author, "alice");
    assert.strictEqual(detail.commentsCount, 2);
    assert.deepStrictEqual(detail.reviewers, ["reviewer"]);
    assert.deepStrictEqual(detail.participants?.[0], {
      displayName: "reviewer",
      role: "REVIEWER",
      approved: true,
    });
    assert.strictEqual(detail.tasksCount, 1);
    assert.deepStrictEqual(detail.linkedWorkItemKeys, ["RYCO-123"]);
    assert.strictEqual(detail.truncated, false);
  }),
);

it.effect("getChangeRequestDiff forwards to api.getPullRequestDiff", () =>
  Effect.gen(function* () {
    let capturedReference: string | undefined;
    const provider = yield* makeProvider({
      getPullRequestDiff: (input) => {
        capturedReference = input.reference;
        return Effect.succeed("diff --git a/a b/a");
      },
    });
    const diff = yield* provider.getChangeRequestDiff({ cwd: "/repo", reference: "99" });
    assert.strictEqual(capturedReference, "99");
    assert.include(diff, "diff --git");
  }),
);

describe("BitbucketSourceControlProvider stubs (Phase 1 of issue creation)", () => {
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

  it.effect("listLabels fails with 'Not implemented'", () =>
    Effect.gen(function* () {
      const provider = yield* makeProvider({});
      const result = yield* provider.listLabels({ cwd: "/repo" }).pipe(Effect.flip);
      assert.include(result.detail, "Not implemented");
    }),
  );
});

describe("BitbucketSourceControlProvider pull requests page", () => {
  const detail: BitbucketPullRequests.NormalizedBitbucketPullRequestDetail = {
    number: 5695,
    title: "Use onClick",
    url: "https://bitbucket.org/atlassian/atlaskit-mk-2/pull-requests/5695",
    baseRefName: "master",
    headRefName: "feature",
    state: "open",
    updatedAt: Option.none(),
    isDraft: false,
    body: "Body",
    comments: [],
    reviewers: ["Jessica Yeh"],
    participants: [],
    linkedWorkItemKeys: [],
    headSha: "728c8bad1813e6a1f2b9a7a3c4d5e6f708192a3b",
    commits: [
      {
        oid: "728c8bad1813e6a1f2b9a7a3c4d5e6f708192a3b",
        shortOid: "728c8ba",
        messageHeadline: "Use onClick",
      },
    ],
    reviewerStates: [{ login: "Jessica Yeh", kind: "user", state: "approved" }],
    reviewDecision: "approved",
    mergeability: "mergeable",
    mergeStateStatus: "clean",
    mergeCapabilities: { merge: true, squash: false, rebase: false },
    checkRollup: [],
    deleteBranchOnMerge: true,
  };

  it.effect("maps the detail's readiness and head into the contract", () =>
    Effect.gen(function* () {
      const provider = yield* makeProvider({ getPullRequestDetail: () => Effect.succeed(detail) });
      const result = yield* provider.getChangeRequestDetail({ cwd: "/repo", reference: "5695" });
      assert.strictEqual(result.headSha, detail.headSha);
      assert.strictEqual(result.isDraft, false);
      assert.deepStrictEqual(result.commits, detail.commits);
      assert.deepStrictEqual(result.reviewerStates, detail.reviewerStates);
      assert.strictEqual(result.reviewDecision, "approved");
      assert.strictEqual(result.mergeability, "mergeable");
      assert.strictEqual(result.mergeStateStatus, "clean");
      assert.deepStrictEqual(result.mergeCapabilities, detail.mergeCapabilities);
      assert.strictEqual(result.deleteBranchOnMerge, true);
    }),
  );

  it.effect("forwards involvement, query, commit scope, head guard and drafts", () =>
    Effect.gen(function* () {
      const seen: Array<unknown> = [];
      const provider = yield* makeProvider({
        listPullRequests: (input) => {
          seen.push(input);
          return Effect.succeed([]);
        },
        getPullRequestDiff: (input) => {
          seen.push(input);
          return Effect.succeed("diff");
        },
        createPullRequest: (input) => {
          seen.push(input.draft);
          return Effect.void;
        },
      });
      yield* provider.listChangeRequests({
        cwd: "/repo",
        headSelector: "",
        state: "open",
        involvement: "authored",
        query: "fix",
      });
      yield* provider.getChangeRequestDiff({
        cwd: "/repo",
        reference: "5695",
        commitSha: "abc1234",
        expectedHeadSha: "def5678",
      });
      yield* provider.createChangeRequest({
        cwd: "/repo",
        baseRefName: "master",
        headSelector: "feature",
        title: "Draft",
        bodyFile: "/tmp/body.md",
        draft: true,
      });
      assert.deepStrictEqual(seen, [
        { cwd: "/repo", headSelector: "", state: "open", involvement: "authored", query: "fix" },
        { cwd: "/repo", reference: "5695", expectedHeadSha: "def5678", commitSha: "abc1234" },
        true,
      ]);
    }),
  );

  it.effect("returns the fresh, uncapped detail after comments and lifecycle actions", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const provider = yield* makeProvider({
        addPullRequestComment: (input) => {
          calls.push(`comment:${input.body}`);
          return Effect.void;
        },
        updatePullRequest: (input) => {
          calls.push(`update:${input.action.kind}`);
          return Effect.void;
        },
        getPullRequestDetail: () => {
          calls.push("detail");
          return Effect.succeed({
            ...detail,
            body: "x".repeat(SOURCE_CONTROL_DETAIL_BODY_MAX_BYTES + 1),
          });
        },
      });
      const commented = yield* provider.addChangeRequestComment({
        cwd: "/repo",
        reference: "5695",
        body: "Hi",
      });
      const updated = yield* provider.updateChangeRequest!({
        cwd: "/repo",
        reference: "5695",
        action: { kind: "set-draft", draft: true },
      });
      assert.deepStrictEqual(calls, ["comment:Hi", "detail", "update:set-draft", "detail"]);
      assert.strictEqual(commented.truncated, false);
      assert.strictEqual(updated.detail.body.length, SOURCE_CONTROL_DETAIL_BODY_MAX_BYTES + 1);
    }),
  );

  it.effect("maps API failures to provider errors naming the operation", () =>
    Effect.gen(function* () {
      const provider = yield* makeProvider({
        getPullRequestActivity: () =>
          Effect.fail(
            new BitbucketApi.BitbucketApiError({
              operation: "getPullRequestActivity",
              detail: "Bitbucket returned HTTP 403.",
              status: 403,
            }),
          ),
      });
      const error = yield* provider.getChangeRequestActivity!({
        cwd: "/repo",
        reference: "5695",
      }).pipe(Effect.flip);
      assert.strictEqual(error.provider, "bitbucket");
      assert.strictEqual(error.operation, "getChangeRequestActivity");
      assert.strictEqual(error.detail, "Bitbucket returned HTTP 403.");
    }),
  );

  it.effect("is forwarded by the lazy registry provider", () =>
    Effect.gen(function* () {
      const provider = yield* makeProvider({
        getPullRequestActivity: (input) =>
          Effect.succeed({
            provider: "bitbucket" as const,
            number: Number(input.reference),
            headSha: null,
            viewer: null,
            timeline: [],
            timelineTruncated: false,
            reviewThreads: [],
            reviewThreadsTruncated: false,
            pendingReview: null,
          }),
        mergePullRequest: () => Effect.succeed({ outcome: "merged" as const }),
      });
      const lazy = yield* SourceControlProviderRegistry.makeLazyProvider(
        "bitbucket",
        Effect.succeed(provider),
      );
      for (const method of [
        "getChangeRequestActivity",
        "getChangeRequestFileContents",
        "submitChangeRequestReview",
        "replyToReviewThread",
        "setReviewThreadResolved",
        "updateChangeRequestComment",
        "updateChangeRequest",
        "mergeChangeRequest",
      ] as const) {
        assert.strictEqual(typeof provider[method], "function", method);
      }
      const activity = yield* lazy.getChangeRequestActivity!({ cwd: "/repo", reference: "7" });
      assert.strictEqual(activity.number, 7);
      const merged = yield* lazy.mergeChangeRequest!({
        cwd: "/repo",
        reference: "7",
        mergeMethod: "merge",
      });
      assert.deepStrictEqual(merged, { outcome: "merged" });
    }),
  );
});

it.effect("reports no PR terminal time because Bitbucket has no close timestamp", () => {
  // `updated_on` moves on every later comment, so it is not a close time: the
  // refresh falls back to the time Ryco first observed the terminal state.
  const { layer } = makeBitbucketApiLayer({
    response: () =>
      Response.json({
        id: 42,
        title: "Merged Bitbucket PR",
        state: "MERGED",
        updated_on: "2026-01-02T00:00:00.000Z",
        links: { html: { href: "https://bitbucket.org/pingdotgg/ryco/pull-requests/42" } },
        source: {
          branch: { name: "feature/merged" },
          repository: { full_name: "pingdotgg/ryco", workspace: { slug: "pingdotgg" } },
        },
        destination: {
          branch: { name: "main" },
          repository: { full_name: "pingdotgg/ryco", workspace: { slug: "pingdotgg" } },
        },
      }),
  });

  return Effect.gen(function* () {
    const provider = yield* BitbucketSourceControlProvider.make();
    const state = yield* provider.getPullRequestState({ cwd: "/repo", number: 42 });
    assert.deepStrictEqual(state, { state: "merged", isDraft: false });
    assert.isUndefined(state.terminalAt);
  }).pipe(Effect.provide(layer));
});
