import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runProcess } from "../processRunner.ts";
import { checkCacheFolders, purgeCacheDirectory } from "./cacheFolders.ts";
import type { CacheMove } from "./filesystem.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const scratch = async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ryco-cache-folders-")));
  roots.push(root);
  return root;
};
const write = async (root: string, files: Record<string, string>) => {
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
  }
};
const budget = (remaining = 100_000) => ({ remaining, deadline: Date.now() + 30_000 });
const exists = (candidate: string) =>
  fs.lstat(candidate).then(
    () => true,
    () => false,
  );
// Root may change any folder, and Windows has no such modes.
const permissionsApply = process.platform !== "win32" && process.getuid?.() !== 0;
/** Runs `work` with `folder` read-only, as a container running as root leaves it. */
const withReadOnly = async (folder: string, work: () => Promise<void>) => {
  await fs.chmod(folder, 0o555);
  try {
    await work();
  } finally {
    await fs.chmod(folder, 0o755);
  }
};

describe("checkCacheFolders", () => {
  it("accepts what packages ship and counts the bytes", async () => {
    const checkout = await scratch();
    await write(checkout, {
      "node_modules/pkg/index.js": "12345",
      // Certificates and credentials sources are package fixtures, not the user's secrets.
      "node_modules/pkg/test/server.pem": "pem",
      "node_modules/@aws-sdk/core/credentials.js": "c",
      ".venv/lib/site.py": "py",
    });
    await fs.symlink("../pkg/index.js", path.join(checkout, "node_modules", "pkg", "link"));
    const check = await checkCacheFolders(checkout, ["node_modules", ".venv"], budget(), budget());
    const identity = async (folder: string) => {
      const stat = await fs.lstat(path.join(checkout, folder));
      return { relativePath: folder, device: stat.dev, inode: stat.ino };
    };
    expect(check).toEqual({
      // The folders as the check saw them: a removal must move exactly these.
      folders: [await identity("node_modules"), await identity(".venv")],
      entries: 10,
      bytes: 5 + 3 + 1 + 2 + "../pkg/index.js".length,
      sized: true,
      finding: null,
      complete: true,
    });
    const unsized = await checkCacheFolders(checkout, ["node_modules"], budget(), null);
    expect([unsized.bytes, unsized.sized, unsized.complete]).toEqual([0, false, true]);
    // Running out of the sizing budget leaves a lower bound, not an incomplete check.
    const partly = await checkCacheFolders(checkout, ["node_modules"], budget(), budget(1));
    expect([partly.sized, partly.complete, partly.bytes > 0]).toEqual([false, true, true]);
  });

  it("finds secrets, repositories and pipes inside cache folders", async () => {
    const cases: [Record<string, string>, string][] = [
      [{ "node_modules/.env.local": "" }, "holds node_modules/.env.local, which is not a cache."],
      [{ "node_modules/a/b/id_rsa": "" }, "holds node_modules/a/b/id_rsa, which is not a cache."],
      [{ "node_modules/.npmrc": "" }, "holds node_modules/.npmrc, which is not a cache."],
      [
        { "node_modules/src/pkg/.git/HEAD": "" },
        "holds a Git repository (node_modules/src/pkg/.git).",
      ],
      // A submodule-style gitlink file counts too.
      [{ "node_modules/dep/.git": "gitdir: x" }, "holds a Git repository (node_modules/dep/.git)."],
    ];
    for (const [files, finding] of cases) {
      const checkout = await scratch();
      await write(checkout, { "node_modules/pkg/index.js": "x", ...files });
      const check = await checkCacheFolders(checkout, ["node_modules"], budget(), null);
      expect(check.finding).toBe(`The cache folder node_modules/ ${finding}`);
    }
    const checkout = await scratch();
    await write(checkout, { "node_modules/pkg/index.js": "x" });
    await runProcess("mkfifo", [path.join(checkout, "node_modules", "pkg", "dev.pipe")], {
      timeoutMs: 5_000,
      maxBufferBytes: 4096,
    });
    expect((await checkCacheFolders(checkout, ["node_modules"], budget(), null)).finding).toBe(
      "The cache folder node_modules/ holds a socket, pipe or device (node_modules/pkg/dev.pipe).",
    );
  });

  it.skipIf(!permissionsApply)("finds folders it cannot delete", async () => {
    const cases: [string, string, string][] = [
      // Moving a folder to another one needs write access to it.
      [
        "node_modules",
        "node_modules",
        "Ryco cannot delete the cache folder node_modules/ (permission denied).",
      ],
      // Emptying it needs write access to every folder inside.
      [
        "node_modules/.cache/babel",
        "node_modules",
        "The cache folder node_modules/ holds a folder Ryco cannot delete (node_modules/.cache/babel).",
      ],
      // And moving it out needs write access to its parent.
      [
        "src/pkg",
        "src/pkg/__pycache__",
        "Ryco cannot delete the cache folder src/pkg/__pycache__/ (permission denied).",
      ],
    ];
    for (const [locked, folder, finding] of cases) {
      const checkout = await scratch();
      await write(checkout, {
        "node_modules/.cache/babel/entry.json": "{}",
        "src/pkg/__pycache__/module.pyc": "",
      });
      await withReadOnly(path.join(checkout, locked), async () => {
        const check = await checkCacheFolders(checkout, [folder], budget(), null);
        expect([check.finding, check.complete]).toEqual([finding, true]);
      });
    }
  });

  it("reports an incomplete check when the budget runs out", async () => {
    const checkout = await scratch();
    await write(checkout, { "node_modules/a.js": "", "node_modules/b.js": "" });
    const check = await checkCacheFolders(checkout, ["node_modules"], budget(1), null);
    expect(check.complete).toBe(false);
    expect(check.finding).toBeNull();
  });
});

describe("purgeCacheDirectory", () => {
  const moved = async (files: Record<string, string>) => {
    const root = await scratch();
    const destination = path.join(root, ".cleanup-row-uuid-cache-0");
    await write(destination, files);
    const stat = await fs.lstat(destination);
    const move: CacheMove = {
      relativePath: "node_modules",
      destination,
      device: stat.dev,
      inode: stat.ino,
    };
    return { root, move };
  };

  it("deletes the folder, unlinking links without following them, and resumes after its budget", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`pkg${index % 4}/m${index}.js`, "m"]),
    );
    const { root, move } = await moved(files);
    await write(root, { "outside/sentinel.txt": "keep" });
    await fs.symlink(path.join(root, "outside"), path.join(move.destination, "pkg0", "outside"));
    // 45 entries to read once and delete once: the first pass stops, the next one finishes.
    const first = budget(60);
    expect(await purgeCacheDirectory(move, first)).toBe("budget");
    expect(await exists(move.destination)).toBe(true);
    expect(await purgeCacheDirectory(move, budget())).toBe("done");
    expect(await exists(move.destination)).toBe(false);
    expect(await fs.readFile(path.join(root, "outside", "sentinel.txt"), "utf8")).toBe("keep");
    // Gone already: nothing left to do.
    expect(await purgeCacheDirectory(move, budget())).toBe("done");
  });

  it("keeps a folder whose identity changed or that holds what is not a cache", async () => {
    const replaced = await moved({ "pkg/index.js": "x" });
    expect(
      await purgeCacheDirectory({ ...replaced.move, inode: replaced.move.inode + 1 }, budget()),
    ).toEqual({
      kept: `The cache folder node_modules/ changed after the checkout was removed; kept at ${replaced.move.destination}.`,
    });
    expect(await exists(path.join(replaced.move.destination, "pkg", "index.js"))).toBe(true);

    const secret = await moved({ "pkg/index.js": "x", "pkg/deeper/.env": "TOKEN=1" });
    const outcome = await purgeCacheDirectory(secret.move, budget());
    expect(outcome).toEqual({
      kept: `The cache folder node_modules/ holds node_modules/pkg/deeper/.env, which is not a cache. Kept at ${secret.move.destination}; nothing in it was deleted.`,
    });
    expect(await exists(path.join(secret.move.destination, "pkg", "index.js"))).toBe(true);

    // A link where the folder was is never followed.
    const linked = await moved({ "pkg/index.js": "x" });
    const target = path.join(linked.root, "target");
    await fs.rename(linked.move.destination, target);
    await fs.symlink(target, linked.move.destination);
    expect(await purgeCacheDirectory(linked.move, budget())).toHaveProperty("kept");
    expect(await exists(path.join(target, "pkg", "index.js"))).toBe(true);
  });

  it.skipIf(!permissionsApply)("keeps a folder whole that holds one it cannot delete", async () => {
    const { move } = await moved({ "pkg/index.js": "x", ".cache/babel/entry.json": "{}" });
    await withReadOnly(path.join(move.destination, ".cache", "babel"), async () => {
      expect(await purgeCacheDirectory(move, budget())).toEqual({
        kept: `The cache folder node_modules/ holds a folder Ryco cannot delete (node_modules/.cache/babel). Kept at ${move.destination}; nothing in it was deleted.`,
      });
    });
    expect(await exists(path.join(move.destination, "pkg", "index.js"))).toBe(true);
  });

  it("keeps the rest of a folder when a deletion is not permitted", async () => {
    // Permissions that changed after the read-only pass, or an immutable file.
    const { move } = await moved({ "pkg/index.js": "x" });
    const unlink = vi
      .spyOn(fs, "unlink")
      .mockRejectedValueOnce(
        Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }),
      );
    try {
      expect(await purgeCacheDirectory(move, budget())).toEqual({
        kept: `Ryco cannot delete node_modules/pkg/index.js (permission denied); the rest of the cache folder node_modules/ is kept at ${move.destination}.`,
      });
    } finally {
      unlink.mockRestore();
    }
    expect(await exists(path.join(move.destination, "pkg", "index.js"))).toBe(true);
  });
});
