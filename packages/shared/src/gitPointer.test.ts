import { describe, expect, it } from "vite-plus/test";

import { isLinkedWorktreeGitDir, parseGitDirPointer } from "./gitPointer.ts";

describe("parseGitDirPointer", () => {
  it("reads the gitdir line", () => {
    expect(parseGitDirPointer("gitdir: /x/repo/.git/worktrees/feature\n")).toBe(
      "/x/repo/.git/worktrees/feature",
    );
  });

  it("accepts CRLF, surrounding whitespace and relative targets", () => {
    expect(parseGitDirPointer("  gitdir:   ../.git/modules/sub  \r\n")).toBe("../.git/modules/sub");
  });

  it("returns undefined for content that is not a pointer", () => {
    expect(parseGitDirPointer("")).toBeUndefined();
    expect(parseGitDirPointer("gitdir:   \n")).toBeUndefined();
    expect(parseGitDirPointer("[core]\n\tbare = false\n")).toBeUndefined();
  });
});

describe("isLinkedWorktreeGitDir", () => {
  it("matches a worktree of a normal and of a bare repository", () => {
    expect(isLinkedWorktreeGitDir("/x/repo/.git/worktrees/feature")).toBe(true);
    expect(isLinkedWorktreeGitDir("/x/repo.git/worktrees/feature/")).toBe(true);
    expect(isLinkedWorktreeGitDir("C:\\x\\repo\\.git\\worktrees\\feature")).toBe(true);
  });

  it("rejects submodules and plain git directories", () => {
    expect(isLinkedWorktreeGitDir("../.git/modules/sub")).toBe(false);
    expect(isLinkedWorktreeGitDir("/x/repo/.git")).toBe(false);
    expect(isLinkedWorktreeGitDir("worktrees")).toBe(false);
  });
});
