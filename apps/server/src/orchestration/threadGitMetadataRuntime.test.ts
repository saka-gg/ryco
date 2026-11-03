import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { locateCheckoutHead } from "./threadGitMetadataRuntime.ts";

let root: string | null = null;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

/** A repository whose HEAD is on `main`, with a plain folder inside it. */
async function repositoryWithFolder() {
  root = await mkdtemp(path.join(tmpdir(), "ryco-checkout-head-"));
  await mkdir(path.join(root, ".git"), { recursive: true });
  await writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  const folder = path.join(root, "worktrees", "feature");
  await mkdir(folder, { recursive: true });
  return { root, folder };
}

describe("locateCheckoutHead", () => {
  it("reads the enclosing repository for a project rooted in its subfolder", async () => {
    const { folder } = await repositoryWithFolder();
    const location = await Effect.runPromise(locateCheckoutHead(folder));
    expect(location).toMatchObject({ _tag: "head", branch: "main" });
  });

  it("reads no repository above a worktree checkout that lost its own .git", async () => {
    const { folder } = await repositoryWithFolder();
    const location = await Effect.runPromise(locateCheckoutHead(folder, { ownGitOnly: true }));
    expect(location).toEqual({ _tag: "none" });
  });
});
