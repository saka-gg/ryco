import { describe, expect, it } from "vite-plus/test";

import { indexForgejoDiffLines } from "./forgejoDiffLines.ts";
import {
  ForgejoCommitSchema,
  ForgejoPullRequestSchema,
  normalizeForgejoPullRequestRecord,
} from "./forgejoPullRequests.ts";
import {
  ForgejoPullReviewCommentSchema,
  ForgejoPullReviewSchema,
  ForgejoReactionSchema,
  ForgejoTimelineEventSchema,
  buildForgejoReviewThreads,
  decodeForgejoEntries,
  deriveForgejoViewerCapabilities,
  forgejoPendingReview,
  forgejoThreadsNeedCurrentDiff,
  forgejoViewerContext,
  normalizeForgejoTimeline,
  parseForgejoCommentId,
  parseForgejoThreadId,
  summarizeForgejoReactions,
  toForgejoReactionContent,
  type ForgejoReviewWithComments,
} from "./forgejoPullRequestActivity.ts";
import {
  forgejoHeadSha,
  forgejoOldHeadSha,
  forgejoPullRequest,
  forgejoPullRequestCommits,
  forgejoPullRequestDiff,
  forgejoReactions,
  forgejoReviewComments,
  forgejoReviews,
  forgejoTimeline,
} from "./forgejoPullRequestPage.fixtures.ts";

const reviews = decodeForgejoEntries(ForgejoPullReviewSchema, forgejoReviews);
const reviewsWithComments: ReadonlyArray<ForgejoReviewWithComments> = reviews.map((review) => ({
  review,
  comments: decodeForgejoEntries(
    ForgejoPullReviewCommentSchema,
    forgejoReviewComments[review.id] ?? [],
  ),
}));
const viewer = forgejoViewerContext({ login: "alice", permissions: { admin: false, push: true } });
const diff = indexForgejoDiffLines(forgejoPullRequestDiff);

function threads(input?: { readonly diff?: typeof diff | null; readonly headSha?: string }) {
  return buildForgejoReviewThreads({
    reviews: reviewsWithComments,
    anchor: {
      headSha: input?.headSha ?? forgejoHeadSha,
      diff: input?.diff === undefined ? diff : input.diff,
    },
    viewer,
    viewerCanReply: true,
  });
}

describe("decodeForgejoEntries", () => {
  it("decodes the documented payloads and skips rows that do not match", () => {
    expect(decodeForgejoEntries(ForgejoTimelineEventSchema, forgejoTimeline)).toHaveLength(
      forgejoTimeline.length,
    );
    expect(
      decodeForgejoEntries(ForgejoPullReviewSchema, [...forgejoReviews, { id: "x" }]),
    ).toHaveLength(forgejoReviews.length);
    expect(decodeForgejoEntries(ForgejoReactionSchema, forgejoReactions)).toHaveLength(4);
  });
});

describe("buildForgejoReviewThreads", () => {
  it("groups a review's comments by path and line, with replies in the opener's thread", () => {
    const result = threads();
    expect(result.threads.map((thread) => thread.id)).toEqual(["101/301", "101/303", "105/304"]);
    const first = result.threads[0]!;
    expect(first).toMatchObject({
      path: "src/app.ts",
      subjectType: "line",
      side: "right",
      line: 12,
      originalLine: 12,
      originalCommitOid: forgejoOldHeadSha,
      diffHunk: expect.stringContaining("const c = 4;"),
      isResolved: true,
      resolvedBy: "alice",
      isOutdated: false,
      viewerCanReply: true,
      viewerCanResolve: false,
      viewerCanUnresolve: false,
      totalComments: 2,
    });
    expect(
      first.comments.map((comment) => [comment.id, comment.author.login, comment.body]),
    ).toEqual([
      ["101:301", "dave", "Should `c` be configurable?"],
      ["101:302", "alice", "Done."],
    ]);
    // The viewer edits and deletes only their own comments.
    expect(first.comments.map((comment) => comment.viewerCanUpdate)).toEqual([false, true]);
    expect(first.comments[0]?.state).toBe("submitted");
    expect(result.threadIdsByReviewId.get(101)).toEqual(["101/301", "101/303"]);
  });

  it("maps base-side comments to the left side", () => {
    const thread = threads().threads.find((candidate) => candidate.id === "101/303");
    expect(thread).toMatchObject({
      path: "src/setup.ts",
      side: "left",
      line: 5,
      isOutdated: false,
    });
  });

  it("keeps a thread from an older head current only while its line still reads the same", () => {
    // Without the current diff, a thread written on another head cannot be placed.
    const unplaced = threads({ diff: null }).threads.find((thread) => thread.id === "101/301");
    expect(unplaced).toMatchObject({ line: null, originalLine: 12, isOutdated: true });

    const changed = indexForgejoDiffLines(
      forgejoPullRequestDiff.replace("const c = 4;", "const c = 5;"),
    );
    const outdated = threads({ diff: changed }).threads.find((thread) => thread.id === "101/301");
    expect(outdated).toMatchObject({ line: null, isOutdated: true });
  });

  it("marks the viewer's pending review comments as pending", () => {
    const pending = threads().threads.find((thread) => thread.id === "105/304");
    expect(pending?.comments[0]?.state).toBe("pending");
    expect(pending).toMatchObject({ line: 2, isOutdated: false });
  });

  it("reads multi-line comments (Forgejo 16 extra_lines_count) as ranges ending on the excerpt's line", () => {
    const [review] = decodeForgejoEntries(ForgejoPullReviewSchema, [forgejoReviews[0]]);
    const [comment] = decodeForgejoEntries(ForgejoPullReviewCommentSchema, [
      { ...forgejoReviewComments[101]![0], position: 11, extra_lines_count: 1 },
    ]);
    const result = buildForgejoReviewThreads({
      reviews: [{ review: review!, comments: [comment!] }],
      anchor: { headSha: forgejoHeadSha, diff },
      viewer,
      viewerCanReply: true,
    });
    expect(result.threads[0]).toMatchObject({
      line: 12,
      startLine: 11,
      originalLine: 12,
      originalStartLine: 11,
    });
  });

  it("only asks for the current diff when a thread was written on another head", () => {
    expect(forgejoThreadsNeedCurrentDiff(reviewsWithComments, forgejoHeadSha)).toBe(true);
    expect(
      forgejoThreadsNeedCurrentDiff(
        reviewsWithComments.filter(({ review }) => review.id === 105),
        forgejoHeadSha,
      ),
    ).toBe(false);
  });
});

describe("normalizeForgejoTimeline", () => {
  const events = decodeForgejoEntries(ForgejoTimelineEventSchema, forgejoTimeline);
  const commits = decodeForgejoEntries(ForgejoCommitSchema, forgejoPullRequestCommits);
  const built = threads();
  const timeline = normalizeForgejoTimeline({
    events,
    commits,
    reviewsById: new Map(reviews.map((review) => [review.id, review])),
    threadIdsByReviewId: built.threadIdsByReviewId,
    reactionsByCommentId: new Map([
      [
        902,
        summarizeForgejoReactions(
          decodeForgejoEntries(ForgejoReactionSchema, forgejoReactions),
          "alice",
        ),
      ],
    ]),
    viewer,
    baseRefName: "main",
  });

  it("maps every supported row kind in chronological order", () => {
    expect(timeline.truncated).toBe(false);
    expect(timeline.items.map((item) => [item.id, item.kind])).toEqual([
      ["900", "labeled"],
      ["901", "review-requested"],
      ["902", "comment"],
      ["903", "review"],
      [`commit:${forgejoHeadSha}`, "commit"],
      ["904", "force-pushed"],
      ["906", "review"],
      ["907", "assigned"],
      ["908", "renamed"],
      ["909", "base-ref-changed"],
      ["910", "cross-referenced"],
      ["911", "review"],
      ["912", "review-dismissed"],
      ["914", "closed"],
      ["915", "reopened"],
      ["916", "head-ref-deleted"],
    ]);
  });

  it("strips Ryco's idempotency marker and carries reactions and permissions", () => {
    const comment = timeline.items.find((item) => item.id === "902");
    expect(comment).toMatchObject({
      kind: "comment",
      body: "Looks promising.",
      actor: { login: "bob", avatarUrl: "https://codeberg.test/avatars/bob" },
      url: "https://codeberg.test/pingdotgg/ryco/pulls/42#issuecomment-902",
      viewerCanUpdate: false,
      viewerCanDelete: false,
      reactions: [
        { content: "thumbs-up", count: 2, viewerHasReacted: false },
        { content: "heart", count: 1, viewerHasReacted: true },
      ],
    });
  });

  it("nests threads under reviews and reads states from the review list", () => {
    expect(timeline.items.find((item) => item.id === "903")).toMatchObject({
      kind: "review",
      state: "commented",
      body: "A few notes inline.",
      threadIds: ["101/301", "101/303"],
      viewerCanUpdate: false,
    });
    expect(timeline.items.find((item) => item.id === "906")).toMatchObject({ state: "approved" });
    expect(timeline.items.find((item) => item.id === "911")).toMatchObject({ state: "dismissed" });
    expect(timeline.items.find((item) => item.id === "912")).toMatchObject({
      reviewAuthor: "carol",
      message: "Addressed in the latest push.",
    });
  });

  it("maps event payloads", () => {
    const byId = new Map(timeline.items.map((item) => [item.id, item]));
    expect(byId.get("900")).toMatchObject({
      label: { name: "enhancement", color: "84b6eb", description: "New feature" },
    });
    expect(byId.get("901")).toMatchObject({ reviewer: "erin", reviewerKind: "user" });
    expect(byId.get("904")).toMatchObject({
      beforeOid: forgejoOldHeadSha,
      afterOid: forgejoHeadSha,
    });
    expect(byId.get("907")).toMatchObject({ assignee: "bob" });
    expect(byId.get("908")).toMatchObject({
      previousTitle: "WIP: Add Forgejo review page",
      currentTitle: "Add Forgejo review page",
    });
    expect(byId.get("909")).toMatchObject({ previousRefName: "develop", currentRefName: "main" });
    expect(byId.get("910")).toMatchObject({
      source: {
        kind: "change-request",
        number: 43,
        title: "Follow-up fixes",
        repository: "pingdotgg/ryco",
        state: "open",
      },
      willCloseTarget: true,
    });
    expect(byId.get(`commit:${forgejoHeadSha}`)).toMatchObject({
      oid: forgejoHeadSha,
      shortOid: forgejoHeadSha.slice(0, 7),
      messageHeadline: "Render review threads",
      messageBody: "With outdated detection.",
      actor: { login: "alice" },
    });
  });

  it("keeps the newest items when over budget", () => {
    const capped = normalizeForgejoTimeline({
      events,
      commits: [],
      reviewsById: new Map(),
      threadIdsByReviewId: new Map(),
      viewer: null,
      baseRefName: null,
      maxItems: 2,
    });
    expect(capped.truncated).toBe(true);
    expect(capped.items.map((item) => item.id)).toEqual(["915", "916"]);
  });
});

describe("viewer and pending review", () => {
  const record = normalizeForgejoPullRequestRecord(
    // The fixture is the raw API payload; decode it like the API layer does.
    (() => {
      const decoded = decodeForgejoEntries(ForgejoPullRequestSchema, [forgejoPullRequest]);
      return decoded[0]!;
    })(),
  );

  it("derives permissions from repository permissions and the base branch", () => {
    expect(
      deriveForgejoViewerCapabilities({
        viewer,
        authorLogin: record.author,
        isLocked: false,
        isCrossRepository: false,
        allowMaintainerEdit: false,
        userCanMergeBase: true,
      }),
    ).toEqual({
      login: "alice",
      isAuthor: true,
      canUpdate: true,
      canMerge: true,
      canReview: true,
      canUpdateBranch: true,
      canEnableAutoMerge: false,
      canDisableAutoMerge: false,
    });
    const reader = forgejoViewerContext({ login: "zed", permissions: { push: false } });
    expect(
      deriveForgejoViewerCapabilities({
        viewer: reader,
        authorLogin: "alice",
        isLocked: true,
        isCrossRepository: true,
        allowMaintainerEdit: true,
        userCanMergeBase: null,
      }),
    ).toMatchObject({
      isAuthor: false,
      canUpdate: false,
      canMerge: false,
      canReview: false,
      canUpdateBranch: false,
    });
    expect(
      deriveForgejoViewerCapabilities({
        viewer: null,
        authorLogin: "alice",
        isLocked: false,
        isCrossRepository: false,
        allowMaintainerEdit: false,
        userCanMergeBase: null,
      }),
    ).toBeNull();
  });

  it("reports the viewer's pending review only", () => {
    expect(forgejoPendingReview(reviewsWithComments, viewer)).toEqual({
      id: "105",
      commentsCount: 1,
    });
    expect(
      forgejoPendingReview(
        reviewsWithComments,
        forgejoViewerContext({ login: "bob", permissions: null }),
      ),
    ).toBeNull();
  });
});

describe("ids and reactions", () => {
  it("round-trips comment and thread ids", () => {
    expect(parseForgejoCommentId("902")).toEqual({ kind: "issue-comment", commentId: 902 });
    expect(parseForgejoCommentId("101:301")).toEqual({
      kind: "review-comment",
      reviewId: 101,
      commentId: 301,
    });
    expect(parseForgejoCommentId("abc")).toBeNull();
    expect(parseForgejoThreadId("101/301")).toEqual({ reviewId: 101, firstCommentId: 301 });
    expect(parseForgejoThreadId("101:301")).toBeNull();
  });

  it("maps reaction names both ways and skips custom reactions", () => {
    expect(toForgejoReactionContent("thumbs-up")).toBe("+1");
    expect(toForgejoReactionContent("thumbs-down")).toBe("-1");
    expect(toForgejoReactionContent("rocket")).toBe("rocket");
    const summary = summarizeForgejoReactions(
      decodeForgejoEntries(ForgejoReactionSchema, forgejoReactions),
      null,
    );
    expect(summary.map((reaction) => reaction.content)).toEqual(["thumbs-up", "heart"]);
  });
});

describe("times", () => {
  it("treats Forgejo's zero time as unset", () => {
    const [event] = decodeForgejoEntries(ForgejoTimelineEventSchema, [
      { ...forgejoTimeline[2], created_at: "0001-01-01T00:00:00Z" },
    ]);
    const result = normalizeForgejoTimeline({
      events: [event!],
      commits: [],
      reviewsById: new Map(),
      threadIdsByReviewId: new Map(),
      viewer: null,
      baseRefName: null,
    });
    expect(result.items).toEqual([]);
  });
});
