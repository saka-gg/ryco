/**
 * CheckpointStoreLive - Filesystem checkpoint store adapter layer.
 *
 * Implements hidden Git-ref checkpoint capture/restore directly with
 * Effect-native child process execution (`effect/process`).
 *
 * This layer owns filesystem/Git interactions only; it does not persist
 * checkpoint metadata and does not coordinate provider rollback semantics.
 *
 * @module CheckpointStoreLive
 */
import { randomUUID } from "node:crypto";

import { Cause, Effect, Layer, FileSystem, Option, Path, Semaphore } from "effect";

import { CheckpointInvariantError } from "../Errors.ts";
import { VcsProcessExitError } from "@ryco/contracts";
import { INTERNAL_PATCH_DIFF_ARGS } from "../../vcs/GitVcsDriver.ts";
import { VcsDriverRegistry } from "../../vcs/VcsDriverRegistry.ts";
import { CheckpointStore, type CheckpointStoreShape } from "../Services/CheckpointStore.ts";
import { CheckpointRef } from "@ryco/contracts";
import { RYCO_REFS_PREFIX } from "../Utils.ts";

const CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 10_000_000;
/** `ls-files -v` of the seeded index; a larger listing falls back to `read-tree HEAD`. */
const CHECKPOINT_INDEX_LISTING_MAX_BYTES = 64 * 1024 * 1024;
/** Concurrent captures allowed; a restore takes all of them. */
const CHECKOUT_ACCESS_PERMITS = 64;
const FULL_COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const makeCheckpointStore = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsRegistry = yield* VcsDriverRegistry;
  // Captures only read a checkout, so threads capture concurrently; a restore
  // rewrites one and runs alone, so no capture records a half-restored tree.
  // A waiting restore holds the turnstile, so captures that keep arriving
  // cannot starve it (the semaphore itself is not fair).
  const checkoutAccess = yield* Semaphore.make(CHECKOUT_ACCESS_PERMITS);
  const restoreTurnstile = yield* Semaphore.make(1);
  const asCheckoutReader = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    restoreTurnstile
      .withPermits(1)(Effect.void)
      .pipe(Effect.andThen(checkoutAccess.withPermits(1)(effect)));
  const asCheckoutWriter = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    restoreTurnstile.withPermits(1)(checkoutAccess.withPermits(CHECKOUT_ACCESS_PERMITS)(effect));
  const vcs = {
    execute: (input: {
      readonly operation: string;
      readonly cwd: string;
      readonly args: ReadonlyArray<string>;
      readonly stdin?: string;
      readonly env?: NodeJS.ProcessEnv;
      readonly allowNonZeroExit?: boolean;
      readonly timeoutMs?: number;
      readonly maxOutputBytes?: number;
      readonly truncateOutputAtMaxBytes?: boolean;
    }) =>
      vcsRegistry
        .resolve({ cwd: input.cwd, requestedKind: "git" })
        .pipe(Effect.flatMap((handle) => handle.driver.execute(input))),
  };

  const resolveHeadCommit = (cwd: string) =>
    vcs
      .execute({
        operation: "CheckpointStore.resolveHeadCommit",
        cwd,
        args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => {
          if (result.exitCode !== 0) {
            return null;
          }
          const commit = result.stdout.trim();
          return commit.length > 0 ? commit : null;
        }),
      );

  const hasHeadCommit: CheckpointStoreShape["hasHeadCommit"] = (cwd) =>
    vcs
      .execute({
        operation: "CheckpointStore.hasHeadCommit",
        cwd,
        args: ["rev-parse", "--verify", "HEAD"],
        allowNonZeroExit: true,
      })
      .pipe(Effect.map((result) => result.exitCode === 0));

  const resolveCommitOid = (operation: string, cwd: string, ref: string) =>
    // A leading dash would be read as an option, and control characters are never a ref.
    ref.startsWith("-") || /[\p{Cc}]/u.test(ref)
      ? Effect.succeed(null)
      : vcs
          .execute({
            operation,
            cwd,
            args: ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
            allowNonZeroExit: true,
          })
          .pipe(
            Effect.map((result) => {
              if (result.exitCode !== 0) {
                return null;
              }
              const commit = result.stdout.trim();
              return commit.length > 0 ? commit : null;
            }),
          );

  const resolveCheckpointCommit = (cwd: string, checkpointRef: CheckpointRef) =>
    resolveCommitOid("CheckpointStore.resolveCheckpointCommit", cwd, checkpointRef);

  const isGitRepository: CheckpointStoreShape["isGitRepository"] = (cwd) =>
    vcs
      .execute({
        operation: "CheckpointStore.isGitRepository",
        cwd,
        args: ["rev-parse", "--is-inside-work-tree"],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => result.exitCode === 0 && result.stdout.trim() === "true"),
        Effect.catch(() => Effect.succeed(false)),
      );

  /**
   * Seeds the capture's temp index with a copy of the checkout's real index, so
   * `add -A` reuses its stat data instead of rehashing every tracked file (the
   * fresh `read-tree HEAD` index has none). The resulting tree is the same as
   * `read-tree HEAD` + `add -A`: assume-unchanged entries are re-armed on the
   * copy so `add -A` stats them. False when the copy cannot give that tree and
   * the caller must seed from HEAD instead: no index yet, a split index, or
   * skip-worktree entries (`add -A` keeps their index version where
   * `read-tree HEAD` yields the HEAD version). Never fails.
   */
  const seedIndexFromCheckout = (input: {
    readonly operation: string;
    readonly cwd: string;
    readonly tempIndexPath: string;
    readonly env: NodeJS.ProcessEnv;
  }): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      // `--git-path` resolves the per-worktree index of a linked worktree.
      const located = yield* vcs.execute({
        operation: input.operation,
        cwd: input.cwd,
        args: ["rev-parse", "--path-format=absolute", "--git-path", "index"],
        allowNonZeroExit: true,
      });
      const indexPath = located.stdout.trim();
      if (located.exitCode !== 0 || indexPath.length === 0 || !path.isAbsolute(indexPath)) {
        return false;
      }
      // A split index keeps its shared half next to the real index.
      const gitDirEntries = yield* fs.readDirectory(path.dirname(indexPath));
      if (gitDirEntries.some((entry) => entry.startsWith("sharedindex."))) {
        return false;
      }
      const indexInfo = yield* fs.stat(indexPath);
      if (Option.isNone(indexInfo.mtime)) {
        return false;
      }
      yield* fs.copyFile(indexPath, input.tempIndexPath);
      // Git trusts an entry's stat data only when the file is older than the
      // index itself ("racy git"). A fresh copy would look newer than the
      // original and hide a same-size edit made in the index's own timestamp,
      // so the copy keeps the original's mtime (millisecond-truncated, which
      // only makes more entries count as racy).
      yield* fs.utimes(input.tempIndexPath, indexInfo.mtime.value, indexInfo.mtime.value);

      const listed = yield* vcs.execute({
        operation: input.operation,
        cwd: input.cwd,
        args: ["ls-files", "-v", "-z"],
        env: input.env,
        maxOutputBytes: CHECKPOINT_INDEX_LISTING_MAX_BYTES,
        truncateOutputAtMaxBytes: true,
      });
      if (listed.stdoutTruncated) {
        return false;
      }
      const assumeUnchanged: Array<string> = [];
      for (const record of listed.stdout.split("\0")) {
        if (record.length < 3) continue;
        const tag = record[0]!;
        if (tag === "S" || tag === "s") {
          return false;
        }
        // `-v` lowercases the tag of assume-unchanged entries.
        if (tag !== tag.toUpperCase()) {
          assumeUnchanged.push(record.slice(2));
        }
      }
      if (assumeUnchanged.length > 0) {
        yield* vcs.execute({
          operation: input.operation,
          cwd: input.cwd,
          args: ["update-index", "--no-assume-unchanged", "-z", "--stdin"],
          stdin: `${assumeUnchanged.join("\0")}\0`,
          env: input.env,
        });
      }
      return true;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logDebug("checkpoint capture could not seed from the checkout index", {
          cwd: input.cwd,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(false)),
      ),
    );

  const captureCheckpoint: CheckpointStoreShape["captureCheckpoint"] = Effect.fn(
    "captureCheckpoint",
  )(function* (input) {
    const operation = "CheckpointStore.captureCheckpoint";

    yield* Effect.acquireUseRelease(
      fs.makeTempDirectory({ prefix: "ryco-fs-checkpoint-" }),
      Effect.fn("captureCheckpoint.withTempDirectory")(function* (tempDir) {
        const tempIndexPath = path.join(tempDir, `index-${randomUUID()}`);
        const commitEnv: NodeJS.ProcessEnv = {
          ...process.env,
          GIT_INDEX_FILE: tempIndexPath,
          GIT_AUTHOR_NAME: "Ryco",
          GIT_AUTHOR_EMAIL: "ryco@users.noreply.github.com",
          GIT_COMMITTER_NAME: "Ryco",
          GIT_COMMITTER_EMAIL: "ryco@users.noreply.github.com",
        };

        const seeded = yield* seedIndexFromCheckout({
          operation,
          cwd: input.cwd,
          tempIndexPath,
          env: commitEnv,
        });
        if (!seeded) {
          // A partly prepared copy must not leak into the HEAD-seeded index.
          yield* fs.remove(tempIndexPath, { force: true });
          const headExists = yield* hasHeadCommit(input.cwd);
          if (headExists) {
            yield* vcs.execute({
              operation,
              cwd: input.cwd,
              args: ["read-tree", "HEAD"],
              env: commitEnv,
            });
          }
        }

        yield* vcs.execute({
          operation,
          cwd: input.cwd,
          args: ["add", "-A", "--", "."],
          env: commitEnv,
        });

        const writeTreeResult = yield* vcs.execute({
          operation,
          cwd: input.cwd,
          args: ["write-tree"],
          env: commitEnv,
        });
        const treeOid = writeTreeResult.stdout.trim();
        if (treeOid.length === 0) {
          return yield* new VcsProcessExitError({
            operation,
            command: "git write-tree",
            cwd: input.cwd,
            exitCode: 0,
            detail: "git write-tree returned an empty tree oid.",
          });
        }

        const message = `ryco checkpoint ref=${input.checkpointRef}`;
        const commitTreeResult = yield* vcs.execute({
          operation,
          cwd: input.cwd,
          args: ["commit-tree", treeOid, "-m", message],
          env: commitEnv,
        });
        const commitOid = commitTreeResult.stdout.trim();
        if (commitOid.length === 0) {
          return yield* new VcsProcessExitError({
            operation,
            command: "git commit-tree",
            cwd: input.cwd,
            exitCode: 0,
            detail: "git commit-tree returned an empty commit oid.",
          });
        }

        yield* vcs.execute({
          operation,
          cwd: input.cwd,
          args: ["update-ref", input.checkpointRef, commitOid],
        });
      }),
      (tempDir) => fs.remove(tempDir, { recursive: true }),
    ).pipe(
      asCheckoutReader,
      Effect.catchTags({
        PlatformError: (error) =>
          Effect.fail(
            new CheckpointInvariantError({
              operation: "CheckpointStore.captureCheckpoint",
              detail: "Failed to capture checkpoint.",
              cause: error,
            }),
          ),
      }),
    );
  });

  const resolveCheckpointCommits: CheckpointStoreShape["resolveCheckpointCommits"] = (input) => {
    // Line breaks are never valid in ref names and would desynchronize the batch.
    const queried = input.checkpointRefs.filter((ref) => !/[\r\n]/.test(ref));
    if (queried.length === 0) return Effect.succeed(input.checkpointRefs.map(() => null));
    return vcs
      .execute({
        operation: "CheckpointStore.resolveCheckpointCommits",
        cwd: input.cwd,
        // One process for every ref; a missing ref answers `<name> missing` on its line.
        args: ["cat-file", "--batch-check=%(objectname)"],
        stdin: queried.map((ref) => `${ref}^{commit}\n`).join(""),
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => {
          const lines = result.exitCode === 0 ? result.stdout.split("\n") : [];
          const commits = new Map<CheckpointRef, string>();
          queried.forEach((ref, index) => {
            const line = lines[index]?.trim() ?? "";
            if (FULL_COMMIT_OID.test(line)) commits.set(ref, line);
          });
          return input.checkpointRefs.map((ref) => commits.get(ref) ?? null);
        }),
      );
  };

  const hasCheckpointRef: CheckpointStoreShape["hasCheckpointRef"] = (input) =>
    resolveCheckpointCommit(input.cwd, input.checkpointRef).pipe(
      Effect.map((commit) => commit !== null),
    );

  const restoreCheckpoint: CheckpointStoreShape["restoreCheckpoint"] = Effect.fn(
    "restoreCheckpoint",
  )(function* (input) {
    const operation = "CheckpointStore.restoreCheckpoint";

    let commitOid = yield* resolveCheckpointCommit(input.cwd, input.checkpointRef);

    if (!commitOid && input.fallbackToHead === true) {
      commitOid = yield* resolveHeadCommit(input.cwd);
    }

    if (!commitOid) {
      return false;
    }

    yield* vcs.execute({
      operation,
      cwd: input.cwd,
      args: ["restore", "--source", commitOid, "--worktree", "--staged", "--", "."],
    });
    yield* vcs.execute({
      operation,
      cwd: input.cwd,
      args: ["clean", "-fd", "--", "."],
    });

    const headExists = yield* hasHeadCommit(input.cwd);
    if (headExists) {
      yield* vcs.execute({
        operation,
        cwd: input.cwd,
        args: ["reset", "--quiet", "--", "."],
      });
    }

    return true;
  }, asCheckoutWriter);

  const diffCheckpointCommits: CheckpointStoreShape["diffCheckpointCommits"] = Effect.fn(
    "diffCheckpointCommits",
  )(function* (input) {
    const diffArgs = [
      ...INTERNAL_PATCH_DIFF_ARGS,
      "--minimal",
      // Git's default for `git diff`; pinned so `diff.renames=copies` cannot
      // turn a copied file into a rename of its source.
      "--find-renames",
      ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
      input.fromCommitOid,
      input.toCommitOid,
    ];

    const result = yield* vcs.execute({
      operation: "CheckpointStore.diffCheckpoints",
      cwd: input.cwd,
      args: diffArgs,
      maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
    });

    return result.stdout;
  });

  const diffCheckpoints: CheckpointStoreShape["diffCheckpoints"] = Effect.fn("diffCheckpoints")(
    function* (input) {
      const operation = "CheckpointStore.diffCheckpoints";

      const [fromCheckpointCommit, toCommitOid] = yield* resolveCheckpointCommits({
        cwd: input.cwd,
        checkpointRefs: [input.fromCheckpointRef, input.toCheckpointRef],
      });
      let fromCommitOid = fromCheckpointCommit ?? null;

      if (!fromCommitOid && input.fallbackFromToHead === true) {
        const headCommit = yield* resolveHeadCommit(input.cwd);
        if (headCommit) {
          fromCommitOid = headCommit;
        }
      }

      if (!fromCommitOid || !toCommitOid) {
        return yield* new VcsProcessExitError({
          operation,
          command: "git diff",
          cwd: input.cwd,
          exitCode: 1,
          detail: "Checkpoint ref is unavailable for diff operation.",
        });
      }

      return yield* diffCheckpointCommits({
        cwd: input.cwd,
        fromCommitOid,
        toCommitOid,
        ignoreWhitespace: input.ignoreWhitespace,
      });
    },
  );

  const deleteCheckpointRefs: CheckpointStoreShape["deleteCheckpointRefs"] = Effect.fn(
    "deleteCheckpointRefs",
  )(function* (input) {
    const operation = "CheckpointStore.deleteCheckpointRefs";

    yield* Effect.forEach(
      input.checkpointRefs,
      (checkpointRef) =>
        vcs.execute({
          operation,
          cwd: input.cwd,
          args: ["update-ref", "-d", checkpointRef],
          allowNonZeroExit: true,
        }),
      { discard: true },
    );
  });

  const resolveCommit: CheckpointStoreShape["resolveCommit"] = (input) =>
    resolveCommitOid("CheckpointStore.resolveCommit", input.cwd, input.ref);

  const pinRef: CheckpointStoreShape["pinRef"] = Effect.fn("pinRef")(function* (input) {
    const operation = "CheckpointStore.pinRef";
    if (!input.ref.startsWith(`${RYCO_REFS_PREFIX}/`)) {
      return yield* new CheckpointInvariantError({
        operation,
        detail: `Refusing to pin a ref outside ${RYCO_REFS_PREFIX}/.`,
      });
    }
    if (!FULL_COMMIT_OID.test(input.commit)) {
      return yield* new CheckpointInvariantError({
        operation,
        detail: "A pinned ref must name a full commit id.",
      });
    }
    yield* vcs.execute({
      operation,
      cwd: input.cwd,
      args: ["update-ref", input.ref, input.commit],
    });
  });

  return {
    isGitRepository,
    captureCheckpoint,
    hasHeadCommit,
    hasCheckpointRef,
    resolveCheckpointCommits,
    restoreCheckpoint,
    diffCheckpoints,
    diffCheckpointCommits,
    deleteCheckpointRefs,
    resolveCommit,
    pinRef,
  } satisfies CheckpointStoreShape;
});

export const CheckpointStoreLive = Layer.effect(CheckpointStore, makeCheckpointStore);
