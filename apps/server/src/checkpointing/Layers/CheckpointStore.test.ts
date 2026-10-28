import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer, PlatformError, Schema, Scope } from "effect";
import { describe, expect } from "vite-plus/test";

import { parseTurnDiffFilesFromUnifiedDiff } from "../Diffs.ts";
import { checkpointRefForThreadTurn, forkPinRefs } from "../Utils.ts";
import {
  CheckpointStoreLive,
  captureRetryDelayMs,
  makeCheckpointStoreLayer,
  type CheckpointStoreOptions,
} from "./CheckpointStore.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import { gitSubcommand } from "../../vcs/GitDurableWrites.ts";
import type { VcsDriverShape } from "../../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { VcsProcessExitError, VcsProcessTimeoutError, type VcsError } from "@ryco/contracts";
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

type GitExecution = Parameters<VcsDriverShape["execute"]>[0];
type GitRun = (execution: GitExecution) => Effect.Effect<VcsProcess.VcsProcessOutput, VcsError>;

/**
 * A store whose git calls go through `wrap`, which may hold, record, fail or
 * rewrite them; `run` is the real git.
 */
function checkpointStoreWithGit(
  wrap: (
    execution: GitExecution,
    run: GitRun,
  ) => Effect.Effect<VcsProcess.VcsProcessOutput, VcsError>,
  options?: CheckpointStoreOptions,
) {
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
                execute: (execution: GitExecution) => wrap(execution, handle.driver.execute),
              },
            })),
          ),
      };
    }),
  );
  // Fresh: the suite's layer already built (and memoized) the plain store.
  return Layer.fresh(makeCheckpointStoreLayer(options)).pipe(Layer.provide(registry));
}

/** Records every git call of a store, then runs it. */
function recordingCheckpointStore(options?: CheckpointStoreOptions) {
  const executions: Array<GitExecution> = [];
  const layer = checkpointStoreWithGit((execution, run) => {
    executions.push(execution);
    return run(execution);
  }, options);
  return { executions, layer };
}

/** A failure git could have answered `execution` with. */
const gitExitFailure = (execution: GitExecution, detail: string) =>
  new VcsProcessExitError({
    operation: execution.operation,
    command: `git ${execution.args.join(" ")}`,
    cwd: execution.cwd,
    exitCode: 128,
    detail,
  });

/** The stderr detail of a failed git command; undefined for any other failure. */
const exitDetail = (error: unknown) =>
  Schema.is(VcsProcessExitError)(error) ? error.detail : undefined;

/** `-c` values passed ahead of the subcommand. */
const gitConfigValues = (args: ReadonlyArray<string>) =>
  args.filter((_, index) => args[index - 1] === "-c");

/** Files-backend repository (reftable reports lock contention differently). */
function initFilesRepoWithCommit(
  cwd: string,
): Effect.Effect<
  void,
  VcsError | PlatformError.PlatformError,
  VcsProcess.VcsProcess | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    // Git before 2.45 knows no `--ref-format` and only the files backend.
    const initialized = yield* process.run({
      operation: "CheckpointStore.test.git",
      command: "git",
      cwd,
      args: ["init", "--ref-format=files"],
      allowNonZeroExit: true,
      timeoutMs: 10_000,
    });
    if (initialized.exitCode !== 0) yield* git(cwd, ["init"]);
    yield* configureTestGitCommitIdentity(cwd, git);
    yield* writeTextFile(path.join(cwd, "README.md"), "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
  });
}

/** Paths and modes of a commit's tree, recursively. */
function treeEntries(
  cwd: string,
  ref: string,
): Effect.Effect<ReadonlyArray<string>, VcsError, VcsProcess.VcsProcess> {
  return git(cwd, ["ls-tree", "-r", ref]).pipe(
    Effect.map((listing) =>
      listing
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => {
          const [meta = "", name = ""] = line.split("\t");
          return `${meta.split(" ")[0]} ${name}`;
        }),
    ),
  );
}

/** Makes `repo` an embedded repository with one commit. */
function initEmbeddedRepoWithCommit(
  repo: string,
): Effect.Effect<
  void,
  VcsError | PlatformError.PlatformError,
  VcsProcess.VcsProcess | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.makeDirectory(repo, { recursive: true });
    yield* git(repo, ["init"]);
    yield* configureTestGitCommitIdentity(repo, git);
    yield* writeTextFile(path.join(repo, "inner.txt"), "inner\n");
    yield* git(repo, ["add", "."]);
    yield* git(repo, ["commit", "-m", "embedded"]);
  });
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

  describe("captureCheckpoint with embedded repositories", () => {
    it.effect(
      "captures a workspace that contains empty nested repositories",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          // `git add -A` refuses an embedded repository whose HEAD has no commit.
          yield* git(tmp, ["init", "sub"]);
          yield* git(tmp, ["init", path.join("pkg", "inner")]);
          yield* initEmbeddedRepoWithCommit(path.join(tmp, "withcommit"));
          yield* writeTextFile(path.join(tmp, "new.txt"), "new\n");
          yield* writeTextFile(path.join(tmp, "pkg", "file.txt"), "package\n");
          const statusBefore = yield* git(tmp, ["status", "--porcelain=v1"]);
          const indexBefore = yield* git(tmp, ["ls-files", "--stage"]);

          const checkpointStore = yield* CheckpointStore;
          const checkpointRef = checkpointRefForThreadTurn(ThreadId.make("thread-nested"), 1);
          yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });

          expect(yield* treeEntries(tmp, checkpointRef)).toEqual([
            "100644 README.md",
            "100644 new.txt",
            "100644 pkg/file.txt",
            // An embedded repository with a commit stays a gitlink.
            "160000 withcommit",
          ]);
          expect(yield* git(tmp, ["status", "--porcelain=v1"])).toBe(statusBefore);
          expect(yield* git(tmp, ["ls-files", "--stage"])).toBe(indexBefore);
        }),
      20_000,
    );

    it.effect(
      "excludes nested repositories relative to a workspace below the repository root",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          yield* git(tmp, ["init", path.join("pkg", "inner")]);
          yield* writeTextFile(path.join(tmp, "pkg", "file.txt"), "package\n");

          const checkpointStore = yield* CheckpointStore;
          const checkpointRef = checkpointRefForThreadTurn(ThreadId.make("thread-nested-sub"), 1);
          yield* checkpointStore.captureCheckpoint({ cwd: path.join(tmp, "pkg"), checkpointRef });

          expect(yield* treeEntries(tmp, checkpointRef)).toEqual([
            "100644 README.md",
            "100644 pkg/file.txt",
          ]);
        }),
      20_000,
    );

    it.effect(
      "finds the empty nested repository among more than 64 that have commits",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          const seed = yield* makeTmpDir("checkpoint-store-embedded-seed-");
          yield* initEmbeddedRepoWithCommit(seed);
          // Copies of one repository: each has a commit, so each stays a gitlink.
          const clones = Array.from({ length: 70 }, (_, index) => `clone${index}`);
          yield* Effect.forEach(clones, (clone) =>
            fileSystem
              .makeDirectory(path.join(tmp, clone))
              .pipe(
                Effect.andThen(
                  fileSystem.copy(path.join(seed, ".git"), path.join(tmp, clone, ".git")),
                ),
              ),
          );
          yield* git(tmp, ["init", "empty"]);

          const checkpointStore = yield* CheckpointStore;
          const checkpointRef = checkpointRefForThreadTurn(ThreadId.make("thread-nested-many"), 1);
          yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });

          const entries = yield* treeEntries(tmp, checkpointRef);
          expect(entries.filter((entry) => entry.startsWith("160000 "))).toHaveLength(70);
          expect(entries.some((entry) => entry.includes("empty"))).toBe(false);
        }),
      30_000,
    );

    it.effect(
      "keeps embedded repositories whose probe gives no clear answer",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          yield* git(tmp, ["init", "empty"]);
          yield* initEmbeddedRepoWithCommit(path.join(tmp, "owned"));
          yield* initEmbeddedRepoWithCommit(path.join(tmp, "slow"));
          const isProbeOf = (execution: GitExecution, name: string) =>
            gitSubcommand(execution.args) === "rev-parse" && execution.cwd === path.join(tmp, name);
          let ownedProbeExit: number | undefined;
          const store = checkpointStoreWithGit(
            (execution, run) => {
              if (isProbeOf(execution, "owned")) {
                // Git refuses to open a repository another user owns; `add` does not check.
                // A global or system `safe.directory` (CI runners set `*`) lifts that refusal,
                // so the probe reads neither.
                return run({
                  ...execution,
                  env: {
                    ...execution.env,
                    GIT_TEST_ASSUME_DIFFERENT_OWNER: "1",
                    GIT_CONFIG_GLOBAL: "/dev/null",
                    GIT_CONFIG_NOSYSTEM: "1",
                  },
                }).pipe(
                  Effect.tap((result) =>
                    Effect.sync(() => {
                      ownedProbeExit = result.exitCode;
                    }),
                  ),
                );
              }
              if (isProbeOf(execution, "slow")) {
                return Effect.fail(
                  new VcsProcessTimeoutError({
                    operation: execution.operation,
                    command: "git rev-parse",
                    cwd: execution.cwd,
                    timeoutMs: 2_000,
                  }),
                );
              }
              return run(execution);
            },
            { captureRetryBaseDelayMs: 0 },
          );
          const checkpointRef = checkpointRefForThreadTurn(
            ThreadId.make("thread-nested-unclear"),
            1,
          );

          yield* Effect.gen(function* () {
            const checkpointStore = yield* CheckpointStore;
            yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });
          }).pipe(Effect.provide(store));

          expect(ownedProbeExit).toBe(128);
          expect(yield* treeEntries(tmp, checkpointRef)).toEqual([
            "100644 README.md",
            "160000 owned",
            "160000 slow",
          ]);
        }),
      20_000,
    );

    it.effect(
      "runs no command an embedded repository's config names and keeps it when its HEAD resolves",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          yield* git(tmp, ["init", "empty"]);
          // A partial clone without its HEAD commit: reading that commit makes
          // git fetch it from the promisor remote, which runs the `uploadpack`
          // command the repository's own config names.
          const outside = yield* makeTmpDir("checkpoint-store-outside-");
          const marker = path.join(outside, "marker");
          const promisorGitDir = path.join(tmp, "promisor", ".git");
          yield* fileSystem.makeDirectory(path.join(promisorGitDir, "objects"), {
            recursive: true,
          });
          yield* fileSystem.makeDirectory(path.join(promisorGitDir, "refs", "heads"), {
            recursive: true,
          });
          yield* writeTextFile(path.join(promisorGitDir, "HEAD"), `${"1".repeat(40)}\n`);
          const configFile = path.join(promisorGitDir, "config");
          yield* writeTextFile(configFile, "");
          for (const [key, value] of [
            ["core.repositoryformatversion", "1"],
            ["extensions.partialClone", "origin"],
            ["remote.origin.url", outside],
            ["remote.origin.promisor", "true"],
            ["remote.origin.uploadpack", `touch '${marker}'; false`],
          ] as const) {
            yield* git(tmp, ["config", "--file", configFile, key, value]);
          }

          const checkpointStore = yield* CheckpointStore;
          const checkpointRef = checkpointRefForThreadTurn(
            ThreadId.make("thread-nested-promisor"),
            1,
          );
          yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });

          expect(yield* fileSystem.exists(marker)).toBe(false);
          // `add` records it as a gitlink, whether or not its HEAD commit is present.
          expect(yield* treeEntries(tmp, checkpointRef)).toEqual([
            "100644 README.md",
            "160000 promisor",
          ]);
        }),
      20_000,
    );

    it.effect(
      "gives up nested recovery when more than 64 nested repositories have no commit",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          for (let index = 0; index < 65; index++) {
            yield* git(tmp, ["init", `empty${index}`]);
          }

          const checkpointStore = yield* CheckpointStore;
          const checkpointRef = checkpointRefForThreadTurn(ThreadId.make("thread-nested-cap"), 1);
          const error = yield* Effect.flip(
            checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef }),
          );

          expect(error._tag).toBe("VcsProcessExitError");
          expect(exitDetail(error)).toContain("does not have a commit checked out");
          expect(yield* checkpointStore.hasCheckpointRef({ cwd: tmp, checkpointRef })).toBe(false);
        }),
      30_000,
    );

    it.effect("does not search for nested repositories after other add failures", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const subcommands: Array<string> = [];
        let listedOthers = false;
        const store = checkpointStoreWithGit(
          (execution, run) => {
            const subcommand = gitSubcommand(execution.args) ?? "";
            subcommands.push(subcommand);
            if (subcommand === "ls-files" && execution.args.includes("--others")) {
              listedOthers = true;
            }
            return subcommand === "add"
              ? Effect.fail(
                  gitExitFailure(execution, "fatal: pathspec 'x' did not match any files"),
                )
              : run(execution);
          },
          { captureRetryBaseDelayMs: 0 },
        );

        const error = yield* Effect.flip(
          Effect.gen(function* () {
            const checkpointStore = yield* CheckpointStore;
            yield* checkpointStore.captureCheckpoint({
              cwd: tmp,
              checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-add-fails"), 1),
            });
          }).pipe(Effect.provide(store)),
        );

        expect(exitDetail(error)).toBe("fatal: pathspec 'x' did not match any files");
        expect(subcommands.filter((subcommand) => subcommand === "add")).toHaveLength(1);
        expect(listedOthers).toBe(false);
      }),
    );
  });

  describe("captureCheckpoint retries", () => {
    it.effect(
      "retries update-ref while another process holds the ref lock",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const tmp = yield* makeTmpDir();
          yield* initFilesRepoWithCommit(tmp);
          const checkpointRef = checkpointRefForThreadTurn(ThreadId.make("thread-lock"), 1);
          const lockPath = path.join(tmp, ".git", `${checkpointRef}.lock`);
          yield* fileSystem.makeDirectory(path.dirname(lockPath), { recursive: true });
          yield* writeTextFile(lockPath, "");
          let updateRefs = 0;
          const store = checkpointStoreWithGit(
            (execution, run) => {
              if (gitSubcommand(execution.args) !== "update-ref") return run(execution);
              updateRefs += 1;
              // The other process lets go just before the second attempt.
              return updateRefs === 2
                ? fileSystem.remove(lockPath).pipe(Effect.orDie, Effect.andThen(run(execution)))
                : run(execution);
            },
            { captureRetryBaseDelayMs: 0 },
          );

          yield* Effect.gen(function* () {
            const checkpointStore = yield* CheckpointStore;
            yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });
            expect(yield* checkpointStore.hasCheckpointRef({ cwd: tmp, checkpointRef })).toBe(true);
          }).pipe(Effect.provide(store));
          expect(updateRefs).toBe(2);
        }),
      10_000,
    );

    it.effect(
      "fails after two retries when the ref lock never clears",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const tmp = yield* makeTmpDir();
          yield* initFilesRepoWithCommit(tmp);
          const checkpointRef = checkpointRefForThreadTurn(ThreadId.make("thread-lock-held"), 1);
          const lockPath = path.join(tmp, ".git", `${checkpointRef}.lock`);
          yield* fileSystem.makeDirectory(path.dirname(lockPath), { recursive: true });
          yield* writeTextFile(lockPath, "");
          let updateRefs = 0;
          const store = checkpointStoreWithGit(
            (execution, run) => {
              if (gitSubcommand(execution.args) === "update-ref") updateRefs += 1;
              return run(execution);
            },
            { captureRetryBaseDelayMs: 0 },
          );

          const error = yield* Effect.flip(
            Effect.gen(function* () {
              const checkpointStore = yield* CheckpointStore;
              yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });
            }).pipe(Effect.provide(store)),
          );

          expect(exitDetail(error)).toMatch(/File exists/);
          expect(updateRefs).toBe(3);
        }),
      10_000,
    );

    it.effect("retries git add when a file vanishes or shrinks mid-capture", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* writeTextFile(path.join(tmp, "kept.txt"), "kept\n");
        const races = [
          "fatal: unable to stat 'gone.txt': No such file or directory",
          "error: short read while indexing log.txt\nerror: log.txt: failed to insert into database\nerror: unable to index file 'log.txt'\nfatal: updating files failed",
        ];

        for (const [index, race] of races.entries()) {
          let adds = 0;
          const store = checkpointStoreWithGit(
            (execution, run) => {
              if (gitSubcommand(execution.args) !== "add") return run(execution);
              adds += 1;
              return adds === 1 ? Effect.fail(gitExitFailure(execution, race)) : run(execution);
            },
            { captureRetryBaseDelayMs: 0 },
          );
          const checkpointRef = checkpointRefForThreadTurn(ThreadId.make("thread-race"), index);

          yield* Effect.gen(function* () {
            const checkpointStore = yield* CheckpointStore;
            yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });
          }).pipe(Effect.provide(store));

          expect(adds).toBe(2);
          expect(yield* checkpointTree(tmp, checkpointRef)).toBe(yield* referenceCaptureTree(tmp));
        }
      }),
    );

    it.effect("spends at most two retries per capture", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const lockFailure = (execution: GitExecution) =>
          gitExitFailure(
            execution,
            "fatal: update_ref failed for ref 'refs/ryco/x': cannot lock ref 'refs/ryco/x': Unable to create '/r/.git/refs/ryco/x.lock': File exists.",
          );
        const calls = { add: 0, "update-ref": 0 };
        const store = checkpointStoreWithGit(
          (execution, run) => {
            const subcommand = gitSubcommand(execution.args);
            if (subcommand === "add") {
              calls.add += 1;
              return calls.add === 1
                ? Effect.fail(
                    gitExitFailure(
                      execution,
                      "fatal: unable to stat 'a': No such file or directory",
                    ),
                  )
                : run(execution);
            }
            if (subcommand === "update-ref") {
              calls["update-ref"] += 1;
              return Effect.fail(lockFailure(execution));
            }
            return run(execution);
          },
          { captureRetryBaseDelayMs: 0 },
        );

        const error = yield* Effect.flip(
          Effect.gen(function* () {
            const checkpointStore = yield* CheckpointStore;
            yield* checkpointStore.captureCheckpoint({
              cwd: tmp,
              checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-budget"), 1),
            });
          }).pipe(Effect.provide(store)),
        );

        // add fails once (retry 1), update-ref once (retry 2), then again: no budget left.
        expect(exitDetail(error)).toMatch(/File exists/);
        expect(calls).toEqual({ add: 2, "update-ref": 2 });
      }),
    );

    it.effect("starts no retry that would begin after the capture's deadline", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        let adds = 0;
        const store = checkpointStoreWithGit(
          (execution, run) => {
            if (gitSubcommand(execution.args) !== "add") return run(execution);
            adds += 1;
            return Effect.fail(
              gitExitFailure(execution, "fatal: unable to stat 'a': No such file or directory"),
            );
          },
          // Every backoff (at least 5 ms) ends past a zero deadline.
          { captureRetryBaseDelayMs: 10, captureRetryDeadlineMs: 0 },
        );

        const error = yield* Effect.flip(
          Effect.gen(function* () {
            const checkpointStore = yield* CheckpointStore;
            yield* checkpointStore.captureCheckpoint({
              cwd: tmp,
              checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-deadline"), 1),
            });
          }).pipe(Effect.provide(store)),
        );

        expect(exitDetail(error)).toMatch(/unable to stat/);
        expect(adds).toBe(1);
      }),
    );

    it("spreads retries over jittered, growing delays", () => {
      for (const random01 of [0, 0.5, 0.999]) {
        const first = captureRetryDelayMs(1, 100, random01);
        const second = captureRetryDelayMs(2, 100, random01);
        expect(first).toBeGreaterThanOrEqual(50);
        expect(first).toBeLessThan(150);
        expect(second).toBeGreaterThanOrEqual(150);
        expect(second).toBeLessThan(450);
        expect(captureRetryDelayMs(1, 0, random01)).toBe(0);
        expect(captureRetryDelayMs(2, 0, random01)).toBe(0);
      }
    });
  });

  describe("durable writes", () => {
    const DURABLE_STEPS = ["add", "write-tree", "commit-tree", "update-ref"];
    const SCRATCH_INDEX_STEPS = ["add", "read-tree", "write-tree", "ls-files", "update-index"];
    const NO_HOOKS = [
      "core.hooksPath=/dev/null",
      "hook.post-index-change.enabled=false",
      "hook.reference-transaction.enabled=false",
    ];
    /** `<step> <effective core.fsyncMethod>` of each durable step, in order. */
    const flushMethods = (list: ReadonlyArray<GitExecution>) =>
      list
        .filter((execution) => DURABLE_STEPS.includes(gitSubcommand(execution.args) ?? ""))
        .map((execution) => {
          const config = gitConfigValues(execution.args);
          const method = config.findLast((value) => value.startsWith("core.fsyncMethod="));
          return `${gitSubcommand(execution.args)} ${method?.slice("core.fsyncMethod=".length)}`;
        });

    it.effect(
      "flushes every object and ref write and keeps the scratch index private",
      () =>
        Effect.gen(function* () {
          for (const platform of ["darwin", "linux"] as const) {
            const tmp = yield* makeTmpDir();
            yield* initRepoWithCommit(tmp);
            yield* writeTextFile(path.join(tmp, "notes.txt"), "notes\n");
            yield* git(tmp, ["add", "notes.txt"]);
            yield* git(tmp, ["commit", "-m", "notes"]);
            // Assume-unchanged makes the seeded capture run `update-index`.
            yield* git(tmp, ["update-index", "--assume-unchanged", "README.md"]);
            yield* writeTextFile(path.join(tmp, "README.md"), "# seeded\n");
            const { executions, layer } = recordingCheckpointStore({
              platform,
              captureRetryBaseDelayMs: 0,
            });
            const threadId = ThreadId.make(`thread-durable-${platform}`);

            yield* Effect.gen(function* () {
              const checkpointStore = yield* CheckpointStore;
              yield* checkpointStore.captureCheckpoint({
                cwd: tmp,
                checkpointRef: checkpointRefForThreadTurn(threadId, 1),
              });
              const seededCount = executions.length;
              // Skip-worktree sends the next capture down the HEAD-seeded path.
              yield* git(tmp, ["update-index", "--skip-worktree", "notes.txt"]);
              yield* writeTextFile(path.join(tmp, "README.md"), "# from head\n");
              const fallbackRef = checkpointRefForThreadTurn(threadId, 2);
              yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: fallbackRef });
              const captureCount = executions.length;
              const commit = (yield* checkpointStore.resolveCommit({
                cwd: tmp,
                ref: fallbackRef,
              }))!;
              const pin = forkPinRefs(ThreadId.make(`fork-durable-${platform}`)).checkpoint;
              yield* checkpointStore.pinRef({ cwd: tmp, ref: pin, commit });
              yield* checkpointStore.deleteCheckpointRefs({ cwd: tmp, checkpointRefs: [pin] });

              const seeded = executions.slice(0, seededCount);
              const fallback = executions.slice(seededCount, captureCount);
              const refWrites = executions
                .slice(captureCount)
                .filter((execution) => gitSubcommand(execution.args) === "update-ref");
              const subcommands = (list: ReadonlyArray<GitExecution>) =>
                list.map((execution) => gitSubcommand(execution.args));
              expect(subcommands(seeded)).toEqual(
                expect.arrayContaining(["ls-files", "update-index", ...DURABLE_STEPS]),
              );
              expect(subcommands(fallback)).toEqual(
                expect.arrayContaining(["read-tree", ...DURABLE_STEPS]),
              );
              expect(refWrites).toHaveLength(2);

              for (const execution of [...seeded, ...fallback, ...refWrites]) {
                const subcommand = gitSubcommand(execution.args) ?? "";
                const config = gitConfigValues(execution.args);
                if (DURABLE_STEPS.includes(subcommand)) {
                  const fsyncAt = config.indexOf("core.fsyncMethod=fsync");
                  expect(config).toContain("core.fsync=objects,reference");
                  expect(fsyncAt).toBeGreaterThanOrEqual(0);
                  if (platform === "darwin") {
                    expect(config.indexOf("core.fsyncMethod=batch")).toBeGreaterThan(fsyncAt);
                  } else {
                    expect(config).not.toContain("core.fsyncMethod=batch");
                  }
                }
                if ([...DURABLE_STEPS, ...SCRATCH_INDEX_STEPS].includes(subcommand)) {
                  // Classified failures need git's untranslated messages.
                  expect(execution.env?.LC_MESSAGES).toBe("C");
                  expect(execution.env?.LC_ALL).toBeUndefined();
                }
                if (SCRATCH_INDEX_STEPS.includes(subcommand)) {
                  expect(config).toContain("core.splitIndex=false");
                }
                if ([...SCRATCH_INDEX_STEPS, "update-ref"].includes(subcommand)) {
                  expect(config).toEqual(expect.arrayContaining(NO_HOOKS));
                }
              }
              // The user's fsmonitor serves the seeded index, never the HEAD-seeded one.
              const fsmonitorOff = (execution: GitExecution) =>
                gitConfigValues(execution.args).includes("core.fsmonitor=false");
              expect(seeded.some(fsmonitorOff)).toBe(false);
              expect(
                fallback
                  .filter((execution) =>
                    ["read-tree", "add", "write-tree"].includes(gitSubcommand(execution.args)!),
                  )
                  .every(fsmonitorOff),
              ).toBe(true);
              const add = seeded.find((execution) => gitSubcommand(execution.args) === "add");
              expect(add?.timeoutMs).toBe(120_000);
            }).pipe(Effect.provide(layer));
          }
        }),
      20_000,
    );

    it.effect("really flushes the checkpoint ref", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* writeTextFile(path.join(tmp, "fresh.txt"), `fresh ${Date.now()}\n`);
        const traceDir = yield* makeTmpDir("checkpoint-store-trace-");
        const tracePath = path.join(traceDir, "trace.json");
        const store = checkpointStoreWithGit((execution, run) =>
          run(
            gitSubcommand(execution.args) === "update-ref"
              ? { ...execution, env: { ...execution.env, GIT_TRACE2_EVENT: tracePath } }
              : execution,
          ),
        );

        yield* Effect.gen(function* () {
          const checkpointStore = yield* CheckpointStore;
          yield* checkpointStore.captureCheckpoint({
            cwd: tmp,
            checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-flush"), 1),
          });
        }).pipe(Effect.provide(store));

        const events = (yield* fileSystem.readFileString(tracePath))
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        const hardwareFlushes = events.flatMap((event) => {
          // Git 2.42 and later report a counter; 2.38 to 2.41 a data event.
          if (
            event.event === "counter" &&
            event.category === "fsync" &&
            event.name === "hardware-flush"
          ) {
            return [Number(event.count)];
          }
          if (event.event === "data" && event.key === "fsync/hardware-flush") {
            return [Number(event.value)];
          }
          return [];
        });
        expect(Math.max(0, ...hardwareFlushes)).toBeGreaterThanOrEqual(1);
      }),
    );

    it.effect(
      "falls back to writeout-only flushes on macOS when the volume rejects full flushes",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          const rejectingFullFlushes =
            (executions: Array<GitExecution>) => (execution: GitExecution, run: GitRun) => {
              executions.push(execution);
              const config = gitConfigValues(execution.args);
              return config.includes("core.fsyncMethod=fsync") &&
                !config.includes("core.fsyncMethod=writeout-only")
                ? Effect.fail(
                    gitExitFailure(
                      execution,
                      "fatal: fsync error on '.git/objects/ab/cdef01': Operation not supported",
                    ),
                  )
                : run(execution);
            };

          const darwinExecutions: Array<GitExecution> = [];
          yield* Effect.gen(function* () {
            const checkpointStore = yield* CheckpointStore;
            const threadId = ThreadId.make("thread-writeout-only");
            yield* checkpointStore.captureCheckpoint({
              cwd: tmp,
              checkpointRef: checkpointRefForThreadTurn(threadId, 1),
            });
            expect(flushMethods(darwinExecutions)).toEqual([
              "add batch",
              "add writeout-only",
              "write-tree writeout-only",
              "commit-tree writeout-only",
              "update-ref writeout-only",
            ]);
            darwinExecutions.length = 0;
            yield* writeTextFile(path.join(tmp, "README.md"), "# second\n");
            yield* checkpointStore.captureCheckpoint({
              cwd: tmp,
              checkpointRef: checkpointRefForThreadTurn(threadId, 2),
            });
            expect(flushMethods(darwinExecutions)).toEqual([
              "add writeout-only",
              "write-tree writeout-only",
              "commit-tree writeout-only",
              "update-ref writeout-only",
            ]);
          }).pipe(
            Effect.provide(
              checkpointStoreWithGit(rejectingFullFlushes(darwinExecutions), {
                platform: "darwin",
                captureRetryBaseDelayMs: 0,
              }),
            ),
          );

          const linuxExecutions: Array<GitExecution> = [];
          const error = yield* Effect.flip(
            Effect.gen(function* () {
              const checkpointStore = yield* CheckpointStore;
              yield* checkpointStore.captureCheckpoint({
                cwd: tmp,
                checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-linux-flush"), 1),
              });
            }).pipe(
              Effect.provide(
                checkpointStoreWithGit(rejectingFullFlushes(linuxExecutions), {
                  platform: "linux",
                  captureRetryBaseDelayMs: 0,
                }),
              ),
            ),
          );
          expect(exitDetail(error)).toMatch(/fsync error/);
          expect(flushMethods(linuxExecutions)).toEqual(["add fsync"]);
        }),
    );

    it.effect(
      "reruns a ref write that failed without a reason but never remembers the fallback",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          const executions: Array<GitExecution> = [];
          // Every full-flush ref write fails as on a disk that was full a moment ago.
          const store = checkpointStoreWithGit(
            (execution, run) => {
              executions.push(execution);
              return gitSubcommand(execution.args) === "update-ref" &&
                !gitConfigValues(execution.args).includes("core.fsyncMethod=writeout-only")
                ? Effect.fail(
                    gitExitFailure(
                      execution,
                      "fatal: update_ref failed for ref 'refs/ryco/x': cannot update ref 'refs/ryco/x': couldn't write '/r/.git/refs/ryco/x.lock'",
                    ),
                  )
                : run(execution);
            },
            { platform: "darwin", captureRetryBaseDelayMs: 0 },
          );
          const expected = [
            "add batch",
            "write-tree batch",
            "commit-tree batch",
            "update-ref batch",
            "update-ref writeout-only",
          ];

          yield* Effect.gen(function* () {
            const checkpointStore = yield* CheckpointStore;
            const threadId = ThreadId.make("thread-ref-write-failed");
            yield* checkpointStore.captureCheckpoint({
              cwd: tmp,
              checkpointRef: checkpointRefForThreadTurn(threadId, 1),
            });
            expect(flushMethods(executions)).toEqual(expected);
            executions.length = 0;
            yield* writeTextFile(path.join(tmp, "README.md"), "# second\n");
            const second = checkpointRefForThreadTurn(threadId, 2);
            yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: second });
            // Full flushes again: the failure proved nothing about the volume.
            expect(flushMethods(executions)).toEqual(expected);
            expect(
              yield* checkpointStore.hasCheckpointRef({ cwd: tmp, checkpointRef: second }),
            ).toBe(true);
          }).pipe(Effect.provide(store));
        }),
    );

    it.effect(
      "leaves no shared index in .git when the repository splits its index",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          yield* git(tmp, ["config", "core.splitIndex", "true"]);
          yield* git(tmp, ["update-index", "--split-index"]);
          const sharedIndexes = fileSystem
            .readDirectory(path.join(tmp, ".git"))
            .pipe(
              Effect.map((entries) => entries.filter((entry) => entry.startsWith("sharedindex."))),
            );
          const before = yield* sharedIndexes;
          expect(before.length).toBeGreaterThan(0);

          const checkpointStore = yield* CheckpointStore;
          const threadId = ThreadId.make("thread-split-index");
          // A split write of a new index state adds a full index copy to .git.
          yield* writeTextFile(path.join(tmp, "README.md"), "# first capture\n");
          yield* checkpointStore.captureCheckpoint({
            cwd: tmp,
            checkpointRef: checkpointRefForThreadTurn(threadId, 1),
          });
          yield* writeTextFile(path.join(tmp, "README.md"), "# second capture\n");
          const checkpointRef = checkpointRefForThreadTurn(threadId, 2);
          yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });

          expect((yield* sharedIndexes).toSorted()).toEqual(before.toSorted());
          expect(yield* checkpointTree(tmp, checkpointRef)).toBe(yield* referenceCaptureTree(tmp));
        }),
      10_000,
    );

    it.effect(
      "never runs the repository's index or reference hooks",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const markerDir = yield* makeTmpDir("checkpoint-store-hooks-");
          const marker = path.join(markerDir, "ran");
          const seeded = yield* makeTmpDir();
          const fromHead = yield* makeTmpDir();
          for (const repo of [seeded, fromHead]) {
            yield* initRepoWithCommit(repo);
            yield* writeTextFile(path.join(repo, "notes.txt"), "notes\n");
            yield* git(repo, ["add", "notes.txt"]);
            yield* git(repo, ["commit", "-m", "notes"]);
          }
          yield* git(fromHead, ["update-index", "--skip-worktree", "notes.txt"]);
          // Config-defined hooks (git 2.54) can be silenced per event from git 2.55.
          const version = (yield* git(seeded, ["--version"])).match(/(\d+)\.(\d+)/);
          const configHooks =
            version !== null &&
            (Number(version[1]) > 2 || (Number(version[1]) === 2 && Number(version[2]) >= 55));
          for (const repo of [seeded, fromHead]) {
            yield* fileSystem.makeDirectory(path.join(repo, ".git", "hooks"), { recursive: true });
            for (const event of ["post-index-change", "reference-transaction"]) {
              const hook = path.join(repo, ".git", "hooks", event);
              yield* writeTextFile(hook, `#!/bin/sh\necho "file ${event}" >> '${marker}'\n`);
              yield* fileSystem.chmod(hook, 0o755);
              if (configHooks) {
                yield* git(repo, ["config", `hook.ryco-test-${event}.event`, event]);
                yield* git(repo, [
                  "config",
                  `hook.ryco-test-${event}.command`,
                  `echo "config ${event}" >> '${marker}'`,
                ]);
              }
            }
            // With nothing changed, `add` and `write-tree` would not write the index.
            yield* writeTextFile(path.join(repo, "README.md"), "# edited\n");
          }

          const checkpointStore = yield* CheckpointStore;
          const threadId = ThreadId.make("thread-hooks");
          const checkpointRef = checkpointRefForThreadTurn(threadId, 1);
          yield* checkpointStore.captureCheckpoint({ cwd: seeded, checkpointRef });
          yield* checkpointStore.captureCheckpoint({
            cwd: fromHead,
            checkpointRef: checkpointRefForThreadTurn(threadId, 2),
          });
          const commit = (yield* checkpointStore.resolveCommit({
            cwd: seeded,
            ref: checkpointRef,
          }))!;
          const pin = forkPinRefs(ThreadId.make("fork-hooks")).checkpoint;
          yield* checkpointStore.pinRef({ cwd: seeded, ref: pin, commit });
          yield* checkpointStore.deleteCheckpointRefs({ cwd: seeded, checkpointRefs: [pin] });

          expect(yield* fileSystem.exists(marker)).toBe(false);
          // The hooks are live: the user's own index write runs them.
          yield* git(seeded, ["add", "README.md"]);
          expect(yield* fileSystem.readFileString(marker)).toContain("file post-index-change");
        }),
      20_000,
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
              checkpointStoreWithGit((execution, run) =>
                (gitSubcommand(execution.args) === "add" && !firstAddHeld
                  ? Effect.sync(() => {
                      firstAddHeld = true;
                    }).pipe(
                      Effect.andThen(Deferred.succeed(firstAddReached, undefined)),
                      Effect.andThen(Deferred.await(releaseFirstAdd)),
                    )
                  : Effect.void
                ).pipe(Effect.andThen(run(execution))),
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
