import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";

import type { GitLabApiRequest } from "./gitLabApi.ts";
import { GitLabCliError } from "./GitLabCli.ts";
import {
  fetchGitLabChangeRequestActivity,
  fetchGitLabChangeRequestDiff,
  fetchGitLabDetailReadiness,
  fetchGitLabFileContents,
  getGitLabJobLog,
  gitLabSupportsReviewerState,
  listGitLabMergeRequestsFiltered,
  listGitLabWorkflowRuns,
  mergeGitLabMergeRequest,
  nextGitLabUserIds,
  replyToGitLabThread,
  setGitLabThreadResolved,
  submitGitLabReview,
  updateGitLabComment,
  updateGitLabMergeRequest,
  type GitLabCall,
} from "./gitLabMergeRequestPage.ts";
import {
  GITLAB_APPROVALS,
  GITLAB_COMMIT,
  GITLAB_COMMIT_STATUSES,
  GITLAB_COMMITS,
  GITLAB_CURRENT_USER,
  GITLAB_DISCUSSIONS,
  GITLAB_DRAFT_NOTES,
  GITLAB_HEAD_SHA,
  GITLAB_JOBS,
  GITLAB_LABEL_EVENTS,
  GITLAB_MERGE_REQUEST,
  GITLAB_MERGE_REQUEST_DIFFS,
  GITLAB_NOTE,
  GITLAB_PIPELINES,
  GITLAB_PROJECT,
  GITLAB_REVIEWERS,
  GITLAB_STATE_EVENTS,
  GITLAB_VERSIONS,
} from "./gitLabMergeRequestPage.fixtures.ts";
import { GitLabMergeRequestDetailSchema, gitLabMergeRequestFacts } from "./gitLabMergeRequests.ts";

const MR = "projects/:fullpath/merge_requests/133";
const DIFF_NOTE_DISCUSSION = GITLAB_DISCUSSIONS[1];

type Route = unknown | ((request: GitLabApiRequest) => unknown);

const isGitLabCliError = Schema.is(GitLabCliError);

/**
 * A fake `glab api`: routes `METHOD endpoint-without-query` to a payload, a
 * `GitLabCliError`, or a function of the request; records every request.
 */
function fakeGitLab(routes: Readonly<Record<string, Route>>) {
  const requests: GitLabApiRequest[] = [];
  const call: GitLabCall = (operation, request) => {
    requests.push(request);
    const key = `${request.method} ${request.endpoint.split("?")[0]}`;
    if (!(key in routes)) {
      return Effect.fail(new GitLabCliError({ operation, detail: `unrouted ${key}`, status: 404 }));
    }
    const route = routes[key];
    const value =
      typeof route === "function" ? (route as (r: GitLabApiRequest) => unknown)(request) : route;
    if (isGitLabCliError(value)) return Effect.fail(value);
    return Effect.succeed({
      stdout: typeof value === "string" ? value : JSON.stringify(value),
      stdoutTruncated: false,
    });
  };
  const find = (method: string, path: string) =>
    requests.filter(
      (request) => request.method === method && request.endpoint.split("?")[0] === path,
    );
  return { call, requests, find };
}

function httpError(status: number, detail = `HTTP ${status}`) {
  return new GitLabCliError({ operation: "test", detail, status });
}

/** The merge request with the docs' diff note on its head. */
const MR_ON_THREAD_HEAD = {
  ...GITLAB_MERGE_REQUEST,
  diff_refs: {
    ...GITLAB_MERGE_REQUEST.diff_refs,
    head_sha: DIFF_NOTE_DISCUSSION.notes[0].position.head_sha,
  },
};

const activityRoutes = {
  [`GET ${MR}`]: MR_ON_THREAD_HEAD,
  "GET user": GITLAB_CURRENT_USER,
  "GET projects/:fullpath": GITLAB_PROJECT,
  [`GET ${MR}/notes`]: [GITLAB_NOTE],
  [`GET ${MR}/discussions`]: GITLAB_DISCUSSIONS,
  [`GET ${MR}/resource_state_events`]: GITLAB_STATE_EVENTS,
  [`GET ${MR}/resource_label_events`]: GITLAB_LABEL_EVENTS,
  [`GET ${MR}/commits`]: GITLAB_COMMITS,
  [`GET ${MR}/versions`]: GITLAB_VERSIONS,
  [`GET ${MR}/draft_notes`]: GITLAB_DRAFT_NOTES,
  [`GET ${MR}/diffs`]: [
    {
      ...GITLAB_MERGE_REQUEST_DIFFS[0],
      old_path: "package.json",
      new_path: "package.json",
      diff: "@@ -25,3 +25,3 @@\n a\n-b\n+c\n d\n",
    },
  ],
};

describe("fetchGitLabChangeRequestActivity", () => {
  it.effect("reads every activity source with bounded pages and assembles the page", () =>
    Effect.gen(function* () {
      const gitlab = fakeGitLab(activityRoutes);
      const activity = yield* fetchGitLabChangeRequestActivity(gitlab.call, "133");
      assert.strictEqual(activity.number, 133);
      assert.deepStrictEqual(activity.pendingReview, { id: "draft-notes", commentsCount: 1 });
      assert.strictEqual(activity.viewer?.login, "john_smith");
      const thread = activity.reviewThreads[0];
      expect(thread).toMatchObject({
        isOutdated: false,
        line: 27,
        diffHunk: "@@ -25,3 +25,3 @@\n a\n-b\n+c\n d",
      });
      // Notes newest first, every list paged with per_page=100.
      const notes = gitlab.find("GET", `${MR}/notes`)[0];
      expect(notes?.endpoint).toBe(`${MR}/notes?sort=desc&order_by=created_at&per_page=100&page=1`);
      for (const request of gitlab.requests) assert.strictEqual(request.method, "GET");
    }),
  );

  it.effect("reads at most the page budget and reports the cut", () =>
    Effect.gen(function* () {
      const fullPage = Array.from({ length: 100 }, (_, index) => ({
        ...GITLAB_NOTE,
        id: 1000 + index,
      }));
      const gitlab = fakeGitLab({ ...activityRoutes, [`GET ${MR}/notes`]: fullPage });
      const activity = yield* fetchGitLabChangeRequestActivity(gitlab.call, "133");
      assert.strictEqual(gitlab.find("GET", `${MR}/notes`).length, 3);
      assert.strictEqual(activity.timelineTruncated, true);
    }),
  );

  it.effect("degrades optional reads instead of failing the page", () =>
    Effect.gen(function* () {
      const gitlab = fakeGitLab({
        ...activityRoutes,
        [`GET ${MR}/draft_notes`]: httpError(404),
        [`GET ${MR}/resource_label_events`]: httpError(500),
        "GET user": httpError(401),
      });
      const activity = yield* fetchGitLabChangeRequestActivity(gitlab.call, "133");
      assert.strictEqual(activity.pendingReview, null);
      assert.strictEqual(activity.viewer, null);
      assert.isFalse(activity.timeline.some((item) => item.kind === "labeled"));
    }),
  );

  it.effect("fails on a reference that is not a merge request", () =>
    Effect.gen(function* () {
      const error = yield* fetchGitLabChangeRequestActivity(fakeGitLab({}).call, "feature/x").pipe(
        Effect.flip,
      );
      assert.include(error.detail, "is not a merge request number");
    }),
  );
});

describe("fetchGitLabChangeRequestDiff", () => {
  it.effect("rebuilds the merge request diff and checks the head before and after", () =>
    Effect.gen(function* () {
      const gitlab = fakeGitLab({
        [`GET ${MR}`]: GITLAB_MERGE_REQUEST,
        [`GET ${MR}/diffs`]: GITLAB_MERGE_REQUEST_DIFFS,
      });
      const diff = yield* fetchGitLabChangeRequestDiff(gitlab.call, {
        reference: "133",
        expectedHeadSha: GITLAB_HEAD_SHA,
      });
      assert.include(diff, "diff --git a/README b/README\n--- a/README\n+++ b/README\n@@ -1 +1 @@");
      assert.strictEqual(gitlab.find("GET", MR).length, 2);
    }),
  );

  it.effect("refuses a moved head", () =>
    Effect.gen(function* () {
      const gitlab = fakeGitLab({ [`GET ${MR}`]: GITLAB_MERGE_REQUEST });
      const error = yield* fetchGitLabChangeRequestDiff(gitlab.call, {
        reference: "133",
        expectedHeadSha: "0000000000000000000000000000000000000000",
      }).pipe(Effect.flip);
      assert.include(error.detail, "head changed since it was loaded");
      assert.strictEqual(gitlab.find("GET", `${MR}/diffs`).length, 0);
    }),
  );

  it.effect("diffs one of the merge request's own commits", () =>
    Effect.gen(function* () {
      const commit = GITLAB_COMMITS[0].id;
      const gitlab = fakeGitLab({
        [`GET ${MR}/commits`]: GITLAB_COMMITS,
        [`GET projects/:fullpath/repository/commits/${commit}/diff`]: GITLAB_MERGE_REQUEST_DIFFS,
      });
      const diff = yield* fetchGitLabChangeRequestDiff(gitlab.call, {
        reference: "133",
        commitSha: commit.slice(0, 10),
      });
      assert.include(diff, "diff --git a/VERSION b/VERSION");
      const outside = yield* fetchGitLabChangeRequestDiff(gitlab.call, {
        reference: "133",
        commitSha: "1234567890",
      }).pipe(Effect.flip);
      assert.strictEqual(outside.detail, "Commit 1234567890 is not part of merge request !133.");
    }),
  );
});

describe("fetchGitLabFileContents", () => {
  it.effect("reads both sides at the merge base and head; a missing side is null", () =>
    Effect.gen(function* () {
      const gitlab = fakeGitLab({
        [`GET ${MR}`]: GITLAB_MERGE_REQUEST,
        "GET projects/:fullpath/repository/files/src%2Fnew.ts/raw": (request: GitLabApiRequest) =>
          request.endpoint.includes(`ref=${GITLAB_HEAD_SHA}`) ? "new\n" : httpError(404),
      });
      const contents = yield* fetchGitLabFileContents(gitlab.call, {
        cwd: "/repo",
        reference: "133",
        path: "src/new.ts",
        headSha: GITLAB_HEAD_SHA,
      });
      assert.deepStrictEqual(contents, {
        path: "src/new.ts",
        oldContents: null,
        newContents: "new\n",
        truncated: false,
      });
      // The old side is read at `diff_refs.base_sha` (the merge base).
      assert.isTrue(
        gitlab.requests.some((request) =>
          request.endpoint.endsWith(`raw?ref=${GITLAB_MERGE_REQUEST.diff_refs.base_sha}`),
        ),
      );
    }),
  );

  it.effect("asks GitLab for the merge base of another head and rejects odd paths", () =>
    Effect.gen(function* () {
      const otherHead = "6104942438c14ec7bd21c6cd5bd995272b3faff6";
      const gitlab = fakeGitLab({
        [`GET ${MR}`]: GITLAB_MERGE_REQUEST,
        "GET projects/:fullpath/repository/merge_base": GITLAB_COMMITS[1],
        "GET projects/:fullpath/repository/files/a.ts/raw": "x",
      });
      yield* fetchGitLabFileContents(gitlab.call, {
        cwd: "/repo",
        reference: "133",
        path: "a.ts",
        headSha: otherHead,
      });
      expect(gitlab.find("GET", "projects/:fullpath/repository/merge_base")[0]?.endpoint).toBe(
        `projects/:fullpath/repository/merge_base?refs[]=main&refs[]=${otherHead}`,
      );
      const error = yield* fetchGitLabFileContents(gitlab.call, {
        cwd: "/repo",
        reference: "133",
        path: "../etc/passwd",
        headSha: otherHead,
      }).pipe(Effect.flip);
      assert.include(error.detail, "Invalid repository file path");
    }),
  );
});

describe("submitGitLabReview", () => {
  const reviewRoutes = (overrides: Readonly<Record<string, Route>> = {}) => {
    let nextId = 500;
    return fakeGitLab({
      [`GET ${MR}`]: GITLAB_MERGE_REQUEST,
      [`GET ${MR}/diffs`]: [
        { ...GITLAB_MERGE_REQUEST_DIFFS[1], diff: "@@ -1,2 +1,2 @@\n-1.9.7\n+1.9.8\n keep\n" },
      ],
      [`GET ${MR}/draft_notes`]: [],
      [`POST ${MR}/draft_notes`]: () => ({ ...GITLAB_DRAFT_NOTES[0], id: (nextId += 1) }),
      [`POST ${MR}/draft_notes/bulk_publish`]: "",
      [`POST ${MR}/approve`]: GITLAB_APPROVALS,
      [`DELETE ${MR}/draft_notes/501`]: "",
      "GET version": { version: "19.5.0-pre", revision: "91699905e27" },
      "GET user": GITLAB_CURRENT_USER,
      // The viewer (id 1) after a recorded change request.
      [`GET ${MR}/reviewers`]: [
        { ...GITLAB_REVIEWERS[0], state: "requested_changes" },
        GITLAB_REVIEWERS[1],
      ],
      ...overrides,
    });
  };

  it.effect("creates anchored drafts plus the summary, then publishes them together", () =>
    Effect.gen(function* () {
      const gitlab = reviewRoutes();
      const result = yield* submitGitLabReview(gitlab.call, {
        cwd: "/repo",
        reference: "133",
        event: "comment",
        body: "Overall fine",
        comments: [
          { path: "VERSION", body: "bump", line: 1, side: "right" },
          { path: "VERSION", body: "context", line: 2, side: "right" },
        ],
        expectedHeadSha: GITLAB_HEAD_SHA,
      });
      assert.deepStrictEqual(result, {
        reviewId: "draft-note:503",
        state: "commented",
        url: GITLAB_MERGE_REQUEST.web_url,
      });
      const drafts = gitlab.find("POST", `${MR}/draft_notes`).map((request) => request.body);
      const refs = GITLAB_MERGE_REQUEST.diff_refs;
      expect(drafts).toEqual([
        {
          note: "bump",
          position: {
            position_type: "text",
            base_sha: refs.base_sha,
            start_sha: refs.start_sha,
            head_sha: refs.head_sha,
            old_path: "VERSION",
            new_path: "VERSION",
            new_line: 1,
          },
        },
        {
          note: "context",
          position: {
            position_type: "text",
            base_sha: refs.base_sha,
            start_sha: refs.start_sha,
            head_sha: refs.head_sha,
            old_path: "VERSION",
            new_path: "VERSION",
            old_line: 2,
            new_line: 2,
          },
        },
        { note: "Overall fine" },
      ]);
      const publish = gitlab.find("POST", `${MR}/draft_notes/bulk_publish`);
      assert.strictEqual(publish.length, 1);
      assert.strictEqual(publish[0]?.body, undefined);
      assert.strictEqual(gitlab.find("POST", `${MR}/approve`).length, 0);
    }),
  );

  it.effect("approves with the reviewed sha and publishes the viewer's pending drafts", () =>
    Effect.gen(function* () {
      const gitlab = reviewRoutes({ [`GET ${MR}/draft_notes`]: GITLAB_DRAFT_NOTES });
      const result = yield* submitGitLabReview(gitlab.call, {
        cwd: "/repo",
        reference: "133",
        event: "approve",
        comments: [],
        expectedHeadSha: GITLAB_HEAD_SHA,
      });
      assert.strictEqual(result.state, "approved");
      assert.strictEqual(result.reviewId, `approval:${GITLAB_HEAD_SHA}`);
      assert.deepStrictEqual(gitlab.find("POST", `${MR}/approve`)[0]?.body, {
        sha: GITLAB_HEAD_SHA,
      });
      assert.strictEqual(gitlab.find("POST", `${MR}/draft_notes/bulk_publish`).length, 1);
    }),
  );

  it.effect("maps a 409 approval to the moved-head error and discards its drafts", () =>
    Effect.gen(function* () {
      const gitlab = reviewRoutes({ [`POST ${MR}/approve`]: httpError(409) });
      const error = yield* submitGitLabReview(gitlab.call, {
        cwd: "/repo",
        reference: "133",
        event: "approve",
        comments: [{ path: "VERSION", body: "bump", line: 1, side: "right" }],
        expectedHeadSha: GITLAB_HEAD_SHA,
      }).pipe(Effect.flip);
      assert.include(error.detail, "head changed since it was loaded");
      assert.strictEqual(gitlab.find("DELETE", `${MR}/draft_notes/501`).length, 1);
      assert.strictEqual(gitlab.find("POST", `${MR}/draft_notes/bulk_publish`).length, 0);
    }),
  );

  it.effect("refuses a moved head and unanchorable lines before writing anything", () =>
    Effect.gen(function* () {
      const gitlab = reviewRoutes();
      const stale = yield* submitGitLabReview(gitlab.call, {
        cwd: "/repo",
        reference: "133",
        event: "comment",
        body: "x",
        comments: [],
        expectedHeadSha: "0000000",
      }).pipe(Effect.flip);
      assert.include(stale.detail, "head changed");
      const unanchored = yield* submitGitLabReview(gitlab.call, {
        cwd: "/repo",
        reference: "133",
        event: "comment",
        comments: [{ path: "missing.ts", body: "x", line: 1, side: "right" }],
        expectedHeadSha: GITLAB_HEAD_SHA,
      }).pipe(Effect.flip);
      assert.strictEqual(unanchored.detail, "missing.ts is not part of this merge request's diff.");
      assert.isTrue(gitlab.requests.every((request) => request.method === "GET"));
    }),
  );

  it.effect("requests changes through bulk_publish on GitLab versions that record it", () =>
    Effect.gen(function* () {
      const gitlab = reviewRoutes();
      const result = yield* submitGitLabReview(gitlab.call, {
        cwd: "/repo",
        reference: "133",
        event: "request_changes",
        body: "Please fix",
        comments: [],
        expectedHeadSha: GITLAB_HEAD_SHA,
      });
      assert.strictEqual(result.state, "changes_requested");
      assert.deepStrictEqual(gitlab.find("POST", `${MR}/draft_notes/bulk_publish`)[0]?.body, {
        reviewer_state: "requested_changes",
      });

      const old = reviewRoutes({ "GET version": { version: "17.11.3-ee", revision: "x" } });
      const error = yield* submitGitLabReview(old.call, {
        cwd: "/repo",
        reference: "133",
        event: "request_changes",
        comments: [],
        expectedHeadSha: GITLAB_HEAD_SHA,
      }).pipe(Effect.flip);
      assert.include(error.detail, "needs GitLab 19.2 or later");
      assert.isTrue(old.requests.every((request) => request.method === "GET"));
      assert.isTrue(gitLabSupportsReviewerState("20.0.0"));
      assert.isFalse(gitLabSupportsReviewerState("19.1.4"));
    }),
  );

  it.effect("reports a change request GitLab published but did not record", () =>
    Effect.gen(function* () {
      // `bulk_publish` answers 204 even when the reviewer state was refused
      // (no update rights, or not a reviewer and none can be added): the
      // viewer (id 1) is still `unreviewed`, or not a reviewer at all.
      const gitlab = reviewRoutes({ [`GET ${MR}/reviewers`]: GITLAB_REVIEWERS });
      const error = yield* submitGitLabReview(gitlab.call, {
        cwd: "/repo",
        reference: "133",
        event: "request_changes",
        body: "Please fix",
        comments: [],
        expectedHeadSha: GITLAB_HEAD_SHA,
      }).pipe(Effect.flip);
      assert.include(error.detail, "GitLab did not record your change request");
      assert.strictEqual(gitlab.find("POST", `${MR}/draft_notes/bulk_publish`).length, 1);
      const notReviewer = reviewRoutes({ [`GET ${MR}/reviewers`]: [GITLAB_REVIEWERS[1]] });
      const absent = yield* submitGitLabReview(notReviewer.call, {
        cwd: "/repo",
        reference: "133",
        event: "request_changes",
        comments: [],
        expectedHeadSha: GITLAB_HEAD_SHA,
      }).pipe(Effect.flip);
      assert.include(absent.detail, "GitLab did not record your change request");

      // An unreadable reviewer list leaves the outcome unknown: the submission stands.
      const unreadable = reviewRoutes({ [`GET ${MR}/reviewers`]: httpError(500) });
      const result = yield* submitGitLabReview(unreadable.call, {
        cwd: "/repo",
        reference: "133",
        event: "request_changes",
        comments: [],
        expectedHeadSha: GITLAB_HEAD_SHA,
      });
      assert.strictEqual(result.state, "changes_requested");
    }),
  );
});

describe("threads and comments", () => {
  it.effect("replies over stdin JSON and returns the re-read thread", () =>
    Effect.gen(function* () {
      const id = DIFF_NOTE_DISCUSSION.id;
      const gitlab = fakeGitLab({
        ...activityRoutes,
        [`POST ${MR}/discussions/${id}/notes`]: GITLAB_NOTE,
        [`GET ${MR}/discussions/${id}`]: DIFF_NOTE_DISCUSSION,
      });
      const thread = yield* replyToGitLabThread(gitlab.call, {
        reference: "133",
        threadId: id,
        body: "Thanks!",
      });
      assert.strictEqual(thread.id, id);
      assert.deepStrictEqual(gitlab.find("POST", `${MR}/discussions/${id}/notes`)[0]?.body, {
        body: "Thanks!",
      });
      const bad = yield* replyToGitLabThread(gitlab.call, {
        reference: "133",
        threadId: "../../x",
        body: "x",
      }).pipe(Effect.flip);
      assert.include(bad.detail, "Unknown review thread");
    }),
  );

  it.effect("resolves with the documented query parameter", () =>
    Effect.gen(function* () {
      const id = DIFF_NOTE_DISCUSSION.id;
      const resolved = {
        ...DIFF_NOTE_DISCUSSION,
        notes: [
          {
            ...DIFF_NOTE_DISCUSSION.notes[0],
            resolved: true,
            resolved_by: { id: 1, username: "root" },
          },
        ],
      };
      const gitlab = fakeGitLab({ [`PUT ${MR}/discussions/${id}`]: resolved });
      const result = yield* setGitLabThreadResolved(gitlab.call, {
        reference: "133",
        threadId: id,
        resolved: true,
      });
      assert.deepStrictEqual(result, { threadId: id, isResolved: true, resolvedBy: "root" });
      assert.strictEqual(gitlab.requests[0]?.endpoint, `${MR}/discussions/${id}?resolved=true`);
    }),
  );

  it.effect("edits and deletes notes by id", () =>
    Effect.gen(function* () {
      const gitlab = fakeGitLab({
        [`PUT ${MR}/notes/301`]: GITLAB_NOTE,
        [`DELETE ${MR}/notes/301`]: "",
      });
      assert.deepStrictEqual(
        yield* updateGitLabComment(gitlab.call, {
          cwd: "/repo",
          reference: "133",
          commentId: "301",
          commentKind: "review-comment",
          action: "edit",
          body: "Edited",
        }),
        { commentId: "301", deleted: false },
      );
      assert.deepStrictEqual(gitlab.requests[0]?.body, { body: "Edited" });
      assert.deepStrictEqual(
        yield* updateGitLabComment(gitlab.call, {
          cwd: "/repo",
          reference: "133",
          commentId: "301",
          commentKind: "issue-comment",
          action: "delete",
        }),
        { commentId: "301", deleted: true },
      );
    }),
  );
});

describe("updateGitLabMergeRequest", () => {
  const routes = (overrides: Readonly<Record<string, Route>> = {}) =>
    fakeGitLab({
      [`GET ${MR}`]: {
        ...GITLAB_MERGE_REQUEST,
        reviewers: [
          { id: 1, username: "user1" },
          { id: 2, username: "user2" },
        ],
      },
      [`PUT ${MR}`]: GITLAB_MERGE_REQUEST,
      "GET users": (request: GitLabApiRequest) =>
        request.endpoint.includes("username=ryley") ? [{ id: 9, username: "ryley" }] : [],
      "GET projects/:fullpath": GITLAB_PROJECT,
      ...overrides,
    });
  const update = (
    gitlab: ReturnType<typeof routes>,
    action: Parameters<typeof updateGitLabMergeRequest>[1]["action"],
  ) => updateGitLabMergeRequest(gitlab.call, { reference: "133", action });

  it.effect("edits title, description and target branch in one PUT", () =>
    Effect.gen(function* () {
      const gitlab = routes();
      yield* update(gitlab, { kind: "edit", title: "New", body: "Body\n", baseRefName: "release" });
      assert.deepStrictEqual(gitlab.find("PUT", MR)[0]?.body, {
        title: "New",
        description: "Body\n",
        target_branch: "release",
      });
    }),
  );

  it.effect("toggles draft through the title prefix", () =>
    Effect.gen(function* () {
      const gitlab = routes();
      yield* update(gitlab, { kind: "set-draft", draft: true });
      assert.deepStrictEqual(gitlab.find("PUT", MR)[0]?.body, { title: "Draft: Manual job rules" });
      const ready = routes();
      yield* update(ready, { kind: "set-draft", draft: false });
      assert.strictEqual(ready.find("PUT", MR).length, 0);
    }),
  );

  it.effect("sends the full reviewer id list after resolving added logins", () =>
    Effect.gen(function* () {
      const gitlab = routes();
      yield* update(gitlab, { kind: "reviewers", add: ["ryley"], remove: ["user1"] });
      assert.deepStrictEqual(gitlab.find("PUT", MR)[0]?.body, { reviewer_ids: [2, 9] });
      const unknown = yield* update(gitlab, { kind: "assignees", add: ["ghost"], remove: [] }).pipe(
        Effect.flip,
      );
      assert.strictEqual(unknown.detail, "No GitLab user named @ghost.");
      assert.deepStrictEqual(
        nextGitLabUserIds({ current: [{ id: 1, username: "a" }], removeLogins: ["A"], addIds: [] }),
        [0],
      );
    }),
  );

  it.effect("adds and removes labels, closes, reopens", () =>
    Effect.gen(function* () {
      const gitlab = routes({
        "DELETE projects/:fullpath/repository/branches/manual-job-rules": "",
      });
      yield* update(gitlab, { kind: "labels", add: ["bug", "p1"], remove: ["wip"] });
      yield* update(gitlab, { kind: "close", deleteBranch: true });
      yield* update(gitlab, { kind: "reopen" });
      expect(gitlab.find("PUT", MR).map((request) => request.body)).toEqual([
        { add_labels: "bug,p1", remove_labels: "wip" },
        { state_event: "close" },
        { state_event: "reopen" },
      ]);
      assert.strictEqual(
        gitlab.find("DELETE", "projects/:fullpath/repository/branches/manual-job-rules").length,
        1,
      );
    }),
  );

  it.effect("rebases only, and only the head that was reviewed", () =>
    Effect.gen(function* () {
      const gitlab = routes({ [`PUT ${MR}/rebase`]: { rebase_in_progress: true } });
      const merge = yield* update(gitlab, {
        kind: "update-branch",
        method: "merge",
        expectedHeadSha: GITLAB_HEAD_SHA,
      }).pipe(Effect.flip);
      assert.include(merge.detail, "by rebasing it");
      const stale = yield* update(gitlab, {
        kind: "update-branch",
        method: "rebase",
        expectedHeadSha: "0000000",
      }).pipe(Effect.flip);
      assert.include(stale.detail, "head changed");
      yield* update(gitlab, {
        kind: "update-branch",
        method: "rebase",
        expectedHeadSha: GITLAB_HEAD_SHA,
      });
      assert.strictEqual(gitlab.find("PUT", `${MR}/rebase`).length, 1);
    }),
  );

  it.effect(
    "arms auto-merge with the head sha and cancels it, failing on GitLab's error status",
    () =>
      Effect.gen(function* () {
        const gitlab = routes({
          [`PUT ${MR}/merge`]: { ...GITLAB_MERGE_REQUEST, merge_when_pipeline_succeeds: true },
          [`POST ${MR}/cancel_merge_when_pipeline_succeeds`]: { status: "success" },
        });
        yield* update(gitlab, {
          kind: "auto-merge",
          enabled: true,
          mergeMethod: "squash",
          expectedHeadSha: GITLAB_HEAD_SHA,
        });
        assert.deepStrictEqual(gitlab.find("PUT", `${MR}/merge`)[0]?.body, {
          auto_merge: true,
          merge_when_pipeline_succeeds: true,
          sha: GITLAB_HEAD_SHA,
          squash: true,
        });
        yield* update(gitlab, { kind: "auto-merge", enabled: false });

        // Docs: 201 with `status: "error"` when the merge request was not set to auto-merge.
        const notSet = routes({
          [`POST ${MR}/cancel_merge_when_pipeline_succeeds`]: {
            message: "Can't cancel the automatic merge",
            status: "error",
            http_status: 406,
          },
        });
        const error = yield* update(notSet, { kind: "auto-merge", enabled: false }).pipe(
          Effect.flip,
        );
        assert.strictEqual(error.detail, "Can't cancel the automatic merge");
      }),
  );

  it.effect("does not delete a fork's branch", () =>
    Effect.gen(function* () {
      const gitlab = routes({ [`GET ${MR}`]: { ...GITLAB_MERGE_REQUEST, source_project_id: 1 } });
      const error = yield* update(gitlab, { kind: "delete-branch" }).pipe(Effect.flip);
      assert.include(error.detail, "fork");
      assert.strictEqual(
        gitlab.requests.filter((request) => request.method === "DELETE").length,
        0,
      );
    }),
  );
});

describe("mergeGitLabMergeRequest", () => {
  const routes = (merge: Route, project: unknown = GITLAB_PROJECT) =>
    fakeGitLab({
      [`GET ${MR}`]: GITLAB_MERGE_REQUEST,
      "GET projects/:fullpath": project,
      [`PUT ${MR}/merge`]: merge,
    });

  it.effect("merges with the sha precondition, squash and branch deletion", () =>
    Effect.gen(function* () {
      const gitlab = routes({ ...GITLAB_MERGE_REQUEST, state: "merged" });
      const result = yield* mergeGitLabMergeRequest(gitlab.call, {
        cwd: "/repo",
        reference: "133",
        mergeMethod: "squash",
        deleteBranch: true,
        expectedHeadSha: GITLAB_HEAD_SHA,
      });
      assert.deepStrictEqual(result, { outcome: "merged" });
      assert.deepStrictEqual(gitlab.find("PUT", `${MR}/merge`)[0]?.body, {
        squash: true,
        sha: GITLAB_HEAD_SHA,
        should_remove_source_branch: true,
      });
    }),
  );

  it.effect("reports a queued merge as enqueued", () =>
    Effect.gen(function* () {
      const gitlab = routes({ ...GITLAB_MERGE_REQUEST, merge_when_pipeline_succeeds: true });
      const result = yield* mergeGitLabMergeRequest(gitlab.call, {
        cwd: "/repo",
        reference: "133",
        mergeMethod: "merge",
      });
      assert.deepStrictEqual(result, { outcome: "enqueued" });
    }),
  );

  it.effect("maps GitLab's merge failures and refuses methods the project lacks", () =>
    Effect.gen(function* () {
      const moved = yield* mergeGitLabMergeRequest(routes(httpError(409)).call, {
        cwd: "/repo",
        reference: "133",
        mergeMethod: "merge",
        expectedHeadSha: GITLAB_HEAD_SHA,
      }).pipe(Effect.flip);
      assert.include(moved.detail, "head changed");
      const blocked = yield* mergeGitLabMergeRequest(routes(httpError(405)).call, {
        cwd: "/repo",
        reference: "133",
        mergeMethod: "merge",
      }).pipe(Effect.flip);
      assert.include(blocked.detail, "cannot merge this merge request right now");
      const gitlab = routes({});
      const rebase = yield* mergeGitLabMergeRequest(gitlab.call, {
        cwd: "/repo",
        reference: "133",
        mergeMethod: "rebase",
      }).pipe(Effect.flip);
      assert.strictEqual(
        rebase.detail,
        "The rebase merge method is not available for this project.",
      );
      assert.strictEqual(gitlab.find("PUT", `${MR}/merge`).length, 0);
    }),
  );
});

/** The docs' merge request's head pipeline runs on a merged-results commit of its head. */
const MERGED_RESULT_SHA = GITLAB_MERGE_REQUEST.head_pipeline.sha;
const MERGED_RESULT_COMMIT = {
  ...GITLAB_COMMIT,
  id: MERGED_RESULT_SHA,
  parent_ids: [GITLAB_MERGE_REQUEST.diff_refs.base_sha, GITLAB_HEAD_SHA],
};
const HEAD_PIPELINE_ID = GITLAB_MERGE_REQUEST.head_pipeline.id;

describe("fetchGitLabDetailReadiness", () => {
  it.effect("adds reviewer states, verdict, merge state and methods, checks and commits", () =>
    Effect.gen(function* () {
      const facts = gitLabMergeRequestFacts(
        Schema.decodeUnknownSync(GitLabMergeRequestDetailSchema)(GITLAB_MERGE_REQUEST),
      );
      const statusSha = MERGED_RESULT_SHA;
      const gitlab = fakeGitLab({
        [`GET ${MR}/reviewers`]: GITLAB_REVIEWERS,
        [`GET ${MR}/approvals`]: GITLAB_APPROVALS,
        "GET projects/:fullpath": GITLAB_PROJECT,
        [`GET projects/:fullpath/repository/commits/${statusSha}`]: MERGED_RESULT_COMMIT,
        [`GET projects/:fullpath/repository/commits/${statusSha}/statuses`]: GITLAB_COMMIT_STATUSES,
        [`GET ${MR}/commits`]: GITLAB_COMMITS,
      });
      const readiness = yield* fetchGitLabDetailReadiness(gitlab.call, facts, "133");
      expect(readiness).toMatchObject({
        headSha: GITLAB_HEAD_SHA,
        reviewDecision: "approved",
        mergeStateStatus: "clean",
        mergeCapabilities: { merge: true, squash: true, rebase: false },
        autoMerge: null,
        deleteBranchOnMerge: true,
        changedFiles: 1,
      });
      assert.strictEqual(readiness.reviewerStates?.length, 4);
      assert.deepStrictEqual(
        readiness.checkRollup?.map((item) => item.name),
        ["test", "bundler:audit"],
      );
      // GitLab lists commits newest first; the page wants them oldest first.
      assert.deepStrictEqual(
        readiness.commits?.map((commit) => commit.shortOid),
        ["6104942438c", "ed899a2f4b5"],
      );
    }),
  );

  it.effect(
    "lists the head pipeline's jobs once, as its check runs, beside external statuses",
    () =>
      Effect.gen(function* () {
        const facts = gitLabMergeRequestFacts(
          Schema.decodeUnknownSync(GitLabMergeRequestDetailSchema)(GITLAB_MERGE_REQUEST),
        );
        // Every CI job is also a commit status with the job's id (docs: job 91
        // is `bundler:audit`); a third status was posted by an external CI.
        const [audit, test] = GITLAB_COMMIT_STATUSES;
        const statuses = [
          { ...audit, status: "failed", allow_failure: false, target_url: null },
          { ...test, status: "success", target_url: null },
          {
            ...test,
            id: 95,
            name: "jenkins/build",
            status: "success",
            target_url: "https://ci.example.com/job/build/12",
          },
        ];
        const jobs = [
          { ...GITLAB_JOBS[0], id: 90, name: "test", stage: "test", status: "success" },
          {
            ...GITLAB_JOBS[0],
            id: 91,
            name: "bundler:audit",
            stage: "security",
            status: "failed",
            web_url: "https://gitlab.example.com/janedoe/gitlab-foss/-/jobs/91",
          },
        ];
        const gitlab = fakeGitLab({
          [`GET projects/:fullpath/repository/commits/${MERGED_RESULT_SHA}`]: MERGED_RESULT_COMMIT,
          [`GET projects/:fullpath/repository/commits/${MERGED_RESULT_SHA}/statuses`]: statuses,
          [`GET projects/:fullpath/pipelines/${HEAD_PIPELINE_ID}/jobs`]: jobs,
        });
        const readiness = yield* fetchGitLabDetailReadiness(gitlab.call, facts, "133");
        expect(
          readiness.checkRollup?.map((item) => ({
            kind: item.kind,
            name: item.name,
            workflowName: item.workflowName,
            url: Option.getOrNull(item.url),
            conclusion: Option.getOrNull(item.conclusion),
          })),
        ).toEqual([
          {
            kind: "check-run",
            name: "test / test",
            workflowName: "Pipeline #1877",
            url: "https://example.com/foo/bar/-/jobs/6",
            conclusion: "success",
          },
          {
            kind: "check-run",
            name: "security / bundler:audit",
            workflowName: "Pipeline #1877",
            url: "https://gitlab.example.com/janedoe/gitlab-foss/-/jobs/91",
            conclusion: "failure",
          },
          {
            kind: "status-context",
            name: "jenkins/build",
            workflowName: undefined,
            url: "https://ci.example.com/job/build/12",
            conclusion: "success",
          },
        ]);
      }),
  );

  it.effect("reads the head's own statuses when the head pipeline is an earlier head's", () =>
    Effect.gen(function* () {
      const facts = gitLabMergeRequestFacts(
        Schema.decodeUnknownSync(GitLabMergeRequestDetailSchema)(GITLAB_MERGE_REQUEST),
      );
      // A push that started no pipeline: `head_pipeline` still names the old one.
      const gitlab = fakeGitLab({
        [`GET projects/:fullpath/repository/commits/${MERGED_RESULT_SHA}`]: {
          ...MERGED_RESULT_COMMIT,
          parent_ids: [GITLAB_MERGE_REQUEST.diff_refs.base_sha],
        },
        [`GET projects/:fullpath/repository/commits/${GITLAB_HEAD_SHA}/statuses`]: [],
      });
      const readiness = yield* fetchGitLabDetailReadiness(gitlab.call, facts, "133");
      assert.deepStrictEqual(readiness.checkRollup, []);
      assert.strictEqual(
        gitlab.find("GET", `projects/:fullpath/repository/commits/${MERGED_RESULT_SHA}/statuses`)
          .length,
        0,
      );
      assert.strictEqual(
        gitlab.find("GET", `projects/:fullpath/pipelines/${HEAD_PIPELINE_ID}/jobs`).length,
        0,
      );
    }),
  );

  it.effect("leaves out what it could not read instead of guessing", () =>
    Effect.gen(function* () {
      const facts = gitLabMergeRequestFacts(
        Schema.decodeUnknownSync(GitLabMergeRequestDetailSchema)(GITLAB_MERGE_REQUEST),
      );
      const readiness = yield* fetchGitLabDetailReadiness(fakeGitLab({}).call, facts, "133");
      assert.isUndefined(readiness.reviewDecision);
      assert.isUndefined(readiness.reviewerStates);
      assert.isUndefined(readiness.checkRollup);
      assert.isUndefined(readiness.mergeCapabilities);
      assert.strictEqual(readiness.mergeStateStatus, "clean");
    }),
  );
});

describe("listGitLabMergeRequestsFiltered", () => {
  it.effect("filters by the viewer's involvement, search and state on the server", () =>
    Effect.gen(function* () {
      const gitlab = fakeGitLab({
        "GET user": GITLAB_CURRENT_USER,
        "GET projects/:fullpath/merge_requests": [GITLAB_MERGE_REQUEST],
      });
      const rows = yield* listGitLabMergeRequestsFiltered(gitlab.call, {
        state: "open",
        involvement: "review-requested",
        query: "job rules",
        limit: 30,
      });
      assert.strictEqual(rows[0]?.number, 133);
      expect(gitlab.find("GET", "projects/:fullpath/merge_requests")[0]?.endpoint).toBe(
        "projects/:fullpath/merge_requests?state=opened&reviewer_username=john_smith&search=job%20rules&order_by=updated_at&sort=desc&per_page=30",
      );
      yield* listGitLabMergeRequestsFiltered(gitlab.call, {
        state: "all",
        involvement: "assigned",
      });
      assert.include(gitlab.requests.at(-1)?.endpoint ?? "", "state=all&assignee_id=1");
      const mentioned = yield* listGitLabMergeRequestsFiltered(gitlab.call, {
        state: "open",
        involvement: "mentioned",
      }).pipe(Effect.flip);
      assert.include(mentioned.detail, 'cannot filter merge requests by "mentioned"');
    }),
  );
});

describe("listGitLabWorkflowRuns", () => {
  it.effect("lists the merge request head's pipelines", () =>
    Effect.gen(function* () {
      const headPipeline = {
        ...GITLAB_PIPELINES[0],
        id: HEAD_PIPELINE_ID,
        iid: GITLAB_MERGE_REQUEST.head_pipeline.iid,
        sha: MERGED_RESULT_SHA,
      };
      const onHead = { ...GITLAB_PIPELINES[1], sha: GITLAB_HEAD_SHA };
      const gitlab = fakeGitLab({
        [`GET ${MR}`]: GITLAB_MERGE_REQUEST,
        [`GET ${MR}/pipelines`]: [headPipeline, onHead, GITLAB_PIPELINES[1]],
        [`GET projects/:fullpath/repository/commits/${MERGED_RESULT_SHA}`]: MERGED_RESULT_COMMIT,
      });
      const result = yield* listGitLabWorkflowRuns(gitlab.call, { pullRequestNumber: 133 });
      assert.deepStrictEqual(
        result.runs.map((run) => [run.runId, run.commit.oid, run.sourceHeadOid]),
        [
          // The merged-results pipeline says which head it verifies.
          [String(HEAD_PIPELINE_ID), MERGED_RESULT_SHA, GITLAB_HEAD_SHA],
          ["48", GITLAB_HEAD_SHA, undefined],
        ],
      );
      assert.deepStrictEqual(result.headSha, Option.some(GITLAB_HEAD_SHA));
      assert.deepStrictEqual(result.pullRequestNumber, Option.some(133));

      // An earlier head's pipeline (its merge commit lacks the head) is not listed.
      const stale = fakeGitLab({
        [`GET ${MR}`]: GITLAB_MERGE_REQUEST,
        [`GET ${MR}/pipelines`]: [headPipeline, onHead],
        [`GET projects/:fullpath/repository/commits/${MERGED_RESULT_SHA}`]: GITLAB_COMMIT,
      });
      const staleResult = yield* listGitLabWorkflowRuns(stale.call, { pullRequestNumber: 133 });
      assert.deepStrictEqual(
        staleResult.runs.map((run) => run.runId),
        ["48"],
      );
    }),
  );
});

describe("getGitLabJobLog", () => {
  it.effect("streams a long trace, keeps only its end, and drops the cut first line", () =>
    Effect.gen(function* () {
      const seen: Array<Parameters<GitLabCall>[2]> = [];
      const call: GitLabCall = (_operation, request, options) => {
        seen.push(options);
        assert.strictEqual(request.endpoint, "projects/:fullpath/jobs/6/trace");
        // The runner kept the last bytes: the first line starts mid-line.
        return Effect.succeed({
          stdout: "tail of an earlier line\n$ bun run test\nerror: 1 test failed\n",
          stdoutTruncated: true,
        });
      };
      const result = yield* getGitLabJobLog(call, { runId: "48", jobId: "6" });
      assert.strictEqual(seen[0]?.keepOutputTail, true);
      assert.isUndefined(seen[0]?.truncateOutputAtMaxBytes);
      assert.strictEqual(result.log, "$ bun run test\nerror: 1 test failed\n");
      assert.strictEqual(result.truncated, true);
    }),
  );
});
