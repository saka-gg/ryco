/**
 * Git arguments, environment and failure classification for the objects, refs
 * and scratch indexes Ryco itself writes into a user's repository (checkpoint
 * captures, fork pins, checkpoint ref deletes).
 *
 * Git version facts these rely on:
 * - `core.fsync`, its `objects` and `reference` components and
 *   `core.fsyncMethod` `fsync` / `writeout-only` exist since git 2.36;
 *   `core.fsyncMethod=batch` since 2.37. Git 2.36 warns about the unknown
 *   `batch` and keeps the value set before it, which is why `fsync` comes
 *   first. Git older than 2.36 ignores unknown `-c` keys: writes then behave
 *   as they always did, only without the flushes.
 * - Git's default components (`committed,-loose-object`) flush neither loose
 *   objects nor refs, and its default method on macOS (`writeout-only`) does
 *   not flush the drive's cache. Explicit `fsync` on macOS is `F_FULLFSYNC`.
 * - `batch` defers only loose-object flushes to one flush per command; refs
 *   are still flushed as with `fsync`. Git documents `batch` as safe on macOS
 *   (HFS+/APFS) and Windows (NTFS/ReFS) only, so other platforms keep `fsync`.
 * - Git reuses an object that already exists instead of writing it again
 *   (it only freshens its mtime), so an object written earlier without a
 *   flush is not flushed by these settings either.
 * - `core.hooksPath=/dev/null` silences the hook directory but not hooks
 *   defined in config (`hook.<name>.command`, git 2.54 and later);
 *   `hook.<event>.enabled=false` silences those (git 2.55 and later) but not
 *   the hook directory, so both are passed. Git 2.54 reads the second as a
 *   hook named after the event and still runs config-defined hooks; older git
 *   ignores the key.
 *
 * @module GitDurableWrites
 */

/**
 * Environment overrides that make git print its messages untranslated (the C
 * locale), so {@link classifyGitExitDetail} can read them: git localizes even
 * without `LANG` or `LC_*`, because macOS gettext falls back to the system
 * languages. Only the message category changes. User code git runs (clean
 * filters, the fsmonitor hook) keeps the user's character-type and other
 * categories: `LC_ALL`, which would override `LC_MESSAGES`, is lifted and its
 * value restated per category. Undefined values remove a variable when the
 * overrides are merged into a child process environment.
 */
export const gitCMessagesEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const all = env.LC_ALL;
  return {
    ...(all
      ? {
          LC_CTYPE: all,
          LC_COLLATE: all,
          LC_NUMERIC: all,
          LC_TIME: all,
          LC_MONETARY: all,
        }
      : {}),
    LC_ALL: undefined,
    LC_MESSAGES: "C",
  };
};

const DURABLE_WRITE_ARGS = Object.freeze([
  "-c",
  "core.fsync=objects,reference",
  "-c",
  "core.fsyncMethod=fsync",
] as const);
const BATCH_DURABLE_WRITE_ARGS = Object.freeze([
  ...DURABLE_WRITE_ARGS,
  "-c",
  "core.fsyncMethod=batch",
] as const);

/**
 * Leading arguments that flush every loose object and ref a command writes
 * before git publishes it: one batched flush per command where git documents
 * that as safe (macOS, Windows), a flush per file elsewhere.
 */
export const durableWriteArgs = (platform: NodeJS.Platform): ReadonlyArray<string> =>
  platform === "darwin" || platform === "win32" ? BATCH_DURABLE_WRITE_ARGS : DURABLE_WRITE_ARGS;

/**
 * macOS only: plain `fsync(2)` without the drive-cache flush, for volumes that
 * reject `F_FULLFSYNC` (network mounts). On Linux `writeout-only` only starts
 * writeback, so it is never used there.
 */
export const WRITEOUT_ONLY_DURABLE_WRITE_ARGS = Object.freeze([
  "-c",
  "core.fsync=objects,reference",
  "-c",
  "core.fsyncMethod=writeout-only",
] as const);

/**
 * Leading arguments that keep the user's hooks out of Ryco's own index and
 * ref writes: `post-index-change` (a scratch index is not the user's index)
 * and `reference-transaction` (Ryco's hidden refs are not the user's refs; a
 * hook that rejects them would fail the write).
 */
export const NO_USER_HOOK_ARGS = Object.freeze([
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "hook.post-index-change.enabled=false",
  "-c",
  "hook.reference-transaction.enabled=false",
] as const);

/**
 * Leading arguments of every command that writes a private scratch index:
 * never split it (a split write leaves a full `sharedindex.*` copy in the
 * user's `.git`) and never run the user's hooks for it.
 */
export const SCRATCH_INDEX_CONFIG_ARGS = Object.freeze([
  "-c",
  "core.splitIndex=false",
  ...NO_USER_HOOK_ARGS,
] as const);

/**
 * Added for a scratch index built from `read-tree`: it has no fsmonitor token
 * to reuse, so the user's fsmonitor daemon or hook would only add a call.
 */
export const NO_FSMONITOR_CONFIG_ARGS = Object.freeze(["-c", "core.fsmonitor=false"] as const);

/** The subcommand of a git argument list, after its leading `-c <key=value>` pairs. */
export const gitSubcommand = (args: ReadonlyArray<string>): string | undefined => {
  let index = 0;
  while (args[index] === "-c") index += 2;
  return args[index];
};

export type GitExitFailureKind =
  /** Another process holds a lock git needs (`Unable to create '….lock': File exists`). */
  | "lock-contention"
  /**
   * A working-tree file changed while git read it: deleted between listing and
   * reading, or rewritten in place to a shorter length.
   */
  | "worktree-race"
  /**
   * The volume rejected the requested flush (`fsync error on …: Operation not
   * supported`; network mounts on macOS).
   */
  | "flush-unsupported"
  /**
   * Git could not write or flush a ref's lock file and printed no reason: a
   * volume that rejects full flushes, or a full or failing disk.
   */
  | "ref-write-failed"
  /** `git add` met an embedded repository whose HEAD has no commit. */
  | "nested-repository-without-commit"
  | "other";

const FLUSH_UNSUPPORTED_PATTERN = /fsync error on [^\r\n]+: operation not supported\r?$/im;
const REF_WRITE_FAILED_PATTERN =
  /cannot update ref [^\r\n]+: couldn't write '[^\r\n]+\.lock'\r?$/im;
const LOCK_CONTENTION_PATTERN = /unable to create [^\n]*\.lock['"]?: file exists/i;
const WORKTREE_RACE_PATTERNS = [
  /(?:unable to stat|lstat\(|error: open\()[^\n]+: no such file or directory/i,
  /short read while indexing /i,
];
const NESTED_REPOSITORY_WITHOUT_COMMIT_PATTERN =
  /^error: '[^'\r\n]+\/' does not have a commit checked out\r?$/m;

/**
 * Classifies the stderr of a failed git command. Git must have run with
 * {@link gitCMessagesEnv}: a translated message is always `other`.
 */
export const classifyGitExitDetail = (detail: string): GitExitFailureKind => {
  if (FLUSH_UNSUPPORTED_PATTERN.test(detail)) return "flush-unsupported";
  if (REF_WRITE_FAILED_PATTERN.test(detail)) return "ref-write-failed";
  if (LOCK_CONTENTION_PATTERN.test(detail)) return "lock-contention";
  if (WORKTREE_RACE_PATTERNS.some((pattern) => pattern.test(detail))) return "worktree-race";
  if (NESTED_REPOSITORY_WITHOUT_COMMIT_PATTERN.test(detail)) {
    return "nested-repository-without-commit";
  }
  return "other";
};

/** Failures that a rerun of the same idempotent command can get past. */
export const isTransientGitExitKind = (kind: GitExitFailureKind): boolean =>
  kind === "lock-contention" || kind === "worktree-race";
