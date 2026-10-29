import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_QUARANTINE_REMOVAL_ENTRIES,
  measureDirectory,
  quarantineRemovalBudget,
  removeQuarantinedTemporaryDirectory,
} from "./filesystem.ts";

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
});
