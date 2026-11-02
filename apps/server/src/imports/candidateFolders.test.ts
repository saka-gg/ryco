import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { canonicalCandidateFolders } from "./candidateFolders.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("canonicalCandidateFolders", () => {
  it("resolves spellings of one folder to its real path and drops what is not a folder here", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ryco-candidate-folders-"));
    dirs.push(root);
    const real = await (await import("node:fs/promises")).realpath(root);
    await symlink(root, path.join(root, "..", `${path.basename(root)}-link`));
    dirs.push(path.join(root, "..", `${path.basename(root)}-link`));
    const resolved = await canonicalCandidateFolders([
      root,
      `${root}${path.sep}`,
      path.join(root, "..", `${path.basename(root)}-link`),
      path.join(root, "gone"),
      "relative/folder",
      "",
      "\\\\host\\share\\repo",
    ]);
    expect(resolved.get(root)).toBe(real);
    expect(resolved.get(`${root}${path.sep}`)).toBe(real);
    expect(resolved.get(path.join(root, "..", `${path.basename(root)}-link`))).toBe(real);
    expect(resolved.get(path.join(root, "gone"))).toBeNull();
    expect(resolved.get("relative/folder")).toBeNull();
    expect(resolved.get("")).toBeNull();
    expect(resolved.get("\\\\host\\share\\repo")).toBeNull();
  });
});
