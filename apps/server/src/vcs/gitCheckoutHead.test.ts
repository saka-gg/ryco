import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { parseHeadFile, readCheckoutHead } from "./gitCheckoutHead.ts";

const git = (cwd: string, args: ReadonlyArray<string>) =>
  execFileSync("git", [...args], {
    cwd,
    env: {
      ...process.env,
      // No user or system config (signing, hooks, default branch) leaks in.
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Ryco",
      GIT_AUTHOR_EMAIL: "ryco@example.com",
      GIT_COMMITTER_NAME: "Ryco",
      GIT_COMMITTER_EMAIL: "ryco@example.com",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();

describe("parseHeadFile", () => {
  it("reads a branch, a detached HEAD, and refuses what only git can answer", () => {
    assert.deepStrictEqual(parseHeadFile("ref: refs/heads/feature/x\n"), { branch: "feature/x" });
    assert.deepStrictEqual(parseHeadFile(`${"a".repeat(40)}\n`), { branch: null });
    // Reftable repositories keep a placeholder HEAD file.
    assert.strictEqual(parseHeadFile("ref: refs/heads/.invalid\n"), null);
    assert.strictEqual(parseHeadFile("ref: refs/remotes/origin/main\n"), null);
    assert.strictEqual(parseHeadFile("garbage"), null);
  });
});

describe("readCheckoutHead", () => {
  it.effect("reads the main checkout and a linked worktree without spawning git", () => {
    const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ryco-checkout-head-")));
    const repo = path.join(base, "repo");
    const worktree = path.join(base, "worktree");
    mkdirSync(repo);
    git(repo, ["init", "--initial-branch=main"]);
    git(repo, ["commit", "--allow-empty", "-m", "initial"]);
    git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    git(repo, ["worktree", "add", "-b", "feature/head", worktree]);

    return Effect.gen(function* () {
      const main = yield* readCheckoutHead(repo);
      assert.deepStrictEqual(main, {
        branch: "main",
        commonDir: path.join(repo, ".git"),
        originDefaultBranch: "main",
      });

      const linked = yield* readCheckoutHead(worktree);
      assert.strictEqual(linked?.branch, "feature/head");
      // A linked worktree resolves the shared metadata, and so origin/HEAD.
      assert.strictEqual(linked?.commonDir, path.join(repo, ".git"));
      assert.strictEqual(linked?.originDefaultBranch, "main");

      git(worktree, ["checkout", "--detach"]);
      assert.strictEqual((yield* readCheckoutHead(worktree))?.branch, null);

      // A folder below the root, or no repository at all: callers ask git.
      mkdirSync(path.join(repo, "sub"));
      assert.strictEqual(yield* readCheckoutHead(path.join(repo, "sub")), null);
      assert.strictEqual(yield* readCheckoutHead(base), null);
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(base, { recursive: true, force: true }))));
  });
});
