import { chmod, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS } from "@ryco/contracts";

import { makeWorkspaceAccessPolicy } from "../workspace/Layers/WorkspaceAccessPolicy.ts";
import { resolveConfiguredWorktreeRoot, validateWorktreeRoot } from "./worktreeRoot.ts";

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "ryco-root-test-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const validate = (value: string, accessRoot?: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const policy = yield* makeWorkspaceAccessPolicy(accessRoot);
      return yield* validateWorktreeRoot(value, policy);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

describe("worktree root policy", () => {
  it("canonicalizes aliases and missing descendants without creating directories", async () => {
    await mkdir(path.join(root, "real"));
    await symlink(path.join(root, "real"), path.join(root, "alias"));
    expect(await validate(path.join(root, "alias", "new", "checkouts"))).toBe(
      path.join(root, "real", "new", "checkouts"),
    );
    await expect(lstat(path.join(root, "real", "new"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await validate(`~/${path.relative(homedir(), root)}`)).toBe(root);
  });
  it.each([
    "relative/root",
    "",
    "~someone/worktrees",
    "C:relative",
    "bad\u0000path",
    "/tmp/bad\npath",
  ])("rejects ambiguous or invalid path %j", async (candidate) => {
    await expect(validate(candidate)).rejects.toThrow("absolute directory");
  });
  it("rejects files and dangling symlinks, including missing children beneath them", async () => {
    const file = path.join(root, "file");
    const broken = path.join(root, "broken");
    await writeFile(file, "keep");
    await symlink(path.join(root, "missing"), broken);
    for (const candidate of [file, path.join(file, "child"), broken, path.join(broken, "child")]) {
      await expect(validate(candidate)).rejects.toThrow("writable directory");
    }
  });
  it("rejects out-of-root destinations and symlink escapes without broadening access", async () => {
    const allowed = path.join(root, "allowed");
    const outside = path.join(root, "outside");
    await mkdir(allowed);
    await mkdir(outside);
    await symlink(outside, path.join(allowed, "escape"));
    for (const candidate of [outside, `${allowed}-sibling`, path.join(allowed, "escape", "new")]) {
      await expect(validate(candidate, allowed)).rejects.toThrow("restricted");
    }
    expect(await validate(path.join(allowed, "new"), allowed)).toBe(path.join(allowed, "new"));
  });
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "rejects unwritable roots and ancestors",
    async () => {
      const locked = path.join(root, "locked");
      await mkdir(locked);
      await chmod(locked, 0o500);
      try {
        await expect(validate(locked)).rejects.toThrow("writable directory");
        await expect(validate(path.join(locked, "missing"))).rejects.toThrow("writable directory");
      } finally {
        await chmod(locked, 0o700);
      }
    },
  );
  it("resolves project override, inheritance, resets and restricted managed defaults", async () => {
    const policy = await Effect.runPromise(
      makeWorkspaceAccessPolicy(root).pipe(Effect.provide(NodeServices.layer)),
    );
    const config = { worktreesDir: path.join(root, "managed"), workspaceAccessRoot: root };
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      worktreeRoot: path.join(root, "environment"),
      projectWorktreeRoots: { a: path.join(root, "project") },
    };
    const resolve = (next: typeof DEFAULT_SERVER_SETTINGS, projectId?: string) =>
      Effect.runPromise(
        resolveConfiguredWorktreeRoot({ settings: next, projectId, config, policy }),
      );
    expect(await resolve(settings, "a")).toBe(path.join(root, "project"));
    expect(await resolve(settings, "b")).toBe(path.join(root, "environment"));
    expect(await resolve(settings, "constructor")).toBe(path.join(root, "environment"));
    expect(await resolve({ ...settings, projectWorktreeRoots: {} }, "a")).toBe(
      path.join(root, "environment"),
    );
    expect(await resolve(DEFAULT_SERVER_SETTINGS)).toBe(path.join(root, ".ryco", "worktrees"));
  });
});
