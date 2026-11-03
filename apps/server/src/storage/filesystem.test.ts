import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  type CacheMove,
  cacheMoveDestination,
  checkoutManifest,
  MAX_QUARANTINE_REMOVAL_ENTRIES,
  measureDirectory,
  quarantineRemovalBudget,
} from "./filesystem.ts";
import { removeQuarantinedTemporaryDirectory } from "./quarantineRemoval.ts";

describe("quarantined removal", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
  });
  /** A tree of `directories` folders with `files` empty files each, like a source checkout. */
  const tree = async (directories: number, files: number) => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "ryco-quarantine-removal-")),
    );
    roots.push(root);
    const source = path.join(root, "checkout");
    for (let directory = 0; directory < directories; directory++) {
      const parent = path.join(source, "src", `module-${directory}`);
      await fs.mkdir(parent, { recursive: true });
      await Promise.all(
        Array.from({ length: files }, (_, index) =>
          fs.writeFile(path.join(parent, `file-${index}.ts`), "x"),
        ),
      );
    }
    const measured = await measureDirectory(
      source,
      { remaining: 100_000, deadline: Date.now() + 60_000 },
      new Set(),
      true,
    );
    return {
      source,
      quarantine: path.join(root, `.cleanup-fixture-${crypto.randomUUID()}`),
      measured,
    };
  };

  it("gives the removal time and checks in proportion to its manifest", () => {
    expect(quarantineRemovalBudget(0, 1_000)).toEqual({ remaining: 16, deadline: 4_000 });
    // A checkout of Ryco without dependencies: 8,730 entries, about 8,200 of them files.
    const budget = quarantineRemovalBudget(8_730, 0);
    expect(budget.remaining).toBeGreaterThanOrEqual(2 * 8_228 + 502);
    expect(budget.deadline).toBe(3_000 + 20 * 8_730);
    expect(quarantineRemovalBudget(MAX_QUARANTINE_REMOVAL_ENTRIES, 0).deadline).toBe(243_000);
  });

  it("removes a tree as large as a Ryco checkout in one pass", async () => {
    // 9,000 files in 90 folders: the old fixed 3-second budget stopped about half-way.
    const { source, quarantine, measured } = await tree(90, 100);
    expect(measured.entries).toBe(9_092);
    // Under load it may use its whole deadline: 3 s + 20 ms per entry, about 185 s here.
    await removeQuarantinedTemporaryDirectory(source, quarantine, measured.fingerprint!);
    await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(quarantine)).rejects.toMatchObject({ code: "ENOENT" });
  }, 240_000);

  it("refuses a tree over the entry limit before moving anything", async () => {
    const { source, quarantine, measured } = await tree(121, 100);
    expect(measured.entries).toBeGreaterThan(MAX_QUARANTINE_REMOVAL_ENTRIES);
    await expect(
      removeQuarantinedTemporaryDirectory(source, quarantine, measured.fingerprint!),
    ).rejects.toThrow("Too many files to remove safely in one pass; nothing was moved.");
    expect((await fs.readdir(path.join(source, "src"))).length).toBe(121);
    await expect(fs.lstat(quarantine)).rejects.toMatchObject({ code: "ENOENT" });
  });

  /** A checkout-like tree: sources, a tracked link and cache folders full of files. */
  const checkoutTree = async (
    directories: number,
    files: number,
    cacheFiles: number,
  ): Promise<{
    source: string;
    quarantine: string;
    outside: string;
    caches: CacheMove[];
    fingerprint: string;
    entries: number;
  }> => {
    const { source, quarantine } = await tree(directories, files);
    await fs.writeFile(path.join(source, "AGENTS.md"), "agents");
    await fs.symlink("AGENTS.md", path.join(source, "CLAUDE.md"));
    const outside = path.join(path.dirname(source), "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "sentinel.txt"), "keep");
    for (const folder of ["node_modules", "apps/web/node_modules"]) {
      const packages = path.join(source, folder, "pkg");
      await fs.mkdir(packages, { recursive: true });
      await Promise.all(
        Array.from({ length: cacheFiles }, (_, index) =>
          fs.writeFile(path.join(packages, `m${index}.js`), "m"),
        ),
      );
      await fs.symlink(outside, path.join(source, folder, "outside"));
    }
    const folders = ["apps/web/node_modules", "node_modules"];
    const measured = await measureDirectory(
      source,
      { remaining: 100_000, deadline: Date.now() + 60_000 },
      new Set(),
      true,
      undefined,
      checkoutManifest(folders),
    );
    const caches = folders.map((relativePath, index) => {
      const stat = measured.manifest!.find(
        (entry) => entry.opaque && entry.relativePath === relativePath,
      )!.stat;
      return {
        relativePath,
        destination: cacheMoveDestination(quarantine, index),
        device: stat.dev,
        inode: stat.ino,
      };
    });
    return {
      source,
      quarantine,
      outside,
      caches,
      fingerprint: measured.fingerprint!,
      entries: measured.entries!,
    };
  };

  it("moves cache folders out whole, so they do not count toward the entry limit", async () => {
    // A Ryco-sized checkout plus 2 x 2,000 cached files: over the limit if they were counted.
    const { source, quarantine, outside, caches, fingerprint, entries } = await checkoutTree(
      90,
      100,
      2_000,
    );
    expect(entries).toBeLessThan(MAX_QUARANTINE_REMOVAL_ENTRIES);
    expect(entries + 4_000).toBeGreaterThan(MAX_QUARANTINE_REMOVAL_ENTRIES);
    await removeQuarantinedTemporaryDirectory(
      source,
      quarantine,
      fingerprint,
      undefined,
      undefined,
      { caches },
    );
    await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(quarantine)).rejects.toMatchObject({ code: "ENOENT" });
    // Each cache folder waits, unread and whole, at its recorded destination.
    for (const cache of caches) {
      const moved = await fs.lstat(cache.destination);
      expect([moved.dev, moved.ino]).toEqual([cache.device, cache.inode]);
      expect((await fs.readdir(path.join(cache.destination, "pkg"))).length).toBe(2_000);
    }
    // The tracked link went as a link; what it pointed at is untouched.
    expect(await fs.readFile(path.join(outside, "sentinel.txt"), "utf8")).toBe("keep");
  }, 240_000);

  it("refuses a cache folder swapped right before the move, for a copy or a link", async () => {
    for (const swap of ["copy", "link"] as const) {
      const { source, quarantine, outside, caches, fingerprint } = await checkoutTree(2, 2, 3);
      const original = path.join(path.dirname(source), `original-${swap}`);
      await expect(
        removeQuarantinedTemporaryDirectory(
          source,
          quarantine,
          fingerprint,
          // Runs right before the cache folders leave: same name and contents, other identity.
          async (moved) => {
            const folder = path.join(moved, "node_modules");
            await fs.rename(folder, original);
            if (swap === "copy")
              await fs.cp(original, folder, { recursive: true, verbatimSymlinks: true });
            else await fs.symlink(outside, folder);
          },
          undefined,
          { caches },
        ),
      ).rejects.toThrow("Cache folder identity changed.");
      // Nothing was moved to a destination or deleted, and the link was never followed.
      for (const cache of caches)
        await expect(fs.lstat(cache.destination)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.readdir(path.join(original, "pkg"))).length).toBe(3);
      expect((await fs.readdir(path.join(quarantine, "src"))).length).toBe(2);
      expect(await fs.readFile(path.join(outside, "sentinel.txt"), "utf8")).toBe("keep");
    }
  });

  it("refuses a cache folder swapped after the manifest was pinned, before anything moves", async () => {
    const { source, quarantine, caches, fingerprint } = await checkoutTree(2, 2, 3);
    const folder = path.join(source, "node_modules");
    await fs.rename(folder, path.join(path.dirname(source), "original"));
    await fs.mkdir(folder);
    await expect(
      removeQuarantinedTemporaryDirectory(source, quarantine, fingerprint, undefined, undefined, {
        caches,
      }),
    ).rejects.toThrow("Temporary data changed at the removal boundary");
    await expect(fs.lstat(quarantine)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("names the moved cache folders when the removal stops after moving them", async () => {
    const { source, quarantine, caches, fingerprint } = await checkoutTree(2, 2, 3);
    const error = await removeQuarantinedTemporaryDirectory(
      source,
      quarantine,
      fingerprint,
      // A tracked file changes after the checks: the folders leave, then the files stop.
      async (moved) => {
        await fs.writeFile(path.join(moved, "AGENTS.md"), "changed");
      },
      undefined,
      { caches },
    ).then(
      () => null,
      (cause: Error) => cause.message,
    );
    expect(error).toContain(`remaining data preserved at ${quarantine} (cache folders moved`);
    for (const cache of caches) {
      expect(error).toContain(`${cache.relativePath} to ${cache.destination}`);
      expect((await fs.readdir(path.join(cache.destination, "pkg"))).length).toBe(3);
    }
    expect(error).toContain("Quarantined file changed before removal.");
  });
});

describe("checkout manifests", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
  });
  const budget = () => ({ remaining: 10_000, deadline: Date.now() + 10_000 });
  const checkout = async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "ryco-checkout-manifest-")),
    );
    roots.push(root);
    await fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(root, "node_modules", "pkg", "index.js"), "x".repeat(1_000));
    await fs.writeFile(path.join(root, "tracked.txt"), "tracked");
    await fs.symlink("tracked.txt", path.join(root, "alias.txt"));
    return root;
  };
  const measure = (root: string, folders: readonly string[]) =>
    measureDirectory(root, budget(), new Set(), true, undefined, checkoutManifest(folders));

  it("records a cache folder by identity only, without reading it", async () => {
    const root = await checkout();
    const measured = await measure(root, ["node_modules"]);
    expect(measured.sizeStatus).toBe("complete");
    expect(measured.unsafe).toBe(false);
    // The root, tracked.txt, the link and node_modules: nothing inside the cache folder.
    expect(measured.entries).toBe(4);
    expect(measured.bytes).toBe("tracked".length + "tracked.txt".length);
    expect(
      measured.manifest!.filter((entry) => entry.opaque).map((entry) => entry.relativePath),
    ).toEqual(["node_modules"]);
    // Its contents may change; the folder itself may not.
    await fs.writeFile(path.join(root, "node_modules", "pkg", "new.js"), "new");
    expect((await measure(root, ["node_modules"])).fingerprint).toBe(measured.fingerprint);
    await fs.rename(
      path.join(root, "node_modules"),
      path.join(root, "..", `${path.basename(root)}-old`),
    );
    roots.push(path.join(root, "..", `${path.basename(root)}-old`));
    await fs.mkdir(path.join(root, "node_modules"));
    const replaced = await measure(root, ["node_modules"]);
    expect(replaced.fingerprint).toBeDefined();
    expect(replaced.fingerprint).not.toBe(measured.fingerprint);
  });

  it("is unsafe when a cache folder is a link, a file or missing, or links are not leaves", async () => {
    const root = await checkout();
    expect((await measure(root, ["node_modules", "missing"])).unsafe).toBe(true);
    // Without the checkout options a link is never accepted.
    expect((await measureDirectory(root, budget(), new Set(), true)).unsafe).toBe(true);
    await fs.rename(path.join(root, "node_modules"), path.join(root, "real_modules"));
    await fs.symlink("real_modules", path.join(root, "node_modules"));
    expect((await measure(root, ["node_modules"])).unsafe).toBe(true);
    await fs.rm(path.join(root, "node_modules"));
    await fs.writeFile(path.join(root, "node_modules"), "file");
    expect((await measure(root, ["node_modules"])).unsafe).toBe(true);
  });
});
