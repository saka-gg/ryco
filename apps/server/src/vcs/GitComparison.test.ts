import {
  WorkspaceAccessPolicyLayer,
  makeWorkspaceAccessPolicy,
} from "../workspace/Layers/WorkspaceAccessPolicy.ts";
import { WorkspaceAccessPolicy } from "../workspace/Services/WorkspaceAccessPolicy.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option } from "effect";
import { ServerConfig } from "../config.ts";
import * as Driver from "./GitVcsDriver.ts";
import { readGitComparison } from "./GitComparison.ts";
import { configureTestGitCommitIdentity } from "./testing/GitTestRepo.ts";

const testLayer = Driver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "comparison-test-" })),
  Layer.provideMerge(WorkspaceAccessPolicyLayer(undefined)),
  Layer.provideMerge(NodeServices.layer),
);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-comparison-" });
  const driver = yield* Driver.GitVcsDriver;
  const git = (args: readonly string[]) => driver.execute({ operation: "test", cwd, args });
  yield* git(["init", "-b", "main"]);
  yield* configureTestGitCommitIdentity(cwd, (_, args) => git(args));
  const write = (name: string, contents: string) => fs.writeFileString(`${cwd}/${name}`, contents);
  const commit = (message: string) =>
    git(["add", "."]).pipe(Effect.andThen(git(["commit", "-m", message])));
  yield* write("shared.txt", "base\n");
  yield* commit("base");
  const base = (yield* git(["rev-parse", "HEAD"])).stdout.trim();
  yield* git(["checkout", "-b", "feature"]);
  yield* write("feature.txt", "feature\n");
  yield* commit("feature");
  const head = (yield* git(["rev-parse", "HEAD"])).stdout.trim();
  yield* git(["checkout", "main"]);
  yield* write("main.txt", "main\n");
  yield* commit("main diverged");
  yield* git(["checkout", "feature"]);
  return { cwd, driver, git, write, commit, base, head };
});

describe("Git comparison", () => {
  it.effect("denies an authorized subdirectory whose repository root is outside policy", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const allowed = `${f.cwd}/allowed`;
      yield* fs.makeDirectory(allowed);
      const policy = yield* makeWorkspaceAccessPolicy(allowed);
      const commands: (readonly string[])[] = [];
      const execute: Driver.GitVcsDriverShape["execute"] = (input) => {
        commands.push(input.args);
        return f.driver.execute(input);
      };
      const input = {
        cwd: allowed,
        selection: { ref: "main", mode: "direct" as const },
        ignoreWhitespace: false,
      };
      const denied = yield* readGitComparison(execute, input).pipe(
        Effect.provideService(WorkspaceAccessPolicy, policy),
        Effect.flip,
      );
      expect(denied.detail).toContain("access is restricted");
      expect(commands).toEqual([["rev-parse", "--show-toplevel"]]);
      commands.length = 0;
      yield* readGitComparison(execute, { ...input, cwd: f.cwd }).pipe(
        Effect.provideService(WorkspaceAccessPolicy, policy),
        Effect.flip,
      );
      expect(commands).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
  it.effect("distinguishes merge-base from direct endpoints and excludes all local changes", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const read = (mode: "mergeBase" | "direct") =>
        readGitComparison(f.driver.execute, {
          cwd: f.cwd,
          selection: { ref: "main", mode },
          ignoreWhitespace: false,
        });
      const branch = yield* read("mergeBase");
      expect(branch.source.baseOid).toBe(f.base);
      expect(branch.source.headOid).toBe(f.head);
      expect(branch.patch).toContain("+feature");
      expect(branch.patch).not.toContain("main.txt");
      const direct = yield* read("direct");
      expect(direct.patch).toContain("-main");
      expect(direct.source.revision).not.toBe(branch.source.revision);
      yield* f.write("shared.txt", "staged\n");
      yield* f.git(["add", "shared.txt"]);
      yield* f.write("shared.txt", "unstaged\n");
      yield* f.write("untracked.txt", "untracked\n");
      const before = (yield* f.git(["status", "--porcelain=v1"])).stdout;
      expect(yield* read("mergeBase")).toEqual(branch);
      expect((yield* f.git(["status", "--porcelain=v1"])).stdout).toBe(before);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "resolves tags and commit IDs, changes revision for moved refs, rejects deleted/ambiguous refs",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const read = (ref: string) =>
          readGitComparison(f.driver.execute, {
            cwd: f.cwd,
            selection: { ref, mode: "direct" },
            ignoreWhitespace: false,
          });
        yield* f.git(["tag", "v1", f.base]);
        expect((yield* read("v1")).source.baseOid).toBe(f.base);
        expect((yield* read(f.base)).source.baseOid).toBe(f.base);
        const before = yield* read("main");
        yield* f.git(["branch", "-f", "main", f.base]);
        expect((yield* read("main")).source.revision).not.toBe(before.source.revision);
        yield* f.git(["tag", "main", f.head]);
        expect(Option.isSome(yield* read("main").pipe(Effect.flip, Effect.option))).toBe(true);
        yield* f.git(["tag", "-d", "main"]);
        yield* f.git(["branch", "-D", "main"]);
        expect(Option.isSome(yield* read("main").pipe(Effect.flip, Effect.option))).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("rejects input before execution and fails when HEAD moves during a read", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      let calls = 0;
      const invalid = readGitComparison(
        (input) => {
          calls++;
          return f.driver.execute(input);
        },
        {
          cwd: f.cwd,
          selection: { ref: "--output=/tmp/file", mode: "direct" },
          ignoreWhitespace: false,
        },
      );
      yield* invalid.pipe(Effect.flip);
      expect(calls).toBe(0);
      let moved = false;
      const moving: Driver.GitVcsDriverShape["execute"] = (input) =>
        Effect.gen(function* () {
          const result = yield* f.driver.execute(input);
          if (input.args[0] === "diff" && !moved) {
            moved = true;
            yield* f.git(["checkout", "--detach", f.base]);
          }
          return result;
        });
      const error = yield* readGitComparison(moving, {
        cwd: f.cwd,
        selection: { ref: "main", mode: "direct" },
        ignoreWhitespace: false,
      }).pipe(Effect.flip);
      expect(error.detail).toContain("changed during comparison");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
  it.effect("handles detached HEAD, unrelated history, linked worktrees, and bounded output", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const read = (cwd: string, ref: string, mode: "direct" | "mergeBase" = "direct") =>
        readGitComparison(f.driver.execute, {
          cwd,
          selection: { ref, mode },
          ignoreWhitespace: false,
        });
      yield* f.git(["checkout", "--detach", f.head]);
      expect((yield* read(f.cwd, f.base)).source.headOid).toBe(f.head);
      yield* f.git(["update-ref", "refs/remotes/origin/main", f.base]);
      expect((yield* read(f.cwd, "origin/main")).source.baseOid).toBe(f.base);
      const fs = yield* FileSystem.FileSystem;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "comparison-linked-" });
      const linked = `${parent}/linked`;
      yield* f.git(["worktree", "add", "--detach", linked, f.base]);
      const a = yield* read(f.cwd, f.base);
      const b = yield* read(linked, f.base);
      expect(a.source.repositoryPath).toBe(b.source.repositoryPath);
      expect(a.source.worktreePath).not.toBe(b.source.worktreePath);
      expect(a.source.revision).not.toBe(b.source.revision);
      yield* f.git(["checkout", "--orphan", "unborn"]);
      yield* read(f.cwd, f.base).pipe(Effect.flip);
      yield* f.git(["rm", "-rf", "."]);
      yield* f.write("unrelated.txt", "unrelated\n");
      yield* f.commit("unrelated");
      expect((yield* read(f.cwd, f.base, "mergeBase").pipe(Effect.flip)).detail).toContain(
        "No merge-base",
      );
      expect((yield* read(f.cwd, f.base)).patch).toContain("unrelated.txt");
      yield* f.write("large.txt", "x".repeat(2_000_100));
      yield* f.commit("large");
      yield* read(f.cwd, f.base).pipe(Effect.flip);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
