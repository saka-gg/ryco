/**
 * CheckpointStoreLive - Filesystem checkpoint store adapter layer.
 *
 * Implements hidden Git-ref checkpoint capture/restore directly with
 * Effect-native child process execution (`effect/process`).
 *
 * This layer owns filesystem/Git interactions only; it does not persist
 * checkpoint metadata and does not coordinate provider rollback semantics.
 *
 * Every object and ref it writes is flushed before the ref that publishes it
 * (see `GitDurableWrites.ts`), so a crash or power loss cannot leave a
 * checkpoint ref, or a later commit of the user's that reuses a blob a
 * capture wrote, pointing at an empty object. Objects that already existed
 * (written moments earlier by the agent's own git commands, under git's
 * defaults) are reused as they are, without a flush.
 *
 * @module CheckpointStoreLive
 */
import { randomUUID } from "node:crypto";

import {
  Cause,
  Clock,
  Duration,
  Effect,
  Layer,
  FileSystem,
  Option,
  Path,
  Random,
  Semaphore,
} from "effect";

import { CheckpointInvariantError } from "../Errors.ts";
import { VcsProcessExitError, type VcsError } from "@ryco/contracts";
import {
  NO_FSMONITOR_CONFIG_ARGS,
  NO_USER_HOOK_ARGS,
  SCRATCH_INDEX_CONFIG_ARGS,
  WRITEOUT_ONLY_DURABLE_WRITE_ARGS,
  classifyGitExitDetail,
  durableWriteArgs,
  gitCMessagesEnv,
  gitSubcommand,
  isTransientGitExitKind,
} from "../../vcs/GitDurableWrites.ts";
import { INTERNAL_PATCH_DIFF_ARGS } from "../../vcs/GitVcsDriver.ts";
import type { VcsDriverShape } from "../../vcs/VcsDriver.ts";
import { VcsDriverRegistry } from "../../vcs/VcsDriverRegistry.ts";
import type { VcsProcessOutput } from "../../vcs/VcsProcess.ts";
import { CheckpointStore, type CheckpointStoreShape } from "../Services/CheckpointStore.ts";
import { CheckpointRef } from "@ryco/contracts";
import { RYCO_REFS_PREFIX } from "../Utils.ts";

const CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 10_000_000;
/** `ls-files -v` of the seeded index; a larger listing falls back to `read-tree HEAD`. */
const CHECKPOINT_INDEX_LISTING_MAX_BYTES = 64 * 1024 * 1024;
/** Concurrent captures allowed; a restore takes all of them. */
const CHECKOUT_ACCESS_PERMITS = 64;
const FULL_COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const DEFAULT_CAPTURE_RETRIES = 2;
const DEFAULT_CAPTURE_RETRY_BASE_DELAY_MS = 100;
const DEFAULT_CAPTURE_RETRY_DEADLINE_MS = 30_000;
/**
 * Bound of the capture steps that write one object per new file or directory
 * (`add`, `write-tree`). Each object is flushed (a drive flush per object on
 * Linux), so a first capture of a large untracked tree can outlast git's
 * usual 30 s. Captures run off the turn-completion path.
 */
const CAPTURE_OBJECT_WRITE_TIMEOUT_MS = 120_000;
/** Bounds of the search for embedded repositories without a commit. */
const NESTED_REPOSITORY_DISCOVERY_TIMEOUT = Duration.seconds(5);
const NESTED_REPOSITORY_LISTING_MAX_BYTES = 8 * 1024 * 1024;
const NESTED_REPOSITORY_CANDIDATE_LIMIT = 256;
const NESTED_REPOSITORY_EXCLUSION_LIMIT = 64;
const NESTED_REPOSITORY_PROBE_CONCURRENCY = 8;
const NESTED_REPOSITORY_PROBE_TIMEOUT_MS = 2_000;
/**
 * A probe reads the embedded repository alone: no repository location
 * inherited from the server's environment. It never fetches a missing object
 * from a promisor remote, which would run a command the embedded
 * repository's own config names (git 2.45 and later).
 */
const NESTED_REPOSITORY_PROBE_ENV = Object.freeze({
  GIT_NO_LAZY_FETCH: "1",
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
  GIT_NAMESPACE: undefined,
  GIT_PREFIX: undefined,
} satisfies NodeJS.ProcessEnv);
/** Checkouts remembered to need writeout-only flushes before the memo starts over. */
const WRITEOUT_ONLY_CHECKOUT_LIMIT = 512;

export interface CheckpointStoreOptions {
  /** Platform whose flush rules apply; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Reruns of transient git failures per capture, across its steps; defaults to 2. */
  readonly captureRetries?: number;
  /** Backoff base in ms; 0 reruns at once (tests run on a test clock). Defaults to 100. */
  readonly captureRetryBaseDelayMs?: number;
  /** No rerun starts this long after the capture began; defaults to 30 s. */
  readonly captureRetryDeadlineMs?: number;
}

/**
 * Backoff before rerun `retry` (1-based) of a capture step: `base * 3^(retry-1)`,
 * jittered uniformly between half and one and a half times that. With the
 * default base: [50, 150) ms, then [150, 450) ms.
 */
export const captureRetryDelayMs = (retry: number, baseDelayMs: number, random01: number): number =>
  Math.floor(baseDelayMs * 3 ** (retry - 1) * (0.5 + random01));

interface GitExecution {
  readonly operation: string;
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly truncateOutputAtMaxBytes?: boolean;
}

/** Reruns one capture may still spend, and when it started. */
interface CaptureRetryBudget {
  readonly startedAtMs: number;
  retriesUsed: number;
}

const makeCheckpointStore = Effect.fn("makeCheckpointStore")(function* (
  options: CheckpointStoreOptions = {},
) {
  const platform = options.platform ?? process.platform;
  const captureRetries = options.captureRetries ?? DEFAULT_CAPTURE_RETRIES;
  const captureRetryBaseDelayMs =
    options.captureRetryBaseDelayMs ?? DEFAULT_CAPTURE_RETRY_BASE_DELAY_MS;
  const captureRetryDeadlineMs =
    options.captureRetryDeadlineMs ?? DEFAULT_CAPTURE_RETRY_DEADLINE_MS;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsRegistry = yield* VcsDriverRegistry;
  /** Checkouts on volumes that reject full flushes (macOS network mounts). */
  const writeoutOnlyCheckouts = new Set<string>();
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
    execute: (input: GitExecution) =>
      vcsRegistry
        .resolve({ cwd: input.cwd, requestedKind: "git" })
        .pipe(Effect.flatMap((handle) => handle.driver.execute(input))),
  };

  const rememberWriteoutOnly = (cwd: string) =>
    Effect.suspend(() => {
      if (writeoutOnlyCheckouts.has(cwd)) return Effect.void;
      if (writeoutOnlyCheckouts.size >= WRITEOUT_ONLY_CHECKOUT_LIMIT) {
        writeoutOnlyCheckouts.clear();
      }
      writeoutOnlyCheckouts.add(cwd);
      return Effect.logWarning("checkpoint writes fell back to writeout-only flushes", { cwd });
    });

  /**
   * Runs a command that writes objects or refs with their flushes on, and with
   * git's messages untranslated so its failures can be classified. On macOS a
   * failed flush (network mounts reject full flushes) gets one writeout-only
   * rerun. Once git has said the volume does not support the flush and the
   * rerun succeeds, the checkout stays on writeout-only. A ref write failure
   * comes without a reason (it may have been a disk that was full a moment
   * ago), so it gets the rerun but is never remembered. Linux and Windows
   * never fall back. Nothing else is rerun here.
   */
  const runDurableGit = (
    input: Omit<GitExecution, "allowNonZeroExit">,
  ): Effect.Effect<VcsProcessOutput, VcsError> => {
    const env = { ...input.env, ...gitCMessagesEnv({ ...process.env, ...input.env }) };
    const run = (prefix: ReadonlyArray<string>) =>
      vcs.execute({ ...input, env, args: [...prefix, ...input.args] });
    if (platform !== "darwin") return run(durableWriteArgs(platform));
    if (writeoutOnlyCheckouts.has(input.cwd)) return run(WRITEOUT_ONLY_DURABLE_WRITE_ARGS);
    return run(durableWriteArgs(platform)).pipe(
      Effect.catchTag("VcsProcessExitError", (error) => {
        const kind = classifyGitExitDetail(error.detail);
        if (kind === "flush-unsupported") {
          return run(WRITEOUT_ONLY_DURABLE_WRITE_ARGS).pipe(
            Effect.tap(() => rememberWriteoutOnly(input.cwd)),
          );
        }
        return kind === "ref-write-failed"
          ? run(WRITEOUT_ONLY_DURABLE_WRITE_ARGS)
          : Effect.fail(error);
      }),
    );
  };

  /**
   * Runs one capture step and reruns it after a transient failure (a file
   * that vanished or shrank while git read it, a lock another process held)
   * while the capture's retry budget and deadline allow. The input's
   * environment must already carry {@link gitCMessagesEnv}.
   *
   * Only capture steps are rerun, and each is idempotent: `add`, `read-tree`,
   * `update-index` and `write-tree` change only the private scratch index,
   * through its lock and a rename, and only on success; objects are
   * content-addressed; `update-ref` points one Ryco-owned ref at a fixed
   * commit. A git killed by a signal (reading a file over 32 KiB that shrinks
   * mid-read dies with SIGBUS) can leave the scratch `index.lock` behind; it
   * fails with another error than `VcsProcessExitError` and is never rerun. A
   * rerun of such a death would first have to remove that lock, which only
   * Ryco can hold.
   */
  const runCaptureStep = (
    input: Omit<GitExecution, "allowNonZeroExit">,
    durable: boolean,
    budget: CaptureRetryBudget,
  ): Effect.Effect<VcsProcessOutput, VcsError> =>
    (durable ? runDurableGit(input) : vcs.execute(input)).pipe(
      Effect.catchTag("VcsProcessExitError", (error) =>
        Effect.gen(function* () {
          const kind = classifyGitExitDetail(error.detail);
          if (!isTransientGitExitKind(kind) || budget.retriesUsed >= captureRetries) {
            return yield* error;
          }
          const retry = budget.retriesUsed + 1;
          const delayMs = captureRetryDelayMs(retry, captureRetryBaseDelayMs, yield* Random.next);
          const nowMs = yield* Clock.currentTimeMillis;
          if (nowMs + delayMs > budget.startedAtMs + captureRetryDeadlineMs) {
            return yield* error;
          }
          budget.retriesUsed = retry;
          yield* Effect.logDebug("checkpoint capture retrying a transient git failure", {
            cwd: input.cwd,
            step: gitSubcommand(input.args),
            kind,
            retry,
            delayMs,
          });
          // A zero delay skips the sleep, which a test clock would never end.
          if (delayMs > 0) yield* Effect.sleep(Duration.millis(delayMs));
          return yield* runCaptureStep(input, durable, budget);
        }),
      ),
    );

  /**
   * True only when git answers that the embedded repository's HEAD does not
   * resolve, which is what `git add` refuses: `rev-parse --verify --quiet`
   * exits 1 for that. The probe reads refs only, like `add`, never an object:
   * the repository and its config are the agent's, and reading a commit it
   * lacks in a partial clone fetches it through a command that config names.
   * Any other outcome keeps the repository in the capture, as `git add`
   * decides it (a probe can fail where `add` does not: git refuses to open a
   * repository another user owns, but `add` still records it as a gitlink).
   * Keeping one wrongly at worst fails the capture as before; excluding one
   * would silently drop it.
   */
  const isRepositoryWithoutCommit = (
    driver: VcsDriverShape,
    input: { readonly operation: string; readonly cwd: string },
    entry: string,
  ) =>
    Effect.gen(function* () {
      const directory = path.resolve(input.cwd, entry);
      // A directory or a gitfile.
      if (!(yield* fs.exists(path.join(directory, ".git")))) return false;
      const probe = yield* driver.execute({
        operation: input.operation,
        cwd: directory,
        args: ["rev-parse", "--verify", "--quiet", "HEAD"],
        allowNonZeroExit: true,
        timeoutMs: NESTED_REPOSITORY_PROBE_TIMEOUT_MS,
        // The ceiling keeps git from walking up into the outer repository
        // when the embedded `.git` is unusable.
        env: { ...NESTED_REPOSITORY_PROBE_ENV, GIT_CEILING_DIRECTORIES: path.dirname(directory) },
      });
      return probe.exitCode === 1;
    }).pipe(
      Effect.catch((error) =>
        Effect.logDebug("checkpoint capture could not probe an embedded repository", {
          cwd: input.cwd,
          entry,
          error: error.message,
        }).pipe(Effect.as(false)),
      ),
    );

  /**
   * `add` exclusion pathspecs, relative to `cwd`, for the untracked embedded
   * repositories whose HEAD has no commit: `add -A` refuses each of them and
   * names only the first. Embedded repositories with a commit stay included
   * and are recorded as gitlinks, as before. Empty when the search fails,
   * times out or finds too many; the capture then fails as it did before.
   */
  const findEmptyNestedRepositoryExclusions = (input: {
    readonly operation: string;
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly indexConfig: ReadonlyArray<string>;
  }): Effect.Effect<ReadonlyArray<string>> =>
    Effect.gen(function* () {
      // The driver itself rather than `vcs.execute`: probing the embedded
      // repositories must not fill the registry's detection cache with them.
      const { driver } = yield* vcsRegistry.resolve({ cwd: input.cwd, requestedKind: "git" });
      const listed = yield* driver.execute({
        operation: input.operation,
        cwd: input.cwd,
        // Untracked relative to the scratch index. Without `--directory`, the
        // only directories listed (with a trailing slash) are embedded
        // repositories git did not descend into, also inside untracked ones.
        args: [...input.indexConfig, "ls-files", "--others", "--exclude-standard", "-z", "--", "."],
        env: input.env,
        maxOutputBytes: NESTED_REPOSITORY_LISTING_MAX_BYTES,
        truncateOutputAtMaxBytes: true,
      });
      if (listed.stdoutTruncated) {
        yield* Effect.logWarning(
          "checkpoint capture could not list untracked files to find empty embedded repositories",
          { cwd: input.cwd, maxBytes: NESTED_REPOSITORY_LISTING_MAX_BYTES },
        );
        return [];
      }
      const candidates = listed.stdout.split("\0").filter((entry) => entry.endsWith("/"));
      if (candidates.length > NESTED_REPOSITORY_CANDIDATE_LIMIT) {
        yield* Effect.logWarning("checkpoint capture found too many embedded repositories", {
          cwd: input.cwd,
          count: candidates.length,
        });
        return [];
      }
      const withoutCommit = yield* Effect.forEach(
        candidates,
        (entry) => isRepositoryWithoutCommit(driver, input, entry),
        { concurrency: NESTED_REPOSITORY_PROBE_CONCURRENCY },
      );
      const exclusions = candidates.filter((_, index) => withoutCommit[index] === true);
      if (exclusions.length > NESTED_REPOSITORY_EXCLUSION_LIMIT) {
        yield* Effect.logWarning(
          "checkpoint capture found too many embedded repositories without a commit",
          { cwd: input.cwd, count: exclusions.length },
        );
        return [];
      }
      return exclusions;
    }).pipe(
      Effect.timeoutOption(NESTED_REPOSITORY_DISCOVERY_TIMEOUT),
      Effect.flatMap(
        Option.match({
          onSome: Effect.succeed,
          onNone: () =>
            Effect.logDebug(
              "checkpoint capture timed out searching for empty embedded repositories",
              {
                cwd: input.cwd,
              },
            ).pipe(Effect.as([])),
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logDebug("checkpoint capture could not search for empty embedded repositories", {
          cwd: input.cwd,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as([])),
      ),
    );

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
        args: [...SCRATCH_INDEX_CONFIG_ARGS, "ls-files", "-v", "-z"],
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
          args: [
            ...SCRATCH_INDEX_CONFIG_ARGS,
            "update-index",
            "--no-assume-unchanged",
            "-z",
            "--stdin",
          ],
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
        // Starts once the checkout is ours: time spent waiting behind a
        // restore does not count against the retry deadline.
        const budget: CaptureRetryBudget = {
          startedAtMs: yield* Clock.currentTimeMillis,
          retriesUsed: 0,
        };
        const tempIndexPath = path.join(tempDir, `index-${randomUUID()}`);
        const commitEnv: NodeJS.ProcessEnv = {
          ...process.env,
          GIT_INDEX_FILE: tempIndexPath,
          GIT_AUTHOR_NAME: "Ryco",
          GIT_AUTHOR_EMAIL: "ryco@users.noreply.github.com",
          GIT_COMMITTER_NAME: "Ryco",
          GIT_COMMITTER_EMAIL: "ryco@users.noreply.github.com",
          ...gitCMessagesEnv(process.env),
        };
        const step = (
          args: ReadonlyArray<string>,
          options: {
            readonly durable: boolean;
            readonly env?: NodeJS.ProcessEnv;
            readonly timeoutMs?: number;
          },
        ) =>
          runCaptureStep(
            {
              operation,
              cwd: input.cwd,
              args,
              env: options.env ?? commitEnv,
              ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
            },
            options.durable,
            budget,
          );

        const seeded = yield* seedIndexFromCheckout({
          operation,
          cwd: input.cwd,
          tempIndexPath,
          env: commitEnv,
        });
        // A HEAD-seeded index has no fsmonitor token, so fsmonitor would only
        // add a call to the user's daemon or hook.
        const indexConfig = seeded
          ? SCRATCH_INDEX_CONFIG_ARGS
          : [...SCRATCH_INDEX_CONFIG_ARGS, ...NO_FSMONITOR_CONFIG_ARGS];
        if (!seeded) {
          // A partly prepared copy must not leak into the HEAD-seeded index.
          yield* fs.remove(tempIndexPath, { force: true });
          const headExists = yield* hasHeadCommit(input.cwd);
          if (headExists) {
            yield* step([...indexConfig, "read-tree", "HEAD"], { durable: false });
          }
        }

        const stage = (exclusions: ReadonlyArray<string>) =>
          step([...indexConfig, "add", "-A", "--", ".", ...exclusions], {
            durable: true,
            timeoutMs: CAPTURE_OBJECT_WRITE_TIMEOUT_MS,
          });
        yield* stage([]).pipe(
          Effect.catchTag("VcsProcessExitError", (error) =>
            classifyGitExitDetail(error.detail) === "nested-repository-without-commit"
              ? findEmptyNestedRepositoryExclusions({
                  operation,
                  cwd: input.cwd,
                  env: commitEnv,
                  indexConfig,
                }).pipe(
                  Effect.flatMap((excluded) =>
                    excluded.length === 0
                      ? Effect.fail(error)
                      : Effect.logInfo("checkpoint capture excluded empty nested repositories", {
                          cwd: input.cwd,
                          count: excluded.length,
                          sample: excluded.slice(0, 5),
                        }).pipe(
                          Effect.andThen(
                            stage(excluded.map((entry) => `:(exclude,literal)${entry}`)),
                          ),
                        ),
                  ),
                )
              : Effect.fail(error),
          ),
        );

        const writeTreeResult = yield* step([...indexConfig, "write-tree"], {
          durable: true,
          timeoutMs: CAPTURE_OBJECT_WRITE_TIMEOUT_MS,
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
        const commitTreeResult = yield* step(["commit-tree", treeOid, "-m", message], {
          durable: true,
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

        yield* step([...NO_USER_HOOK_ARGS, "update-ref", input.checkpointRef, commitOid], {
          durable: true,
          env: gitCMessagesEnv(process.env),
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

    // Deleting a packed ref rewrites `packed-refs`, which holds the user's
    // packed branches and tags too, so the rewrite is flushed.
    yield* Effect.forEach(
      input.checkpointRefs,
      (checkpointRef) =>
        runDurableGit({
          operation,
          cwd: input.cwd,
          args: [...NO_USER_HOOK_ARGS, "update-ref", "-d", checkpointRef],
        }).pipe(
          Effect.catchTag("VcsProcessExitError", (error) =>
            Effect.logDebug("checkpoint ref delete failed", {
              cwd: input.cwd,
              checkpointRef,
              detail: error.detail,
            }),
          ),
        ),
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
    yield* runDurableGit({
      operation,
      cwd: input.cwd,
      args: [...NO_USER_HOOK_ARGS, "update-ref", input.ref, input.commit],
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

export const makeCheckpointStoreLayer = (options?: CheckpointStoreOptions) =>
  Layer.effect(CheckpointStore, makeCheckpointStore(options));

export const CheckpointStoreLive = makeCheckpointStoreLayer();
