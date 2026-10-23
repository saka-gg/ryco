import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer, PlatformError, Scope } from "effect";
import { describe, expect } from "vite-plus/test";

import { parseTurnDiffFilesFromUnifiedDiff } from "../Diffs.ts";
import { checkpointRefForThreadTurn, forkPinRefs } from "../Utils.ts";
import { CheckpointStoreLive } from "./CheckpointStore.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import type { VcsError } from "@ryco/contracts";
import { ServerConfig } from "../../config.ts";
import { ThreadId } from "@ryco/contracts";
import {
  configureHostileDiffConfig,
  configureTestGitCommitIdentity,
} from "../../vcs/testing/GitTestRepo.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "ryco-checkpoint-store-test-",
});
const VcsProcessTestLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const VcsDriverTestLayer = VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcessTestLayer));
const CheckpointStoreTestLayer = CheckpointStoreLive.pipe(
  Layer.provideMerge(VcsDriverTestLayer),
  Layer.provideMerge(NodeServices.layer),
);
const TestLayer = CheckpointStoreTestLayer.pipe(
  Layer.provideMerge(VcsProcessTestLayer),
  Layer.provideMerge(VcsDriverTestLayer),
  Layer.provideMerge(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);

function makeTmpDir(
  prefix = "checkpoint-store-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });
}

function writeTextFile(
  filePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(filePath, contents);
  });
}

function git(
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, VcsError, VcsProcess.VcsProcess> {
  return Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    const result = yield* process.run({
      operation: "CheckpointStore.test.git",
      command: "git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });
}

function initRepoWithCommit(
  cwd: string,
): Effect.Effect<
  void,
  VcsError | PlatformError.PlatformError,
  VcsProcess.VcsProcess | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    yield* git(cwd, ["init"]);
    yield* configureTestGitCommitIdentity(cwd, git);
    yield* writeTextFile(path.join(cwd, "README.md"), "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
  });
}

/** The tree the original capture algorithm produced: `read-tree HEAD` + `add -A` in a fresh index. */
function referenceCaptureTree(
  cwd: string,
): Effect.Effect<
  string,
  VcsError | PlatformError.PlatformError,
  VcsProcess.VcsProcess | FileSystem.FileSystem | Scope.Scope
> {
  return Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    const indexDir = yield* makeTmpDir("checkpoint-store-reference-index-");
    const env = { GIT_INDEX_FILE: path.join(indexDir, "index") };
    const run = (args: ReadonlyArray<string>) =>
      process.run({
        operation: "CheckpointStore.test.referenceTree",
        command: "git",
        cwd,
        args,
        env,
        timeoutMs: 10_000,
      });
    const head = yield* process.run({
      operation: "CheckpointStore.test.referenceTree",
      command: "git",
      cwd,
      args: ["rev-parse", "--verify", "HEAD"],
      allowNonZeroExit: true,
      timeoutMs: 10_000,
    });
    if (head.exitCode === 0) yield* run(["read-tree", "HEAD"]);
    yield* run(["add", "-A", "--", "."]);
    return (yield* run(["write-tree"])).stdout.trim();
  });
}

function checkpointTree(
  cwd: string,
  checkpointRef: string,
): Effect.Effect<string, VcsError, VcsProcess.VcsProcess> {
  return git(cwd, ["rev-parse", `${checkpointRef}^{tree}`]);
}

/** A store whose git calls first pass `hold`, to pin operations in flight. */
function checkpointStoreHoldingGit(hold: (args: ReadonlyArray<string>) => Effect.Effect<void>) {
  const registry = Layer.effect(
    VcsDriverRegistry.VcsDriverRegistry,
    Effect.gen(function* () {
      const live = yield* VcsDriverRegistry.VcsDriverRegistry;
      return {
        ...live,
        resolve: (input: Parameters<typeof live.resolve>[0]) =>
          live.resolve(input).pipe(
            Effect.map((handle) => ({
              ...handle,
              driver: {
                ...handle.driver,
                execute: (execution: Parameters<typeof handle.driver.execute>[0]) =>
                  hold(execution.args).pipe(Effect.andThen(handle.driver.execute(execution))),
              },
            })),
          ),
      };
    }),
  );
  // Fresh: the suite's layer already built (and memoized) the plain store.
  return Layer.fresh(CheckpointStoreLive).pipe(Layer.provide(registry));
}

const pause = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

function buildLargeText(lineCount = 5_000): string {
  return Array.from({ length: lineCount }, (_, index) => `line ${String(index).padStart(5, "0")}`)
    .join("\n")
    .concat("\n");
}

it.layer(TestLayer)("CheckpointStoreLive", (it) => {
  describe("hasHeadCommit", () => {
    it.effect("is true on a repository with a commit and false on an empty one", () =>
      Effect.gen(function* () {
        const checkpointStore = yield* CheckpointStore;
        const withCommit = yield* makeTmpDir();
        yield* initRepoWithCommit(withCommit);
        expect(yield* checkpointStore.hasHeadCommit(withCommit)).toBe(true);

        const empty = yield* makeTmpDir();
        yield* git(empty, ["init"]);
        expect(yield* checkpointStore.hasHeadCommit(empty)).toBe(false);
      }),
    );
  });

  describe("captureCheckpoint", () => {
    it.effect(
      "captures the reference tree from the checkout index without touching that index",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          yield* writeTextFile(path.join(tmp, "tracked.txt"), "one\n");
          yield* writeTextFile(path.join(tmp, "removed.txt"), "gone soon\n");
          yield* git(tmp, ["add", "."]);
          yield* git(tmp, ["commit", "-m", "more files"]);
          // Staged, unstaged, untracked and deleted changes at once.
          yield* writeTextFile(path.join(tmp, "tracked.txt"), "two\n");
          yield* git(tmp, ["add", "tracked.txt"]);
          yield* writeTextFile(path.join(tmp, "tracked.txt"), "three\n");
          yield* writeTextFile(path.join(tmp, "README.md"), "# changed\n");
          yield* writeTextFile(path.join(tmp, "untracked.txt"), "new\n");
          const fileSystem = yield* FileSystem.FileSystem;
          yield* fileSystem.remove(path.join(tmp, "removed.txt"));
          const statusBefore = yield* git(tmp, ["status", "--porcelain=v1"]);
          const stagedBefore = yield* git(tmp, ["diff", "--cached", "--name-status"]);

          const checkpointStore = yield* CheckpointStore;
          const checkpointRef = checkpointRefForThreadTurn(ThreadId.make("thread-seeded"), 1);
          yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });

          expect(yield* checkpointTree(tmp, checkpointRef)).toBe(yield* referenceCaptureTree(tmp));
          expect(yield* git(tmp, ["show", `${checkpointRef}:tracked.txt`])).toBe("three");
          expect(yield* git(tmp, ["status", "--porcelain=v1"])).toBe(statusBefore);
          expect(yield* git(tmp, ["diff", "--cached", "--name-status"])).toBe(stagedBefore);
        }),
    );

    it.effect(
      "sees a same-size edit made in the second the index was written",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          // Index write and edit share a second; the capture then runs in a
          // later one. Git compares whole seconds, so only the index's own
          // timestamp ("racy git") can reveal the same-size edit.
          yield* writeTextFile(path.join(tmp, "README.md"), "racy\n");
          yield* git(tmp, ["add", "README.md"]);
          yield* writeTextFile(path.join(tmp, "README.md"), "RACY\n");
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1_100)));

          const checkpointStore = yield* CheckpointStore;
          const checkpointRef = checkpointRefForThreadTurn(ThreadId.make("thread-racy"), 1);
          yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });
          expect(yield* git(tmp, ["show", `${checkpointRef}:README.md`])).toBe("RACY");
        }),
      10_000,
    );

    it.effect("records worktree content of entries marked assume-unchanged", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* git(tmp, ["update-index", "--assume-unchanged", "README.md"]);
        yield* writeTextFile(path.join(tmp, "README.md"), "# edited behind git's back\n");

        const checkpointStore = yield* CheckpointStore;
        const checkpointRef = checkpointRefForThreadTurn(ThreadId.make("thread-assume"), 1);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });

        expect(yield* git(tmp, ["show", `${checkpointRef}:README.md`])).toBe(
          "# edited behind git's back",
        );
        expect(yield* checkpointTree(tmp, checkpointRef)).toBe(yield* referenceCaptureTree(tmp));
        // The real index keeps the user's flag.
        expect(yield* git(tmp, ["ls-files", "-v", "README.md"])).toBe("h README.md");
      }),
    );

    it.effect("falls back to HEAD for checkouts with skip-worktree entries", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* writeTextFile(path.join(tmp, "README.md"), "# staged then hidden\n");
        yield* git(tmp, ["add", "README.md"]);
        yield* git(tmp, ["update-index", "--skip-worktree", "README.md"]);

        const checkpointStore = yield* CheckpointStore;
        const checkpointRef = checkpointRefForThreadTurn(ThreadId.make("thread-skip"), 1);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });

        expect(yield* checkpointTree(tmp, checkpointRef)).toBe(yield* referenceCaptureTree(tmp));
      }),
    );

    it.effect("captures inside a linked worktree and in a repository without commits", () =>
      Effect.gen(function* () {
        const repo = yield* makeTmpDir();
        yield* initRepoWithCommit(repo);
        const worktreeParent = yield* makeTmpDir("checkpoint-store-linked-");
        const worktree = path.join(worktreeParent, "linked");
        yield* git(repo, ["worktree", "add", "-b", "linked", worktree]);
        yield* writeTextFile(path.join(worktree, "README.md"), "# linked edit\n");
        yield* writeTextFile(path.join(worktree, "extra.txt"), "extra\n");

        const checkpointStore = yield* CheckpointStore;
        const linkedRef = checkpointRefForThreadTurn(ThreadId.make("thread-linked"), 1);
        yield* checkpointStore.captureCheckpoint({ cwd: worktree, checkpointRef: linkedRef });
        expect(yield* checkpointTree(worktree, linkedRef)).toBe(
          yield* referenceCaptureTree(worktree),
        );
        expect(yield* git(worktree, ["show", `${linkedRef}:README.md`])).toBe("# linked edit");

        const empty = yield* makeTmpDir();
        yield* git(empty, ["init"]);
        yield* configureTestGitCommitIdentity(empty, git);
        yield* writeTextFile(path.join(empty, "first.txt"), "first\n");
        const emptyRef = checkpointRefForThreadTurn(ThreadId.make("thread-empty"), 0);
        yield* checkpointStore.captureCheckpoint({ cwd: empty, checkpointRef: emptyRef });
        expect(yield* git(empty, ["show", `${emptyRef}:first.txt`])).toBe("first");
      }),
    );
  });

  describe("checkout access", () => {
    it.effect(
      "runs a waiting restore before captures that arrive after it",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          const firstAddReached = yield* Deferred.make<void>();
          const releaseFirstAdd = yield* Deferred.make<void>();
          let firstAddHeld = false;
          const order: Array<string> = [];
          const ref = (turn: number) =>
            checkpointRefForThreadTurn(ThreadId.make("thread-turnstile"), turn);

          yield* Effect.gen(function* () {
            const store = yield* CheckpointStore;
            const first = yield* store.captureCheckpoint({ cwd: tmp, checkpointRef: ref(1) }).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  order.push("capture-1");
                }),
              ),
              Effect.forkChild,
            );
            yield* Deferred.await(firstAddReached);
            // The restore waits for the capture in flight...
            const restore = yield* store
              .restoreCheckpoint({ cwd: tmp, checkpointRef: ref(9), fallbackToHead: true })
              .pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    order.push("restore");
                  }),
                ),
                Effect.forkChild,
              );
            yield* pause(50);
            // ...and a capture that arrives now waits behind the restore.
            const second = yield* store.captureCheckpoint({ cwd: tmp, checkpointRef: ref(2) }).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  order.push("capture-2");
                }),
              ),
              Effect.forkChild,
            );
            yield* pause(200);
            expect(order).toEqual([]);

            yield* Deferred.succeed(releaseFirstAdd, undefined);
            yield* Fiber.join(first);
            yield* Fiber.join(restore);
            yield* Fiber.join(second);
            expect(order).toEqual(["capture-1", "restore", "capture-2"]);
          }).pipe(
            Effect.provide(
              checkpointStoreHoldingGit((args) =>
                args[0] === "add" && !firstAddHeld
                  ? Effect.sync(() => {
                      firstAddHeld = true;
                    }).pipe(
                      Effect.andThen(Deferred.succeed(firstAddReached, undefined)),
                      Effect.andThen(Deferred.await(releaseFirstAdd)),
                    )
                  : Effect.void,
              ),
            ),
          );
        }),
      10_000,
    );
  });

  describe("resolveCheckpointCommits", () => {
    it.effect("resolves present refs in input order and reports missing ones as null", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-resolve");
        const first = checkpointRefForThreadTurn(threadId, 0);
        const missing = checkpointRefForThreadTurn(threadId, 7);
        const second = checkpointRefForThreadTurn(threadId, 1);

        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: first });
        yield* writeTextFile(path.join(tmp, "README.md"), "# changed\n");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: second });

        const resolved = yield* checkpointStore.resolveCheckpointCommits({
          cwd: tmp,
          checkpointRefs: [second, missing, first],
        });
        expect(resolved).toEqual([
          yield* git(tmp, ["rev-parse", second]),
          null,
          yield* git(tmp, ["rev-parse", first]),
        ]);

        const diff = yield* checkpointStore.diffCheckpointCommits({
          cwd: tmp,
          fromCommitOid: resolved[2]!,
          toCommitOid: resolved[0]!,
          ignoreWhitespace: false,
        });
        expect(diff).toContain("+# changed");
      }),
    );
  });

  describe("diffCheckpoints", () => {
    it.effect("returns full oversized checkpoint diffs without truncation", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(path.join(tmp, "README.md"), buildLargeText());
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: true,
        });

        expect(diff).toContain("diff --git");
        expect(diff).not.toContain("[truncated]");
        expect(diff).toContain("+line 04999");
      }),
    );

    it.effect("can hide indentation churn when changes wrap existing lines", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-whitespace");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        const componentPath = path.join(tmp, "Component.tsx");
        yield* writeTextFile(
          componentPath,
          [
            "export function View() {",
            "  return (",
            "    <section>",
            "      <h1>Title</h1>",
            "      <p>Body</p>",
            "    </section>",
            "  );",
            "}",
            "",
          ].join("\n"),
        );
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(
          componentPath,
          [
            "export function View() {",
            "  return (",
            "    <section>",
            "      {isReady ? (",
            "        <div>",
            "          <h1>Title</h1>",
            "          <p>Body</p>",
            "        </div>",
            "      ) : null}",
            "    </section>",
            "  );",
            "}",
            "",
          ].join("\n"),
        );
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const normalDiff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: false,
        });
        const whitespaceIgnoredDiff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: true,
        });

        expect(normalDiff).toContain("diff --git");
        expect(normalDiff).toContain("-      <h1>Title</h1>");
        expect(normalDiff).toContain("+          <h1>Title</h1>");
        expect(whitespaceIgnoredDiff).toContain("diff --git");
        expect(whitespaceIgnoredDiff).toContain("+      {isReady ? (");
        expect(whitespaceIgnoredDiff).toContain("+        <div>");
        expect(whitespaceIgnoredDiff).not.toContain("-      <h1>Title</h1>");
        expect(whitespaceIgnoredDiff).not.toContain("+          <h1>Title</h1>");
      }),
    );

    it.effect("reads the same parseable patch whatever the repository's diff config says", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const commitAll = (message: string, submoduleCommit: string) =>
          Effect.gen(function* () {
            yield* git(tmp, ["add", "-A"]);
            // A submodule without a checkout: `diff.submodule=log` prints a log
            // line in place of its patch.
            yield* git(tmp, [
              "update-index",
              "--add",
              "--cacheinfo",
              `160000,${submoduleCommit},vendor/lib`,
            ]);
            yield* git(tmp, ["commit", "-m", message]);
            return yield* git(tmp, ["rev-parse", "HEAD"]);
          });
        const sourceLines = Array.from({ length: 30 }, (_, index) => `source ${index + 1}\n`);
        yield* fileSystem.makeDirectory(path.join(tmp, "nested"));
        yield* writeTextFile(path.join(tmp, "notes.txt"), "first\n\nsecond\n\nthird\n");
        yield* writeTextFile(path.join(tmp, "source.txt"), sourceLines.join(""));
        yield* writeTextFile(path.join(tmp, "removed.txt"), "gone\n");
        yield* writeTextFile(path.join(tmp, "nested", "inner.txt"), "inner\n");
        const fromCommitOid = yield* commitAll("before", "1".repeat(40));
        yield* writeTextFile(path.join(tmp, "notes.txt"), "first\n\nSECOND\n\nthird\n");
        // A copy of a file that changed too: `diff.renames=copies` reports it
        // copied from its source, which reads as a rename.
        yield* writeTextFile(path.join(tmp, "copy.txt"), sourceLines.join(""));
        yield* writeTextFile(
          path.join(tmp, "source.txt"),
          sourceLines.with(14, "source fifteen\n").join(""),
        );
        yield* fileSystem.remove(path.join(tmp, "removed.txt"));
        yield* writeTextFile(path.join(tmp, "nested", "inner.txt"), "inner changed\n");
        const toCommitOid = yield* commitAll("after", "2".repeat(40));
        const diff = (cwd: string) =>
          checkpointStore.diffCheckpointCommits({
            cwd,
            fromCommitOid,
            toCommitOid,
            ignoreWhitespace: false,
          });

        const clean = yield* diff(tmp);
        yield* configureHostileDiffConfig(tmp, git);
        yield* git(tmp, ["config", "diff.renames", "copies"]);

        expect(yield* diff(tmp)).toBe(clean);
        // `diff.relative` would limit a read from a subdirectory to that directory.
        expect(yield* diff(path.join(tmp, "nested"))).toBe(clean);
        expect(clean).toContain("diff --git a/notes.txt b/notes.txt\n");
        expect(clean).toContain("@@ -1,5 +1,5 @@\n first\n \n-second\n+SECOND\n \n third\n");
        expect(parseTurnDiffFilesFromUnifiedDiff(clean)).toEqual([
          { path: "copy.txt", kind: "added", additions: 30, deletions: 0 },
          { path: "nested/inner.txt", kind: "modified", additions: 1, deletions: 1 },
          { path: "notes.txt", kind: "modified", additions: 1, deletions: 1 },
          { path: "removed.txt", kind: "deleted", additions: 0, deletions: 1 },
          { path: "source.txt", kind: "modified", additions: 1, deletions: 1 },
          { path: "vendor/lib", kind: "modified", additions: 1, deletions: 1 },
        ]);
      }),
    );
  });

  describe("resolveCommit and pinRef", () => {
    it.effect("resolves refs to full commit ids and refuses option-like refs", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const head = yield* git(tmp, ["rev-parse", "HEAD"]);

        expect(yield* checkpointStore.resolveCommit({ cwd: tmp, ref: "HEAD" })).toBe(head);
        expect(yield* checkpointStore.resolveCommit({ cwd: tmp, ref: head.slice(0, 10) })).toBe(
          head,
        );
        expect(yield* checkpointStore.resolveCommit({ cwd: tmp, ref: "no-such-branch" })).toBe(
          null,
        );
        expect(yield* checkpointStore.resolveCommit({ cwd: tmp, ref: "--all" })).toBe(null);
        expect(yield* checkpointStore.resolveCommit({ cwd: tmp, ref: "HEAD\n--all" })).toBe(null);
        // A tree is not a commit.
        expect(yield* checkpointStore.resolveCommit({ cwd: tmp, ref: "HEAD^{tree}" })).toBe(null);
      }),
    );

    it.effect("pins a commit under a fork-owned ref until the ref is deleted", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-pin-source");
        const checkpointRef = checkpointRefForThreadTurn(threadId, 1);
        yield* writeTextFile(path.join(tmp, "work.txt"), "turn one\n");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });
        const commit = yield* checkpointStore.resolveCommit({ cwd: tmp, ref: checkpointRef });
        expect(commit).toMatch(/^[0-9a-f]{40}$/);

        const pins = forkPinRefs(ThreadId.make("fork-0123456789abcdef0123456789abcdef"));
        expect(pins.checkpoint.startsWith("refs/ryco/forks/")).toBe(true);
        yield* checkpointStore.pinRef({ cwd: tmp, ref: pins.checkpoint, commit: commit! });
        yield* checkpointStore.pinRef({ cwd: tmp, ref: pins.checkpoint, commit: commit! });
        // The source's ref going away (a revert) leaves the pin.
        yield* checkpointStore.deleteCheckpointRefs({ cwd: tmp, checkpointRefs: [checkpointRef] });
        expect(yield* checkpointStore.resolveCommit({ cwd: tmp, ref: pins.checkpoint })).toBe(
          commit,
        );

        yield* checkpointStore.deleteCheckpointRefs({
          cwd: tmp,
          checkpointRefs: [pins.checkpoint],
        });
        expect(yield* checkpointStore.resolveCommit({ cwd: tmp, ref: pins.checkpoint })).toBe(null);
      }),
    );

    it.effect("refuses refs outside Ryco's namespace and abbreviated commits", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const head = yield* git(tmp, ["rev-parse", "HEAD"]);
        const outside = yield* Effect.exit(
          checkpointStore.pinRef({
            cwd: tmp,
            ref: checkpointRefForThreadTurn(ThreadId.make("t"), 0).replace(
              "refs/ryco/",
              "refs/heads/",
            ) as never,
            commit: head,
          }),
        );
        expect(outside._tag).toBe("Failure");
        const abbreviated = yield* Effect.exit(
          checkpointStore.pinRef({
            cwd: tmp,
            ref: forkPinRefs(ThreadId.make("fork-x")).base,
            commit: head.slice(0, 12),
          }),
        );
        expect(abbreviated._tag).toBe("Failure");
        expect(yield* git(tmp, ["for-each-ref", "refs/heads/ryco"])).toBe("");
      }),
    );

    it.effect("materializes a pinned checkpoint over its base commit in a new worktree", () =>
      Effect.gen(function* () {
        const source = yield* makeTmpDir();
        yield* initRepoWithCommit(source);
        const checkpointStore = yield* CheckpointStore;
        yield* writeTextFile(path.join(source, ".gitignore"), "ignored.txt\n");
        yield* git(source, ["add", ".gitignore"]);
        yield* git(source, ["commit", "-m", "ignore"]);
        yield* writeTextFile(path.join(source, "README.md"), "# changed by the turn\n");
        yield* writeTextFile(path.join(source, "untracked.txt"), "new file\n");
        yield* writeTextFile(path.join(source, "ignored.txt"), "secret\n");
        const checkpointRef = checkpointRefForThreadTurn(ThreadId.make("thread-overlay"), 1);
        yield* checkpointStore.captureCheckpoint({ cwd: source, checkpointRef });

        const pins = forkPinRefs(ThreadId.make("fork-overlay"));
        const base = (yield* checkpointStore.resolveCommit({ cwd: source, ref: "HEAD" }))!;
        const snapshot = (yield* checkpointStore.resolveCommit({
          cwd: source,
          ref: checkpointRef,
        }))!;
        yield* checkpointStore.pinRef({ cwd: source, ref: pins.base, commit: base });
        yield* checkpointStore.pinRef({ cwd: source, ref: pins.checkpoint, commit: snapshot });

        const worktree = path.join(yield* makeTmpDir("checkpoint-store-fork-"), "fork");
        yield* git(source, ["worktree", "add", "-b", "ryco/fork-test", worktree, base]);
        expect(
          yield* checkpointStore.restoreCheckpoint({
            cwd: worktree,
            checkpointRef: pins.checkpoint,
          }),
        ).toBe(true);

        const fileSystem = yield* FileSystem.FileSystem;
        expect(yield* fileSystem.readFileString(path.join(worktree, "README.md"))).toBe(
          "# changed by the turn\n",
        );
        expect(yield* fileSystem.readFileString(path.join(worktree, "untracked.txt"))).toBe(
          "new file\n",
        );
        expect(yield* fileSystem.exists(path.join(worktree, "ignored.txt"))).toBe(false);
        // HEAD stays on the base commit; the turn's work shows as uncommitted changes.
        expect(yield* git(worktree, ["rev-parse", "HEAD"])).toBe(base);
        expect(yield* git(worktree, ["status", "--porcelain"])).toContain("README.md");
        // The source checkout is untouched.
        expect(yield* fileSystem.readFileString(path.join(source, "ignored.txt"))).toBe("secret\n");
        yield* git(source, ["worktree", "remove", "--force", worktree]);
      }),
    );
  });
});
