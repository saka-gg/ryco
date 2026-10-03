import { createHash } from "node:crypto";

import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";
import { ChangeRequestActivity, type ChangeRequestTimelineItem } from "@ryco/contracts";

import * as Activity from "./gitHubPullRequestActivity.ts";

const actor = (login: string, typename = "User") => ({
  __typename: typename,
  login,
  avatarUrl: `https://avatars.example/${login}`,
});
const event = (typename: string, id: string, extra: Record<string, unknown> = {}) => ({
  __typename: typename,
  id,
  createdAt: "2026-10-01T10:00:00Z",
  actor: actor("octocat"),
  ...extra,
});
const reactions = [
  { content: "THUMBS_UP", viewerHasReacted: true, reactors: { totalCount: 2 } },
  { content: "HEART", viewerHasReacted: false, reactors: { totalCount: 0 } },
];
const marker = `<!-- ryco-comment-id:${createHash("sha256").update("m-1").digest("hex")} -->`;

/** One node per contract kind, shaped like real `gh api graphql` output. */
const timelineNodes: ReadonlyArray<unknown> = [
  {
    __typename: "IssueComment",
    id: "IC_1",
    createdAt: "2026-10-01T09:00:00Z",
    updatedAt: "2026-10-01T09:05:00Z",
    lastEditedAt: "2026-10-01T09:05:00Z",
    author: actor("alice"),
    authorAssociation: "MEMBER",
    body: `Looks good\n\n${marker}`,
    url: "https://github.com/acme/repo/pull/7#issuecomment-1",
    isMinimized: false,
    viewerCanUpdate: true,
    viewerCanDelete: true,
    reactionGroups: reactions,
  },
  {
    __typename: "PullRequestReview",
    id: "PRR_A",
    createdAt: "2026-10-01T09:10:00Z",
    submittedAt: "2026-10-01T09:11:00Z",
    author: actor("reviewbot", "Bot"),
    authorAssociation: "NONE",
    state: "CHANGES_REQUESTED",
    body: "",
    url: "https://github.com/acme/repo/pull/7#pullrequestreview-1",
    viewerCanUpdate: false,
    reactionGroups: [],
  },
  {
    __typename: "PullRequestReview",
    id: "PRR_B",
    createdAt: "2026-10-01T09:20:00Z",
    submittedAt: "2026-10-01T09:20:00Z",
    author: actor("bob"),
    state: "APPROVED",
    body: "Ship it",
  },
  {
    __typename: "PullRequestCommit",
    id: "PURC_1",
    commit: {
      oid: "0123456789abcdef0123456789abcdef01234567",
      abbreviatedOid: "0123456",
      messageHeadline: "Fix the thing",
      messageBody: "Longer explanation",
      committedDate: "2026-10-01T08:00:00Z",
      author: { name: "Alice", user: actor("alice") },
      statusCheckRollup: { state: "ERROR" },
    },
  },
  {
    __typename: "PullRequestCommit",
    id: "PURC_2",
    commit: {
      oid: "89abcdef0123456789abcdef0123456789abcdef",
      abbreviatedOid: "89abcde",
      messageHeadline: "Unlinked author",
      messageBody: "",
      committedDate: "2026-10-01T08:30:00Z",
      author: { name: "Someone Else", user: null },
      statusCheckRollup: null,
    },
  },
  event("HeadRefForcePushedEvent", "HRFPE_1", {
    beforeCommit: { oid: "aaaaaaa" },
    afterCommit: null,
  }),
  event("ReviewRequestedEvent", "RRE_1", {
    requestedReviewer: { __typename: "Team", slug: "core", organization: { login: "acme" } },
  }),
  event("ReviewRequestRemovedEvent", "RRRE_1", {
    requestedReviewer: actor("copilot-pull-request-reviewer", "Bot"),
  }),
  event("LabeledEvent", "LE_1", {
    label: { name: "bug", color: "d73a4a", description: "" },
  }),
  event("UnlabeledEvent", "ULE_1", { label: { name: "wip", color: null, description: null } }),
  event("AssignedEvent", "AE_1", { assignee: { __typename: "User", login: "alice" } }),
  event("UnassignedEvent", "UAE_1", { assignee: { __typename: "Bot", login: "helper" } }),
  event("RenamedTitleEvent", "RTE_1", { previousTitle: "Old", currentTitle: "New" }),
  event("BaseRefChangedEvent", "BRCE_1", { previousRefName: "develop", currentRefName: "main" }),
  event("CrossReferencedEvent", "CRE_1", {
    willCloseTarget: true,
    source: {
      __typename: "PullRequest",
      number: 314404,
      title: "gh 2.102.0",
      url: "https://github.com/Homebrew/homebrew-core/pull/314404",
      state: "MERGED",
      repository: { nameWithOwner: "Homebrew/homebrew-core" },
    },
  }),
  event("CrossReferencedEvent", "CRE_2", {
    willCloseTarget: false,
    source: {
      __typename: "Issue",
      number: 12,
      title: "Crash on start",
      url: "https://github.com/acme/repo/issues/12",
      state: "OPEN",
      repository: { nameWithOwner: "acme/repo" },
    },
  }),
  event("ReadyForReviewEvent", "RFRE_1"),
  event("ConvertToDraftEvent", "CTDE_1"),
  event("AutoMergeEnabledEvent", "AMEE_1"),
  event("AutoSquashEnabledEvent", "ASEE_1"),
  event("AutoRebaseEnabledEvent", "AREE_1"),
  event("AutoMergeDisabledEvent", "AMDE_1"),
  event("ReviewDismissedEvent", "RDE_1", {
    dismissalMessage: "Outdated after rebase",
    review: { author: { login: "carol" } },
  }),
  event("HeadRefDeletedEvent", "HRDE_1"),
  event("HeadRefRestoredEvent", "HRRE_1"),
  event("ReopenedEvent", "RE_1"),
  event("MergedEvent", "ME_1", {
    commit: { oid: "6fc1c29d5477bfe71da7af290eb481c0df7811f1" },
    mergeRefName: "trunk",
  }),
  event("ClosedEvent", "CE_1"),
  // Malformed or unknown nodes are skipped, never fatal.
  { __typename: "IssueComment", id: "IC_BAD", createdAt: 42, body: "mistyped" },
  event("ReviewRequestedEvent", "RRE_GHOST", { requestedReviewer: null }),
  event("LabeledEvent", "LE_NO_LABEL", { label: { name: "  " } }),
  { __typename: "SomeFutureEvent", id: "SFE_1", createdAt: "2026-10-01T10:00:00Z" },
  null,
  "not-a-node",
];

const threadComment = (
  id: string,
  reviewId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  author: actor("bob"),
  authorAssociation: "MEMBER",
  body: `comment ${id}`,
  createdAt: "2026-10-01T09:12:00Z",
  updatedAt: "2026-10-01T09:12:00Z",
  url: `https://github.com/acme/repo/pull/7#discussion_${id}`,
  diffHunk: "@@ -1,3 +1,4 @@\n line",
  state: "SUBMITTED",
  isMinimized: false,
  viewerCanUpdate: false,
  viewerCanDelete: false,
  pullRequestReview: { id: reviewId },
  reactionGroups: reactions,
  ...extra,
});

const threadNodes: ReadonlyArray<unknown> = [
  {
    id: "PRRT_current",
    path: "src/app.ts",
    line: 12,
    startLine: 10,
    originalLine: 12,
    originalStartLine: 10,
    diffSide: "RIGHT",
    startDiffSide: "RIGHT",
    subjectType: "LINE",
    isResolved: true,
    isOutdated: false,
    resolvedBy: { login: "alice" },
    viewerCanReply: true,
    viewerCanResolve: false,
    viewerCanUnresolve: true,
    comments: {
      totalCount: 42,
      nodes: [
        threadComment("PRRC_1", "PRR_A", { originalCommit: { oid: " c0ffee0 " } }),
        threadComment("PRRC_2", "PRR_B", { originalCommit: { oid: "beef000" } }),
        { id: "PRRC_BAD", body: 7 },
      ],
    },
  },
  {
    id: "PRRT_outdated",
    path: "src/old.ts",
    line: null,
    startLine: null,
    originalLine: 45,
    originalStartLine: 42,
    diffSide: "LEFT",
    startDiffSide: "LEFT",
    subjectType: "LINE",
    isResolved: false,
    isOutdated: true,
    resolvedBy: null,
    viewerCanReply: true,
    viewerCanResolve: true,
    viewerCanUnresolve: false,
    comments: {
      totalCount: 1,
      nodes: [threadComment("PRRC_3", "PRR_A", { author: null, state: "PENDING" })],
    },
  },
  {
    id: "PRRT_file",
    path: "README.md",
    line: null,
    diffSide: "RIGHT",
    subjectType: "FILE",
    isResolved: false,
    isOutdated: false,
    viewerCanReply: true,
    viewerCanResolve: true,
    viewerCanUnresolve: false,
    comments: { totalCount: 1, nodes: [threadComment("PRRC_4", "PRR_B")] },
  },
  { id: "PRRT_broken", path: "x.ts", isResolved: "nope" },
];

const firstPage = (overrides: {
  readonly viewerPermission?: string;
  readonly state?: string;
  readonly locked?: boolean;
  readonly viewerLogin?: string;
  readonly pendingAuthor?: string;
  readonly timeline?: {
    readonly nodes: ReadonlyArray<unknown>;
    readonly hasPreviousPage?: boolean;
    readonly startCursor?: string | null;
  };
  readonly threads?: {
    readonly nodes: ReadonlyArray<unknown>;
    readonly hasNextPage?: boolean;
    readonly endCursor?: string | null;
  };
}) =>
  JSON.stringify({
    data: {
      viewer: { login: overrides.viewerLogin ?? "alice" },
      repository: {
        viewerPermission: overrides.viewerPermission ?? "WRITE",
        pullRequest: {
          id: "PR_7",
          number: 7,
          state: overrides.state ?? "OPEN",
          locked: overrides.locked ?? false,
          headRefOid: "0123456789abcdef0123456789abcdef01234567",
          author: actor("alice"),
          viewerDidAuthor: true,
          viewerCanUpdate: true,
          viewerCanUpdateBranch: true,
          viewerCanEnableAutoMerge: true,
          viewerCanDisableAutoMerge: false,
          pendingReviews: {
            nodes: [
              {
                id: "PRR_pending",
                author: { login: overrides.pendingAuthor ?? "alice" },
                comments: { totalCount: 3 },
              },
            ],
          },
          timelineItems: {
            pageInfo: {
              hasPreviousPage: overrides.timeline?.hasPreviousPage ?? false,
              startCursor: overrides.timeline?.startCursor ?? "t0",
            },
            nodes: overrides.timeline?.nodes ?? timelineNodes,
          },
          reviewThreads: {
            pageInfo: {
              hasNextPage: overrides.threads?.hasNextPage ?? false,
              endCursor: overrides.threads?.endCursor ?? "r0",
            },
            nodes: overrides.threads?.nodes ?? threadNodes,
          },
        },
      },
    },
  });

const decodeFirst = (raw: string) => {
  const result = Activity.decodeGitHubActivityFirstPageJson(raw);
  if (!Result.isSuccess(result)) throw new Error(result.failure);
  return result.success;
};

const assemble = (raw: string) =>
  Activity.assembleGitHubChangeRequestActivity({
    first: decodeFirst(raw),
    olderTimelinePages: [],
    laterThreadPages: [],
    timelineTruncated: false,
    reviewThreadsTruncated: false,
  });

const byId = (items: ReadonlyArray<ChangeRequestTimelineItem>, id: string) => {
  const item = items.find((entry) => entry.id === id);
  if (!item) throw new Error(`missing ${id}`);
  return item;
};

const encodeActivity = Schema.encodeUnknownSync(Schema.toCodecJson(ChangeRequestActivity));

describe("GitHub activity query documents", () => {
  it("asks for every timeline type the contract can represent", () => {
    for (const type of Activity.GITHUB_ACTIVITY_TIMELINE_ITEM_TYPES) {
      expect(Activity.GITHUB_PULL_REQUEST_ACTIVITY_QUERY).toContain(type);
    }
    expect(Activity.GITHUB_PULL_REQUEST_ACTIVITY_QUERY).toContain("timelineItems(last: 100");
    expect(Activity.GITHUB_PULL_REQUEST_TIMELINE_PAGE_QUERY).toContain("before: $before");
    expect(Activity.GITHUB_PULL_REQUEST_REVIEW_THREADS_PAGE_QUERY).toContain("after: $after");
    expect(Activity.GITHUB_PULL_REQUEST_ACTIVITY_QUERY).toContain(
      `comments(first: ${Activity.GITHUB_ACTIVITY_THREAD_COMMENTS})`,
    );
  });
});

describe("decodeGitHubActivityFirstPageJson", () => {
  it("normalizes every timeline kind and skips malformed nodes", () => {
    const activity = assemble(firstPage({}));

    expect(activity.timeline.map((item) => item.kind)).toEqual([
      "comment",
      "review",
      "review",
      "commit",
      "commit",
      "force-pushed",
      "review-requested",
      "review-request-removed",
      "labeled",
      "unlabeled",
      "assigned",
      "unassigned",
      "renamed",
      "base-ref-changed",
      "cross-referenced",
      "cross-referenced",
      "ready-for-review",
      "converted-to-draft",
      "auto-merge-enabled",
      "auto-merge-enabled",
      "auto-merge-enabled",
      "auto-merge-disabled",
      "review-dismissed",
      "head-ref-deleted",
      "head-ref-restored",
      "reopened",
      "merged",
      "closed",
    ]);
    // Contract-valid end to end: the RPC encoder accepts the payload.
    expect(() => encodeActivity(activity)).not.toThrow();
  });

  it("maps node details into the contract shapes", () => {
    const { timeline } = assemble(firstPage({}));

    const comment = byId(timeline, "IC_1");
    assert(comment.kind === "comment");
    expect(comment.body).toBe("Looks good");
    expect(comment.actor).toEqual({ login: "alice", avatarUrl: "https://avatars.example/alice" });
    expect(comment.viewerCanDelete).toBe(true);
    expect(comment.reactions).toEqual([{ content: "thumbs-up", count: 2, viewerHasReacted: true }]);
    expect(comment.updatedAt?.toString()).toContain("2026-10-01T09:05:00");

    const botReview = byId(timeline, "PRR_A");
    assert(botReview.kind === "review");
    expect(botReview.state).toBe("changes_requested");
    expect(botReview.actor?.isBot).toBe(true);
    expect(botReview.createdAt.toString()).toContain("09:11:00");

    const commit = byId(timeline, "PURC_1");
    assert(commit.kind === "commit");
    expect(commit).toMatchObject({
      shortOid: "0123456",
      messageHeadline: "Fix the thing",
      messageBody: "Longer explanation",
      checkState: "failure",
    });
    const unlinked = byId(timeline, "PURC_2");
    assert(unlinked.kind === "commit");
    expect(unlinked.actor).toEqual({ login: "Someone Else" });
    expect(unlinked.messageBody).toBeUndefined();
    expect(unlinked.checkState).toBeUndefined();

    expect(byId(timeline, "HRFPE_1")).toMatchObject({ beforeOid: "aaaaaaa" });
    expect(byId(timeline, "HRFPE_1")).not.toHaveProperty("afterOid");
    expect(byId(timeline, "RRE_1")).toMatchObject({ reviewer: "acme/core", reviewerKind: "team" });
    expect(byId(timeline, "RRRE_1")).toMatchObject({
      reviewer: "copilot-pull-request-reviewer",
      reviewerKind: "bot",
    });
    expect(byId(timeline, "LE_1")).toMatchObject({ label: { name: "bug", color: "d73a4a" } });
    expect(byId(timeline, "ULE_1")).toMatchObject({ label: { name: "wip" } });
    expect(byId(timeline, "UAE_1")).toMatchObject({ assignee: "helper" });
    expect(byId(timeline, "RTE_1")).toMatchObject({ previousTitle: "Old", currentTitle: "New" });
    expect(byId(timeline, "BRCE_1")).toMatchObject({
      previousRefName: "develop",
      currentRefName: "main",
    });
    expect(byId(timeline, "CRE_1")).toMatchObject({
      willCloseTarget: true,
      source: {
        kind: "change-request",
        number: 314404,
        repository: "Homebrew/homebrew-core",
        state: "merged",
      },
    });
    expect(byId(timeline, "CRE_2")).toMatchObject({ source: { kind: "issue", state: "open" } });
    expect(byId(timeline, "AMEE_1")).toMatchObject({ mergeMethod: "merge" });
    expect(byId(timeline, "ASEE_1")).toMatchObject({ mergeMethod: "squash" });
    expect(byId(timeline, "AREE_1")).toMatchObject({ mergeMethod: "rebase" });
    expect(byId(timeline, "AMDE_1")).not.toHaveProperty("mergeMethod");
    expect(byId(timeline, "RDE_1")).toMatchObject({
      reviewAuthor: "carol",
      message: "Outdated after rebase",
    });
    expect(byId(timeline, "ME_1")).toMatchObject({
      commitOid: "6fc1c29d5477bfe71da7af290eb481c0df7811f1",
      baseRefName: "trunk",
    });
  });

  it("normalizes review threads, including outdated, file-level, and paged comments", () => {
    const { reviewThreads } = assemble(firstPage({}));
    expect(reviewThreads.map((thread) => thread.id)).toEqual([
      "PRRT_current",
      "PRRT_outdated",
      "PRRT_file",
    ]);

    const [current, outdated, file] = reviewThreads;
    expect(current).toMatchObject({
      path: "src/app.ts",
      subjectType: "line",
      side: "right",
      startSide: "right",
      line: 12,
      startLine: 10,
      isResolved: true,
      resolvedBy: "alice",
      viewerCanReply: true,
      viewerCanUnresolve: true,
      diffHunk: "@@ -1,3 +1,4 @@\n line",
      // The opener's commit: `originalLine` refers to it, not to a reply's.
      originalCommitOid: "c0ffee0",
      // GitHub has more comments than the activity read carries.
      totalComments: 42,
    });
    // The mistyped comment is dropped; the rest of the thread survives.
    expect(current?.comments.map((comment) => comment.id)).toEqual(["PRRC_1", "PRRC_2"]);
    expect(current?.comments[0]?.state).toBe("submitted");

    expect(outdated).toMatchObject({
      side: "left",
      line: null,
      startLine: null,
      originalLine: 45,
      originalStartLine: 42,
      isOutdated: true,
    });
    expect(outdated?.comments[0]).toMatchObject({ state: "pending", author: { login: "ghost" } });
    expect(outdated).not.toHaveProperty("originalCommitOid");

    expect(file).toMatchObject({ subjectType: "file", line: null });
  });

  it("nests threads under the review whose comment opened them", () => {
    const { timeline } = assemble(firstPage({}));
    const reviewA = byId(timeline, "PRR_A");
    const reviewB = byId(timeline, "PRR_B");
    assert(reviewA.kind === "review" && reviewB.kind === "review");
    // PRRT_current's first comment belongs to PRR_A even though PRR_B replied in it.
    expect(reviewA.threadIds).toEqual(["PRRT_current", "PRRT_outdated"]);
    expect(reviewB.threadIds).toEqual(["PRRT_file"]);
  });

  it("derives viewer capabilities and the viewer's pending review", () => {
    const writer = decodeFirst(firstPage({ viewerPermission: "ADMIN" }));
    expect(writer.viewer).toEqual({
      login: "alice",
      isAuthor: true,
      canUpdate: true,
      canMerge: true,
      canReview: true,
      canUpdateBranch: true,
      canEnableAutoMerge: true,
      canDisableAutoMerge: false,
    });
    expect(writer.pendingReview).toEqual({ id: "PRR_pending", commentsCount: 3 });
    expect(writer.headSha).toBe("0123456789abcdef0123456789abcdef01234567");

    const reader = decodeFirst(firstPage({ viewerPermission: "READ", locked: true }));
    expect(reader.viewer).toMatchObject({ canMerge: false, canReview: false });

    const merged = decodeFirst(firstPage({ viewerPermission: "MAINTAIN", state: "MERGED" }));
    expect(merged.viewer?.canMerge).toBe(false);

    const someoneElsesPending = decodeFirst(firstPage({ pendingAuthor: "mallory" }));
    expect(someoneElsesPending.pendingReview).toBeNull();
  });

  it("reports GraphQL errors and missing pull requests instead of empty activity", () => {
    const errors = Activity.decodeGitHubActivityFirstPageJson(
      JSON.stringify({ data: null, errors: [{ message: "Something went wrong" }] }),
    );
    assert(Result.isFailure(errors));
    expect(errors.failure).toContain("Something went wrong");

    const missing = Activity.decodeGitHubActivityFirstPageJson(
      JSON.stringify({ data: { viewer: { login: "a" }, repository: { pullRequest: null } } }),
    );
    assert(Result.isFailure(missing));
  });
});

describe("fetchGitHubChangeRequestActivity", () => {
  const timelinePageJson = (
    nodes: ReadonlyArray<unknown>,
    hasPreviousPage: boolean,
    startCursor: string | null,
  ) =>
    JSON.stringify({
      data: {
        repository: {
          pullRequest: { timelineItems: { pageInfo: { hasPreviousPage, startCursor }, nodes } },
        },
      },
    });
  const threadsPageJson = (
    nodes: ReadonlyArray<unknown>,
    hasNextPage: boolean,
    endCursor: string | null,
  ) =>
    JSON.stringify({
      data: {
        repository: {
          pullRequest: { reviewThreads: { pageInfo: { hasNextPage, endCursor }, nodes } },
        },
      },
    });
  const commentNode = (id: string, minute: number) => ({
    __typename: "IssueComment",
    id,
    createdAt: `2026-10-01T10:${String(minute).padStart(2, "0")}:00Z`,
    author: actor("alice"),
    body: id,
  });

  it.effect("walks the timeline backwards, keeps it chronological, and bounds the pages", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly query: string; readonly variables: unknown }> = [];
      const responses = new Map<string, string>();
      for (let page = 1; page < Activity.GITHUB_ACTIVITY_TIMELINE_MAX_PAGES + 2; page += 1) {
        responses.set(
          `t${page - 1}`,
          timelinePageJson([commentNode(`IC_page_${page}`, 50 - page)], true, `t${page}`),
        );
      }
      const activity = yield* Activity.fetchGitHubChangeRequestActivity({
        owner: "acme",
        name: "repo",
        number: 7,
        runQuery: (query, variables) => {
          calls.push({ query, variables });
          if (query === Activity.GITHUB_PULL_REQUEST_ACTIVITY_QUERY) {
            return Effect.succeed(
              firstPage({
                timeline: {
                  nodes: [commentNode("IC_newest", 55)],
                  hasPreviousPage: true,
                  startCursor: "t0",
                },
                threads: { nodes: [threadNodes[0]], hasNextPage: true, endCursor: "r0" },
              }),
            );
          }
          if (query === Activity.GITHUB_PULL_REQUEST_TIMELINE_PAGE_QUERY) {
            const before = (variables as { readonly before: string }).before;
            return Effect.succeed(responses.get(before) ?? "{}");
          }
          return Effect.succeed(threadsPageJson([threadNodes[2]], false, null));
        },
        fail: (detail) => new Error(detail),
      });

      expect(activity.timeline.map((item) => item.id)).toEqual([
        "IC_page_4",
        "IC_page_3",
        "IC_page_2",
        "IC_page_1",
        "IC_newest",
      ]);
      expect(activity.timelineTruncated).toBe(true);
      expect(
        calls.filter((call) => call.query === Activity.GITHUB_PULL_REQUEST_TIMELINE_PAGE_QUERY),
      ).toHaveLength(Activity.GITHUB_ACTIVITY_TIMELINE_MAX_PAGES - 1);
      expect(calls[1]?.variables).toEqual({ owner: "acme", name: "repo", number: 7, before: "t0" });

      expect(activity.reviewThreads.map((thread) => thread.id)).toEqual([
        "PRRT_current",
        "PRRT_file",
      ]);
      expect(activity.reviewThreadsTruncated).toBe(false);
    }),
  );

  it.effect("stops on a repeated cursor and reports the threads as truncated", () =>
    Effect.gen(function* () {
      let threadPages = 0;
      const activity = yield* Activity.fetchGitHubChangeRequestActivity({
        owner: "acme",
        name: "repo",
        number: 7,
        runQuery: (query) => {
          if (query === Activity.GITHUB_PULL_REQUEST_ACTIVITY_QUERY) {
            return Effect.succeed(
              firstPage({ threads: { nodes: [], hasNextPage: true, endCursor: "same" } }),
            );
          }
          threadPages += 1;
          return Effect.succeed(threadsPageJson([], true, "same"));
        },
        fail: (detail) => new Error(detail),
      });
      expect(threadPages).toBe(1);
      expect(activity.reviewThreadsTruncated).toBe(true);
    }),
  );

  it.effect("fails with the decoder's message when a page is unreadable", () =>
    Effect.gen(function* () {
      const error = yield* Activity.fetchGitHubChangeRequestActivity({
        owner: "acme",
        name: "repo",
        number: 7,
        runQuery: () => Effect.succeed("not json"),
        fail: (detail) => new Error(detail),
      }).pipe(Effect.flip);
      expect(error.message).toContain("Invalid GitHub activity response");
    }),
  );
});

describe("single-node decoders", () => {
  it("reads one thread with its pull request scope and raw bodies", () => {
    const result = Activity.decodeGitHubReviewThreadNodeJson(
      JSON.stringify({
        data: {
          node: {
            __typename: "PullRequestReviewThread",
            pullRequest: { number: 7, repository: { nameWithOwner: "acme/repo" } },
            ...(threadNodes[0] as Record<string, unknown>),
            comments: {
              totalCount: 1,
              nodes: [threadComment("PRRC_9", "PRR_A", { body: `hi\n\n${marker}` })],
            },
          },
        },
      }),
    );
    assert(Result.isSuccess(result));
    expect(result.success.scope).toEqual({ number: 7, repository: "acme/repo" });
    expect(result.success.thread.thread.comments[0]?.body).toBe("hi");
    expect(result.success.thread.rawCommentBodies[0]).toContain(marker);

    const notAThread = Activity.decodeGitHubReviewThreadNodeJson(
      JSON.stringify({ data: { node: { __typename: "IssueComment" } } }),
    );
    assert(Result.isFailure(notAThread));
  });

  it("reads node scopes and resolve results", () => {
    const scope = Activity.decodeGitHubNodeScopeJson(
      JSON.stringify({
        data: {
          node: {
            __typename: "IssueComment",
            id: "IC_1",
            pullRequest: { number: 7, repository: { nameWithOwner: "acme/repo" } },
          },
        },
      }),
    );
    assert(Result.isSuccess(scope));
    expect(scope.success).toEqual({
      typename: "IssueComment",
      scope: { number: 7, repository: "acme/repo" },
    });
    const missing = Activity.decodeGitHubNodeScopeJson(JSON.stringify({ data: { node: null } }));
    assert(Result.isSuccess(missing));
    expect(missing.success).toBeNull();

    const resolved = Activity.decodeGitHubResolveThreadJson(
      JSON.stringify({
        data: {
          resolveReviewThread: {
            thread: { id: "PRRT_1", isResolved: true, resolvedBy: { login: "alice" } },
          },
        },
      }),
    );
    assert(Result.isSuccess(resolved));
    expect(resolved.success).toEqual({ threadId: "PRRT_1", isResolved: true, resolvedBy: "alice" });
  });
});
