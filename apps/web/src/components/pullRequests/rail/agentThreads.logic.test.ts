import { describe, expect, it } from "vitest";

import {
  composeHandoffPrompt,
  findPullRequestWorktree,
  linkedAgentThreads,
  localHeadBranch,
  resolveHandoffWorkLocation,
} from "./agentThreads.logic";

function worktree(
  id: string,
  patch: Partial<Parameters<typeof findPullRequestWorktree>[0][number]> = {},
) {
  return {
    id,
    branch: `branch-${id}`,
    worktreePath: `/tmp/${id}`,
    prNumber: null,
    archivedAt: null,
    updatedAt: "2026-10-01T10:00:00.000Z",
    ...patch,
  } as Parameters<typeof findPullRequestWorktree>[0][number];
}

function thread(
  id: string,
  patch: Partial<Parameters<typeof linkedAgentThreads>[0]["threads"][number]> = {},
) {
  return {
    id,
    branch: null,
    worktreePath: null,
    worktreeId: null,
    archivedAt: null,
    updatedAt: "2026-10-01T10:00:00.000Z",
    createdAt: "2026-10-01T09:00:00.000Z",
    latestUserMessageAt: null,
    ...patch,
  } as Parameters<typeof linkedAgentThreads>[0]["threads"][number];
}

const link = { number: 703, headRefName: "ryco/stack-3-web-rail" };
/** Fork PR #42 from `contributor:main`: its head shares a name with our own `main`. */
const forkLink = { number: 42, headRefName: "main", isCrossRepository: true };

describe("findPullRequestWorktree", () => {
  it("prefers a worktree linked by number, then by head branch, newest first", () => {
    const byBranch = worktree("b", { branch: link.headRefName });
    const byNumberOld = worktree("n1", { prNumber: 703, updatedAt: "2026-09-01T00:00:00.000Z" });
    const byNumberNew = worktree("n2", { prNumber: 703, updatedAt: "2026-10-02T00:00:00.000Z" });
    expect(findPullRequestWorktree([byBranch, byNumberOld, byNumberNew], link)?.id).toBe("n2");
    expect(findPullRequestWorktree([byBranch], link)?.id).toBe("b");
  });

  it("links a fork's head by number only, never by its branch name", () => {
    const ownMain = worktree("own", { branch: "main" });
    expect(findPullRequestWorktree([ownMain], forkLink)).toBeNull();
    const checkedOut = worktree("pr", { branch: "pr-42/main", prNumber: 42 });
    expect(findPullRequestWorktree([ownMain, checkedOut], forkLink)?.id).toBe("pr");
    expect(localHeadBranch(forkLink)).toBeNull();
    expect(localHeadBranch(link)).toBe(link.headRefName);
  });

  it("skips archived and path-less worktrees", () => {
    expect(
      findPullRequestWorktree(
        [
          worktree("a", { prNumber: 703, archivedAt: "2026-10-01T00:00:00.000Z" }),
          worktree("p", { prNumber: 703, worktreePath: null }),
        ],
        link,
      ),
    ).toBeNull();
  });
});

describe("linkedAgentThreads", () => {
  it("finds threads by worktree id, worktree path, or head branch, newest first", () => {
    const worktrees = [worktree("w", { prNumber: 703 })];
    const threads = [
      thread("by-id", { worktreeId: "w", latestUserMessageAt: "2026-10-01T12:00:00.000Z" }),
      thread("by-path", {
        worktreePath: "/tmp/w",
        latestUserMessageAt: "2026-10-01T13:00:00.000Z",
      }),
      thread("by-branch", { branch: link.headRefName }),
      thread("other", { branch: "main" }),
      thread("archived", { branch: link.headRefName, archivedAt: "2026-10-01T00:00:00.000Z" }),
    ];
    expect(linkedAgentThreads({ threads, worktrees, link }).map((entry) => entry.id)).toEqual([
      "by-path",
      "by-id",
      "by-branch",
    ]);
    expect(linkedAgentThreads({ threads, worktrees, link, limit: 1 })).toHaveLength(1);
  });

  it("lists only threads in a fork's own checkout, not ones on a same-named local branch", () => {
    const worktrees = [
      worktree("own-main", { branch: "main" }),
      worktree("fork", { branch: "pr-42/main", prNumber: 42 }),
    ];
    const threads = [
      thread("on-main", { branch: "main" }),
      thread("in-own-main", { worktreeId: "own-main", branch: "main" }),
      thread("in-fork", { worktreeId: "fork", branch: "pr-42/main" }),
    ];
    expect(
      linkedAgentThreads({ threads, worktrees, link: forkLink }).map((entry) => entry.id),
    ).toEqual(["in-fork"]);
  });
});

describe("composeHandoffPrompt", () => {
  it("returns the prompt alone when there is no material", () => {
    expect(composeHandoffPrompt("Fix it.  ")).toBe("Fix it.");
  });

  it("fences material with a fence longer than any backtick run inside it", () => {
    expect(composeHandoffPrompt("Look:", "a ```b``` c\n\n")).toBe(
      "Look:\n\n````\na ```b``` c\n````\n",
    );
    expect(composeHandoffPrompt("", "plain")).toBe("```\nplain\n```\n");
  });
});

describe("resolveHandoffWorkLocation", () => {
  it("reuses a live worktree, else the project checkout on the head, else a new worktree", () => {
    const head = { number: 7, headRefName: "head" };
    expect(
      resolveHandoffWorkLocation({
        worktree: { worktreePath: "/tmp/w", branch: "head" },
        projectBranch: "main",
        link: head,
      }),
    ).toEqual({ kind: "existing-worktree", worktreePath: "/tmp/w", branch: "head" });
    expect(
      resolveHandoffWorkLocation({ worktree: null, projectBranch: "head", link: head }),
    ).toEqual({ kind: "project-root", branch: "head" });
    expect(
      resolveHandoffWorkLocation({ worktree: null, projectBranch: "main", link: head }),
    ).toEqual({ kind: "new-worktree" });
  });

  it("never runs a fork's hand-off in the project checkout that shares its branch name", () => {
    expect(
      resolveHandoffWorkLocation({ worktree: null, projectBranch: "main", link: forkLink }),
    ).toEqual({ kind: "new-worktree" });
  });
});
