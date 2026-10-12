import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, PlatformError, Scope } from "effect";
import { describe, expect } from "vite-plus/test";

import { checkpointRefForThreadTurn, forkPinRefs } from "../Utils.ts";
import { CheckpointStoreLive } from "./CheckpointStore.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import type { VcsError } from "@ryco/contracts";
import { ServerConfig } from "../../config.ts";
import { ThreadId } from "@ryco/contracts";
import { configureTestGitCommitIdentity } from "../../vcs/testing/GitTestRepo.ts";

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
