import type {
  ChangeRequestActor,
  ChangeRequestReviewThread,
  ChangeRequestTimelineItem,
} from "@ryco/contracts";
import { DateTime } from "effect";
import { describe, expect, it } from "vitest";

import { groupChangeRequestTimeline, summarizeTimelineEvents } from "./timeline.ts";

const alice: ChangeRequestActor = { login: "alice" };
const bob: ChangeRequestActor = { login: "bob" };

function at(minute: number): DateTime.Utc {
  return DateTime.makeUnsafe(Date.UTC(2026, 0, 1, 10, minute));
}

let sequence = 0;
function base(actor: ChangeRequestActor | undefined, minute: number) {
  sequence += 1;
  return { id: `item-${sequence}`, createdAt: at(minute), ...(actor ? { actor } : {}) };
}

function commit(actor: ChangeRequestActor | undefined, minute: number): ChangeRequestTimelineItem {
  const common = base(actor, minute);
  return {
    ...common,
    kind: "commit",
    oid: `${common.id}-oid`,
    shortOid: common.id.slice(0, 7),
    messageHeadline: `Commit ${common.id}`,
  };
}

function labeled(
  actor: ChangeRequestActor,
  minute: number,
  name: string,
  kind: "labeled" | "unlabeled" = "labeled",
): ChangeRequestTimelineItem {
  return { ...base(actor, minute), kind, label: { name } };
}

function thread(
  id: string,
  overrides: Partial<ChangeRequestReviewThread> = {},
): ChangeRequestReviewThread {
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
    comments: [
      {
        id: `${id}-c1`,
        author: bob,
        body: "Nit",
        createdAt: at(0),
      },
    ],
    totalComments: 1,
    ...overrides,
  };
}

describe("groupChangeRequestTimeline", () => {
  it("collapses consecutive commits by one actor and splits on force-pushes and other actors", () => {
    const items: ChangeRequestTimelineItem[] = [
      commit(alice, 0),
      commit(alice, 1),
      commit(alice, 2),
      { ...base(alice, 3), kind: "force-pushed" },
      commit(alice, 4),
      commit(bob, 5),
    ];
    const display = groupChangeRequestTimeline(items, []);
    expect(
      display.groups.map((group) =>
        group.kind === "commits"
          ? `commits:${group.actor?.login}:${group.commits.length}`
          : group.kind,
      ),
    ).toEqual(["commits:alice:3", "item", "commits:alice:1", "commits:bob:1"]);
    expect(display.counts.commits).toBe(5);
    expect(display.counts.forcePushes).toBe(1);
  });

  it("collapses a burst of minor events by one actor within the window", () => {
    const items: ChangeRequestTimelineItem[] = [
      labeled(alice, 0, "bug"),
      { ...base(alice, 2), kind: "assigned", assignee: "bob" },
      { ...base(alice, 4), kind: "review-requested", reviewer: "carol", reviewerKind: "user" },
      labeled(alice, 30, "ui"),
      labeled(bob, 31, "docs"),
    ];
    const display = groupChangeRequestTimeline(items, [], { minorEventWindowMs: 10 * 60_000 });
    expect(
      display.groups.map((group) => (group.kind === "events" ? group.events.length : 0)),
    ).toEqual([3, 1, 1]);
    const first = display.groups[0];
    expect(first?.kind === "events" ? first.summary : null).toMatchObject({
      labelsAdded: [{ name: "bug" }],
      assigned: ["bob"],
      reviewRequested: [{ reviewer: "carol", reviewerKind: "user" }],
      isEmpty: false,
    });
  });

  it("nets out a change undone within the same run", () => {
    const summary = summarizeTimelineEvents([
      labeled(alice, 0, "wip") as Extract<ChangeRequestTimelineItem, { kind: "labeled" }>,
      labeled(alice, 1, "WIP", "unlabeled") as Extract<
        ChangeRequestTimelineItem,
        { kind: "unlabeled" }
      >,
    ]);
    expect(summary.isEmpty).toBe(true);
    expect(summary.labelsAdded).toEqual([]);
  });

  it("nests threads under the review that opened them, once each", () => {
    const threads = [thread("t1"), thread("t2", { isResolved: true }), thread("t3")];
    const items: ChangeRequestTimelineItem[] = [
      {
        ...base(bob, 0),
        kind: "review",
        state: "changes_requested",
        body: "Please fix",
        threadIds: ["t1", "t2", "missing"],
      },
      // A bare reply: commented, no body, its thread already claimed.
      { ...base(alice, 1), kind: "review", state: "commented", body: "", threadIds: ["t1"] },
      { ...base(alice, 2), kind: "review", state: "approved", body: "", threadIds: [] },
    ];
    const display = groupChangeRequestTimeline(items, threads);

    expect(display.groups.map((group) => group.kind)).toEqual(["review", "review"]);
    const first = display.groups[0];
    expect(first?.kind === "review" ? first.threads.map((entry) => entry.id) : []).toEqual([
      "t1",
      "t2",
    ]);
    expect(display.unattachedThreads.map((entry) => entry.id)).toEqual(["t3"]);
    expect(display.counts).toMatchObject({
      reviews: 2,
      approvals: 1,
      changesRequested: 1,
      threads: 3,
      unresolvedThreads: 2,
      // "Please fix" + one comment in each of the three threads.
      comments: 4,
    });
  });

  it("drops reviews whose body is only bot bookkeeping", () => {
    const display = groupChangeRequestTimeline(
      [
        {
          ...base(bob, 0),
          kind: "review",
          state: "commented",
          body: "<!-- bot:meta -->",
          threadIds: [],
        },
      ],
      [],
    );
    expect(display.groups).toEqual([]);
  });

  it("keeps other events as standalone items and lists participants once", () => {
    const items: ChangeRequestTimelineItem[] = [
      { ...base(alice, 0), kind: "comment", body: "Hello" },
      { ...base(bob, 1), kind: "comment", body: "Hi" },
      { ...base(alice, 2), kind: "merged", commitOid: "abc" },
      commit(undefined, 3),
      commit(undefined, 4),
    ];
    const display = groupChangeRequestTimeline(items, []);
    expect(display.groups.map((group) => group.kind)).toEqual(["item", "item", "item", "commits"]);
    expect(display.counts.comments).toBe(2);
    expect(display.counts.participants.map((actor) => actor.login)).toEqual(["alice", "bob"]);
  });
});
