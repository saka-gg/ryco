/**
 * GitTemporaryIndex - seeding a throwaway index (`GIT_INDEX_FILE`) from a checkout's real one.
 *
 * Checkpoint capture and the cross-node project export both record the working tree with
 * `add -A` into a temporary index, never touching the checkout's own index. Seeding that index
 * with a copy of the real one lets `add -A` reuse its stat data instead of rehashing every
 * tracked file.
 *
 * @module GitTemporaryIndex
 */
import { Cause, Effect, Option } from "effect";
import type { FileSystem, Path } from "effect";

import { SCRATCH_INDEX_CONFIG_ARGS } from "./GitDurableWrites.ts";

/** `ls-files -v` of the seeded index; a larger listing falls back to `read-tree HEAD`. */
const TEMPORARY_INDEX_LISTING_MAX_BYTES = 64 * 1024 * 1024;

/** One git command, as the checkpoint store's VCS driver and the git driver both run them. */
export interface TemporaryIndexGitCommand {
  readonly operation: string;
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowNonZeroExit?: boolean;
  readonly maxOutputBytes?: number;
  readonly truncateOutputAtMaxBytes?: boolean;
}

export type TemporaryIndexGit<E> = (input: TemporaryIndexGitCommand) => Effect.Effect<
  {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stdoutTruncated: boolean;
  },
  E
>;

/**
 * Seeds the temporary index at `tempIndexPath` with a copy of the checkout's real index, so
 * `add -A` reuses its stat data instead of rehashing every tracked file (the fresh `read-tree
 * HEAD` index has none). The resulting tree is the same as `read-tree HEAD` + `add -A`:
 * assume-unchanged entries are re-armed on the copy so `add -A` stats them. False when the copy
 * cannot give that tree and the caller must seed from HEAD instead: no index yet, a split index,
 * or skip-worktree entries (`add -A` keeps their index version where `read-tree HEAD` yields the
 * HEAD version). Never fails.
 *
 * `env` must point `GIT_INDEX_FILE` at `tempIndexPath`; the real index is located without it.
 * Commands on the copy never split it and never run the user's hooks (`SCRATCH_INDEX_CONFIG_ARGS`).
 */
export const seedIndexFromCheckout = <E>(input: {
  readonly git: TemporaryIndexGit<E>;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly operation: string;
  readonly cwd: string;
  readonly tempIndexPath: string;
  readonly env: NodeJS.ProcessEnv;
}): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const { fs, path } = input;
    // `--git-path` resolves the per-worktree index of a linked worktree.
    const located = yield* input.git({
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

    const listed = yield* input.git({
      operation: input.operation,
      cwd: input.cwd,
      args: [...SCRATCH_INDEX_CONFIG_ARGS, "ls-files", "-v", "-z"],
      env: input.env,
      maxOutputBytes: TEMPORARY_INDEX_LISTING_MAX_BYTES,
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
      yield* input.git({
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
      Effect.logDebug("could not seed a temporary index from the checkout index", {
        operation: input.operation,
        cwd: input.cwd,
        cause: Cause.pretty(cause),
      }).pipe(Effect.as(false)),
    ),
  );
