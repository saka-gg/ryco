// @effect-diagnostics nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vite-plus/test";

import { readWorktreeListFingerprint } from "./worktreeListFingerprint.ts";

const base = mkdtempSync(path.join(tmpdir(), "ryco-worktree-fingerprint-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Ryco",
      GIT_AUTHOR_EMAIL: "ryco@example.test",
      GIT_COMMITTER_NAME: "Ryco",
      GIT_COMMITTER_EMAIL: "ryco@example.test",
    },
  });

describe("readWorktreeListFingerprint", () => {
  it("changes exactly when worktree registrations change", async () => {
    const root = path.join(base, "repo");
    execFileSync("mkdir", ["-p", root]);
    git(root, "init", "-q", "-b", "main");
    writeFileSync(path.join(root, "README.md"), "hello\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "init");

    const initial = await readWorktreeListFingerprint(root);
    expect(initial).not.toBeNull();
    // Commits, branches and file edits do not touch registrations.
    writeFileSync(path.join(root, "README.md"), "changed\n");
    git(root, "commit", "-qam", "edit");
    git(root, "branch", "topic");
    expect(await readWorktreeListFingerprint(root)).toBe(initial);

    const linked = path.join(base, "linked");
    git(root, "worktree", "add", "-q", linked, "topic");
    const added = await readWorktreeListFingerprint(root);
    expect(added).not.toBe(initial);
    // The linked checkout resolves to the same repository and fingerprint.
    expect(await readWorktreeListFingerprint(linked)).toBe(added);

    const moved = path.join(base, "moved");
    git(root, "worktree", "move", linked, moved);
    const afterMove = await readWorktreeListFingerprint(root);
    expect(afterMove).not.toBe(added);

    git(root, "worktree", "remove", moved);
    expect(await readWorktreeListFingerprint(root)).not.toBe(afterMove);
  });

  it("returns null for directories that are not repositories", async () => {
    const plain = path.join(base, "plain");
    execFileSync("mkdir", ["-p", plain]);
    expect(await readWorktreeListFingerprint(plain)).toBeNull();
    expect(await readWorktreeListFingerprint(path.join(base, "missing"))).toBeNull();
  });
});
