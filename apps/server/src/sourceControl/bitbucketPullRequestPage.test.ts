import { DateTime, Option, Result, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import * as Page from "./bitbucketPullRequestPage.ts";
import * as Fixtures from "./bitbucketPullRequestPageFixtures.ts";
import { BitbucketPullRequestSchema } from "./bitbucketPullRequests.ts";

const pullRequest = Schema.decodeUnknownSync(BitbucketPullRequestSchema)(Fixtures.pullRequest);
const activity = Schema.decodeUnknownSync(Page.BitbucketActivityPageSchema)(Fixtures.activityPage);
const comments = Schema.decodeUnknownSync(Page.BitbucketPullRequestCommentPageSchema)(
  Fixtures.commentsPage,
);
const commits = Schema.decodeUnknownSync(Page.BitbucketCommitPageSchema)(Fixtures.commitsPage);
const viewer = Schema.decodeUnknownSync(Page.BitbucketViewerSchema)(Fixtures.viewer);
const checks = Schema.decodeUnknownSync(Page.BitbucketMergeabilityChecksSchema)(
  Fixtures.mergeabilityChecks,
);

const iso = (value: DateTime.Utc | undefined) => (value ? DateTime.formatIso(value) : undefined);

function assemble(
  overrides: Partial<Parameters<typeof Page.assembleBitbucketChangeRequestActivity>[0]> = {},
) {
  return Page.assembleBitbucketChangeRequestActivity({
    pullRequest,
    headSha: Fixtures.HEAD_SHA,
    viewer,
    permission: "write",
    activity: activity.values,
    activityTruncated: false,
    comments: comments.values,
    commentsTruncated: false,
    commits: commits.values,
    commitsTruncated: false,
    ...overrides,
  });
}

describe("Bitbucket review threads", () => {
  it("groups inline comments into threads keyed by the root comment and maps sides", () => {
    const result = assemble();
    expect(result.reviewThreads.map((thread) => thread.id)).toEqual([
      "118571000",
      "118571088",
      "118571600",
    ]);

    const left = result.reviewThreads[1]!;
    expect(left).toMatchObject({
      path: "packages/editor/src/index.ts",
      subjectType: "line",
      side: "left",
      line: 211,
      originalLine: 211,
      isOutdated: false,
      isResolved: false,
      viewerCanReply: true,
      viewerCanResolve: true,
      viewerCanUnresolve: false,
      totalComments: 2,
    });
    expect(left.comments.map((comment) => [comment.id, comment.author.login])).toEqual([
      ["118571088", "Jessica Yeh"],
      ["118571200", "Name Lastname"],
    ]);
    // Only the viewer's own comments are editable.
    expect(left.comments.map((comment) => comment.viewerCanUpdate)).toEqual([true, false]);
    expect(left.comments[0]?.url).toBe(
      "https://bitbucket.org/atlassian/atlaskit-mk-2/pull-requests/5695/_/diff#comment-118571088",
    );
  });

  it("reports outdated range threads by their original lines and resolution", () => {
    const outdated = assemble().reviewThreads[0]!;
    expect(outdated).toMatchObject({
      path: "README.md",
      side: "right",
      line: null,
      originalLine: 12,
      startSide: "right",
      startLine: null,
      originalStartLine: 10,
      isOutdated: true,
      isResolved: true,
      resolvedBy: "Jessica Yeh",
      viewerCanResolve: false,
      viewerCanUnresolve: true,
    });
  });

  it("keeps pending drafts visible but not actionable", () => {
    const pending = assemble().reviewThreads[2]!;
    expect(pending.comments[0]?.state).toBe("pending");
    expect(pending.viewerCanReply).toBe(false);
    expect(pending.viewerCanResolve).toBe(false);
  });

  it("drops replies whose root is outside the window and flags the threads truncated", () => {
    const reply = comments.values.find((comment) => comment.id === 118571200)!;
    const conversation = Page.buildBitbucketConversation({ comments: [reply], viewer: null });
    expect(conversation.threads).toEqual([]);
    expect(conversation.missingRoots).toBe(true);
    expect(assemble({ comments: [reply] }).reviewThreadsTruncated).toBe(true);
  });

  it("anchors file comments and cross-side ranges", () => {
    expect(Page.bitbucketThreadAnchor({ path: "a.ts" })).toMatchObject({
      subjectType: "file",
      line: null,
    });
    expect(Page.bitbucketThreadAnchor({ path: "a.ts", to: 9, start_from: 4 })).toMatchObject({
      side: "right",
      line: 9,
      startSide: "left",
      startLine: 4,
    });
    // A one-line "range" is a plain line comment.
    expect(Page.bitbucketThreadAnchor({ path: "a.ts", to: 9, start_to: 9 })).not.toHaveProperty(
      "startLine",
    );
  });
});

describe("Bitbucket timeline", () => {
  it("diffs update snapshots, orders commits, and interleaves verdicts and comments", () => {
    const result = assemble();
    expect(result.timeline.map((item) => item.kind)).toEqual([
      "renamed",
      "force-pushed",
      "review-requested",
      "commit",
      "commit",
      "review",
      "comment",
      "review",
    ]);
    expect(result.timeline[0]).toMatchObject({
      previousTitle: "WIP: onClick",
      currentTitle: Fixtures.PULL_REQUEST_TITLE,
    });
    expect(result.timeline[1]).toMatchObject({
      beforeOid: Fixtures.REWRITTEN_SHA,
      afterOid: "728c8bad1813",
    });
    expect(result.timeline[2]).toMatchObject({ reviewer: "Jessica Yeh", reviewerKind: "user" });
    // Same commit date: the parent comes first.
    expect(
      result.timeline.slice(3, 5).map((item) => (item.kind === "commit" ? item.oid : null)),
    ).toEqual([Fixtures.PARENT_SHA, Fixtures.HEAD_SHA]);
    expect(result.timeline[4]).toMatchObject({
      messageHeadline: "Use onClick",
      messageBody: "Keeps the editor collapsed while tabbing.",
      actor: { login: "Brodie Rao" },
    });
    expect(result.timeline[5]).toMatchObject({
      state: "approved",
      actor: { login: "Jessica Yeh" },
      threadIds: [],
    });
    expect(result.timeline[6]).toMatchObject({
      id: "118571400",
      body: "Thanks for the reviews!",
      viewerCanUpdate: false,
    });
    expect(result.timeline[7]).toMatchObject({
      state: "changes_requested",
      actor: { login: "Brodie Rao" },
    });
    expect(result.timelineTruncated).toBe(false);
    expect(result.pendingReview).toBeNull();
  });

  it("does not claim force pushes when the commit list was cut short", () => {
    const result = assemble({ commitsTruncated: true });
    expect(result.timeline.some((item) => item.kind === "force-pushed")).toBe(false);
    expect(result.timelineTruncated).toBe(true);
  });

  it("names the merger on the final merge transition", () => {
    const merged = Schema.decodeUnknownSync(BitbucketPullRequestSchema)({
      ...Fixtures.pullRequest,
      state: "MERGED",
      closed_by: Fixtures.reviewerUser,
      merge_commit: { hash: "abcdef123456" },
    });
    const update = (date: string, state: string) => ({
      update: { date, state, title: "t", destination: { branch: { name: "master" } } },
    });
    const timeline = Page.buildBitbucketTimeline({
      pullRequest: merged,
      activity: [update("2019-01-02T00:00:00Z", "MERGED"), update("2019-01-01T00:00:00Z", "OPEN")],
      commits: [],
      commitsComplete: true,
      comments: [],
    });
    expect(timeline).toEqual([
      expect.objectContaining({
        kind: "merged",
        actor: expect.objectContaining({ login: "Jessica Yeh" }),
        commitOid: "abcdef123456",
        baseRefName: "master",
      }),
    ]);
  });
});

describe("Bitbucket viewer", () => {
  it("derives permissions from the account and repository permission", () => {
    expect(assemble().viewer).toEqual({
      login: "Jessica Yeh",
      isAuthor: false,
      canUpdate: true,
      canMerge: true,
      canReview: true,
      canUpdateBranch: false,
      canEnableAutoMerge: false,
      canDisableAutoMerge: false,
    });
  });

  it("is conservative without a readable permission", () => {
    const author = Schema.decodeUnknownSync(Page.BitbucketViewerSchema)(Fixtures.authorUser);
    expect(assemble({ viewer: author, permission: null }).viewer).toMatchObject({
      isAuthor: true,
      canUpdate: true,
      canMerge: false,
    });
    expect(assemble({ permission: "read" }).viewer).toMatchObject({
      canUpdate: false,
      canMerge: false,
    });
  });

  it("reads the permission of this repository only", () => {
    const page = Schema.decodeUnknownSync(Page.BitbucketRepositoryPermissionPageSchema)(
      Fixtures.permissionsPage,
    );
    expect(Page.bitbucketRepositoryPermission(page, "Atlassian/Atlaskit-MK-2")).toBe("write");
    expect(Page.bitbucketRepositoryPermission(page, "atlassian/other")).toBeNull();
  });
});

describe("Bitbucket merge readiness", () => {
  it("maps participants to reviewer states, leaving the author out", () => {
    const states = Page.bitbucketReviewerStates(pullRequest);
    expect(states.map((state) => [state.login, state.state])).toEqual([
      ["Jessica Yeh", "approved"],
      ["Brodie Rao", "changes_requested"],
    ]);
    expect(iso(states[0]?.submittedAt)).toBe("2019-09-27T00:37:19.849Z");
    expect(Page.bitbucketReviewDecision(states, checks.values)).toBe("changes_requested");
  });

  it("decides reviews from approval merge checks, else from approvals", () => {
    const approved = [{ login: "a", kind: "user" as const, state: "approved" as const }];
    const requested = [{ login: "a", kind: "user" as const, state: "requested" as const }];
    const conflicting = Schema.decodeUnknownSync(Page.BitbucketMergeabilityChecksSchema)(
      Fixtures.conflictingMergeabilityChecks,
    );
    expect(Page.bitbucketReviewDecision(approved, checks.values)).toBe("approved");
    expect(Page.bitbucketReviewDecision(approved, conflicting.values)).toBe("review_required");
    expect(Page.bitbucketReviewDecision(approved, null)).toBe("approved");
    expect(Page.bitbucketReviewDecision(requested, null)).toBeNull();
  });

  it("maps mergeability checks to mergeability and merge state", () => {
    const conflicting = Schema.decodeUnknownSync(Page.BitbucketMergeabilityChecksSchema)(
      Fixtures.conflictingMergeabilityChecks,
    );
    expect(Page.bitbucketMergeReadiness({ checks: checks.values, isDraft: false })).toEqual({
      mergeability: "mergeable",
      mergeStateStatus: "clean",
    });
    expect(Page.bitbucketMergeReadiness({ checks: conflicting.values, isDraft: false })).toEqual({
      mergeability: "conflicting",
      mergeStateStatus: "dirty",
    });
    expect(Page.bitbucketMergeReadiness({ checks: checks.values, isDraft: true })).toEqual({
      mergeability: "mergeable",
      mergeStateStatus: "draft",
    });
    expect(Page.bitbucketMergeReadiness({ checks: null, isDraft: false })).toEqual({
      mergeability: "unknown",
      mergeStateStatus: "unknown",
    });
    const blocked = Schema.decodeUnknownSync(Page.BitbucketMergeabilityChecksSchema)({
      values: Fixtures.mergeabilityChecks.values.filter(
        (check) => check.type !== "standard_merge_check",
      ),
    }).values.concat(
      Schema.decodeUnknownSync(Page.BitbucketMergeabilityChecksSchema)(
        Fixtures.conflictingMergeabilityChecks,
      ).values.filter((check) => check.type === "standard_merge_check"),
    );
    expect(Page.bitbucketMergeReadiness({ checks: blocked, isDraft: false }).mergeStateStatus).toBe(
      "blocked",
    );
  });

  it("rolls up the head commit's build statuses", () => {
    const statuses = Schema.decodeUnknownSync(Page.BitbucketCommitStatusPageSchema)(
      Fixtures.statusesPage,
    );
    const rollup = Page.bitbucketCheckRollup(statuses.values, Fixtures.HEAD_SHA);
    expect(
      rollup.map((item) => [
        item.name,
        Option.getOrNull(item.status),
        Option.getOrNull(item.conclusion),
        Option.getOrNull(item.url),
      ]),
    ).toEqual([
      ["BB-DEPLOY-1", "COMPLETED", "SUCCESS", "https://ci.example.com/BB-DEPLOY-1"],
      ["Lint", "IN_PROGRESS", null, "https://ci.example.com/LINT-7"],
    ]);
    expect(Option.isSome(rollup[0]!.completedAt)).toBe(true);
    expect(Option.isNone(rollup[1]!.completedAt)).toBe(true);
  });

  it("maps merge methods onto the branch's merge strategies", () => {
    const strategies = pullRequest.destination.branch.merge_strategies;
    expect(Page.bitbucketMergeCapabilities(strategies)).toEqual({
      merge: true,
      squash: true,
      rebase: true,
    });
    expect(Page.bitbucketMergeStrategy("merge", strategies)).toBe("merge_commit");
    expect(Page.bitbucketMergeStrategy("squash", strategies)).toBe("squash");
    expect(Page.bitbucketMergeStrategy("rebase", strategies)).toBe("fast_forward");
    expect(Page.bitbucketMergeStrategy("rebase", ["rebase_fast_forward", "fast_forward"])).toBe(
      "rebase_fast_forward",
    );
    expect(Page.bitbucketMergeStrategy("squash", ["merge_commit"])).toBeNull();
    expect(Page.bitbucketMergeCapabilities(undefined)).toBeUndefined();
  });
});

describe("Bitbucket request bodies", () => {
  it("anchors draft line comments on the right side, left side, ranges and files", () => {
    const build = (comment: Parameters<typeof Page.buildBitbucketInlineCommentBody>[0]) =>
      Page.buildBitbucketInlineCommentBody(comment);
    expect(build({ path: "src/a.ts", body: "new", line: 4, side: "right" })).toEqual(
      Result.succeed({ content: { raw: "new" }, inline: { path: "src/a.ts", to: 4 } }),
    );
    expect(build({ path: "src/a.ts", body: "old", line: 4, side: "left" })).toEqual(
      Result.succeed({ content: { raw: "old" }, inline: { path: "src/a.ts", from: 4 } }),
    );
    expect(
      build({ path: "src/a.ts", body: "range", line: 9, side: "right", startLine: 5 }),
    ).toEqual(
      Result.succeed({
        content: { raw: "range" },
        inline: { path: "src/a.ts", to: 9, start_to: 5 },
      }),
    );
    expect(
      build({
        path: "src/a.ts",
        body: "x",
        line: 9,
        side: "right",
        startLine: 3,
        startSide: "left",
      }),
    ).toEqual(
      Result.succeed({ content: { raw: "x" }, inline: { path: "src/a.ts", to: 9, start_from: 3 } }),
    );
    expect(build({ path: "src/a.ts", body: "file", subjectType: "file" })).toEqual(
      Result.succeed({ content: { raw: "file" }, inline: { path: "src/a.ts" } }),
    );
    expect(Result.isFailure(build({ path: "../etc/passwd", body: "x", line: 1 }))).toBe(true);
    expect(Result.isFailure(build({ path: "src/a.ts", body: "x" }))).toBe(true);
    expect(Result.isFailure(build({ path: "src/a.ts", body: "x", line: 2, startLine: 5 }))).toBe(
      true,
    );
  });

  it("keeps the title and reviewers in every pull request update", () => {
    const reviewers = [{ uuid: Fixtures.reviewerUser.uuid }];
    expect(
      Page.buildBitbucketPullRequestUpdateBody({
        pullRequest,
        action: { kind: "edit", body: "New body", baseRefName: "develop" },
      }),
    ).toEqual({
      title: Fixtures.PULL_REQUEST_TITLE,
      description: "New body",
      destination: { branch: { name: "develop" } },
      reviewers,
    });
    expect(
      Page.buildBitbucketPullRequestUpdateBody({
        pullRequest,
        action: { kind: "set-draft", draft: true },
      }),
    ).toEqual({ title: Fixtures.PULL_REQUEST_TITLE, draft: true, reviewers });
    expect(
      Page.buildBitbucketPullRequestUpdateBody({
        pullRequest,
        action: { kind: "reviewers" },
        reviewers: [{ account_id: "557058:x" }],
      }),
    ).toEqual({ title: Fixtures.PULL_REQUEST_TITLE, reviewers: [{ account_id: "557058:x" }] });
  });

  it("resolves reviewer logins to accounts", () => {
    const candidates = [Fixtures.authorUser, Fixtures.reviewerUser, Fixtures.otherUser];
    const resolved = Page.resolveBitbucketReviewerSet({
      current: [Fixtures.reviewerUser],
      candidates,
      add: ["brodie"],
      remove: ["Jessica Yeh"],
    });
    expect(Result.map(resolved, (accounts) => accounts.map((account) => account.uuid))).toEqual(
      Result.succeed([Fixtures.otherUser.uuid]),
    );
    expect(
      Result.isFailure(
        Page.resolveBitbucketReviewerSet({ current: [], candidates, add: ["nobody"], remove: [] }),
      ),
    ).toBe(true);
    const twin = { ...Fixtures.otherUser, uuid: "{twin}", account_id: "557058:twin" };
    expect(
      Page.resolveBitbucketReviewerSet({
        current: [],
        candidates: [Fixtures.otherUser, twin],
        add: ["Brodie Rao"],
        remove: [],
      }),
    ).toEqual(Result.fail("Several Bitbucket users are named Brodie Rao; pick one on Bitbucket."));
  });
});

describe("Bitbucket commit identity", () => {
  it("matches abbreviated and full hashes by prefix", () => {
    expect(Page.bitbucketCommitsMatch("728c8bad1813", Fixtures.HEAD_SHA)).toBe(true);
    expect(Page.bitbucketCommitsMatch(Fixtures.HEAD_SHA, "728C8BAD1813")).toBe(true);
    expect(Page.bitbucketCommitsMatch("728c8bad1814", Fixtures.HEAD_SHA)).toBe(false);
    expect(Page.bitbucketCommitsMatch("728c8b", Fixtures.HEAD_SHA)).toBe(false);
    expect(Page.bitbucketCommitsMatch(null, Fixtures.HEAD_SHA)).toBe(false);
    expect(Page.resolveBitbucketCommitHash("728c8bad1813", commits.values)).toBe(Fixtures.HEAD_SHA);
  });

  it("orders commits parents first", () => {
    expect(Page.orderBitbucketCommits(commits.values).map((commit) => commit.hash)).toEqual([
      Fixtures.PARENT_SHA,
      Fixtures.HEAD_SHA,
    ]);
    expect(Page.toBitbucketChangeRequestCommit(commits.values[0]!)).toEqual({
      oid: Fixtures.HEAD_SHA,
      shortOid: "728c8ba",
      messageHeadline: "Use onClick",
      committedDate: "2019-09-26T10:00:00+00:00",
      author: "Brodie Rao",
    });
  });

  it("validates repository paths", () => {
    expect(Page.isBitbucketRepositoryFilePath("src/a b.ts")).toBe(true);
    expect(Page.encodeBitbucketPath("src/a b#.ts")).toBe("src/a%20b%23.ts");
    for (const bad of ["", "/abs", "a/../b", "a//b", "./a"]) {
      expect(Page.isBitbucketRepositoryFilePath(bad), bad).toBe(false);
    }
  });
});
