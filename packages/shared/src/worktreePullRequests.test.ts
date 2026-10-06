import { describe, expect, it } from "vite-plus/test";

import {
  applyPullRequestLinkChanges,
  applySourceControlStateToPullRequestLinks,
  currentPullRequestFields,
  initialPullRequestLinks,
  readWorktreePullRequestLinks,
  resolveThreadPullRequestLink,
  selectCurrentPullRequestLink,
  visiblePullRequestLinks,
  workspaceDiscoversPullRequests,
  type WorktreePullRequestLink,
} from "./worktreePullRequests.ts";

const T = (hour: number) => `2026-10-06T${String(hour).padStart(2, "0")}:00:00.000Z`;

/** The lifecycle workspace: #675 merged at 06:51, then follow-up #677 opened. */
function shippedThenFollowUp(): WorktreePullRequestLink[] {
  const merged = applyPullRequestLinkChanges(
    [],
    {
      upserts: [
        {
          number: 675,
          title: "Centralize safe workspace lifecycle management",
          state: "merged",
          isDraft: false,
          terminalAt: T(6),
          source: "created",
        },
      ],
    },
    T(1),
  );
  return applyPullRequestLinkChanges(
    merged,
    {
      upserts: [
        {
          number: 677,
          title: "Add Projects map",
          state: "open",
          isDraft: false,
          source: "manual",
        },
      ],
    },
    T(16),
  );
}

describe("worktree pull request links", () => {
  it("makes the open follow-up current while the merged one stays as history", () => {
    const links = shippedThenFollowUp();
    expect(links.map((link) => link.number)).toEqual([675, 677]);
    expect(selectCurrentPullRequestLink(links)?.number).toBe(677);
    expect(visiblePullRequestLinks(links).map((link) => link.number)).toEqual([677, 675]);
    expect(currentPullRequestFields(links)).toEqual({
      prNumber: 677,
      prTitle: "Add Projects map",
      prState: "open",
      prIsDraft: false,
      prTerminalAt: null,
    });
  });

  it("keeps the most recently finished one current once nothing is open", () => {
    const links = applyPullRequestLinkChanges(
      shippedThenFollowUp(),
      { upserts: [{ number: 677, state: "merged", isDraft: false, source: "discovered" }] },
      T(20),
    );
    const current = selectCurrentPullRequestLink(links);
    expect(current?.number).toBe(677);
    expect(current?.terminalAt).toBe(T(20));
    // Provenance and link time never change on refresh.
    expect(current?.source).toBe("manual");
    expect(current?.linkedAt).toBe(T(16));
  });

  it("keeps the first observed finish time while the state holds", () => {
    const once = applyPullRequestLinkChanges(
      [],
      { upserts: [{ number: 9, state: "closed", isDraft: false, source: "created" }] },
      T(3),
    );
    const again = applyPullRequestLinkChanges(
      once,
      { upserts: [{ number: 9, state: "closed", isDraft: false, source: "created" }] },
      T(5),
    );
    expect(again[0]?.terminalAt).toBe(T(3));
    const reopened = applyPullRequestLinkChanges(
      again,
      { upserts: [{ number: 9, state: "open", isDraft: false, source: "created" }] },
      T(6),
    );
    expect(reopened[0]?.terminalAt).toBeNull();
  });

  it("hides dismissed links, and only a manual link brings one back", () => {
    const dismissed = applyPullRequestLinkChanges(
      shippedThenFollowUp(),
      { dismissals: [677] },
      T(17),
    );
    expect(selectCurrentPullRequestLink(dismissed)?.number).toBe(675);
    const rediscovered = applyPullRequestLinkChanges(
      dismissed,
      { upserts: [{ number: 677, state: "open", isDraft: false, source: "discovered" }] },
      T(18),
    );
    expect(selectCurrentPullRequestLink(rediscovered)?.number).toBe(675);
    // A refresh of a manual link (racing its dismissal) keeps it dismissed.
    const refreshed = applyPullRequestLinkChanges(
      dismissed,
      { upserts: [{ number: 677, state: "merged", isDraft: false, source: "manual" }] },
      T(18),
    );
    expect(refreshed.find((link) => link.number === 677)?.dismissedAt).toBe(T(17));
    const relinked = applyPullRequestLinkChanges(
      dismissed,
      {
        upserts: [{ number: 677, state: "open", isDraft: false, source: "manual", restore: true }],
      },
      T(18),
    );
    expect(selectCurrentPullRequestLink(relinked)?.number).toBe(677);
  });

  it("starts a workspace with its origin pull request, and derives links from older servers", () => {
    expect(
      initialPullRequestLinks({ origin: "pr", prNumber: 12, prTitle: "Fix", createdAt: T(2) }),
    ).toMatchObject([{ number: 12, source: "origin", linkedAt: T(2), state: null }]);
    expect(
      initialPullRequestLinks({ origin: "branch", prNumber: null, prTitle: null, createdAt: T(2) }),
    ).toEqual([]);
    expect(
      readWorktreePullRequestLinks({
        prNumber: 660,
        prTitle: "Old",
        prState: "merged",
        prIsDraft: false,
        prTerminalAt: T(4),
      }),
    ).toMatchObject([{ number: 660, state: "merged", terminalAt: T(4), linkedAt: null }]);
    expect(readWorktreePullRequestLinks({ prNumber: null, prTitle: null })).toEqual([]);
  });

  it("replays older events: a relink adds a link, a refresh updates the current one", () => {
    const start = initialPullRequestLinks({
      origin: "branch",
      prNumber: 660,
      prTitle: "First",
      createdAt: T(1),
    });
    const refreshed = applySourceControlStateToPullRequestLinks(
      start,
      { prState: "merged", prIsDraft: false, prTerminalAt: T(3), updatedAt: T(3) },
      660,
    );
    expect(refreshed).toMatchObject([{ number: 660, state: "merged", terminalAt: T(3) }]);
    const relinked = applySourceControlStateToPullRequestLinks(
      refreshed,
      { prNumber: 680, prTitle: "Second", prState: "open", prIsDraft: false, updatedAt: T(5) },
      660,
    );
    expect(relinked.map((link) => [link.number, link.state])).toEqual([
      [660, "merged"],
      [680, "open"],
    ]);
    const current = [{ ...relinked[0]!, number: 1 }];
    expect(
      applySourceControlStateToPullRequestLinks(
        relinked,
        { prState: null, prIsDraft: null, pullRequests: current, updatedAt: T(6) },
        680,
      ),
    ).toBe(current);
  });

  it("judges each thread by the pull request its own activity belongs to", () => {
    const links = shippedThenFollowUp();
    // Worked before #675 was linked: #675 is what its work produced.
    expect(resolveThreadPullRequestLink(links, T(0))?.number).toBe(675);
    // Active after #675 shipped, before #677 existed: produced #677.
    expect(resolveThreadPullRequestLink(links, T(10))?.number).toBe(677);
    // Active after #677 was linked: answers to the open follow-up.
    expect(resolveThreadPullRequestLink(links, T(17))?.number).toBe(677);
    // Links without a time count as already there.
    const legacy = readWorktreePullRequestLinks({
      prNumber: 660,
      prTitle: null,
      prState: "merged",
    });
    expect(resolveThreadPullRequestLink(legacy, T(1))?.number).toBe(660);
    expect(resolveThreadPullRequestLink([], T(1))).toBeNull();
  });

  it("keeps a thread that went quiet on an open pull request with that one", () => {
    const links = shippedThenFollowUp();
    // Still iterating on #675 (merged later, at 06:00) when it went quiet.
    expect(resolveThreadPullRequestLink(links, T(3))?.number).toBe(675);
    // A pre-upgrade link (no link or finish time) never hands its threads on.
    const legacy = applyPullRequestLinkChanges(
      readWorktreePullRequestLinks({ prNumber: 660, prTitle: null, prState: "merged" }),
      { upserts: [{ number: 661, state: "open", isDraft: false, source: "discovered" }] },
      T(16),
    );
    expect(resolveThreadPullRequestLink(legacy, T(1))?.number).toBe(660);
  });
});

describe("workspaceDiscoversPullRequests", () => {
  it("is true only for a workspace whose links the server keeps up to date", () => {
    expect(workspaceDiscoversPullRequests({ origin: "branch", pullRequests: [] })).toBe(true);
    expect(workspaceDiscoversPullRequests({ origin: "main", pullRequests: [] })).toBe(false);
    // A server that predates links never discovers.
    expect(workspaceDiscoversPullRequests({ origin: "branch" })).toBe(false);
    expect(workspaceDiscoversPullRequests(null)).toBe(false);
  });
});
