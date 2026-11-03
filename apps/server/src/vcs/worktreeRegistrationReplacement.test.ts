import { describe, expect, it } from "vite-plus/test";

import {
  missingRegistrationReplacement,
  type WorktreeRegistration,
} from "./worktreeRegistrationReplacement.ts";

const main: WorktreeRegistration = {
  path: "/repo",
  fields: ["worktree /repo", "HEAD 1111", "branch refs/heads/main"],
};
const stale = (...fields: string[]): WorktreeRegistration => ({
  path: "/repo-worktrees/topic",
  fields: ["worktree /repo-worktrees/topic", "HEAD 2222", ...fields],
});
const decide = (registrations: readonly WorktreeRegistration[], branch = "topic") =>
  missingRegistrationReplacement(registrations, "/repo-worktrees/topic", branch);

describe("missingRegistrationReplacement", () => {
  it("adds plainly when Git registers nothing at the path", () => {
    expect(decide([main])).toEqual({ registered: false, refusal: null });
  });

  it("replaces a stale registration of the path on a branch, whichever branch it held", () => {
    const prunable = "prunable gitdir file points to non-existent location";
    expect(decide([main, stale("branch refs/heads/topic", prunable)])).toEqual({
      registered: true,
      refusal: null,
    });
    expect(decide([main, stale("branch refs/heads/older", prunable)])).toEqual({
      registered: true,
      refusal: null,
    });
  });

  it("refuses a locked or detached registration of the path", () => {
    for (const locked of ["locked", "locked moved to a USB drive"])
      expect(decide([main, stale("branch refs/heads/topic", locked)]).refusal).toContain(
        "Git has locked the missing checkout",
      );
    const detached = decide([main, stale("detached")]).refusal;
    expect(detached).toContain("on a detached commit");
    expect(detached).toContain("git worktree remove /repo-worktrees/topic");
    expect(detached).not.toContain("prune");
  });

  it("refuses a branch another registration holds, present or missing", () => {
    expect(decide([main, stale("branch refs/heads/topic")], "main")).toEqual({
      registered: true,
      refusal: "Branch main is checked out at /repo.",
    });
    const elsewhere: WorktreeRegistration = {
      path: "/repo-worktrees/old",
      fields: [
        "worktree /repo-worktrees/old",
        "HEAD 3333",
        "branch refs/heads/topic",
        "prunable gitdir file points to non-existent location",
      ],
    };
    expect(decide([main, elsewhere])).toEqual({
      registered: false,
      refusal: "Branch topic is still checked out at /repo-worktrees/old, which is missing.",
    });
  });
});
