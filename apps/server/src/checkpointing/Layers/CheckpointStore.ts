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

import { Effect, Layer, FileSystem, Path, Semaphore } from "effect";

import { CheckpointInvariantError } from "../Errors.ts";
import { VcsProcessExitError } from "@ryco/contracts";
import { seedIndexFromCheckout } from "../../vcs/GitTemporaryIndex.ts";
import { VcsDriverRegistry } from "../../vcs/VcsDriverRegistry.ts";
import { CheckpointStore, type CheckpointStoreShape } from "../Services/CheckpointStore.ts";
import { CheckpointRef } from "@ryco/contracts";
import { RYCO_REFS_PREFIX } from "../Utils.ts";

const CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 10_000_000;
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

        // A copy of the checkout's own index, so `add -A` reuses its stat data.
        const seeded = yield* seedIndexFromCheckout({
          git: vcs.execute,
          fs,
          path,
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
      "diff",
      "--patch",
      "--minimal",
      "--no-color",
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
