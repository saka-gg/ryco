import type { ChangeRequestReviewThread, ChangeRequestTimelineItem } from "@ryco/contracts";
import { groupChangeRequestTimeline } from "@ryco/client-runtime/state/pull-request-review";
import { DateTime } from "effect";
import { describe, expect, it } from "vitest";

import {
  buildConversationTimeline,
  commitChecksOverall,
  sameRepositoryPullNumber,
  toggleCommentReaction,
} from "./conversationTimeline.logic";

function at(minute: number): DateTime.Utc {
  return DateTime.makeUnsafe(Date.UTC(2026, 9, 1, 10, minute));
}

function thread(id: string, minute: number): ChangeRequestReviewThread {
  return {
    id,
    path: "src/a.ts",
    subjectType: "line",
    side: "right",
    line: 3,
    isResolved: false,
    isOutdated: false,
    viewerCanReply: true,
    viewerCanResolve: true,
    viewerCanUnresolve: false,
    comments: [{ id: `${id}-c1`, author: { login: "bob" }, body: "Nit", createdAt: at(minute) }],
    totalComments: 1,
  };
}

const alice = { login: "alice" };

describe("buildConversationTimeline", () => {
  it("places unattached threads where their first comment was written", () => {
    const items: ChangeRequestTimelineItem[] = [
      { id: "c1", createdAt: at(0), actor: alice, kind: "comment", body: "One" },
      { id: "c2", createdAt: at(10), actor: alice, kind: "comment", body: "Two" },
    ];
    const display = groupChangeRequestTimeline(items, [thread("late", 20), thread("mid", 5)]);
    expect(buildConversationTimeline(display).map((entry) => entry.id)).toEqual([
      "c1",
      "thread:mid",
      "c2",
      "thread:late",
    ]);
  });

  it("drops minor-event runs that net out to nothing", () => {
    const items: ChangeRequestTimelineItem[] = [
      { id: "l1", createdAt: at(0), actor: alice, kind: "labeled", label: { name: "wip" } },
      { id: "l2", createdAt: at(1), actor: alice, kind: "unlabeled", label: { name: "wip" } },
      { id: "c1", createdAt: at(2), actor: alice, kind: "comment", body: "Hi" },
    ];
    expect(
      buildConversationTimeline(groupChangeRequestTimeline(items, [])).map((entry) => entry.id),
    ).toEqual(["c1"]);
  });
});

describe("commitChecksOverall", () => {
  it("maps host check states onto glyph states", () => {
    expect(commitChecksOverall("success")).toBe("passing");
    expect(commitChecksOverall("failure")).toBe("failing");
    expect(commitChecksOverall("pending")).toBe("pending");
    expect(commitChecksOverall("neutral")).toBe("none");
    expect(commitChecksOverall(undefined)).toBeNull();
  });
});

describe("sameRepositoryPullNumber", () => {
  const current = "https://github.com/ryco-labs/ryco/pull/703";
  it("resolves pull requests in the same repository", () => {
    expect(sameRepositoryPullNumber("https://github.com/ryco-labs/ryco/pull/704", current)).toBe(
      704,
    );
    expect(
      sameRepositoryPullNumber("https://github.com/Ryco-Labs/ryco/pull/12#discussion", current),
    ).toBe(12);
  });
  it("ignores issues, other repositories and missing context", () => {
    expect(sameRepositoryPullNumber("https://github.com/ryco-labs/ryco/issues/612", current)).toBe(
      null,
    );
    expect(sameRepositoryPullNumber("https://github.com/other/ryco/pull/1", current)).toBeNull();
    expect(sameRepositoryPullNumber("https://github.com/ryco-labs/ryco/pull/1", null)).toBeNull();
  });
});

describe("toggleCommentReaction", () => {
  it("adds, increments and takes back the viewer's reaction in place", () => {
    const start = [
      { content: "thumbs-up" as const, count: 2 },
      { content: "hooray" as const, count: 1, viewerHasReacted: true },
    ];
    expect(toggleCommentReaction(start, "thumbs-up")).toEqual([
      { content: "thumbs-up", count: 3, viewerHasReacted: true },
      start[1],
    ]);
    expect(toggleCommentReaction(start, "hooray")).toEqual([start[0]]);
    expect(toggleCommentReaction(undefined, "eyes")).toEqual([
      { content: "eyes", count: 1, viewerHasReacted: true },
    ]);
  });
});
