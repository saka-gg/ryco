import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem } from "effect";
import type { HttpClientRequest } from "effect/unstable/http";

import * as ForgejoApi from "./ForgejoApi.ts";
import { appendCommentMutationMarker } from "./gitHubCommentMutationMarker.ts";
import { FORGEJO_STALE_HEAD_DETAIL } from "./forgejoApiError.ts";
import {
  apiPath,
  forgejoRoutes,
  makeForgejoApiTestLayer,
  requestJsonBody,
  urlParam,
} from "./forgejoApiTestLayer.ts";
import {
  alice,
  bob,
  forgejoBaseRepository,
  forgejoCombinedStatus,
  forgejoHeadSha,
  forgejoMergeBaseSha,
  forgejoProtectedBranch,
  forgejoPullRequest,
  forgejoPullRequestCommits,
  forgejoPullRequestDiff,
  forgejoReactions,
  forgejoReviewComments,
  forgejoReviews,
  forgejoTimeline,
} from "./forgejoPullRequestPage.fixtures.ts";

/**
 * Request building, response mapping and error mapping of the pull request
 * page calls against a fake Forgejo answering with the fixtures (shaped like
 * https://codeberg.org/api/swagger). Nothing here reaches a real host.
 */

const repo = "/repos/pingdotgg/ryco";
const pull = `${repo}/pulls/42`;

type Route = Parameters<typeof forgejoRoutes>[0][number];

const readRoutes: ReadonlyArray<Route> = [
  ["GET", "/user", () => Response.json(alice)],
  ["GET", repo, () => Response.json(forgejoBaseRepository)],
  ["GET", pull, () => Response.json(forgejoPullRequest)],
  ["GET", `${repo}/branches/main`, () => Response.json(forgejoProtectedBranch)],
  ["GET", `${repo}/issues/42/timeline`, () => Response.json(forgejoTimeline)],
  ["GET", `${pull}/reviews`, () => Response.json(forgejoReviews)],
  [
    "GET",
    /^\/repos\/pingdotgg\/ryco\/pulls\/42\/reviews\/(\d+)\/comments$/u,
    (request) =>
      Response.json(
        forgejoReviewComments[Number(/reviews\/(\d+)/u.exec(apiPath(request))?.[1])] ?? [],
      ),
  ],
  ["GET", `${pull}/commits`, () => Response.json(forgejoPullRequestCommits)],
  [
    "GET",
    /^\/repos\/pingdotgg\/ryco\/issues\/comments\/\d+\/reactions$/u,
    (request) => Response.json(apiPath(request).includes("/902/") ? forgejoReactions : []),
  ],
  ["GET", `${pull}.diff`, () => new Response(forgejoPullRequestDiff)],
  ["GET", `${repo}/commits/${forgejoHeadSha}/status`, () => Response.json(forgejoCombinedStatus)],
];

function setup(extra: ReadonlyArray<Route> = []) {
  // Specific routes first: they override the shared reads.
  return makeForgejoApiTestLayer({ response: forgejoRoutes([...extra, ...readRoutes]) });
}

function calls(execute: {
  readonly mock: { readonly calls: ReadonlyArray<ReadonlyArray<unknown>> };
}) {
  return execute.mock.calls.map(([request]) => request as HttpClientRequest.HttpClientRequest);
}

/** Every non-GET request as method, API path, `style` query (updates) and JSON body. */
function writes(execute: Parameters<typeof calls>[0]) {
  return calls(execute)
    .filter((request) => request.method !== "GET")
    .map((request) => {
      const write: Record<string, unknown> = { method: request.method, path: apiPath(request) };
      const style = urlParam(request, "style");
      if (style) write.style = style;
      write.body = (request.body as { readonly body?: Uint8Array }).body
        ? requestJsonBody(request)
        : null;
      return write;
    });
}

function bodyText(write: Record<string, unknown> | undefined): string {
  return String((write?.body as { readonly body?: string } | undefined)?.body);
}

describe("getPullRequestActivity", () => {
  it.effect("reads the timeline, threads, viewer and pending review", () => {
    const { execute, layer } = setup();
    return Effect.gen(function* () {
      const forgejo = yield* ForgejoApi.ForgejoApi;
      const activity = yield* forgejo.getPullRequestActivity({ cwd: "/repo", reference: "42" });

      assert.strictEqual(activity.provider, "forgejo");
      assert.strictEqual(activity.number, 42);
      assert.strictEqual(activity.headSha, forgejoHeadSha);
      assert.deepStrictEqual(activity.viewer, {
        login: "alice",
        isAuthor: true,
        canUpdate: true,
        canMerge: true,
        canReview: true,
        canUpdateBranch: true,
        canEnableAutoMerge: false,
        canDisableAutoMerge: false,
      });
      assert.deepStrictEqual(
        activity.reviewThreads.map((thread) => [thread.id, thread.line, thread.isOutdated]),
        [
          ["101/301", 12, false],
          ["101/303", 5, false],
          ["105/304", 2, false],
        ],
      );
      assert.deepStrictEqual(activity.pendingReview, { id: "105", commentsCount: 1 });
      assert.strictEqual(activity.timelineTruncated, false);
      assert.strictEqual(activity.reviewThreadsTruncated, false);
      const comment = activity.timeline.find((item) => item.id === "902");
      assert.deepStrictEqual(comment?.kind === "comment" ? comment.reactions : null, [
        { content: "thumbs-up", count: 2, viewerHasReacted: false },
        { content: "heart", count: 1, viewerHasReacted: true },
      ]);

      const requests = calls(execute);
      const timeline = requests.find((request) => apiPath(request).endsWith("/timeline"));
      assert.strictEqual(urlParam(timeline!, "page"), "1");
      assert.strictEqual(urlParam(timeline!, "limit"), "50");
      const commits = requests.find((request) => apiPath(request) === `${pull}/commits`);
      assert.strictEqual(urlParam(commits!, "verification"), "false");
      assert.strictEqual(urlParam(commits!, "files"), "false");
      // Review 101 was written on an older head, so the current diff is read once to place it.
      assert.strictEqual(
        requests.filter((request) => apiPath(request) === `${pull}.diff`).length,
        1,
      );
      // Reviews without code comments are not read.
      assert.deepStrictEqual(
        requests
          .map(apiPath)
          .filter((path) => /reviews\/\d+\/comments$/u.test(path))
          .toSorted(),
        [`${pull}/reviews/101/comments`, `${pull}/reviews/105/comments`],
      );
      assert.strictEqual(requests[0]?.headers.authorization, "token token");
    }).pipe(Effect.provide(layer));
  });

  it.effect("shows a site admin only their own pending review", () => {
    // Forgejo lists every pending review to site admins.
    const { execute, layer } = setup([["GET", "/user", () => Response.json(bob)]]);
    return Effect.gen(function* () {
      const forgejo = yield* ForgejoApi.ForgejoApi;
      const activity = yield* forgejo.getPullRequestActivity({ cwd: "/repo", reference: "42" });
      assert.strictEqual(activity.pendingReview, null);
      assert.isFalse(activity.reviewThreads.some((thread) => thread.id.startsWith("105/")));
      assert.isFalse(
        calls(execute).some((request) => apiPath(request).endsWith("/reviews/105/comments")),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("walks timeline pages until a short page", () => {
    const page = (start: number, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        ...forgejoTimeline[2],
        id: start + index,
        created_at: `2026-03-11T08:${String(Math.floor((start + index) / 60) % 60).padStart(2, "0")}:${String((start + index) % 60).padStart(2, "0")}Z`,
      }));
    const { execute, layer } = setup([
      [
        "GET",
        `${repo}/issues/42/timeline`,
        (request) =>
          Response.json(urlParam(request, "page") === "1" ? page(1000, 50) : page(1050, 3)),
      ],
    ]);
    return Effect.gen(function* () {
      const forgejo = yield* ForgejoApi.ForgejoApi;
      const activity = yield* forgejo.getPullRequestActivity({ cwd: "/repo", reference: "42" });
      assert.strictEqual(activity.timeline.filter((item) => item.kind === "comment").length, 53);
      assert.deepStrictEqual(
        calls(execute)
          .filter((request) => apiPath(request).endsWith("/timeline"))
          .map((request) => urlParam(request, "page")),
        ["1", "2"],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads without a viewer when no token is configured", () => {
    const { layer } = makeForgejoApiTestLayer({
      env: { RYCO_FORGEJO_BASE_URL: "https://codeberg.test" },
      response: forgejoRoutes([
        ["GET", repo, () => Response.json({ ...forgejoBaseRepository, permissions: undefined })],
        ...readRoutes,
      ]),
    });
    return Effect.gen(function* () {
      const forgejo = yield* ForgejoApi.ForgejoApi;
      const activity = yield* forgejo.getPullRequestActivity({ cwd: "/repo", reference: "42" });
      assert.strictEqual(activity.viewer, null);
      assert.strictEqual(activity.pendingReview, null);
      assert.isTrue(activity.reviewThreads.every((thread) => !thread.viewerCanReply));
    }).pipe(Effect.provide(layer));
  });
});

describe("reviews", () => {
  it.effect("submits a review pinned to the expected head", () => {
    const { execute, layer } = setup([
      [
        "POST",
        `${pull}/reviews`,
        () => Response.json({ ...forgejoReviews[2], id: 120, dismissed: false }),
      ],
    ]);
    return Effect.gen(function* () {
      const forgejo = yield* ForgejoApi.ForgejoApi;
      const result = yield* forgejo.submitPullRequestReview({
        cwd: "/repo",
        reference: "42",
        event: "request_changes",
        body: "Please split this.",
        comments: [{ path: "src/app.ts", body: "here", line: 12, side: "right" }],
        expectedHeadSha: forgejoHeadSha,
      });
      assert.deepStrictEqual(result, {
        reviewId: "120",
        state: "changes_requested",
        url: "https://codeberg.test/pingdotgg/ryco/pulls/42#issuecomment-103",
      });
      assert.deepStrictEqual(writes(execute), [
        {
          method: "POST",
          path: `${pull}/reviews`,
          body: {
            event: "REQUEST_CHANGES",
            body: "Please split this.",
            commit_id: forgejoHeadSha,
            comments: [{ path: "src/app.ts", body: "here", new_position: 12 }],
          },
        },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses to review a moved head", () => {
    const { execute, layer } = setup();
    return Effect.gen(function* () {
      const forgejo = yield* ForgejoApi.ForgejoApi;
      const error = yield* forgejo
        .submitPullRequestReview({
          cwd: "/repo",
          reference: "42",
          event: "approve",
          comments: [],
          expectedHeadSha: "0".repeat(40),
        })
        .pipe(Effect.flip);
      assert.strictEqual(error.detail, FORGEJO_STALE_HEAD_DETAIL);
      assert.deepStrictEqual(writes(execute), []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("surfaces Forgejo's validation message", () => {
    const { layer } = setup([
      [
        "POST",
        `${pull}/reviews`,
        () =>
          Response.json(
            {
              message: "approve your own pull is not allowed",
              url: "https://codeberg.test/api/swagger",
            },
            { status: 422 },
          ),
      ],
    ]);
    return Effect.gen(function* () {
      const forgejo = yield* ForgejoApi.ForgejoApi;
      const error = yield* forgejo
        .submitPullRequestReview({
          cwd: "/repo",
          reference: "42",
          event: "approve",
          comments: [],
          expectedHeadSha: forgejoHeadSha,
        })
        .pipe(Effect.flip);
      assert.strictEqual(error.status, 422);
      assert.strictEqual(
        error.detail,
        "Forgejo returned HTTP 422: approve your own pull is not allowed",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("replies into the opener's review on the same line and returns the thread", () => {
    let replied = false;
    const reply = {
      ...forgejoReviewComments[101]![1],
      id: 320,
      user: bob,
      body: "Agreed.",
      created_at: "2026-03-14T11:00:00Z",
    };
    const { execute, layer } = setup([
      [
        "POST",
        `${pull}/reviews/101/comments`,
        () => {
          replied = true;
          return Response.json(reply);
        },
      ],
      [
        "GET",
        `${pull}/reviews/101/comments`,
        () => Response.json([...forgejoReviewComments[101]!, ...(replied ? [reply] : [])]),
      ],
      ["GET", `${pull}/reviews/101`, () => Response.json(forgejoReviews[0])],
    ]);
    return Effect.gen(function* () {
      const forgejo = yield* ForgejoApi.ForgejoApi;
      const thread = yield* forgejo.replyToPullRequestReviewThread({
        cwd: "/repo",
        reference: "42",
        threadId: "101/301",
        body: "Agreed.",
      });
      assert.strictEqual(thread.id, "101/301");
      assert.deepStrictEqual(
        thread.comments.map((comment) => comment.id),
        ["101:301", "101:302", "101:320"],
      );
      assert.deepStrictEqual(writes(execute), [
        {
          method: "POST",
          path: `${pull}/reviews/101/comments`,
          body: { path: "src/app.ts", body: "Agreed.", new_position: 12 },
        },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("replies on the base side with old_position, once per client mutation", () => {
    const { execute, layer } = setup([
      ["POST", `${pull}/reviews/101/comments`, () => Response.json({})],
      ["GET", `${pull}/reviews/101`, () => Response.json(forgejoReviews[0])],
    ]);
    return Effect.gen(function* () {
      const forgejo = yield* ForgejoApi.ForgejoApi;
      yield* forgejo.replyToPullRequestReviewThread({
        cwd: "/repo",
        reference: "42",
        threadId: "101/303",
        body: "Because it is unused.",
        clientMutationId: "m-1",
      });
      const [post] = writes(execute);
      assert.deepInclude(post?.body as object, { path: "src/setup.ts", old_position: 5 });
      assert.match(bodyText(post), /<!-- ryco-comment-id:[a-f0-9]{64} -->$/u);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails clearly when the thread is gone", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const forgejo = yield* ForgejoApi.ForgejoApi;
      const error = yield* forgejo
        .replyToPullRequestReviewThread({
          cwd: "/repo",
          reference: "42",
          threadId: "101/999",
          body: "hello",
        })
        .pipe(Effect.flip);
      assert.strictEqual(error.detail, "This conversation no longer exists on Forgejo.");
    }).pipe(Effect.provide(layer));
  });
});

describe("comments and reactions", () => {
  it.effect("posts a comment once per client mutation id", () => {
    const { execute, layer } = setup([
      ["GET", `${repo}/issues/42/comments`, () => Response.json([])],
      ["POST", `${repo}/issues/42/comments`, () => Response.json({ id: 950 }, { status: 201 })],
    ]);
    return Effect.gen(function* () {
      const forgejo = yield* ForgejoApi.ForgejoApi;
      yield* forgejo.addPullRequestComment({
        cwd: "/repo",
        reference: "42",
        body: "Thanks!",
        clientMutationId: "c-1",
      });
      const [post] = writes(execute);
      assert.strictEqual(post?.path, `${repo}/issues/42/comments`);
      assert.match(bodyText(post), /^Thanks!\n\n<!-- ryco-comment-id:/u);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not repost a comment whose marker is already there", () => {
    const { execute, layer } = setup([
      [
        "GET",
        `${repo}/issues/42/comments`,
        () =>
          Response.json([
            {
              id: 950,
              body: appendCommentMutationMarker("Thanks!", "c-1"),
              user: alice,
              created_at: "2026-03-14T10:00:00Z",
            },
          ]),
      ],
    ]);
    return Effect.gen(function* () {
      const forgejo = yield* ForgejoApi.ForgejoApi;
      yield* forgejo.addPullRequestComment({
        cwd: "/repo",
        reference: "42",
        body: "Thanks!",
        clientMutationId: "c-1",
      });
      assert.deepStrictEqual(writes(execute), []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("toggles the viewer's reaction", () => {
    const { execute, layer } = setup([
      ["POST", `${repo}/issues/comments/902/reactions`, () => Response.json({}, { status: 201 })],
      ["DELETE", `${repo}/issues/comments/902/reactions`, () => Response.json({})],
    ]);
    return Effect.gen(function* () {
      const forgejo = yield* ForgejoApi.ForgejoApi;
      yield* forgejo.togglePullRequestCommentReaction({
        cwd: "/repo",
        reference: "42",
        commentId: "902",
        content: "thumbs-up",
      });
      // Alice already reacted with a heart: it is removed.
      yield* forgejo.togglePullRequestCommentReaction({
        cwd: "/repo",
        reference: "42",
        commentId: "902",
        content: "heart",
      });
      assert.deepStrictEqual(writes(execute), [
        { method: "POST", path: `${repo}/issues/comments/902/reactions`, body: { content: "+1" } },
        {
          method: "DELETE",
          path: `${repo}/issues/comments/902/reactions`,
          body: { content: "heart" },
        },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reacts to review comments by their comment id", () => {
    const { execute, layer } = setup([
      ["GET", `${repo}/issues/comments/301/reactions`, () => Response.json([])],
      ["POST", `${repo}/issues/comments/301/reactions`, () => Response.json({}, { status: 201 })],
    ]);
    return Effect.gen(function* () {
      const forgejo = yield* ForgejoApi.ForgejoApi;
      yield* forgejo.togglePullRequestCommentReaction({
        cwd: "/repo",
        reference: "42",
        commentId: "101:301",
        content: "eyes",
      });
      assert.deepStrictEqual(writes(execute)[0]?.path, `${repo}/issues/comments/301/reactions`);
    }).pipe(Effect.provide(layer));
  });

  it.effect("edits and deletes comments by kind", () => {
    const { execute, layer } = setup([
      ["PATCH", `${repo}/issues/comments/902`, () => Response.json({ id: 902, body: "Edited" })],
      ["PATCH", `${repo}/issues/comments/301`, () => Response.json({ id: 301, body: "Edited" })],
      ["DELETE", `${repo}/issues/comments/902`, () => new Response(null, { status: 204 })],
      ["DELETE", `${pull}/reviews/101/comments/301`, () => new Response(null, { status: 204 })],
    ]);
    return Effect.gen(function* () {
      const forgejo = yield* ForgejoApi.ForgejoApi;
      const base = { cwd: "/repo", reference: "42" } as const;
      assert.deepStrictEqual(
        yield* forgejo.updatePullRequestComment({
          ...base,
          commentId: "902",
          commentKind: "issue-comment",
          action: "edit",
          body: "Edited",
        }),
        { commentId: "902", deleted: false },
      );
      yield* forgejo.updatePullRequestComment({
        ...base,
        commentId: "101:301",
        commentKind: "review-comment",
        action: "edit",
        body: "Edited",
      });
      yield* forgejo.updatePullRequestComment({
        ...base,
        commentId: "902",
        commentKind: "issue-comment",
        action: "delete",
      });
      assert.deepStrictEqual(
        yield* forgejo.updatePullRequestComment({
          ...base,
          commentId: "101:301",
          commentKind: "review-comment",
          action: "delete",
        }),
        { commentId: "101:301", deleted: true },
      );
      assert.deepStrictEqual(
        writes(execute).map((write) => [write.method, write.path]),
        [
          ["PATCH", `${repo}/issues/comments/902`],
          ["PATCH", `${repo}/issues/comments/301`],
          ["DELETE", `${repo}/issues/comments/902`],
          ["DELETE", `${pull}/reviews/101/comments/301`],
        ],
      );
      const review = yield* forgejo
        .updatePullRequestComment({
          ...base,
          commentId: "903",
          commentKind: "review",
          action: "edit",
          body: "x",
        })
        .pipe(Effect.flip);
      assert.strictEqual(review.detail, "Forgejo review summaries cannot be edited from Ryco.");
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports an edit Forgejo answered without content", () => {
    const { layer } = setup([
      ["PATCH", `${repo}/issues/comments/902`, () => new Response(null, { status: 204 })],
    ]);
    return Effect.gen(function* () {
      const forgejo = yield* ForgejoApi.ForgejoApi;
      const error = yield* forgejo
        .updatePullRequestComment({
          cwd: "/repo",
          reference: "42",
          commentId: "902",
          commentKind: "issue-comment",
          action: "edit",
          body: "Edited",
        })
        .pipe(Effect.flip);
      assert.strictEqual(error.detail, "Forgejo did not edit this comment.");
    }).pipe(Effect.provide(layer));
  });
});

describe("mergePullRequest", () => {
  it.effect("merges with the head precondition, then deletes the head branch", () => {
    const { execute, layer } = setup([
      ["POST", `${pull}/merge`, () => new Response(null, { status: 200 })],
      ["DELETE", `${repo}/branches/feature/review-page`, () => new Response(null, { status: 204 })],
    ]);
    return Effect.gen(function* () {
      const forgejo = yield* ForgejoApi.ForgejoApi;
      const result = yield* forgejo.mergePullRequest({
        cwd: "/repo",
        reference: "42",
        mergeMethod: "rebase",
        deleteBranch: true,
        expectedHeadSha: forgejoHeadSha,
      });
      assert.deepStrictEqual(result, { outcome: "merged" });
      assert.deepStrictEqual(writes(execute), [
        {
          method: "POST",
          path: `${pull}/merge`,
          body: { Do: "rebase", head_commit_id: forgejoHeadSha },
        },
        { method: "DELETE", path: `${repo}/branches/feature/review-page`, body: null },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps Forgejo's head-out-of-date conflict to the stale-head error", () => {
    const { layer } = setup([
      [
        "POST",
        `${pull}/merge`,
        () => Response.json({ message: "head out of date", url: "" }, { status: 409 }),
      ],
    ]);
    return Effect.gen(function* () {
      const forgejo = yield* ForgejoApi.ForgejoApi;
      const error = yield* forgejo
        .mergePullRequest({
          cwd: "/repo",
          reference: "42",
          mergeMethod: "merge",
          expectedHeadSha: forgejoHeadSha,
        })
        .pipe(Effect.flip);
      assert.strictEqual(error.detail, FORGEJO_STALE_HEAD_DETAIL);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a moved head or a disabled method before merging", () => {
    const { execute, layer } = setup();
    return Effect.gen(function* () {
      const forgejo = yield* ForgejoApi.ForgejoApi;
      const moved = yield* forgejo
        .mergePullRequest({
          cwd: "/repo",
          reference: "42",
          mergeMethod: "merge",
          expectedHeadSha: "0".repeat(40),
        })
        .pipe(Effect.flip);
      assert.strictEqual(moved.detail, FORGEJO_STALE_HEAD_DETAIL);
      const squash = yield* forgejo
        .mergePullRequest({ cwd: "/repo", reference: "42", mergeMethod: "squash" })
        .pipe(Effect.flip);
      assert.strictEqual(squash.detail, "The squash merge method is disabled for this repository.");
      assert.deepStrictEqual(writes(execute), []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports the merge even when the branch cleanup fails", () => {
    const { layer } = setup([
      ["POST", `${pull}/merge`, () => new Response(null, { status: 200 })],
      [
        "DELETE",
        `${repo}/branches/feature/review-page`,
        () => Response.json({ message: "branch protected" }, { status: 403 }),
      ],
    ]);
    return Effect.gen(function* () {
      const forgejo = yield* ForgejoApi.ForgejoApi;
      const result = yield* forgejo.mergePullRequest({
        cwd: "/repo",
        reference: "42",
        mergeMethod: "merge",
        deleteBranch: true,
      });
      assert.deepStrictEqual(result, { outcome: "merged" });
    }).pipe(Effect.provide(layer));
  });
});

describe("updatePullRequest", () => {
  const update = (
    action: Parameters<ForgejoApi.ForgejoApiShape["updatePullRequest"]>[0]["action"],
  ) =>
    Effect.gen(function* () {
      const forgejo = yield* ForgejoApi.ForgejoApi;
      return yield* forgejo.updatePullRequest({ cwd: "/repo", reference: "42", action });
    });

  it.effect("edits, closes, reopens and toggles drafts through the pull request", () => {
    const { execute, layer } = setup([
      [
        "PATCH",
        pull,
        (request) => {
          const body = requestJsonBody(request) as { title?: string; state?: string };
          return Response.json(
            {
              ...forgejoPullRequest,
              ...(body.title ? { title: body.title, draft: body.title.startsWith("WIP:") } : {}),
              ...(body.state ? { state: body.state } : {}),
            },
            { status: 201 },
          );
        },
      ],
    ]);
    return Effect.gen(function* () {
      yield* update({ kind: "edit", title: "New title", body: "", baseRefName: "develop" });
      yield* update({ kind: "set-draft", draft: true });
      yield* update({ kind: "close" });
      yield* update({ kind: "reopen" });
      assert.deepStrictEqual(
        writes(execute).map((write) => write.body),
        [
          { title: "New title", body: "", base: "develop" },
          { title: "WIP: Add Forgejo review page" },
          { state: "closed" },
          { state: "open" },
        ],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("puts the title back when the instance does not read `WIP:` as a draft", () => {
    const { execute, layer } = setup([
      [
        "PATCH",
        pull,
        (request) =>
          Response.json(
            {
              ...forgejoPullRequest,
              title: (requestJsonBody(request) as { title: string }).title,
              draft: false,
            },
            { status: 201 },
          ),
      ],
    ]);
    return Effect.gen(function* () {
      const error = yield* update({ kind: "set-draft", draft: true }).pipe(Effect.flip);
      assert.include(error.detail, "does not use the `WIP:` title prefix");
      assert.deepStrictEqual(
        writes(execute).map((write) => write.body),
        [{ title: "WIP: Add Forgejo review page" }, { title: "Add Forgejo review page" }],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("edits reviewers, labels and assignees with Forgejo's shapes", () => {
    const { execute, layer } = setup([
      ["POST", `${pull}/requested_reviewers`, () => Response.json([], { status: 201 })],
      ["DELETE", `${pull}/requested_reviewers`, () => new Response(null, { status: 204 })],
      [
        "GET",
        `${repo}/labels`,
        () =>
          Response.json([
            {
              id: 7,
              name: "enhancement",
              color: "84b6eb",
              description: "",
              exclusive: false,
              is_archived: false,
              url: "",
            },
            {
              id: 8,
              name: "bug",
              color: "ee0701",
              description: "",
              exclusive: false,
              is_archived: false,
              url: "",
            },
          ]),
      ],
      ["POST", `${repo}/issues/42/labels`, () => Response.json([])],
      ["DELETE", `${repo}/issues/42/labels/7`, () => new Response(null, { status: 204 })],
      ["PATCH", pull, () => Response.json(forgejoPullRequest, { status: 201 })],
    ]);
    return Effect.gen(function* () {
      yield* update({ kind: "reviewers", add: ["carol", "pingdotgg/core"], remove: ["erin"] });
      yield* update({ kind: "labels", add: ["bug"], remove: ["enhancement"] });
      yield* update({ kind: "assignees", add: ["dave"], remove: ["bob"] });
      assert.deepStrictEqual(writes(execute), [
        {
          method: "POST",
          path: `${pull}/requested_reviewers`,
          body: { reviewers: ["carol"], team_reviewers: ["core"] },
        },
        {
          method: "DELETE",
          path: `${pull}/requested_reviewers`,
          body: { reviewers: ["erin"], team_reviewers: [] },
        },
        { method: "POST", path: `${repo}/issues/42/labels`, body: { labels: [8] } },
        { method: "DELETE", path: `${repo}/issues/42/labels/7`, body: null },
        { method: "PATCH", path: pull, body: { assignees: ["dave"] } },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("updates the branch only from the expected head", () => {
    const { execute, layer } = setup([
      ["POST", `${pull}/update`, () => new Response(null, { status: 200 })],
    ]);
    return Effect.gen(function* () {
      yield* update({ kind: "update-branch", method: "rebase", expectedHeadSha: forgejoHeadSha });
      const stale = yield* update({
        kind: "update-branch",
        method: "merge",
        expectedHeadSha: "0".repeat(40),
      }).pipe(Effect.flip);
      assert.strictEqual(stale.detail, FORGEJO_STALE_HEAD_DETAIL);
      assert.deepStrictEqual(writes(execute), [
        { method: "POST", path: `${pull}/update`, style: "rebase", body: null },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("deletes the head branch only once the pull request is closed", () => {
    const { execute, layer } = setup();
    return Effect.gen(function* () {
      const error = yield* update({ kind: "delete-branch" }).pipe(Effect.flip);
      assert.strictEqual(
        error.detail,
        "Close or merge the pull request before deleting its branch.",
      );
      assert.deepStrictEqual(writes(execute), []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("treats an already deleted branch as deleted", () => {
    const { execute, layer } = setup([
      ["GET", pull, () => Response.json({ ...forgejoPullRequest, state: "closed", merged: true })],
    ]);
    return Effect.gen(function* () {
      yield* update({ kind: "delete-branch" });
      assert.deepStrictEqual(writes(execute), [
        { method: "DELETE", path: `${repo}/branches/feature/review-page`, body: null },
      ]);
    }).pipe(Effect.provide(layer));
  });
});

describe("files and diffs", () => {
  it.effect("reads both sides from the merge base and the head", () => {
    const { execute, layer } = setup([
      [
        "GET",
        `${repo}/raw/src/app.ts`,
        (request) =>
          new Response(urlParam(request, "ref") === forgejoMergeBaseSha ? "old\n" : "new\n"),
      ],
    ]);
    return Effect.gen(function* () {
      const forgejo = yield* ForgejoApi.ForgejoApi;
      const contents = yield* forgejo.getPullRequestFileContents({
        cwd: "/repo",
        reference: "42",
        path: "src/app.ts",
        headSha: forgejoHeadSha,
      });
      assert.deepStrictEqual(contents, {
        path: "src/app.ts",
        oldContents: "old\n",
        newContents: "new\n",
        truncated: false,
      });
      assert.deepStrictEqual(
        calls(execute)
          .filter((request) => apiPath(request).startsWith(`${repo}/raw/`))
          .map((request) => urlParam(request, "ref"))
          .toSorted(),
        [forgejoMergeBaseSha, forgejoHeadSha].toSorted(),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports added, binary, and oversized files", () => {
    const big = "x".repeat(1024 * 1024 + 10);
    const { layer } = setup([
      [
        "GET",
        `${repo}/raw/added.ts`,
        (request) =>
          urlParam(request, "ref") === "base"
            ? Response.json({ message: "not found" }, { status: 404 })
            : new Response("hi"),
      ],
      ["GET", `${repo}/raw/image.png`, () => new Response(new Uint8Array([137, 80, 0, 71]))],
      ["GET", `${repo}/raw/big.txt`, () => new Response(big)],
    ]);
    return Effect.gen(function* () {
      const forgejo = yield* ForgejoApi.ForgejoApi;
      const read = (path: string) =>
        forgejo.getPullRequestFileContents({
          cwd: "/repo",
          reference: "42",
          path,
          baseSha: "base",
          headSha: forgejoHeadSha,
        });
      const added = yield* read("added.ts");
      assert.deepStrictEqual([added.oldContents, added.newContents], [null, "hi"]);
      const binary = yield* read("image.png");
      assert.deepStrictEqual([binary.oldContents, binary.newContents], [null, null]);
      const oversized = yield* read("big.txt");
      assert.isTrue(oversized.truncated);
      assert.strictEqual(oversized.newContents?.length, 1024 * 1024);
      const invalid = yield* read("../secret").pipe(Effect.flip);
      assert.strictEqual(invalid.detail, "Invalid repository file path: ../secret");
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads one commit's diff only for the pull request's commits", () => {
    const { execute, layer } = setup([
      [
        "GET",
        `${repo}/git/commits/${forgejoHeadSha}.diff`,
        () => new Response("diff --git a/x b/x\n"),
      ],
    ]);
    return Effect.gen(function* () {
      const forgejo = yield* ForgejoApi.ForgejoApi;
      const diff = yield* forgejo.getPullRequestDiff({
        cwd: "/repo",
        reference: "42",
        commitSha: forgejoHeadSha.slice(0, 10),
        expectedHeadSha: forgejoHeadSha,
      });
      assert.strictEqual(diff, "diff --git a/x b/x\n");
      const foreign = yield* forgejo
        .getPullRequestDiff({ cwd: "/repo", reference: "42", commitSha: "deadbeefdeadbeef" })
        .pipe(Effect.flip);
      assert.strictEqual(
        foreign.detail,
        "Commit deadbeefdeadbeef is not part of pull request #42.",
      );
      assert.isTrue(
        calls(execute).some(
          (request) => apiPath(request) === `${repo}/git/commits/${forgejoHeadSha}.diff`,
        ),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a diff whose head moved", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const forgejo = yield* ForgejoApi.ForgejoApi;
      const error = yield* forgejo
        .getPullRequestDiff({ cwd: "/repo", reference: "42", expectedHeadSha: "0".repeat(40) })
        .pipe(Effect.flip);
      assert.strictEqual(
        error.detail,
        "Pull request changed while loading the diff. Refresh and try again.",
      );
    }).pipe(Effect.provide(layer));
  });
});

describe("lists", () => {
  const issue = (number: number, updatedAt: string, fullName = "pingdotgg/ryco") => ({
    id: 600 + number,
    number,
    title: `PR ${number}`,
    state: "open",
    updated_at: updatedAt,
    pull_request: { merged: false, merged_at: null, draft: false, html_url: "" },
    repository: { id: 12, name: "ryco", owner: "pingdotgg", full_name: fullName },
  });

  it.effect("unions the involvement filters for `involved` and adds readiness", () => {
    const { execute, layer } = setup([
      [
        "GET",
        `${repo}/issues`,
        (request) =>
          Response.json(
            urlParam(request, "created_by") === "alice"
              ? [issue(42, "2026-03-14T10:00:00Z")]
              : urlParam(request, "assigned_by") === "alice"
                ? [issue(42, "2026-03-14T10:00:00Z")]
                : [],
          ),
      ],
      [
        "GET",
        "/repos/issues/search",
        () =>
          Response.json([
            issue(44, "2026-03-15T10:00:00Z"),
            issue(9, "2026-03-16T10:00:00Z", "other/repo"),
          ]),
      ],
      [
        "GET",
        `${repo}/pulls/44`,
        () =>
          Response.json({
            ...forgejoPullRequest,
            number: 44,
            head: { ...forgejoPullRequest.head, sha: "a".repeat(40) },
          }),
      ],
      [
        "GET",
        /\/commits\/a{40}\/status$/u,
        () => Response.json({ state: "success", statuses: [] }),
      ],
    ]);
    return Effect.gen(function* () {
      const forgejo = yield* ForgejoApi.ForgejoApi;
      const rows = yield* forgejo.listInvolvedPullRequests({
        cwd: "/repo",
        involvement: "involved",
        state: "open",
        query: "review",
      });
      assert.deepStrictEqual(
        rows.map((row) => row.number),
        [44, 42],
      );
      // Rows carry the head's statuses and mergeability; reviews and branch
      // rules (the verdict) are left to the detail.
      assert.strictEqual(rows[1]?.readiness?.checkRollup?.length, 3);
      assert.strictEqual(rows[1]?.readiness?.mergeability, "mergeable");
      assert.isUndefined(rows[1]?.readiness?.reviewDecision);
      assert.isUndefined(rows[1]?.readiness?.mergeStateStatus);

      const requests = calls(execute);
      assert.isFalse(requests.some((request) => apiPath(request).endsWith("/reviews")));
      assert.isFalse(requests.some((request) => apiPath(request).includes("/branches/")));
      const filters = requests
        .filter((request) => apiPath(request) === `${repo}/issues`)
        .map((request) =>
          ["created_by", "assigned_by", "mentioned_by"].find(
            (name) => urlParam(request, name) === "alice",
          ),
        )
        .toSorted();
      assert.deepStrictEqual(filters, ["assigned_by", "created_by", "mentioned_by"]);
      const search = requests.find((request) => apiPath(request) === "/repos/issues/search");
      assert.strictEqual(urlParam(search!, "review_requested"), "true");
      assert.strictEqual(urlParam(search!, "owner"), "pingdotgg");
      assert.strictEqual(urlParam(search!, "type"), "pulls");
      assert.strictEqual(urlParam(search!, "q"), "review");
    }).pipe(Effect.provide(layer));
  });

  it.effect("needs a signed-in viewer for involvement filters", () => {
    const { layer } = makeForgejoApiTestLayer({
      env: { RYCO_FORGEJO_BASE_URL: "https://codeberg.test" },
      response: forgejoRoutes(readRoutes),
    });
    return Effect.gen(function* () {
      const forgejo = yield* ForgejoApi.ForgejoApi;
      const error = yield* forgejo
        .listInvolvedPullRequests({ cwd: "/repo", involvement: "authored", state: "open" })
        .pipe(Effect.flip);
      assert.include(error.detail, "to filter pull requests by involvement");
    }).pipe(Effect.provide(layer));
  });

  it.effect("lists every head for the page and reads readiness for open rows", () => {
    const { execute, layer } = setup([
      [
        "GET",
        `${repo}/pulls`,
        () =>
          Response.json([
            forgejoPullRequest,
            { ...forgejoPullRequest, number: 41, state: "closed", merged: true },
          ]),
      ],
    ]);
    return Effect.gen(function* () {
      const forgejo = yield* ForgejoApi.ForgejoApi;
      const rows = yield* forgejo.listPullRequests({
        cwd: "/repo",
        headSelector: "",
        state: "all",
      });
      assert.deepStrictEqual(
        rows.map((row) => [row.number, row.state, row.readiness !== undefined]),
        [
          [42, "open", true],
          [41, "merged", false],
        ],
      );
      const statusReads = calls(execute).filter((request) => apiPath(request).endsWith("/status"));
      assert.strictEqual(statusReads.length, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads each row and head once across the lists the page polls together", () => {
    const { execute, layer } = setup([
      ["GET", `${repo}/pulls`, () => Response.json([forgejoPullRequest])],
      // The authored list names the same pull request at the same update.
      ["GET", `${repo}/issues`, () => Response.json([issue(42, forgejoPullRequest.updated_at)])],
    ]);
    return Effect.gen(function* () {
      const forgejo = yield* ForgejoApi.ForgejoApi;
      const state = yield* forgejo.listPullRequests({
        cwd: "/repo",
        headSelector: "",
        state: "open",
      });
      const authored = yield* forgejo.listInvolvedPullRequests({
        cwd: "/repo",
        involvement: "authored",
        state: "open",
      });
      assert.deepStrictEqual(
        [...state, ...authored].map((row) => row.readiness?.checkRollup?.length),
        [3, 3],
      );
      const requests = calls(execute);
      assert.strictEqual(requests.filter((r) => apiPath(r).endsWith("/status")).length, 1);
      assert.strictEqual(requests.filter((r) => apiPath(r) === pull).length, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("searches through the host's issue search", () => {
    const { execute, layer } = setup([
      ["GET", `${repo}/issues`, () => Response.json([issue(42, "2026-03-14T10:00:00Z")])],
    ]);
    return Effect.gen(function* () {
      const forgejo = yield* ForgejoApi.ForgejoApi;
      const rows = yield* forgejo.searchPullRequests({ cwd: "/repo", query: "review page" });
      assert.deepStrictEqual(
        rows.map((row) => row.number),
        [42],
      );
      const search = calls(execute).find((request) => apiPath(request) === `${repo}/issues`);
      assert.strictEqual(urlParam(search!, "q"), "review page");
      assert.strictEqual(urlParam(search!, "type"), "pulls");
    }).pipe(Effect.provide(layer));
  });
});

describe("createPullRequest", () => {
  const createDraft = (draftOnHost: boolean) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const bodyFile = yield* fileSystem.makeTempFileScoped({ prefix: "forgejo-pr-body-" });
      yield* fileSystem.writeFileString(bodyFile, "Body");
      const { execute, layer } = setup([
        [
          "POST",
          `${repo}/pulls`,
          (request) => {
            const title = (requestJsonBody(request) as { title: string }).title;
            return Response.json(
              { ...forgejoPullRequest, title, draft: draftOnHost && title.startsWith("WIP:") },
              { status: 201 },
            );
          },
        ],
      ]);
      const result = yield* Effect.gen(function* () {
        const forgejo = yield* ForgejoApi.ForgejoApi;
        return yield* forgejo.createPullRequest({
          cwd: "/repo",
          baseBranch: "main",
          headSelector: "feature/review-page",
          title: "Add page",
          bodyFile,
          draft: true,
        });
      }).pipe(Effect.provide(layer), Effect.result);
      return { result, writes: writes(execute) };
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

  it.effect("opens drafts with Forgejo's work-in-progress prefix", () =>
    Effect.gen(function* () {
      const { result, writes } = yield* createDraft(true);
      assert.strictEqual(result._tag, "Success");
      assert.deepInclude(writes[0]?.body as object, { title: "WIP: Add page", body: "Body" });
    }),
  );

  it.effect("says so when the instance did not open it as a draft", () =>
    Effect.gen(function* () {
      const { result } = yield* createDraft(false);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.include(result.failure.message, "Opened #42, but this Forgejo instance");
      }
    }),
  );
});

describe("lookups", () => {
  it.effect("lists label and assignee candidates", () => {
    const { layer } = setup([
      [
        "GET",
        `${repo}/labels`,
        () =>
          Response.json([
            { id: 7, name: "enhancement", color: "84b6eb", description: "New feature" },
          ]),
      ],
      [
        "GET",
        "/orgs/pingdotgg/labels",
        () => Response.json([{ id: 90, name: "org-wide", color: "#000000", description: "" }]),
      ],
      ["GET", `${repo}/assignees`, () => Response.json([alice, bob])],
    ]);
    return Effect.gen(function* () {
      const forgejo = yield* ForgejoApi.ForgejoApi;
      assert.deepStrictEqual(yield* forgejo.listLabels({ cwd: "/repo" }), [
        { name: "enhancement", color: "84b6eb", description: "New feature" },
        { name: "org-wide", color: "000000" },
      ]);
      assert.deepStrictEqual(yield* forgejo.listAssignees({ cwd: "/repo" }), [
        { login: "alice", displayName: "Alice", avatarUrl: "https://codeberg.test/avatars/alice" },
        { login: "bob", displayName: "Bob", avatarUrl: "https://codeberg.test/avatars/bob" },
      ]);
    }).pipe(Effect.provide(layer));
  });
});

it.effect("caches the viewer login per instance", () => {
  const { execute, layer } = setup();
  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    yield* forgejo.getPullRequestActivity({ cwd: "/repo", reference: "42" });
    yield* forgejo.getPullRequestActivity({ cwd: "/repo", reference: "42" });
    assert.strictEqual(calls(execute).filter((request) => apiPath(request) === "/user").length, 1);
  }).pipe(Effect.provide(layer));
});
