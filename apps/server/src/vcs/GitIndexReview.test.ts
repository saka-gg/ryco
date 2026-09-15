import {
  WorkspaceAccessPolicyLayer,
  makeWorkspaceAccessPolicy,
} from "../workspace/Layers/WorkspaceAccessPolicy.ts";
import { WorkspaceAccessPolicy } from "../workspace/Services/WorkspaceAccessPolicy.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { ServerConfig } from "../config.ts";
import * as Driver from "./GitVcsDriver.ts";
import { readGitLocalChanges, applyGitIndexPatch } from "./GitIndexReview.ts";
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
  const read = () => readGitLocalChanges(driver.execute, { cwd });
  const apply = (
    snapshot: import("@ryco/contracts").GitLocalChangesResult,
    scope: "staged" | "unstaged",
    fileIndex = 0,
    hunkIndex?: number,
  ) =>
    applyGitIndexPatch(driver.execute, {
      cwd,
      scope,
      expectedRevision: snapshot.revision,
      fileId: snapshot[scope].files[fileIndex]!.id,
      ...(hunkIndex !== undefined ? { hunkIndex } : {}),
    });
  return { cwd, driver, git, write, commit, base, head, read, apply };
});

describe("Git index review", () => {
  it.effect("separates index from working copy and stages only the selected hunk", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const original = Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join("");
      yield* f.write("shared.txt", original);
      yield* f.commit("lines");
      const changed = original
        .replace("line 2\n", "first edit\n")
        .replace("line 25\n", "second edit\n");
      yield* f.write("shared.txt", changed);
      const initial = yield* f.read();
      expect(initial.staged.patch).toBe("");
      expect(initial.unstaged.files[0]?.hunkCount).toBe(2);
      yield* f.apply(initial, "unstaged", 0, 0);
      const staged = yield* f.read();
      expect(staged.staged.patch).toContain("+first edit");
      expect(staged.staged.patch).not.toContain("+second edit");
      expect(staged.unstaged.patch).toContain("+second edit");
      expect(staged.unstaged.patch).not.toContain("+first edit");
      yield* f.write("shared.txt", changed.replace("first edit", "later agent edit"));
      const later = yield* f.read();
      expect(later.unstaged.patch).toContain("-first edit");
      expect(later.unstaged.patch).toContain("+later agent edit");
      yield* f.apply(later, "staged", 0, 0);
      expect((yield* f.read()).staged.patch).toBe("");
      expect((yield* f.git(["diff"])).stdout).toContain("+later agent edit");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
  it.effect(
    "rejects stale worktree, index, branch, HEAD and forged selections without mutation",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.write("shared.txt", "review me\n");
        let snapshot = yield* f.read();
        const expectStale = (before: import("@ryco/contracts").GitLocalChangesResult) =>
          Effect.gen(function* () {
            const index = (yield* f.git(["write-tree"])).stdout;
            expect((yield* f.apply(before, "unstaged").pipe(Effect.flip)).detail).toContain(
              "changed",
            );
            expect((yield* f.git(["write-tree"])).stdout).toBe(index);
          });
        yield* f.write("shared.txt", "external edit\n");
        yield* expectStale(snapshot);
        snapshot = yield* f.read();
        yield* f.write("other.txt", "other\n");
        yield* f.git(["add", "other.txt"]);
        yield* expectStale(snapshot);
        snapshot = yield* f.read();
        yield* f.git(["checkout", "-b", "different-branch"]);
        yield* expectStale(snapshot);
        snapshot = yield* f.read();
        yield* f.git(["commit", "--allow-empty", "-m", "head changed"]);
        yield* expectStale(snapshot);
        const current = yield* f.read();
        yield* applyGitIndexPatch(f.driver.execute, {
          cwd: f.cwd,
          scope: "unstaged",
          expectedRevision: current.revision,
          fileId: "f".repeat(64),
        }).pipe(Effect.flip);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
  it.effect("handles untracked binary and rename pairs without changing working files", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write("new binary.dat", "hello\0binary\n");
      const binary = yield* f.read();
      expect(binary.unstaged.files[0]?.hunkAction).toBe(false);
      yield* f.apply(binary, "unstaged");
      expect((yield* f.git(["show", ":new binary.dat"])).stdout).toBe("hello\0binary\n");
      yield* f.apply(yield* f.read(), "staged");
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(`${f.cwd}/new binary.dat`);
      yield* f.git(["mv", "shared.txt", "renamed.txt"]);
      const renamed = yield* f.read();
      expect(renamed.staged.files).toHaveLength(2);
      expect(renamed.staged.files.every((file) => !file.hunkAction)).toBe(true);
      yield* f.apply(renamed, "staged");
      yield* f.apply(yield* f.read(), "staged");
      expect((yield* f.read()).staged.patch).toBe("");
      expect(yield* fs.readFileString(`${f.cwd}/renamed.txt`)).toBe("base\n");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
  it.effect("retains others' locks and detects an edit during patch preparation", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      yield* f.write("shared.txt", "changed\n");
      const snapshot = yield* f.read();
      yield* fs.writeFileString(`${f.cwd}/.git/index.lock`, "other owner");
      yield* f.apply(snapshot, "unstaged").pipe(Effect.flip);
      expect(yield* fs.readFileString(`${f.cwd}/.git/index.lock`)).toBe("other owner");
      yield* fs.remove(`${f.cwd}/.git/index.lock`);
      const execute: Driver.GitVcsDriverShape["execute"] = (input) =>
        Effect.gen(function* () {
          const result = yield* f.driver.execute(input);
          if (input.args[0] === "apply")
            yield* f.write("shared.txt", "changed during apply\n").pipe(Effect.orDie);
          return result;
        });
      yield* applyGitIndexPatch(execute, {
        cwd: f.cwd,
        scope: "unstaged",
        expectedRevision: snapshot.revision,
        fileId: snapshot.unstaged.files[0]!.id,
      }).pipe(Effect.flip);
      expect((yield* f.read()).staged.patch).toBe("");
      expect(yield* fs.exists(`${f.cwd}/.git/index.lock`)).toBe(false);
      expect(yield* fs.exists(`${f.cwd}/.git/HEAD.lock`)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
  it.effect(
    "supports split indexes, linked worktree gitdirs and byte-for-byte read-only review",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const fs = yield* FileSystem.FileSystem;
        yield* f.git(["update-index", "--split-index"]);
        yield* f.write("shared.txt", "split index edit\n");
        const before = yield* fs.readFile(`${f.cwd}/.git/index`);
        const snapshot = yield* f.read();
        expect(yield* fs.readFile(`${f.cwd}/.git/index`)).toEqual(before);
        yield* f.apply(snapshot, "unstaged");
        expect((yield* f.read()).unstaged.patch).toBe("");
        expect((yield* f.git(["show", ":shared.txt"])).stdout).toBe("split index edit\n");
        const parent = yield* fs.makeTempDirectoryScoped({ prefix: "index-linked-" });
        const linked = `${parent}/linked`;
        yield* f.git(["worktree", "add", "--detach", linked, f.base]);
        yield* fs.writeFileString(`${linked}/shared.txt`, "linked edit\n");
        const linkedSnapshot = yield* readGitLocalChanges(f.driver.execute, { cwd: linked });
        expect(linkedSnapshot.branch).toBeNull();
        yield* applyGitIndexPatch(f.driver.execute, {
          cwd: linked,
          scope: "unstaged",
          expectedRevision: linkedSnapshot.revision,
          fileId: linkedSnapshot.unstaged.files[0]!.id,
        });
        expect((yield* f.git(["show", ":shared.txt"])).stdout).toBe("split index edit\n");
        expect(
          (yield* readGitLocalChanges(f.driver.execute, { cwd: linked })).staged.patch,
        ).toContain("+linked edit");
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
  it.effect("supports sparse indexes without bringing excluded files into the working copy", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${f.cwd}/visible`);
      yield* fs.makeDirectory(`${f.cwd}/hidden`);
      yield* f.write("visible/a.txt", "visible\n");
      yield* f.write("hidden/b.txt", "hidden\n");
      yield* f.commit("directories");
      yield* f.git(["sparse-checkout", "set", "--cone", "--sparse-index", "visible"]);
      yield* f.write("visible/a.txt", "sparse edit\n");
      const before = yield* fs.readFile(`${f.cwd}/.git/index`);
      const snapshot = yield* f.read();
      expect(yield* fs.readFile(`${f.cwd}/.git/index`)).toEqual(before);
      yield* f.apply(snapshot, "unstaged");
      expect((yield* f.git(["show", ":hidden/b.txt"])).stdout).toBe("hidden\n");
      expect(yield* fs.exists(`${f.cwd}/hidden/b.txt`)).toBe(false);
      expect((yield* f.read()).staged.patch).toContain("+sparse edit");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
  it.effect(
    "stages and unstages an unborn index, preserves special paths, and rejects unsafe hunks",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.git(["checkout", "--orphan", "unborn"]);
        yield* f.git(["rm", "-rf", "."]);
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${f.cwd}/a`);
        yield* f.write('a/space " ü.txt', "new file\n");
        const snapshot = yield* f.read();
        expect(snapshot.headOid).toBeNull();
        expect(snapshot.unstaged.files[0]?.hunkAction).toBe(false);
        yield* f.apply(snapshot, "unstaged", 0, 0).pipe(Effect.flip);
        expect((yield* f.read()).staged.patch).toBe("");
        yield* f.apply(snapshot, "unstaged");
        const staged = yield* f.read();
        yield* f.apply(staged, "staged");
        expect((yield* f.read()).staged.patch).toBe("");
        expect(yield* fs.exists(`${f.cwd}/.git/index.lock`)).toBe(false);
        expect(yield* fs.exists(`${f.cwd}/.git/HEAD.lock`)).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
  it.effect("authorizes the resolved repository before reading refs or acquiring locks", () =>
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
      yield* readGitLocalChanges(execute, { cwd: allowed }).pipe(
        Effect.provideService(WorkspaceAccessPolicy, policy),
        Effect.flip,
      );
      expect(commands).toEqual([["rev-parse", "--show-toplevel"]]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
