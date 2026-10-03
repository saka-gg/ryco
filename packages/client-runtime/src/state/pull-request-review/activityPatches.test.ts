import type {
  ChangeRequestActivity,
  ChangeRequestReviewThread,
  SourceControlChangeRequestDetail,
} from "@ryco/contracts";
import { DateTime, Option } from "effect";
import { describe, expect, it } from "vitest";

import {
  applyCommentUpdateToActivity,
  applyCommentUpdateToDetail,
  applyOptimisticChangeRequestUpdate,
  readReviewThreadResolution,
  replaceReviewThreadInActivity,
  rollbackOptimisticChangeRequestUpdate,
  rollbackReviewThreadResolved,
  setReviewThreadResolvedInActivity,
} from "./activityPatches.ts";

const now = DateTime.makeUnsafe("2026-01-01T00:00:00Z");

function thread(
  id: string,
  overrides: Partial<ChangeRequestReviewThread> = {},
): ChangeRequestReviewThread {
  return {
    id,
    path: "a.ts",
    subjectType: "line",
    side: "right",
    line: 1,
    isResolved: false,
    isOutdated: false,
    viewerCanReply: true,
    viewerCanResolve: true,
    viewerCanUnresolve: false,
    comments: [{ id: `${id}-c1`, author: { login: "bob" }, body: "first", createdAt: now }],
    totalComments: 1,
    ...overrides,
  };
}

function activity(threads: ReadonlyArray<ChangeRequestReviewThread>): ChangeRequestActivity {
  return {
    provider: "github",
    number: 7,
    headSha: "h1",
    viewer: null,
    timeline: [
      { id: "comment-1", createdAt: now, kind: "comment", body: "hello" },
      {
        id: "review-1",
        createdAt: now,
        kind: "review",
        state: "commented",
        body: "rev",
        threadIds: [],
      },
    ],
    timelineTruncated: false,
    reviewThreads: threads,
    reviewThreadsTruncated: false,
    pendingReview: null,
  };
}

function detail(
  overrides: Partial<SourceControlChangeRequestDetail> = {},
): SourceControlChangeRequestDetail {
  return {
    provider: "github",
    number: 7,
    title: "Title",
    url: "https://github.com/acme/app/pull/7",
    baseRefName: "main",
    headRefName: "feature",
    state: "open",
    updatedAt: Option.none(),
    body: "Body",
    comments: [
      { id: "ic-1", author: "alice", body: "issue comment", createdAt: now },
      { author: "bob", body: "no id", createdAt: now },
    ],
    truncated: false,
    ...overrides,
  };
}

describe("review thread resolution patches", () => {
  it("flips one thread and leaves the activity untouched when nothing changes", () => {
    const original = activity([thread("t1"), thread("t2")]);
    const resolved = setReviewThreadResolvedInActivity(original, "t1", {
      isResolved: true,
      resolvedBy: "octocat",
    });
    expect(readReviewThreadResolution(resolved, "t1")).toEqual({
      isResolved: true,
      resolvedBy: "octocat",
    });
    expect(resolved.reviewThreads[1]).toBe(original.reviewThreads[1]);
    expect(setReviewThreadResolvedInActivity(original, "missing", { isResolved: true })).toBe(
      original,
    );
    expect(setReviewThreadResolvedInActivity(original, "t1", { isResolved: false })).toBe(original);
  });

  it("drops resolvedBy when unresolving", () => {
    const resolved = activity([thread("t1", { isResolved: true, resolvedBy: "octocat" })]);
    expect(
      readReviewThreadResolution(
        setReviewThreadResolvedInActivity(resolved, "t1", { isResolved: false }),
        "t1",
      ),
    ).toEqual({ isResolved: false });
  });

  it("rolls back only while the optimistic value is still showing", () => {
    const previous = { isResolved: false };
    const optimistic = setReviewThreadResolvedInActivity(activity([thread("t1")]), "t1", {
      isResolved: true,
      resolvedBy: "octocat",
    });
    expect(
      readReviewThreadResolution(
        rollbackReviewThreadResolved(optimistic, "t1", previous, true),
        "t1",
      ),
    ).toEqual(previous);

    // A newer toggle or read already moved the thread on: leave it.
    const newer = setReviewThreadResolvedInActivity(optimistic, "t1", { isResolved: false });
    expect(rollbackReviewThreadResolved(newer, "t1", previous, true)).toBe(newer);
  });

  it("replaces a thread by id or appends a new one", () => {
    const original = activity([thread("t1")]);
    const replied = thread("t1", { totalComments: 2 });
    expect(replaceReviewThreadInActivity(original, replied).reviewThreads).toEqual([replied]);
    expect(
      replaceReviewThreadInActivity(original, thread("t9")).reviewThreads.map((t) => t.id),
    ).toEqual(["t1", "t9"]);
  });
});

describe("comment update patches", () => {
  it("edits conversation comments, review bodies, and thread comments", () => {
    const original = activity([thread("t1")]);
    const editedComment = applyCommentUpdateToActivity(original, {
      commentId: "comment-1",
      action: "edit",
      body: "edited",
    });
    expect(editedComment.timeline[0]).toMatchObject({ body: "edited" });

    const editedReview = applyCommentUpdateToActivity(original, {
      commentId: "review-1",
      action: "edit",
      body: "new review body",
    });
    expect(editedReview.timeline[1]).toMatchObject({ body: "new review body" });

    const editedThread = applyCommentUpdateToActivity(original, {
      commentId: "t1-c1",
      action: "edit",
      body: "thread edit",
    });
    expect(editedThread.reviewThreads[0]?.comments[0]?.body).toBe("thread edit");
    expect(
      applyCommentUpdateToActivity(original, { commentId: "nope", action: "edit", body: "x" }),
    ).toBe(original);
  });

  it("deletes comments and removes a thread left without comments", () => {
    const original = activity([
      thread("t1"),
      thread("t2", {
        comments: [
          { id: "t2-c1", author: { login: "bob" }, body: "a", createdAt: now },
          { id: "t2-c2", author: { login: "alice" }, body: "b", createdAt: now },
        ],
        totalComments: 2,
      }),
    ]);
    const withoutComment = applyCommentUpdateToActivity(original, {
      commentId: "comment-1",
      action: "delete",
    });
    expect(withoutComment.timeline.map((item) => item.id)).toEqual(["review-1"]);

    const withoutThread = applyCommentUpdateToActivity(original, {
      commentId: "t1-c1",
      action: "delete",
    });
    expect(withoutThread.reviewThreads.map((entry) => entry.id)).toEqual(["t2"]);

    const shorterThread = applyCommentUpdateToActivity(original, {
      commentId: "t2-c2",
      action: "delete",
    });
    expect(shorterThread.reviewThreads[1]).toMatchObject({ totalComments: 1 });
  });

  it("patches detail comments by id", () => {
    const original = detail();
    expect(
      applyCommentUpdateToDetail(original, { commentId: "ic-1", action: "edit", body: "x" })
        .comments[0]?.body,
    ).toBe("x");
    expect(
      applyCommentUpdateToDetail(original, { commentId: "ic-1", action: "delete" }).comments,
    ).toHaveLength(1);
    expect(applyCommentUpdateToDetail(original, { commentId: "nope", action: "delete" })).toBe(
      original,
    );
  });
});

describe("optimistic change request updates", () => {
  it("flips draft state and the matching merge state", () => {
    const toDraft = applyOptimisticChangeRequestUpdate(detail({ mergeStateStatus: "clean" }), {
      kind: "set-draft",
      draft: true,
    });
    expect(toDraft).toMatchObject({ isDraft: true, mergeStateStatus: "draft" });
    const ready = applyOptimisticChangeRequestUpdate(toDraft, { kind: "set-draft", draft: false });
    expect(ready).toMatchObject({ isDraft: false, mergeStateStatus: "unknown" });
    const unchanged = detail({ isDraft: false });
    expect(applyOptimisticChangeRequestUpdate(unchanged, { kind: "set-draft", draft: false })).toBe(
      unchanged,
    );
  });

  it("edits labels, assignees, and reviewers case-insensitively", () => {
    const original = detail({
      labels: [{ name: "bug", color: "ff0000" }, { name: "ui" }],
      assignees: ["alice"],
      reviewers: ["bob"],
      reviewerStates: [
        { login: "bob", kind: "user", state: "requested" },
        { login: "carol", kind: "user", state: "approved" },
      ],
    });
    expect(
      applyOptimisticChangeRequestUpdate(original, {
        kind: "labels",
        add: ["UI", "docs"],
        remove: ["bug"],
      }).labels,
    ).toEqual([{ name: "ui" }, { name: "docs" }]);
    expect(
      applyOptimisticChangeRequestUpdate(original, {
        kind: "assignees",
        add: ["dave"],
        remove: ["Alice"],
      }).assignees,
    ).toEqual(["dave"]);

    const reviewers = applyOptimisticChangeRequestUpdate(original, {
      kind: "reviewers",
      add: ["carol", "org/core"],
      remove: ["bob"],
    });
    expect(reviewers.reviewers).toEqual(["carol", "org/core"]);
    expect(reviewers.reviewerStates).toEqual([
      { login: "carol", kind: "user", state: "requested" },
      { login: "org/core", kind: "team", state: "requested" },
    ]);
  });

  it("leaves non-predictable actions alone", () => {
    const original = detail();
    expect(applyOptimisticChangeRequestUpdate(original, { kind: "close" })).toBe(original);
    expect(
      applyOptimisticChangeRequestUpdate(original, { kind: "auto-merge", enabled: true }),
    ).toBe(original);
  });

  it("rolls back exactly the touched fields that still hold the optimistic value", () => {
    const previous = detail({ labels: [{ name: "bug" }], assignees: ["alice"] });
    const optimistic = applyOptimisticChangeRequestUpdate(previous, {
      kind: "labels",
      add: ["ui"],
      remove: [],
    });
    // Another field changed meanwhile (e.g. a poll); it must survive the rollback.
    const current = { ...optimistic, assignees: ["bob"] };
    const rolledBack = rollbackOptimisticChangeRequestUpdate(
      current,
      previous,
      optimistic,
      "labels",
    );
    expect(rolledBack.labels).toBe(previous.labels);
    expect(rolledBack.assignees).toEqual(["bob"]);

    // The labels were already replaced by a fresher read: nothing to undo.
    const refreshed = { ...optimistic, labels: [{ name: "fresh" }] };
    expect(rollbackOptimisticChangeRequestUpdate(refreshed, previous, optimistic, "labels")).toBe(
      refreshed,
    );
  });

  it("removes a field the previous detail did not have", () => {
    const previous = detail();
    const optimistic = applyOptimisticChangeRequestUpdate(previous, {
      kind: "set-draft",
      draft: true,
    });
    const rolledBack = rollbackOptimisticChangeRequestUpdate(
      optimistic,
      previous,
      optimistic,
      "set-draft",
    );
    expect("isDraft" in rolledBack).toBe(false);
    expect("mergeStateStatus" in rolledBack).toBe(false);
  });
});
