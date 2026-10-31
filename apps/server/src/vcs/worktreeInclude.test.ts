import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { copyWorktreeIncludedFiles, parseWorktreeIncludePaths } from "./worktreeInclude.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const scratch = async () => {
  const dir = await mkdtemp(nodePath.join(tmpdir(), "ryco-worktree-include-"));
  dirs.push(dir);
  return dir;
};

describe("parseWorktreeIncludePaths", () => {
  it("keeps matched paths Git also ignores, inside the checkout, sorted and once each", () => {
    expect(
      parseWorktreeIncludePaths(
        [
          "config/local.json",
          ".env",
          "notes.txt",
          "../outside",
          "/etc/passwd",
          "a//b",
          ".env",
        ].join("\0"),
        [".env", "config/local.json", "dist/app.js", "../outside", "/etc/passwd", "a//b"].join(
          "\0",
        ),
      ),
    ).toEqual([".env", "config/local.json"]);
  });
});

describe("copyWorktreeIncludedFiles", () => {
  it("never writes through a symlinked folder the new branch tracks", async () => {
    const source = await scratch();
    const worktree = await scratch();
    const outside = await scratch();
    await mkdir(nodePath.join(source, "packages", "api"), { recursive: true });
    await writeFile(nodePath.join(source, "packages", "api", ".env"), "SECRET=1\n");
    await writeFile(nodePath.join(source, ".env"), "ROOT=1\n");
    await mkdir(nodePath.join(worktree, "packages"), { recursive: true });
    await symlink(outside, nodePath.join(worktree, "packages", "api"));

    const result = await Effect.runPromise(
      copyWorktreeIncludedFiles({
        sourceRoot: source,
        worktreePath: worktree,
        paths: [".env", "packages/api/.env"],
      }),
    );

    expect(result.copied).toEqual([".env"]);
    expect(result.failed.map((entry) => entry.path)).toEqual(["packages/api/.env"]);
    await expect(readFile(nodePath.join(outside, ".env"), "utf8")).rejects.toThrow();
    expect(await readFile(nodePath.join(worktree, ".env"), "utf8")).toBe("ROOT=1\n");
  });
});
