import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import type { HttpClientRequest } from "effect/unstable/http";

import * as BitbucketApi from "./BitbucketApi.ts";
import { makeLayer } from "./bitbucketApiTestLayer.ts";
import * as Fixtures from "./bitbucketPullRequestPageFixtures.ts";
import { STALE_HEAD_DETAIL } from "./bitbucketPullRequestPageApi.ts";

const API = "https://api.test.local/2.0";
const REPO = "/repositories/atlassian/atlaskit-mk-2";
const PR = `${REPO}/pullrequests/${Fixtures.PULL_REQUEST_ID}`;
const target = { cwd: "/repo", reference: String(Fixtures.PULL_REQUEST_ID) } as const;

type Handler = (request: HttpClientRequest.HttpClientRequest) => Response;

/** Answer `METHOD /path` (path after the API base); anything else is a 404. */
function routed(routes: Readonly<Record<string, Response | Handler>>) {
  return makeLayer({
    remoteUrl: "git@bitbucket.org:atlassian/atlaskit-mk-2.git",
    response: (request) => {
      const path = request.url.startsWith(API) ? request.url.slice(API.length) : request.url;
      const route = routes[`${request.method} ${path}`];
      if (!route) {
        return Response.json(
          { type: "error", error: { message: `No route for ${request.method} ${path}` } },
          { status: 404 },
        );
      }
      return typeof route === "function" ? route(request) : (route.clone() as Response);
    },
  });
}

function calls(execute: ReturnType<typeof makeLayer>["execute"]) {
  return execute.mock.calls.map(
    ([request]) => `${request.method} ${request.url.slice(API.length)}`,
  );
}

function jsonBody(request: HttpClientRequest.HttpClientRequest | undefined): unknown {
  const raw = (request?.body as { readonly body?: Uint8Array } | undefined)?.body;
  return raw ? JSON.parse(new TextDecoder().decode(raw)) : undefined;
}

function find(
  execute: ReturnType<typeof makeLayer>["execute"],
  method: string,
  path: string,
): HttpClientRequest.HttpClientRequest | undefined {
  return execute.mock.calls
    .map(([request]) => request)
    .find((request) => request.method === method && request.url === `${API}${path}`);
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const noContent = () => new Response(null, { status: 204 });

const readRoutes = {
  [`GET ${PR}`]: json(Fixtures.pullRequest),
  "GET /user": json(Fixtures.viewer),
  "GET /user/workspaces/atlassian/permissions/repositories": json(Fixtures.permissionsPage),
  [`GET ${PR}/activity`]: json(Fixtures.activityPage),
  [`GET ${PR}/comments`]: json(Fixtures.commentsPage),
  [`GET ${PR}/commits`]: json(Fixtures.commitsPage),
};

describe("Bitbucket pull request activity", () => {
  it.effect("reads the timeline, threads and viewer with bounded, newest-first reads", () => {
    const { execute, layer } = routed(readRoutes);
    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      const activity = yield* bitbucket.getPullRequestActivity(target);
      assert.strictEqual(activity.provider, "bitbucket");
      assert.strictEqual(activity.number, Fixtures.PULL_REQUEST_ID);
      // The abbreviated head resolves to the full hash through the commit list.
      assert.strictEqual(activity.headSha, Fixtures.HEAD_SHA);
      assert.strictEqual(activity.viewer?.login, "Jessica Yeh");
      assert.strictEqual(activity.viewer?.canMerge, true);
      assert.deepStrictEqual(
        activity.reviewThreads.map((thread) => thread.id),
        ["118571000", "118571088", "118571600"],
      );
      assert.strictEqual(activity.timeline.length, 8);
      assert.isFalse(activity.timelineTruncated);

      const comments = find(execute, "GET", `${PR}/comments`);
      assert.deepStrictEqual(comments?.urlParams.params, [
        ["pagelen", "100"],
        ["sort", "-created_on"],
      ]);
      assert.deepStrictEqual(find(execute, "GET", `${PR}/activity`)?.urlParams.params, [
        ["pagelen", "50"],
      ]);
      assert.deepStrictEqual(
        find(execute, "GET", "/user/workspaces/atlassian/permissions/repositories")?.urlParams
          .params,
        [
          ["q", 'repository.full_name ~ "atlassian/atlaskit-mk-2"'],
          ["pagelen", "100"],
        ],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("follows next links up to the page cap and reports truncation", () => {
    let page = 0;
    const { execute, layer } = routed({
      ...readRoutes,
      [`GET ${PR}/comments`]: () => {
        page += 1;
        return json({ values: [], next: `${API}${PR}/comments?page=${page + 1}` });
      },
      [`GET ${PR}/comments?page=2`]: () =>
        json({ values: [], next: `${API}${PR}/comments?page=3` }),
      [`GET ${PR}/comments?page=3`]: () =>
        json({ values: [], next: `${API}${PR}/comments?page=4` }),
      [`GET ${PR}/comments?page=4`]: () =>
        json({ values: [], next: `${API}${PR}/comments?page=5` }),
      [`GET ${PR}/comments?page=5`]: () =>
        json({ values: [], next: `${API}${PR}/comments?page=6` }),
    });
    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      const activity = yield* bitbucket.getPullRequestActivity(target);
      assert.isTrue(activity.timelineTruncated);
      assert.isTrue(activity.reviewThreadsTruncated);
      assert.strictEqual(calls(execute).filter((call) => call.includes("/comments")).length, 5);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses to send credentials to a pagination link off the API", () => {
    const { layer } = routed({
      ...readRoutes,
      [`GET ${PR}/activity`]: json({ values: [], next: "https://evil.example.com/2.0/next" }),
    });
    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      const error = yield* bitbucket.getPullRequestActivity(target).pipe(Effect.flip);
      assert.include(error.detail, "pagination link off its API");
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects references that are not pull request numbers", () => {
    const { execute, layer } = routed(readRoutes);
    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      const error = yield* bitbucket
        .getPullRequestActivity({ cwd: "/repo", reference: "../../admin" })
        .pipe(Effect.flip);
      assert.include(error.detail, "Invalid Bitbucket pull request id");
      assert.strictEqual(execute.mock.calls.length, 0);
    }).pipe(Effect.provide(layer));
  });
});

describe("Bitbucket pull request detail", () => {
  it.effect("adds the full head, ordered commits, reviewers, readiness and checks", () => {
    const { layer } = routed({
      ...readRoutes,
      [`GET ${PR}/comments`]: json({ values: [] }),
      [`GET ${PR}/statuses`]: json(Fixtures.statusesPage),
      [`GET ${PR}/mergeability/checks`]: json(Fixtures.mergeabilityChecks),
    });
    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      const detail = yield* bitbucket.getPullRequestDetail(target);
      assert.strictEqual(detail.headSha, Fixtures.HEAD_SHA);
      assert.deepStrictEqual(
        detail.commits?.map((commit) => commit.oid),
        [Fixtures.PARENT_SHA, Fixtures.HEAD_SHA],
      );
      assert.deepStrictEqual(
        detail.reviewerStates?.map((reviewer) => [reviewer.login, reviewer.state]),
        [
          ["Jessica Yeh", "approved"],
          ["Brodie Rao", "changes_requested"],
        ],
      );
      assert.strictEqual(detail.reviewDecision, "changes_requested");
      assert.strictEqual(detail.mergeability, "mergeable");
      assert.strictEqual(detail.mergeStateStatus, "clean");
      assert.deepStrictEqual(detail.mergeCapabilities, { merge: true, squash: true, rebase: true });
      assert.strictEqual(detail.checkRollup?.length, 2);
      assert.strictEqual(detail.deleteBranchOnMerge, true);
      assert.strictEqual(detail.isDraft, false);
    }).pipe(Effect.provide(layer));
  });
});

describe("Bitbucket file contents and diffs", () => {
  const fileRoutes = {
    [`GET ${PR}`]: json(Fixtures.pullRequest),
    [`GET ${REPO}/merge-base/${Fixtures.HEAD_SHA}..${Fixtures.DESTINATION_SHA}`]: json(
      Fixtures.mergeBaseCommit,
    ),
    [`GET ${REPO}/src/${Fixtures.MERGE_BASE_SHA}/src/old%20name.ts`]: new Response("old\n"),
    [`GET ${REPO}/src/${Fixtures.HEAD_SHA}/src/new%20name.ts`]: new Response("new\n"),
  };

  it.effect("reads both sides at the merge base and the head, renames included", () => {
    const { layer } = routed(fileRoutes);
    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      const contents = yield* bitbucket.getPullRequestFileContents({
        ...target,
        path: "src/new name.ts",
        previousPath: "src/old name.ts",
        headSha: Fixtures.HEAD_SHA,
      });
      assert.deepStrictEqual(contents, {
        path: "src/new name.ts",
        oldContents: "old\n",
        newContents: "new\n",
        truncated: false,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("treats a missing side as added/deleted, binary as null, and caps size", () => {
    const big = "x".repeat(1024 * 1024 + 10);
    const { execute, layer } = routed({
      ...fileRoutes,
      // Fresh bodies: a cloned (teed) body never settles a partial read's cancel.
      [`GET ${REPO}/src/${Fixtures.PARENT_SHA}/big.txt`]: () => new Response(big),
      [`GET ${REPO}/src/${Fixtures.HEAD_SHA}/big.txt`]: () =>
        new Response(new Uint8Array([1, 0, 2])),
    });
    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      const added = yield* bitbucket.getPullRequestFileContents({
        ...target,
        path: "src/new name.ts",
        headSha: Fixtures.HEAD_SHA,
        baseSha: Fixtures.PARENT_SHA,
      });
      assert.strictEqual(added.oldContents, null);
      assert.strictEqual(added.newContents, "new\n");
      // A caller-scoped base (one commit) skips the merge-base read.
      assert.isFalse(calls(execute).some((call) => call.includes("/merge-base/")));

      const capped = yield* bitbucket.getPullRequestFileContents({
        ...target,
        path: "big.txt",
        headSha: Fixtures.HEAD_SHA,
        baseSha: Fixtures.PARENT_SHA,
      });
      assert.strictEqual(capped.oldContents?.length, 1024 * 1024);
      assert.strictEqual(capped.newContents, null);
      assert.isTrue(capped.truncated);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects traversal paths before any request", () => {
    const { execute, layer } = routed(fileRoutes);
    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      const error = yield* bitbucket
        .getPullRequestFileContents({ ...target, path: "../secrets", headSha: Fixtures.HEAD_SHA })
        .pipe(Effect.flip);
      assert.include(error.detail, "Invalid repository file path");
      assert.strictEqual(execute.mock.calls.length, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("diffs one commit of the pull request against its parent", () => {
    const { execute, layer } = routed({
      [`GET ${PR}`]: json(Fixtures.pullRequest),
      [`GET ${PR}/commits`]: json(Fixtures.commitsPage),
      [`GET ${REPO}/diff/${Fixtures.PARENT_SHA}`]: new Response("diff --git a/x b/x\n"),
    });
    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      const diff = yield* bitbucket.getPullRequestDiff({
        ...target,
        commitSha: Fixtures.PARENT_SHA,
        expectedHeadSha: Fixtures.HEAD_SHA,
      });
      assert.include(diff, "diff --git");
      // The head is verified before and after the read.
      assert.strictEqual(calls(execute).filter((call) => call === `GET ${PR}`).length, 3);

      const foreign = yield* bitbucket
        .getPullRequestDiff({ ...target, commitSha: "abcdef1234567" })
        .pipe(Effect.flip);
      assert.include(foreign.detail, "is not one of this pull request's commits");
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails a diff whose head moved", () => {
    const { layer } = routed({
      [`GET ${PR}`]: json(Fixtures.pullRequest),
      [`GET ${PR}/diff`]: new Response("diff --git a/x b/x\n"),
    });
    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      const error = yield* bitbucket
        .getPullRequestDiff({ ...target, expectedHeadSha: Fixtures.PARENT_SHA })
        .pipe(Effect.flip);
      assert.include(error.detail, "changed while loading the diff");
    }).pipe(Effect.provide(layer));
  });
});

describe("Bitbucket reviews", () => {
  it.effect(
    "checks the head, records the verdict, then posts line comments and the summary",
    () => {
      let created = 900;
      const { execute, layer } = routed({
        [`GET ${PR}`]: json(Fixtures.pullRequest),
        [`POST ${PR}/approve`]: json(Fixtures.approvalParticipant),
        [`POST ${PR}/comments`]: (request) => {
          created += 1;
          const { inline } = jsonBody(request) as { readonly inline?: unknown };
          return json(Fixtures.createdComment(created, "posted", { inline }), 201);
        },
      });
      return Effect.gen(function* () {
        const bitbucket = yield* BitbucketApi.BitbucketApi;
        const result = yield* bitbucket.submitPullRequestReview({
          ...target,
          event: "approve",
          body: "Ship it",
          expectedHeadSha: Fixtures.HEAD_SHA,
          comments: [
            { path: "src/a.ts", body: "nit", line: 4, side: "right" },
            { path: "src/b.ts", body: "old", line: 2, side: "left", startLine: 1 },
          ],
        });
        assert.deepStrictEqual(calls(execute), [
          `GET ${PR}`,
          `POST ${PR}/approve`,
          `POST ${PR}/comments`,
          `POST ${PR}/comments`,
          `POST ${PR}/comments`,
        ]);
        const posted = execute.mock.calls.slice(2).map(([request]) => jsonBody(request));
        assert.deepStrictEqual(posted, [
          { content: { raw: "nit" }, inline: { path: "src/a.ts", to: 4 } },
          { content: { raw: "old" }, inline: { path: "src/b.ts", from: 2, start_from: 1 } },
          { content: { raw: "Ship it" } },
        ]);
        assert.deepStrictEqual(result, {
          reviewId: "903",
          state: "approved",
          url: "https://bitbucket.org/atlassian/atlaskit-mk-2/pull-requests/5695/_/diff#comment-903",
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("posts nothing when the head moved", () => {
    const { execute, layer } = routed({ [`GET ${PR}`]: json(Fixtures.pullRequest) });
    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      const error = yield* bitbucket
        .submitPullRequestReview({
          ...target,
          event: "request_changes",
          expectedHeadSha: Fixtures.PARENT_SHA,
          comments: [{ path: "src/a.ts", body: "x", line: 1 }],
        })
        .pipe(Effect.flip);
      assert.strictEqual(error.detail, STALE_HEAD_DETAIL);
      assert.deepStrictEqual(calls(execute), [`GET ${PR}`]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("validates every draft before any request", () => {
    const { execute, layer } = routed({});
    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      const empty = yield* bitbucket
        .submitPullRequestReview({
          ...target,
          event: "comment",
          expectedHeadSha: Fixtures.HEAD_SHA,
          comments: [],
        })
        .pipe(Effect.flip);
      assert.include(empty.detail, "needs a summary");
      const lineless = yield* bitbucket
        .submitPullRequestReview({
          ...target,
          event: "comment",
          expectedHeadSha: Fixtures.HEAD_SHA,
          comments: [{ path: "src/a.ts", body: "x" }],
        })
        .pipe(Effect.flip);
      assert.include(lineless.detail, "has no line");
      assert.strictEqual(execute.mock.calls.length, 0);
    }).pipe(Effect.provide(layer));
  });
});

describe("Bitbucket threads and comments", () => {
  it.effect("replies under the root comment and returns the re-read thread", () => {
    const reply = Fixtures.createdComment(118571700, "On it", {
      parent: 118571088,
      inline: { to: null, from: 211, path: "packages/editor/src/index.ts" },
    });
    let posted = false;
    const { execute, layer } = routed({
      ...readRoutes,
      [`POST ${PR}/comments`]: () => {
        posted = true;
        return json(reply, 201);
      },
      [`GET ${PR}/comments`]: () =>
        json({
          values: posted ? [reply, ...Fixtures.commentsPage.values] : Fixtures.commentsPage.values,
        }),
    });
    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      const thread = yield* bitbucket.replyToPullRequestThread({
        ...target,
        threadId: "118571088",
        body: "On it",
      });
      assert.deepStrictEqual(jsonBody(find(execute, "POST", `${PR}/comments`)), {
        content: { raw: "On it" },
        parent: { id: 118571088 },
      });
      assert.strictEqual(thread.id, "118571088");
      assert.deepStrictEqual(
        thread.comments.map((comment) => comment.id),
        ["118571088", "118571200", "118571700"],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("resolves and reopens threads, treating the goal state as done", () => {
    const commentPath = `${PR}/comments/118571088`;
    const { layer } = routed({
      [`POST ${commentPath}/resolve`]: json(Fixtures.commentResolution),
      [`DELETE ${commentPath}/resolve`]: json(
        { type: "error", error: { message: "not resolved" } },
        404,
      ),
      [`GET ${commentPath}`]: json(Fixtures.commentsPage.values[4]),
    });
    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      assert.deepStrictEqual(
        yield* bitbucket.setPullRequestThreadResolved({
          ...target,
          threadId: "118571088",
          resolved: true,
        }),
        { threadId: "118571088", isResolved: true, resolvedBy: "Jessica Yeh" },
      );
      assert.deepStrictEqual(
        yield* bitbucket.setPullRequestThreadResolved({
          ...target,
          threadId: "118571088",
          resolved: false,
        }),
        { threadId: "118571088", isResolved: false },
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads the resolver when the thread was already resolved", () => {
    const commentPath = `${PR}/comments/118571000`;
    const { layer } = routed({
      [`POST ${commentPath}/resolve`]: json({ type: "error", error: { message: "resolved" } }, 409),
      [`GET ${commentPath}`]: json(Fixtures.commentsPage.values[5]),
    });
    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      const result = yield* bitbucket.setPullRequestThreadResolved({
        ...target,
        threadId: "118571000",
        resolved: true,
      });
      assert.deepStrictEqual(result, {
        threadId: "118571000",
        isResolved: true,
        resolvedBy: "Jessica Yeh",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("edits and deletes comments; review summaries are not comments", () => {
    const commentPath = `${PR}/comments/118571400`;
    const { execute, layer } = routed({
      [`PUT ${commentPath}`]: json(Fixtures.createdComment(118571400, "Edited")),
      [`DELETE ${commentPath}`]: noContent(),
      [`POST ${PR}/comments`]: json(Fixtures.createdComment(1, "Hello"), 201),
    });
    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      assert.deepStrictEqual(
        yield* bitbucket.updatePullRequestComment({
          ...target,
          commentId: "118571400",
          commentKind: "issue-comment",
          action: "edit",
          body: "Edited",
        }),
        { commentId: "118571400", deleted: false },
      );
      assert.deepStrictEqual(jsonBody(find(execute, "PUT", commentPath)), {
        content: { raw: "Edited" },
      });
      assert.deepStrictEqual(
        yield* bitbucket.updatePullRequestComment({
          ...target,
          commentId: "118571400",
          commentKind: "review-comment",
          action: "delete",
        }),
        { commentId: "118571400", deleted: true },
      );
      const review = yield* bitbucket
        .updatePullRequestComment({
          ...target,
          commentId: "903",
          commentKind: "review",
          action: "edit",
          body: "x",
        })
        .pipe(Effect.flip);
      assert.include(review.detail, "no summary to edit");

      yield* bitbucket.addPullRequestComment({ ...target, body: "Hello" });
      assert.deepStrictEqual(jsonBody(find(execute, "POST", `${PR}/comments`)), {
        content: { raw: "Hello" },
      });
    }).pipe(Effect.provide(layer));
  });
});

describe("Bitbucket lifecycle", () => {
  it.effect("edits keep the title and reviewers; reviewer edits resolve workspace members", () => {
    const { execute, layer } = routed({
      [`GET ${PR}`]: json({ ...Fixtures.pullRequest, participants: [] }),
      [`PUT ${PR}`]: json(Fixtures.pullRequest),
      "GET /workspaces/atlassian/members": json(Fixtures.membersPage),
    });
    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      yield* bitbucket.updatePullRequest({ ...target, action: { kind: "edit", body: "New body" } });
      assert.deepStrictEqual(jsonBody(find(execute, "PUT", PR)), {
        title: Fixtures.PULL_REQUEST_TITLE,
        description: "New body",
        reviewers: [{ uuid: Fixtures.reviewerUser.uuid }],
      });

      execute.mockClear();
      yield* bitbucket.updatePullRequest({
        ...target,
        action: { kind: "reviewers", add: ["brodie"], remove: ["Jessica Yeh"] },
      });
      assert.deepStrictEqual(calls(execute), [
        `GET ${PR}`,
        "GET /workspaces/atlassian/members",
        `PUT ${PR}`,
      ]);
      assert.deepStrictEqual(jsonBody(find(execute, "PUT", PR)), {
        title: Fixtures.PULL_REQUEST_TITLE,
        reviewers: [{ uuid: Fixtures.otherUser.uuid }],
      });

      const author = yield* bitbucket
        .updatePullRequest({
          ...target,
          action: { kind: "reviewers", add: ["Name Lastname"], remove: [] },
        })
        .pipe(Effect.flip);
      assert.include(author.detail, "cannot review their own");

      const unsupported = yield* bitbucket
        .updatePullRequest({ ...target, action: { kind: "reopen" } })
        .pipe(Effect.flip);
      assert.include(unsupported.detail, "does not support the reopen action");
    }).pipe(Effect.provide(layer));
  });

  it.effect("declines and deletes the branch; deleting an open pull request's branch fails", () => {
    const branch = encodeURIComponent("username/NONE-add-onClick-prop-for-accessibility");
    const { execute, layer } = routed({
      [`GET ${PR}`]: json(Fixtures.pullRequest),
      [`POST ${PR}/decline`]: json({ ...Fixtures.pullRequest, state: "DECLINED" }),
      [`DELETE ${REPO}/refs/branches/${branch}`]: noContent(),
    });
    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      yield* bitbucket.updatePullRequest({
        ...target,
        action: { kind: "close", deleteBranch: true },
      });
      assert.deepStrictEqual(calls(execute), [
        `GET ${PR}`,
        `POST ${PR}/decline`,
        `DELETE ${REPO}/refs/branches/${branch}`,
      ]);
      const open = yield* bitbucket
        .updatePullRequest({ ...target, action: { kind: "delete-branch" } })
        .pipe(Effect.flip);
      assert.include(open.detail, "before deleting its branch");
    }).pipe(Effect.provide(layer));
  });

  it.effect("toggles drafts through the update endpoint", () => {
    const { execute, layer } = routed({
      [`GET ${PR}`]: json(Fixtures.pullRequest),
      [`PUT ${PR}`]: json({ ...Fixtures.pullRequest, draft: true }),
    });
    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      yield* bitbucket.updatePullRequest({ ...target, action: { kind: "set-draft", draft: true } });
      assert.deepStrictEqual(jsonBody(find(execute, "PUT", PR)), {
        title: Fixtures.PULL_REQUEST_TITLE,
        draft: true,
        reviewers: [{ uuid: Fixtures.reviewerUser.uuid }],
      });
    }).pipe(Effect.provide(layer));
  });
});

describe("Bitbucket merges", () => {
  it.effect("merges with the mapped strategy after checking the head", () => {
    const { execute, layer } = routed({
      [`GET ${PR}`]: json(Fixtures.pullRequest),
      [`POST ${PR}/merge`]: json({ ...Fixtures.pullRequest, state: "MERGED" }),
    });
    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      const result = yield* bitbucket.mergePullRequest({
        ...target,
        mergeMethod: "squash",
        deleteBranch: true,
        expectedHeadSha: Fixtures.HEAD_SHA,
      });
      assert.deepStrictEqual(result, { outcome: "merged" });
      assert.deepStrictEqual(jsonBody(find(execute, "POST", `${PR}/merge`)), {
        merge_strategy: "squash",
        close_source_branch: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("polls the task-status link of a long merge", () => {
    const task = `${PR}/merge/task-status/1`;
    const { layer } = routed({
      [`GET ${PR}`]: json(Fixtures.pullRequest),
      [`POST ${PR}/merge`]: () =>
        new Response(null, { status: 202, headers: { Location: `${API}${task}` } }),
      [`GET ${task}`]: json(Fixtures.mergeTaskSuccess),
    });
    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      const result = yield* bitbucket.mergePullRequest({ ...target, mergeMethod: "merge" });
      assert.deepStrictEqual(result, { outcome: "merged" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses moved heads, disabled methods and concurrent ref changes", () => {
    const { execute, layer } = routed({
      [`GET ${PR}`]: json(Fixtures.pullRequest),
      [`POST ${PR}/merge`]: json({ type: "error", error: { message: "ref changed" } }, 409),
    });
    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      const moved = yield* bitbucket
        .mergePullRequest({ ...target, mergeMethod: "merge", expectedHeadSha: Fixtures.PARENT_SHA })
        .pipe(Effect.flip);
      assert.strictEqual(moved.detail, STALE_HEAD_DETAIL);
      assert.isFalse(calls(execute).includes(`POST ${PR}/merge`));

      const conflict = yield* bitbucket
        .mergePullRequest({ ...target, mergeMethod: "merge", expectedHeadSha: Fixtures.HEAD_SHA })
        .pipe(Effect.flip);
      assert.strictEqual(conflict.status, 409);
      assert.include(conflict.detail, "changed while merging");
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails a method the destination branch does not allow", () => {
    const { layer } = routed({
      [`GET ${PR}`]: json({
        ...Fixtures.pullRequest,
        destination: {
          ...Fixtures.pullRequest.destination,
          branch: { name: "master", merge_strategies: ["merge_commit"] },
        },
      }),
    });
    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      const error = yield* bitbucket
        .mergePullRequest({ ...target, mergeMethod: "rebase" })
        .pipe(Effect.flip);
      assert.include(error.detail, "rebase merge method is disabled for master");
    }).pipe(Effect.provide(layer));
  });
});

describe("Bitbucket lists and creation", () => {
  it.effect("filters by the viewer's uuid and title, and rejects involvement it lacks", () => {
    const { execute, layer } = routed({
      "GET /user": json(Fixtures.viewer),
      [`GET ${REPO}/pullrequests`]: json({ values: [Fixtures.pullRequest] }),
    });
    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      const rows = yield* bitbucket.listPullRequests({
        cwd: "/repo",
        headSelector: "",
        state: "open",
        involvement: "review-requested",
        query: 'say "hi"',
      });
      assert.strictEqual(rows[0]?.isDraft, false);
      assert.deepStrictEqual(find(execute, "GET", `${REPO}/pullrequests`)?.urlParams.params, [
        ["pagelen", "20"],
        ["sort", "-updated_on"],
        [
          "q",
          `state = "OPEN" AND reviewers.uuid = "${Fixtures.reviewerUser.uuid}" AND title ~ "say \\"hi\\""`,
        ],
        ["state", "OPEN"],
      ]);
      const assigned = yield* bitbucket
        .listPullRequests({
          cwd: "/repo",
          headSelector: "",
          state: "open",
          involvement: "assigned",
        })
        .pipe(Effect.flip);
      assert.include(assigned.detail, 'cannot list pull requests by "assigned"');
    }).pipe(Effect.provide(layer));
  });

  it.effect("lists workspace members as reviewer candidates", () => {
    const { layer } = routed({ "GET /workspaces/atlassian/members": json(Fixtures.membersPage) });
    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      const candidates = yield* bitbucket.listAssignees({ cwd: "/repo" });
      assert.deepStrictEqual(
        candidates.map((candidate) => candidate.login),
        ["Name Lastname", "Jessica Yeh", "Brodie Rao"],
      );
      assert.include(candidates[0]?.avatarUrl ?? "", "557058:author");
    }).pipe(Effect.provide(layer));
  });

  it.effect("opens draft pull requests", () => {
    const { execute, layer } = routed({
      [`POST ${REPO}/pullrequests`]: json({ ...Fixtures.pullRequest, draft: true }, 201),
    });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const bodyFile = yield* fileSystem.makeTempFileScoped({ prefix: "bitbucket-pr-body-" });
      yield* fileSystem.writeFileString(bodyFile, "Body");
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      yield* bitbucket.createPullRequest({
        cwd: "/repo",
        baseBranch: "master",
        headSelector: "feature",
        title: "Draft",
        bodyFile,
        draft: true,
      });
      assert.deepStrictEqual(jsonBody(find(execute, "POST", `${REPO}/pullrequests`)), {
        title: "Draft",
        description: "Body",
        source: { branch: { name: "feature" } },
        destination: { branch: { name: "master" } },
        draft: true,
      });
    }).pipe(Effect.provide(layer), Effect.scoped);
  });
});
