import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  allocateWorktreeCheckoutPath,
  buildWorktreeCheckoutDirectoryName,
  initialWorktreeName,
  resolveManagedProjectDirectory,
  resolveWorktreeCheckoutPath,
  worktreeDirectorySlug,
} from "./worktreeCheckoutPaths.ts";
import { ProjectId } from "@ryco/contracts";

describe("worktree checkout paths", () => {
  it.each([
    ["feature/My PR Branch", "feature-my-pr-branch"],
    ["Fíx login 💡", "fix-login"],
    ["../../.hidden\\file", "hidden-file"],
    ["  !!!  ", "new-worktree"],
    ["a".repeat(49), "a".repeat(48)],
    ["a".repeat(47) + "-suffix", "a".repeat(47)],
  ])("normalizes %s to a bounded directory slug", (input, expected) => {
    expect(worktreeDirectorySlug(input)).toBe(expected);
    expect(buildWorktreeCheckoutDirectoryName(input, "a7c3b9d2")).toBe(`a7c3b9d2_${expected}`);
  });
  it("retries collisions and refuses to overwrite an occupied directory after eight attempts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ryco-name-collision-"));
    const occupied = path.join(root, "deadbeef_fix-login");
    await fs.mkdir(occupied);
    await fs.writeFile(path.join(occupied, "keep.txt"), "retain");
    try {
      let calls = 0;
      const createId = () => {
        calls++;
        return calls < 3 ? "deadbeef" : "cafebabe";
      };
      expect(
        await Effect.runPromise(allocateWorktreeCheckoutPath(root, "fix/login", createId)),
      ).toBe(path.join(root, "cafebabe_fix-login"));
      expect(calls).toBe(3);
      calls = 0;
      await expect(
        Effect.runPromise(
          allocateWorktreeCheckoutPath(root, "fix/login", () => {
            calls++;
            return "deadbeef";
          }),
        ),
      ).rejects.toThrow("eight attempts");
      expect(calls).toBe(8);
      expect(await fs.readFile(path.join(occupied, "keep.txt"), "utf8")).toBe("retain");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses useful titles and ignores temporary branches", () => {
    expect(initialWorktreeName("Fix login", "ryco/af8368f2")).toBe("Fix login");
    expect(initialWorktreeName("New thread", "ryco/af8368f2")).toBe("new-worktree");
    expect(initialWorktreeName(null, "fix/login")).toBe("fix/login");
    expect(initialWorktreeName("tasks/af8368f2", "tasks/af8368f2")).toBe("new-worktree");
    expect(initialWorktreeName(null, "af8368f2")).toBe("new-worktree");
    expect(initialWorktreeName("New thread", "tasks/af8368f2", "Fix login timeout")).toBe(
      "Fix login timeout",
    );
  });
  it("uses the new layout and retains the deprecated project metadata root", async () => {
    const base = {
      appWorktreesRoot: "/app/.ryco/worktrees",
      projectId: ProjectId.make("long-project-id"),
      projectTitle: "Ryco",
      workspaceRoot: "/repo",
      projectMetadataDir: ".ryco",
      branchName: "bug/fix",
    };
    expect(
      await Effect.runPromise(resolveWorktreeCheckoutPath({ ...base, location: undefined })),
    ).toMatch(/^\/app\/\.ryco\/worktrees\/[a-f0-9]{8}_ryco\/[a-f0-9]{8}_bug-fix$/);
    expect(
      await Effect.runPromise(
        resolveWorktreeCheckoutPath({ ...base, location: "projectMetadata" }),
      ),
    ).toMatch(/^\/repo\/\.ryco\/worktrees\/[a-f0-9]{8}_bug-fix$/);
  });
  it("persists the initial project name across renames and concurrent allocations", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(SqlitePersistenceMemory);
          yield* Effect.gen(function* () {
            const names = yield* Effect.all(
              [
                resolveManagedProjectDirectory("project-id", "Ryco"),
                resolveManagedProjectDirectory("project-id", "Ryco"),
              ],
              { concurrency: 2 },
            );
            expect(names[0]).toMatch(/^[a-f0-9]{8}_ryco$/);
            expect(names[1]).toBe(names[0]);
            expect(yield* resolveManagedProjectDirectory("project-id", "New name")).toBe(names[0]);
            const sql = yield* SqlClient.SqlClient;
            const paths = yield* Effect.all(
              Array.from({ length: 16 }, () =>
                resolveWorktreeCheckoutPath({
                  location: undefined,
                  appWorktreesRoot: "/tmp/ryco-naming",
                  projectId: "project-id",
                  projectTitle: "New name",
                  workspaceRoot: "/repo",
                  projectMetadataDir: null,
                  branchName: "fix/login",
                }),
              ),
              { concurrency: 4 },
            );
            expect(new Set(paths).size).toBe(16);
            expect((yield* sql`SELECT path FROM managed_worktree_paths`).length).toBe(16);
            expect(paths.every((file) => file.includes(`/${names[0]}/`))).toBe(true);
          }).pipe(Effect.provideContext(context));
        }),
      ),
    );
  });
});
