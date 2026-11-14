import { describe, expect, it } from "vite-plus/test";

import type { WorktreeIdentity } from "./filesystem.ts";
import {
  isSameMovedWorktreeIdentity,
  isSameWorktreeIdentity,
  readTemporaryIdentity,
  readWorktreeIdentity,
} from "./ownedEntryIdentity.ts";

const worktree: WorktreeIdentity = {
  device: 16777232,
  inode: 4242,
  gitFile: "gitdir: /repo/.git/worktrees/feature\n",
  gitDirectory: "/repo/.git/worktrees/feature",
  commonDirectory: "/repo/.git",
  commonDevice: 16777232,
  commonInode: 17,
};

describe("owned entry identity", () => {
  it("reads a worktree identity whatever its key order", () => {
    const reordered = JSON.stringify({
      commonInode: worktree.commonInode,
      commonDevice: worktree.commonDevice,
      commonDirectory: worktree.commonDirectory,
      gitDirectory: worktree.gitDirectory,
      gitFile: worktree.gitFile,
      inode: worktree.inode,
      device: worktree.device,
    });
    expect(reordered).not.toBe(JSON.stringify(worktree));
    const recorded = readWorktreeIdentity(reordered);
    expect(recorded).not.toBeNull();
    expect(isSameWorktreeIdentity(recorded!, worktree)).toBe(true);
  });

  it("reads past fields a later write adds beside the identity", () => {
    const recorded = readWorktreeIdentity(
      JSON.stringify({ ...worktree, fingerprint: "abc", quarantinePath: "/repo/.cleanup-1" }),
    );
    expect(recorded).toEqual(worktree);
  });

  it("tells a changed checkout apart by any pinned field", () => {
    for (const key of Object.keys(worktree) as Array<keyof WorktreeIdentity>) {
      const changed = {
        ...worktree,
        [key]: typeof worktree[key] === "number" ? (worktree[key] as number) + 1 : "other",
      };
      expect(isSameWorktreeIdentity(changed, worktree)).toBe(false);
    }
  });

  it("keeps a moved checkout the same whatever its .git file now says, and nothing else", () => {
    const moved = { ...worktree, gitFile: "gitdir: /repo/.git/worktrees/feature-2\n" };
    expect(isSameWorktreeIdentity(moved, worktree)).toBe(false);
    expect(isSameMovedWorktreeIdentity(moved, worktree)).toBe(true);
    expect(isSameMovedWorktreeIdentity({ ...moved, inode: 1 }, worktree)).toBe(false);
    expect(isSameMovedWorktreeIdentity({ ...moved, commonDirectory: "/other" }, worktree)).toBe(
      false,
    );
  });

  it("refuses unreadable records instead of trusting them", () => {
    expect(readWorktreeIdentity("{}")).toBeNull();
    expect(isSameWorktreeIdentity(readWorktreeIdentity("{}"), worktree)).toBe(false);
    expect(isSameMovedWorktreeIdentity(null, worktree)).toBe(false);
    expect(readWorktreeIdentity("not json")).toBeNull();
    expect(readWorktreeIdentity(JSON.stringify({ ...worktree, inode: "4242" }))).toBeNull();
    expect(readTemporaryIdentity("null")).toBeNull();
    expect(readTemporaryIdentity(JSON.stringify({ device: 1 }))).toBeNull();
  });

  it("reads a staging directory's identity with and without its fingerprint", () => {
    expect(readTemporaryIdentity(JSON.stringify({ device: 1, inode: 2 }))).toEqual({
      device: 1,
      inode: 2,
    });
    expect(
      readTemporaryIdentity(JSON.stringify({ inode: 2, fingerprint: "f", device: 1 })),
    ).toEqual({ device: 1, inode: 2, fingerprint: "f" });
  });
});
