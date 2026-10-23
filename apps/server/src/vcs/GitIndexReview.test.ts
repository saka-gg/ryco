import {
  WorkspaceAccessPolicyLayer,
  makeWorkspaceAccessPolicy,
} from "../workspace/Layers/WorkspaceAccessPolicy.ts";
import { WorkspaceAccessPolicy } from "../workspace/Services/WorkspaceAccessPolicy.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { ServerConfig } from "../config.ts";
import * as Driver from "./GitVcsDriver.ts";
import { readGitLocalChanges, applyGitIndexPatch } from "./GitIndexReview.ts";
import {
  configureHostileDiffConfig,
  configureTestGitCommitIdentity,
} from "./testing/GitTestRepo.ts";

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
  it.effect("reads and stages the same patches whatever the repository's diff config says", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write("notes.txt", "first\n\nsecond\n\nthird\n");
      yield* f.commit("notes");
      yield* f.write("notes.txt", "first\n\nSECOND\n\nthird\n");
      yield* f.git(["add", "notes.txt"]);
      yield* f.write("notes.txt", "first\n\nSECOND\n\nthird, edited\n");
      yield* f.write("untracked.txt", "untracked\n");

      const clean = yield* f.read();
      yield* configureHostileDiffConfig(f.cwd, (_, args) => f.git(args));
      const hostile = yield* f.read();

      expect(hostile).toEqual(clean);
      expect(clean.staged.patch).toContain("diff --git a/notes.txt b/notes.txt\n");
      expect(clean.staged.patch).toContain("\n \n-second\n+SECOND\n \n");
      expect(clean.unstaged.patch).toContain("\n \n-third\n+third, edited\n");
      expect(clean.unstaged.patch).toContain("diff --git a/untracked.txt b/untracked.txt\n");
      yield* f.apply(hostile, "unstaged");
      expect((yield* f.read()).staged.patch).toContain("+third, edited");
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
  it.effect("reviews untracked files with a constant number of Git processes", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const commands: (readonly string[])[] = [];
      const execute: Driver.GitVcsDriverShape["execute"] = (input) => {
        commands.push(input.args);
        return f.driver.execute(input);
      };
      const review = () => readGitLocalChanges(execute, { cwd: f.cwd });
      yield* f.write("shared.txt", "tracked edit\n");
      yield* f.write("[glob]*.txt", "literal pathspec\n");
      yield* f.write("empty.txt", "");
      yield* f.write("script.sh", "#!/bin/sh\necho hi\n");
      yield* fs.chmod(`${f.cwd}/script.sh`, 0o755);
      yield* fs.makeDirectory(`${f.cwd}/nested`);
      yield* f.driver.execute({ operation: "test", cwd: `${f.cwd}/nested`, args: ["init"] });

      const few = yield* review();
      const fewCommands = commands.length;
      expect(commands.some((args) => args.includes("--no-index"))).toBe(false);
      expect(commands.some((args) => args[0] === "symbolic-ref")).toBe(false);
      const patch = few.unstaged.patch;
      expect(patch).toContain("diff --git a/[glob]*.txt b/[glob]*.txt\nnew file mode 100644");
      expect(patch).toContain("diff --git a/empty.txt b/empty.txt\nnew file mode 100644");
      expect(patch).toContain("diff --git a/script.sh b/script.sh\nnew file mode 100755");
      expect(patch).toContain("+tracked edit");
      // An embedded repository is listed as untracked but has no file patch.
      expect(patch).not.toContain("nested");
      expect(few.branch).toBe("refs/heads/feature");
      // The live index never sees the intent-to-add entries.
      expect((yield* f.git(["status", "--porcelain"])).stdout).toContain("?? empty.txt");

      for (let index = 0; index < 40; index += 1) yield* f.write(`more-${index}.txt`, `${index}\n`);
      commands.length = 0;
      const many = yield* review();
      expect(commands.length).toBe(fewCommands);
      expect(many.unstaged.files).toHaveLength(few.unstaged.files.length + 40);

      // Staging an untracked file from the batched review still applies cleanly.
      const scriptIndex = many.unstaged.files.findIndex((_, index) =>
        many.unstaged.patch.split(/(?=^diff --git )/m)[index]?.includes("script.sh"),
      );
      yield* f.apply(many, "unstaged", scriptIndex);
      expect((yield* f.git(["ls-files", "-s", "script.sh"])).stdout).toMatch(/^100755 /);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
  it.effect.skipIf(process.getuid?.() === 0)(
    "refuses an unreadable tracked file next to untracked ones with a review error",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const fs = yield* FileSystem.FileSystem;
        yield* f.write("shared.txt", "tracked edit\n");
        yield* fs.chmod(`${f.cwd}/shared.txt`, 0o000);
        yield* f.write("untracked.txt", "new\n");
        const failure = yield* f
          .read()
          .pipe(
            Effect.flip,
            Effect.ensuring(fs.chmod(`${f.cwd}/shared.txt`, 0o644).pipe(Effect.orDie)),
          );
        expect(failure.detail).toBe(
          "An untracked file changed or could not be read. Refresh the review.",
        );
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
  it.effect("asks Git for the branch when HEAD lives in a reftable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const driver = yield* Driver.GitVcsDriver;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-reftable-" });
      yield* driver.execute({
        operation: "test",
        cwd,
        args: ["init", "--ref-format=reftable", "-b", "trunk"],
      });
      yield* fs.writeFileString(`${cwd}/new.txt`, "new\n");
      expect(yield* fs.readFileString(`${cwd}/.git/HEAD`)).toContain("refs/heads/.invalid");
      const snapshot = yield* readGitLocalChanges(driver.execute, { cwd });
      expect(snapshot.branch).toBe("refs/heads/trunk");
      expect(snapshot.headOid).toBeNull();
      expect(snapshot.unstaged.patch).toContain("+new");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
  it.effect("falls back to per-file diffs when Git refuses the intent-to-add batch", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write("one.txt", "one\n");
      yield* f.write("two.txt", "two\n");
      const batched = yield* f.read();
      const execute: Driver.GitVcsDriverShape["execute"] = (input) =>
        input.args.includes("--intent-to-add")
          ? Effect.succeed({
              exitCode: ChildProcessSpawner.ExitCode(1),
              stdout: "",
              stderr: "refused",
              stdoutTruncated: false,
              stderrTruncated: false,
            })
          : f.driver.execute(input);
      const fallback = yield* readGitLocalChanges(execute, { cwd: f.cwd });
      expect(fallback.unstaged.patch).toBe(batched.unstaged.patch);
      expect(fallback.revision).toBe(batched.revision);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
  it.effect("does not run repository hooks while marking untracked files", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const marker = `${f.cwd}/.git/post-index-change-ran`;
      yield* f.write(".git/hooks/post-index-change", `#!/bin/sh\ntouch "${marker}"\n`);
      yield* fs.chmod(`${f.cwd}/.git/hooks/post-index-change`, 0o755);
      yield* f.write("new.txt", "new\n");
      expect((yield* f.read()).unstaged.patch).toContain("+new");
      expect(yield* fs.exists(marker)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
  it.effect("refuses an untracked file that vanishes after it was marked intent-to-add", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      yield* f.write("kept.txt", "kept\n");
      yield* f.write("transient.txt", "transient\n");
      const execute: Driver.GitVcsDriverShape["execute"] = (input) =>
        input.args.includes("--intent-to-add")
          ? f.driver
              .execute(input)
              .pipe(Effect.tap(() => fs.remove(`${f.cwd}/transient.txt`).pipe(Effect.orDie)))
          : f.driver.execute(input);
      const failure = yield* readGitLocalChanges(execute, { cwd: f.cwd }).pipe(Effect.flip);
      expect(failure.detail).toContain("An untracked file changed or could not be read");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
  it.effect("does not duplicate files Git accepted from a partially refused batch", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${f.cwd}/inside`);
      yield* fs.makeDirectory(`${f.cwd}/outside`);
      yield* f.write("inside/kept.txt", "kept\n");
      yield* f.write("outside/hidden.txt", "hidden\n");
      yield* f.commit("sparse layout");
      yield* f.git(["sparse-checkout", "set", "inside"]);
      // `git add` refuses the path outside the sparse checkout (exit 1) but still
      // records the one inside it in the disposable index.
      yield* fs.makeDirectory(`${f.cwd}/outside`, { recursive: true });
      yield* f.write("outside/new.txt", "outside\n");
      yield* f.write("inside/new.txt", "inside\n");
      const snapshot = yield* f.read();
      const headers = snapshot.unstaged.patch.match(/^diff --git .*$/gm) ?? [];
      expect(headers.toSorted()).toEqual([
        "diff --git a/inside/new.txt b/inside/new.txt",
        "diff --git a/outside/new.txt b/outside/new.txt",
      ]);
      expect(snapshot.unstaged.files).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
  it.effect("keeps a tracked file's deletion when an untracked directory replaces it", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      yield* f.write("foo", "tracked\n");
      yield* f.commit("tracked file");
      yield* fs.remove(`${f.cwd}/foo`);
      yield* fs.makeDirectory(`${f.cwd}/foo`);
      yield* f.write("foo/bar", "untracked\n");
      const snapshot = yield* f.read();
      expect(snapshot.unstaged.patch).toContain("diff --git a/foo b/foo\ndeleted file mode 100644");
      expect(snapshot.unstaged.patch).toContain("diff --git a/foo/bar b/foo/bar\nnew file mode");
      expect(snapshot.unstaged.files).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
  it.effect("keeps a tracked directory's deletions when an untracked file replaces it", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${f.cwd}/dir`);
      yield* f.write("dir/x", "tracked\n");
      yield* f.commit("tracked directory");
      yield* fs.remove(`${f.cwd}/dir`, { recursive: true });
      yield* f.write("dir", "untracked\n");
      const snapshot = yield* f.read();
      expect(snapshot.unstaged.patch).toContain(
        "diff --git a/dir/x b/dir/x\ndeleted file mode 100644",
      );
      expect(snapshot.unstaged.patch).toContain("diff --git a/dir b/dir\nnew file mode");
      expect(snapshot.unstaged.files).toHaveLength(2);
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
