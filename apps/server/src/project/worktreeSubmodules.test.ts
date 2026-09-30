import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS, WorktreeSubmoduleRepositoryConfig } from "@ryco/contracts";
import { makeWorkspaceAccessPolicy } from "../workspace/Layers/WorkspaceAccessPolicy.ts";
import { resolveWorktreeSubmodules } from "./worktreeSubmodules.ts";

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "ryco-submodules-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const resolve = (checkoutPath = root, accessRoot?: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* resolveWorktreeSubmodules({
        checkoutPath,
        settings: DEFAULT_SERVER_SETTINGS,
        policy: yield* makeWorkspaceAccessPolicy(accessRoot),
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

describe("worktree submodule repository policy", () => {
  it("inherits when absent and ignores unrelated config keys", async () => {
    expect(await resolve()).toEqual({ mode: "recursive", source: "node" });
    await writeFile(path.join(root, "ryco.json"), '{"worktreeSubmodules":"none","other":true}');
    expect(await resolve()).toEqual({ mode: "none", source: "repository" });
  });
  it.each(["invalid", "null", '{"worktreeSubmodules":"disabled"}', '{"worktreeSubmodules":null}'])(
    "rejects malformed configuration %s",
    async (contents) => {
      await writeFile(path.join(root, "ryco.json"), contents);
      await expect(resolve()).rejects.toThrow("Fix the file");
    },
  );
  it("uses explicit project policy without reading malformed repository config", async () => {
    await writeFile(path.join(root, "ryco.json"), "invalid JSON");
    const selected = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* resolveWorktreeSubmodules({
          checkoutPath: root,
          projectId: "p",
          settings: { ...DEFAULT_SERVER_SETTINGS, projectWorktreeSubmodules: { p: "none" } },
          policy: yield* makeWorkspaceAccessPolicy(undefined),
        });
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(selected).toEqual({ mode: "none", source: "project" });
  });
  it("does not discover config in parents", async () => {
    await writeFile(path.join(root, "ryco.json"), '{"worktreeSubmodules":"none"}');
    const child = path.join(root, "child");
    await mkdir(child);
    expect(await resolve(child)).toEqual({ mode: "recursive", source: "node" });
  });
  it("bounds configuration reads", async () => {
    await writeFile(path.join(root, "ryco.json"), " ".repeat(65537));
    await expect(resolve()).rejects.toThrow("64 KiB");
  });
  it("rejects directories and external symlinks even on unrestricted nodes", async () => {
    const outside = path.join(root, "outside.json");
    await writeFile(outside, '{"worktreeSubmodules":"none"}');
    await symlink(outside, path.join(root, "ryco.json"));
    await expect(resolve()).rejects.toThrow("not a symlink");
    await rm(path.join(root, "ryco.json"));
    await mkdir(path.join(root, "ryco.json"));
    await expect(resolve()).rejects.toThrow("regular file");
  });
  it.each(["file", "symlink"])(
    "rejects descriptor replacement with a %s between inspection and opening",
    async (kind) => {
      const configPath = path.join(root, "ryco.json");
      await writeFile(configPath, '{"worktreeSubmodules":"recursive"}');
      const replacement = path.join(root, "replacement.json");
      await writeFile(replacement, '{"worktreeSubmodules":"none"}');
      await expect(
        Effect.runPromise(
          Effect.gen(function* () {
            const policy = yield* makeWorkspaceAccessPolicy(undefined);
            return yield* resolveWorktreeSubmodules({
              checkoutPath: root,
              settings: DEFAULT_SERVER_SETTINGS,
              policy: {
                ...policy,
                assertExistingPath: (input) =>
                  policy.assertExistingPath(input).pipe(
                    Effect.tap(() =>
                      input.path === configPath
                        ? Effect.tryPromise(async () => {
                            if (kind === "file") await rename(replacement, configPath);
                            else {
                              await rm(configPath);
                              await symlink(replacement, configPath);
                            }
                          }).pipe(Effect.orDie)
                        : Effect.void,
                    ),
                  ),
              },
            });
          }).pipe(Effect.provide(NodeServices.layer)),
        ),
      ).rejects.toThrow(
        kind === "file" ? "changed while opening" : "Cannot read worktree submodule configuration",
      );
    },
  );

  it("rejects unauthorized checkout roots before config discovery", async () => {
    const allowed = path.join(root, "allowed");
    await mkdir(allowed);
    await expect(resolve(root, allowed)).rejects.toThrow("restricted");
  });
  it.each(["recursive", "top-level", "none"])("decodes branch policy %s", (mode) => {
    expect(
      Schema.decodeUnknownSync(WorktreeSubmoduleRepositoryConfig)({ worktreeSubmodules: mode }),
    ).toEqual({ worktreeSubmodules: mode });
  });
});
