import { describe, expect, it } from "vitest";

import {
  branchSlotPreposition,
  resolveWorkLocation,
  showsBranchSlot,
  workLocationDraftPatch,
  workLocationLabel,
  worktreeChoiceLabel,
  type WorktreeChoice,
} from "./NewThreadWorkLocation.logic";

const WORKTREE: WorktreeChoice = {
  worktreeId: "wt-1",
  worktreePath: "/repo/.ryco/worktrees/feature",
  branch: "feature/thing",
  title: null,
};

describe("resolveWorkLocation", () => {
  it("reads project root from local mode with no worktree path", () => {
    const location = resolveWorkLocation({
      draft: { envMode: "local", worktreePath: null },
      worktrees: [WORKTREE],
    });

    expect(location).toEqual({ kind: "projectRoot", worktree: null });
  });

  it("reads a new worktree from worktree mode with no path yet", () => {
    const location = resolveWorkLocation({
      draft: { envMode: "worktree", worktreePath: null },
      worktrees: [WORKTREE],
    });

    expect(location).toEqual({ kind: "newWorktree", worktree: null });
  });

  it("matches an existing worktree by path", () => {
    const location = resolveWorkLocation({
      draft: { envMode: "local", worktreePath: WORKTREE.worktreePath },
      worktrees: [WORKTREE],
    });

    expect(location.kind).toBe("existingWorktree");
    expect(location.worktree).toEqual(WORKTREE);
  });

  it("a path always wins over the env mode", () => {
    // The send path treats a set path as the working directory regardless of
    // envMode, so the sentence has to agree or it would misreport the target.
    const location = resolveWorkLocation({
      draft: { envMode: "worktree", worktreePath: WORKTREE.worktreePath },
      worktrees: [WORKTREE],
    });

    expect(location.kind).toBe("existingWorktree");
  });

  it("still reports an existing worktree when no summary matches the path", () => {
    const location = resolveWorkLocation({
      draft: { envMode: "local", worktreePath: "/repo/.ryco/worktrees/unknown" },
      worktrees: [WORKTREE],
    });

    expect(location.kind).toBe("existingWorktree");
    expect(location.worktree?.worktreePath).toBe("/repo/.ryco/worktrees/unknown");
  });
});

describe("workLocationDraftPatch", () => {
  it("clears the branch for the project root so the live checkout wins", () => {
    expect(workLocationDraftPatch({ kind: "projectRoot", worktree: null })).toEqual({
      envMode: "local",
      worktreePath: null,
      branch: null,
      worktreeSource: null,
    });
  });

  it("drops a recorded source when leaving new-worktree mode", () => {
    // Otherwise sending from the project root would still create a worktree
    // for the PR the user had selected earlier.
    expect(
      workLocationDraftPatch({ kind: "projectRoot", worktree: null }).worktreeSource,
    ).toBeNull();
    expect(
      workLocationDraftPatch({ kind: "existingWorktree", worktree: WORKTREE }).worktreeSource,
    ).toBeNull();
  });

  it("leaves the branch alone for a new worktree, where it is the base", () => {
    expect(workLocationDraftPatch({ kind: "newWorktree", worktree: null })).toEqual({
      envMode: "worktree",
      worktreePath: null,
    });
  });

  it("adopts the worktree's own path and branch", () => {
    expect(workLocationDraftPatch({ kind: "existingWorktree", worktree: WORKTREE })).toEqual({
      envMode: "local",
      worktreePath: WORKTREE.worktreePath,
      branch: WORKTREE.branch,
      worktreeSource: null,
    });
  });

  it("nulls an empty worktree branch rather than writing a blank string", () => {
    expect(
      workLocationDraftPatch({
        kind: "existingWorktree",
        worktree: { ...WORKTREE, branch: "" },
      }).branch,
    ).toBeNull();
  });
});

describe("labels", () => {
  it("prefers a worktree title over its branch", () => {
    expect(worktreeChoiceLabel({ ...WORKTREE, title: "Inbox refinements" })).toBe(
      "Inbox refinements",
    );
  });

  it("falls back to the branch, then the directory name", () => {
    expect(worktreeChoiceLabel(WORKTREE)).toBe("feature/thing");
    expect(worktreeChoiceLabel({ ...WORKTREE, branch: "  ", title: "  " })).toBe("feature");
  });

  it("names each target in the sentence", () => {
    expect(workLocationLabel({ kind: "projectRoot", worktree: null })).toBe("the project root");
    expect(workLocationLabel({ kind: "newWorktree", worktree: null })).toBe("a new worktree");
    expect(workLocationLabel({ kind: "existingWorktree", worktree: WORKTREE })).toBe(
      "feature/thing",
    );
  });
});

describe("branch slot", () => {
  it("is dropped for an existing worktree, which already has its branch", () => {
    expect(showsBranchSlot({ kind: "existingWorktree", worktree: WORKTREE })).toBe(false);
  });

  it("is shown for the project root and a new worktree", () => {
    expect(showsBranchSlot({ kind: "projectRoot", worktree: null })).toBe(true);
    expect(showsBranchSlot({ kind: "newWorktree", worktree: null })).toBe(true);
  });

  it('reads "from" when forking and "on" when working in place', () => {
    expect(branchSlotPreposition({ kind: "newWorktree", worktree: null })).toBe("from");
    expect(branchSlotPreposition({ kind: "projectRoot", worktree: null })).toBe("on");
  });
});
