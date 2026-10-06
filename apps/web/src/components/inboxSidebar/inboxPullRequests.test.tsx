import type { SourceControlChangeRequestDetail, VcsStatusResult } from "@ryco/contracts";
import { Option } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { InboxPullRequestBadges } from "./InboxPullRequestBadges";
import {
  resolveInboxChangeStats,
  resolveInboxPullRequest,
  resolveInboxPullRequests,
} from "./inboxPullRequests";

const status: VcsStatusResult = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: {
    number: 42,
    title: "Current PR",
    url: "https://github.com/acme/ryco/pull/42",
    baseRef: "main",
    headRef: "feature",
    state: "open",
  },
};
const detail: SourceControlChangeRequestDetail = {
  provider: "github",
  number: 42,
  title: "Current PR",
  url: status.pr!.url,
  baseRefName: "main",
  headRefName: "feature",
  state: "open",
  isDraft: true,
  updatedAt: Option.none(),
  body: "",
  comments: [],
  truncated: false,
  stack: {
    number: 7,
    size: 3,
    position: 2,
    baseRefName: "main",
    entries: [41, 42, 43].map((number, index) => ({
      number,
      position: index + 1,
      title: `PR ${number}`,
      url: `https://github.com/acme/ryco/pull/${number}`,
      headRefName: `stack/${number}`,
      baseRefName: "main",
      state: number === 41 ? "merged" : "open",
      isDraft: false,
      mergeability: "mergeable",
    })),
  },
};

describe("inbox pull requests", () => {
  it("discovers a branch PR without a worktree PR and prefers it to old worktree metadata", () => {
    for (const pullRequest of [null, { number: 12, state: "closed" as const, isDraft: true }]) {
      expect(resolveInboxPullRequest({ branchLabel: "feature", pullRequest }, status)).toEqual({
        number: 42,
        state: "open",
        isDraft: false,
        title: status.pr!.title,
        url: status.pr!.url,
      });
    }
  });
  it("keeps the thread's own linked PR when the branch reports a newer one", () => {
    const shipped = { number: 12, state: "merged" as const, isDraft: false, title: "Ship it" };
    expect(
      resolveInboxPullRequest(
        { branchLabel: "feature", pullRequest: shipped, pullRequestLinked: true },
        status,
      ),
    ).toBe(shipped);
    // The same number takes the live state, title and link.
    expect(
      resolveInboxPullRequest(
        {
          branchLabel: "feature",
          pullRequest: { number: 42, state: null, isDraft: true },
          pullRequestLinked: true,
        },
        status,
      ),
    ).toEqual({
      number: 42,
      state: "open",
      isDraft: true,
      title: status.pr!.title,
      url: status.pr!.url,
    });
  });
  it("leaves out a finished branch pull request the row does not name", () => {
    const merged = { ...status, pr: { ...status.pr!, state: "merged" as const } };
    expect(
      resolveInboxPullRequest(
        { branchLabel: "feature", pullRequest: null, pullRequestsDiscovered: true },
        merged,
      ),
    ).toBeNull();
    // Without discovery (no workspace record) git status is all there is.
    expect(
      resolveInboxPullRequest({ branchLabel: "feature", pullRequest: null }, merged)?.number,
    ).toBe(42);
    // The row's own pull request still takes its live state.
    expect(
      resolveInboxPullRequest(
        {
          branchLabel: "feature",
          pullRequest: { number: 42, state: "open", isDraft: false },
          pullRequestsDiscovered: true,
        },
        merged,
      )?.state,
    ).toBe("merged");
  });
  it("never brings back a pull request the user unlinked", () => {
    expect(
      resolveInboxPullRequest(
        { branchLabel: "feature", pullRequest: null, dismissedPullRequestNumbers: [42] },
        status,
      ),
    ).toBeNull();
  });
  it("does not borrow the checked-out branch's PR for another thread", () => {
    expect(resolveInboxPullRequest({ branchLabel: "other", pullRequest: null }, status)).toBeNull();
    expect(resolveInboxPullRequest({ branchLabel: null, pullRequest: null }, status)).toBeNull();
  });
  it("retains projected metadata while offline or loading", () => {
    const pullRequest = { number: 12, state: "closed" as const, isDraft: false };
    expect(resolveInboxPullRequest({ branchLabel: "feature", pullRequest }, null)).toBe(
      pullRequest,
    );
    expect(resolveInboxPullRequests(pullRequest, null).requests).toEqual([pullRequest]);
  });
  it("shows the whole stack, enriching the selected PR's draft and current state", () => {
    const result = resolveInboxPullRequests({ number: 42, state: "open", isDraft: false }, detail);
    expect(
      result.requests.map(({ number, state, isDraft }) => ({ number, state, isDraft })),
    ).toEqual([
      { number: 41, state: "merged", isDraft: false },
      { number: 42, state: "open", isDraft: true },
      { number: 43, state: "open", isDraft: false },
    ]);
    expect(result.stack?.position).toBe(2);
  });
  it("ignores details from another PR and retains the current PR in incomplete stacks", () => {
    const current = { number: 50, state: "open" as const, isDraft: false };
    expect(resolveInboxPullRequests(current, detail)).toEqual({ requests: [current], stack: null });
    const partial = resolveInboxPullRequests(current, { ...detail, number: 50 });
    expect(partial.requests.at(-1)?.number).toBe(50);
  });
  it.each([
    ["open", false, "Open", "emerald"],
    ["open", true, "Draft", "zinc"],
    ["merged", false, "Merged", "violet"],
    ["closed", false, "Closed", "rose"],
  ] as const)(
    "renders %s (draft: %s) with its shared state color",
    (state, isDraft, label, color) => {
      const html = renderToStaticMarkup(
        <InboxPullRequestBadges
          requests={[{ number: 42, state, isDraft }]}
          stack={null}
          shortName="PR"
        />,
      );
      expect(html).toContain(`aria-label="PR #42 · ${label}"`);
      expect(html).toContain(`text-${color}-`);
    },
  );
});

describe("inbox change stats", () => {
  const current = { number: 42, state: "open" as const, isDraft: false };
  const passing = {
    kind: "check-run" as const,
    name: "ci",
    status: Option.some("COMPLETED"),
    conclusion: Option.some("SUCCESS"),
    url: Option.none(),
    startedAt: Option.none(),
    completedAt: Option.none(),
  };

  it("reads checks and diff from the pull request's detail", () => {
    const stats = resolveInboxChangeStats({
      current,
      detail: { ...detail, checkRollup: [passing], additions: 212, deletions: 58, changedFiles: 9 },
      status,
      branchLabel: "feature",
    });
    expect(stats).toMatchObject({
      scope: "pull-request",
      additions: 212,
      deletions: 58,
      changedFiles: 9,
    });
    expect(stats?.checks).toMatchObject({ passed: 1, total: 1 });
  });

  it("falls back to the checked-out branch's uncommitted changes", () => {
    const dirty = {
      ...status,
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [{ path: "a.ts", insertions: 12, deletions: 3 }],
        insertions: 12,
        deletions: 3,
      },
    };
    expect(
      resolveInboxChangeStats({
        current: null,
        detail: null,
        status: dirty,
        branchLabel: "feature",
      }),
    ).toEqual({
      scope: "working-tree",
      checks: null,
      additions: 12,
      deletions: 3,
      changedFiles: 1,
    });
    // Another thread's branch must not borrow the checkout's numbers.
    expect(
      resolveInboxChangeStats({ current: null, detail: null, status: dirty, branchLabel: "other" }),
    ).toBeNull();
  });

  it("ignores a detail for a different pull request", () => {
    expect(
      resolveInboxChangeStats({
        current: { ...current, number: 7 },
        detail: { ...detail, additions: 1, deletions: 1 },
        status: null,
        branchLabel: "feature",
      }),
    ).toBeNull();
  });
});
