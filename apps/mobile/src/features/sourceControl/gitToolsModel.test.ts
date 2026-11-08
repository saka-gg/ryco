import { describe, expect, it } from "vite-plus/test";

import type {
  GitComparisonSource,
  GitLocalChangesResult,
  VcsRef,
  VcsStatusResult,
} from "@ryco/contracts";

import {
  blameSummary,
  blameTargetForRow,
  branchNameProblem,
  branchToCreate,
  buildBranchSections,
  buildChangeFiles,
  changeCounts,
  changeFileStartsCollapsed,
  commitChoices,
  repositorySetupStep,
  resolveCheckoutCwd,
  stageVerb,
} from "./gitToolsModel";

const ref = (overrides: Partial<VcsRef> & Pick<VcsRef, "name">): VcsRef => ({
  current: false,
  isDefault: false,
  worktreePath: null,
  ...overrides,
});

const status = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/x",
  hasWorkingTreeChanges: true,
  workingTree: { files: [], insertions: 2, deletions: 1 },
  committed: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  aheadOfDefaultCount: 0,
  pr: null,
} satisfies VcsStatusResult;

const PATCH_A = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,2 @@",
  " keep",
  "-old",
  "+new",
  "@@ -10,1 +10,2 @@",
  " ten",
  "+eleven",
].join("\n");
const PATCH_B = [
  "diff --git a/b.md b/b.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/b.md",
  "@@ -0,0 +1 @@",
  "+hello",
].join("\n");

const local = (patch: string, files: GitLocalChangesResult["staged"]["files"]) =>
  ({
    worktreePath: "/repo",
    headOid: "a".repeat(40),
    branch: "main",
    indexIdentity: "i",
    revision: "r".repeat(64),
    staged: { patch: "", files: [] },
    unstaged: { patch, files },
  }) satisfies GitLocalChangesResult;

describe("checkout", () => {
  it("acts on the named worktree or on nothing, never on main instead", () => {
    const project = { cwd: "/repo" };
    expect(resolveCheckoutCwd({ worktreeId: null, worktree: null, project })).toBe("/repo");
    expect(
      resolveCheckoutCwd({ worktreeId: "w1", worktree: { worktreePath: "/wt/w1" }, project }),
    ).toBe("/wt/w1");
    expect(resolveCheckoutCwd({ worktreeId: "w1", worktree: null, project })).toBeNull();
    expect(
      resolveCheckoutCwd({ worktreeId: "w1", worktree: { worktreePath: null }, project }),
    ).toBeNull();
    expect(resolveCheckoutCwd({ worktreeId: null, worktree: null, project: null })).toBeNull();
  });
});

describe("branches", () => {
  it("orders local branches current, default, then by name, and hides remote twins", () => {
    const sections = buildBranchSections(
      [
        ref({ name: "zeta" }),
        ref({ name: "main", isDefault: true }),
        ref({ name: "feature/x", current: true, worktreePath: "/repo" }),
        ref({ name: "origin/main", isRemote: true, remoteName: "origin" }),
        ref({ name: "origin/only-remote", isRemote: true, remoteName: "origin" }),
        ref({ name: "other", worktreePath: "/elsewhere" }),
      ],
      "/repo",
    );
    expect(sections.local.map((row) => row.label)).toEqual(["feature/x", "main", "other", "zeta"]);
    expect(sections.local[0]?.detail).toBe("Current");
    expect(sections.local[2]?.disabledReason).toBe("Checked out in another worktree");
    expect(sections.remote.map((row) => row.label)).toEqual(["origin/only-remote"]);
  });

  it("validates new branch names the way git does for typed input", () => {
    expect(branchNameProblem("feature/phone")).toBeNull();
    expect(branchNameProblem("  ")).toBe("Enter a branch name.");
    expect(branchNameProblem("has space")).not.toBeNull();
    expect(branchNameProblem("a..b")).not.toBeNull();
    expect(branchNameProblem("x.lock")).not.toBeNull();
    expect(branchNameProblem("-x")).not.toBeNull();
    expect(branchNameProblem("dir/.hidden")).not.toBeNull();
  });

  it("offers to create only a new, valid name", () => {
    const refs = [ref({ name: "main" })];
    expect(branchToCreate("main", refs)).toBeNull();
    expect(branchToCreate(" fix/thing ", refs)).toBe("fix/thing");
    expect(branchToCreate("bad name", refs)).toBeNull();
  });
});

describe("commit and setup", () => {
  it("offers pushing only with a remote and a PR only without one", () => {
    expect(commitChoices(status, true).map((choice) => choice.enabled)).toEqual([true, true, true]);
    expect(
      commitChoices({ ...status, hasPrimaryRemote: false }, true).map((choice) => choice.enabled),
    ).toEqual([true, false, false]);
    expect(commitChoices(status, false).every((choice) => !choice.enabled)).toBe(true);
  });

  it("asks for Git first, then a host", () => {
    expect(repositorySetupStep(null)).toBeNull();
    expect(repositorySetupStep({ ...status, isRepo: false })).toBe("initialize");
    expect(repositorySetupStep({ ...status, hasPrimaryRemote: false })).toBe("publish");
    expect(repositorySetupStep(status)).toBeNull();
  });
});

describe("local changes", () => {
  it("pairs files with the node's ids in patch order and splits hunks", () => {
    const files = buildChangeFiles(
      local(`${PATCH_A}\n${PATCH_B}`, [
        { id: "f1", hunkCount: 2, fileAction: true, hunkAction: true },
        { id: "f2", hunkCount: 1, fileAction: true, hunkAction: false },
      ]),
      "unstaged",
    );
    expect(files.map((file) => [file.id, file.file.path, file.hunks.length])).toEqual([
      ["f1", "src/a.ts", 2],
      ["f2", "b.md", 1],
    ]);
    expect(files[0]?.hunkAction).toBe(true);
    expect(files[0]?.hunks[1]?.rows.map((row) => row.kind)).toEqual(["context", "addition"]);
    expect(files[1]?.hunkAction).toBe(false);
  });

  it("pairs nothing when the listing and the patch disagree", () => {
    const files = buildChangeFiles(
      local(PATCH_A, [
        { id: "f1", hunkCount: 2, fileAction: true, hunkAction: true },
        { id: "f2", hunkCount: 1, fileAction: true, hunkAction: true },
      ]),
      "unstaged",
    );
    expect(files[0]?.id).toBeNull();
    expect(files[0]?.fileAction).toBe(false);
  });

  it("opens the first few small files and collapses the rest", () => {
    const small = { additions: 3, deletions: 1, binary: false };
    expect(changeFileStartsCollapsed(0, small)).toBe(false);
    expect(changeFileStartsCollapsed(3, small)).toBe(true);
    expect(changeFileStartsCollapsed(0, { ...small, additions: 400 })).toBe(true);
  });

  it("counts both sides and names the action", () => {
    expect(changeCounts(local(PATCH_A, []))).toEqual({ staged: 0, unstaged: 1 });
    expect(stageVerb("staged")).toBe("Unstage");
    expect(stageVerb("unstaged")).toBe("Stage");
  });
});

describe("blame", () => {
  const source = {
    repositoryPath: "/repo",
    worktreePath: "/repo",
    refOid: "c".repeat(40),
    headOid: "h".repeat(40),
    baseOid: "b".repeat(40),
    revision: "rev",
  } satisfies GitComparisonSource;
  const file = { path: "src/a.ts", previousPath: "src/old.ts", status: "renamed" as const };

  it("blames deletions on base and context on head, never additions", () => {
    expect(
      blameTargetForRow(source, file, { kind: "addition", text: "x", oldLine: null, newLine: 4 }),
    ).toBeNull();
    expect(
      blameTargetForRow(source, file, { kind: "deletion", text: "x", oldLine: 3, newLine: null }),
    ).toEqual({ side: "base", filePath: "src/old.ts", line: 3 });
    expect(
      blameTargetForRow(source, file, { kind: "context", text: "x", oldLine: 2, newLine: 5 }),
    ).toEqual({ side: "head", filePath: "src/a.ts", line: 5 });
  });

  it("only blames the base side against working files", () => {
    const working = { ...source, target: "workingTree" as const };
    expect(
      blameTargetForRow(working, file, { kind: "context", text: "x", oldLine: 2, newLine: 5 }),
    ).toEqual({ side: "base", filePath: "src/old.ts", line: 2 });
    expect(
      blameTargetForRow(source, file, { kind: "hunk", text: "@@", oldLine: null, newLine: null }),
    ).toBeNull();
  });

  it("summarises author, commit and age", () => {
    expect(
      blameSummary(
        {
          author: "Ada",
          summary: "Fix parser",
          authorTime: "2026-11-05T12:00:00Z",
          oid: "abcdef1234",
        },
        new Date("2026-11-08T12:00:00Z"),
      ),
    ).toBe("Ada · abcdef1 · 3 days ago\nFix parser");
  });
});
