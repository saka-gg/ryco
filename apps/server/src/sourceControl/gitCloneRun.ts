/**
 * gitCloneRun - runs the one-shot `sourceControl.cloneRepository` clone.
 *
 * `SourceControlRepositoryService` loads this module with `import()` on the first clone, so none of
 * it is in the server's boot chunk. It serves only that RPC (the command palette and older
 * clients); the cross-node project import has its own git runner.
 *
 * - **Detached.** A clone runs in a fiber that lives as long as the service, keyed by its
 *   destination and remote URL. A request only joins it, so a dropped connection (a hidden tab,
 *   machine sleep, a hosted relay re-attempt) does not stop it. The same request again joins the
 *   running clone, or gets its outcome while the repository it describes is still at the
 *   destination (kept {@link CLONE_OUTCOME_RETENTION_MS}). A clone nobody waits for during
 *   {@link CLONE_ORPHAN_GRACE_MS} is stopped and its staging folder removed.
 * - **No wall-clock limit.** git runs with `--progress`, and a clone fails only after
 *   {@link CLONE_STALL_TIMEOUT_MS} without any output.
 * - **Staging.** git clones into a hidden sibling of the destination, which is moved onto the
 *   destination by rename once complete, so a failure, a stop or a crash never leaves a partial
 *   checkout there. A repository git fetched completely but could not check out (a failing LFS
 *   smudge filter or post-checkout hook) is published anyway, with an error that says so.
 * - **Errors** are git's last real messages, credential-redacted, never its progress redraws or
 *   the raw command error (which holds the command line and all of stderr).
 * - At most {@link CLONE_CONCURRENCY} clones run at once.
 *
 * @module gitCloneRun
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rename, rm, rmdir, stat } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

import {
  SourceControlRepositoryError,
  type SourceControlCloneRepositoryResult,
  type SourceControlProviderKind,
} from "@ryco/contracts";
import { redactDiagnosticText } from "@ryco/shared/diagnosticRedaction";
import { Clock, Effect, Exit, Fiber, FiberMap, Result, Schedule, Semaphore } from "effect";

import { processIsAlive } from "../device/bootOwnership.ts";
import { GIT_PROCESS_LIMIT } from "../processGovernor.ts";
import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

/** A clone fails after this long without any output (the cross-node import uses the same). */
export const CLONE_STALL_TIMEOUT_MS = 5 * 60_000;
/** A clone no request has waited for during this long is stopped. */
export const CLONE_ORPHAN_GRACE_MS = 10 * 60_000;
/** How long a finished clone's outcome answers the same request again. */
export const CLONE_OUTCOME_RETENTION_MS = 30 * 60_000;
/**
 * The collected output stays this small; the line callbacks see everything. Nothing reads the
 * collected text once the failure tail exists, so it only bounds memory.
 */
export const CLONE_KEPT_OUTPUT_BYTES = 16 * 1024;
/** git's last messages that explain a failure. */
export const CLONE_FAILURE_TAIL_LINES = 4;
const CLONE_FAILURE_LINE_MAX_CHARS = 500;
const CLONE_FAILURE_DETAIL_MAX_CHARS = 1_000;
const CLONE_FAILURE_LOG_MAX_CHARS = 2_000;
/**
 * A clone holds one git process permit for its whole life, so clones take at most half of the
 * process pool and background git work (status, sweeps) keeps room.
 */
export const CLONE_CONCURRENCY = Math.min(2, Math.max(1, Math.floor(GIT_PROCESS_LIMIT / 2)));
const cloneSlots = Semaphore.makeUnsafe(CLONE_CONCURRENCY);
/**
 * On top of `execute`'s `LC_ALL=C LANG=C`: the progress meters start at once, no terminal prompt
 * can hang the clone, and git-lfs prints progress to a pipe so an LFS checkout keeps the stall
 * limit fed.
 */
export const CLONE_ENV: Readonly<Record<string, string>> = {
  GIT_PROGRESS_DELAY: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_LFS_FORCE_PROGRESS: "1",
};
export const CLONE_STAGING_MARKER = ".ryco-clone-";

const PROGRESS_LINE =
  /^(?:remote:\s*)?(?:Enumerating objects|Counting objects|Compressing objects|Receiving objects|Resolving deltas|Unpacking objects|Updating files|Checking out files|Checking connectivity|Filtering content)\b/iu;
const REMOTE_TOTAL_LINE = /^remote:\s*Total \d+/u;

/** A progress-meter redraw, never part of an error message. */
export function isGitCloneProgressLine(line: string): boolean {
  const trimmed = line.trim();
  return PROGRESS_LINE.test(trimmed) || REMOTE_TOTAL_LINE.test(trimmed);
}

/** User-facing detail from git's last messages. */
export function cloneFailureDetail(
  tail: ReadonlyArray<string>,
  fallback = "The repository could not be cloned.",
): string {
  const joined = tail.join(" ").trim();
  if (joined.length === 0) return fallback;
  return joined.length <= CLONE_FAILURE_DETAIL_MAX_CHARS
    ? joined
    : `…${joined.slice(-(CLONE_FAILURE_DETAIL_MAX_CHARS - 1)).trimStart()}`;
}

const tailOfText = (text: string, maxChars: number): string => {
  const trimmed = text.trim();
  return trimmed.length <= maxChars ? trimmed : `…${trimmed.slice(-(maxChars - 1))}`;
};

const errnoOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

const messageOf = (error: unknown): string =>
  error instanceof Error && error.message.length > 0 ? error.message : String(error);

// ---------------------------------------------------------------------------------------------
// Staging names
// ---------------------------------------------------------------------------------------------

/**
 * The part of the destination's name a staging name keeps: whole code points within a byte
 * budget, so the name fits NAME_MAX (255 bytes). On Windows it is much shorter, because every
 * checked-out path grows by the staging name's extra length and deep repositories would pass
 * MAX_PATH (260) without `core.longpaths`.
 */
function stagingNamePart(directoryName: string, platform: NodeJS.Platform): string {
  const maxBytes = platform === "win32" ? 16 : 120;
  let part = "";
  let bytes = 0;
  for (const character of directoryName) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes) break;
    part += character;
    bytes += size;
  }
  return part;
}

/** A fresh random token: a UUID, or 8 hex characters on Windows (see {@link stagingNamePart}). */
export function cloneStagingToken(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? randomBytes(4).toString("hex") : randomUUID();
}

/**
 * This machine, in staging names. A pid means something only on the machine that wrote it, so
 * the leftover sweep leaves alone the staging folders another machine's server is cloning into
 * when the parent folder is shared (a synced or network folder, a container bind mount).
 */
export const CLONE_STAGING_HOST = createHash("sha256").update(hostname()).digest("hex").slice(0, 6);

/** `.<name>.ryco-clone-<host>-<pid>-<token>`: hidden, and owned by server process `pid` on `host`. */
export function cloneStagingDirectoryName(
  directoryName: string,
  options: {
    readonly token: string;
    readonly host?: string;
    readonly pid?: number;
    readonly platform?: NodeJS.Platform;
  },
): string {
  const platform = options.platform ?? process.platform;
  const host = options.host ?? CLONE_STAGING_HOST;
  const pid = options.pid ?? process.pid;
  return `.${stagingNamePart(directoryName, platform)}${CLONE_STAGING_MARKER}${host}-${pid}-${options.token}`;
}

const STAGING_SUFFIX =
  /^([0-9a-f]{6})-(\d+)-(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{8})$/u;

/** The server that owns a staging folder of `directoryName`, or null for other entries. */
export function cloneStagingOwner(
  entry: string,
  directoryName: string,
  platform: NodeJS.Platform = process.platform,
): { readonly host: string; readonly pid: number } | null {
  const prefix = `.${stagingNamePart(directoryName, platform)}${CLONE_STAGING_MARKER}`;
  if (!entry.startsWith(prefix)) return null;
  const match = STAGING_SUFFIX.exec(entry.slice(prefix.length));
  return match ? { host: match[1]!, pid: Number(match[2]) } : null;
}

/**
 * Names of the staging folders this process is cloning into right now; the leftover sweep skips
 * them. Names, not paths: the random token makes a name unique, and two requests may spell the
 * same parent folder differently (a symbolic link, letter case).
 */
const liveStagingNames = new Set<string>();

// ---------------------------------------------------------------------------------------------
// Filesystem steps
// ---------------------------------------------------------------------------------------------

/** Renames, retrying the transient EPERM/EBUSY Windows reports while a scanner holds a file. */
export const renameWithRetry = async (from: string, to: string): Promise<void> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = errnoOf(error);
      const transient = process.platform === "win32" && (code === "EPERM" || code === "EBUSY");
      if (attempt >= 4 || !transient) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
    }
  }
};

/** Removes a staging folder, retried a few times; never fails (a leftover is only logged). */
const removeStagingDirectory = (stagingPath: string): Effect.Effect<void> =>
  Effect.tryPromise(() => rm(stagingPath, { recursive: true, force: true })).pipe(
    Effect.retry({ times: 4, schedule: Schedule.spaced("200 millis") }),
    Effect.catch((error) =>
      Effect.logWarning("clone staging folder could not be removed", {
        stagingPath,
        error: messageOf(error.cause),
      }),
    ),
  );

/**
 * Removes this destination's staging folders that a server process on this machine left behind:
 * it died (crash, SIGKILL after a quit timeout, power loss) before it could remove them. Folders
 * of a live server, including this one's running clones, and of other machines stay. Best effort.
 */
const sweepLeftoverStaging = (destination: PreparedCloneDestination): Effect.Effect<void> =>
  Effect.promise(async () => {
    let entries: string[];
    try {
      entries = await readdir(destination.parentPath);
    } catch {
      return [];
    }
    const leftovers: string[] = [];
    for (const entry of entries) {
      const owner = cloneStagingOwner(entry, destination.directoryName);
      if (owner === null || owner.host !== CLONE_STAGING_HOST) continue;
      if (liveStagingNames.has(entry)) continue;
      if (owner.pid !== process.pid && processIsAlive(owner.pid)) continue;
      leftovers.push(path.join(destination.parentPath, entry));
    }
    return leftovers;
  }).pipe(
    Effect.flatMap((leftovers) =>
      Effect.forEach(
        leftovers,
        (stagingPath) =>
          Effect.logInfo("removing a clone staging folder a stopped server left behind", {
            stagingPath,
          }).pipe(Effect.andThen(removeStagingDirectory(stagingPath))),
        { discard: true },
      ),
    ),
  );

export interface CloneTarget {
  readonly parentPath: string;
  readonly directoryName: string;
}

export interface PreparedCloneDestination extends CloneTarget {
  readonly destinationPath: string;
}

const repositoryError = (provider: SourceControlProviderKind, detail: string) =>
  new SourceControlRepositoryError({ operation: "cloneRepository", provider, detail });

/**
 * Why the clone must run in the destination itself, as before staging existed, or null. A
 * symlinked destination or a mount point cannot be replaced by a rename (and publishing would fail
 * only after the whole clone), and a parent the server cannot write to takes no sibling.
 */
const inPlaceReason = (destination: PreparedCloneDestination): Effect.Effect<string | null> =>
  Effect.promise(async () => {
    const entry = await lstat(destination.destinationPath).catch(() => null);
    if (entry === null) return null;
    if (entry.isSymbolicLink()) return "the destination is a symbolic link";
    const parent = await stat(destination.parentPath).catch(() => null);
    return parent !== null && parent.dev !== entry.dev ? "the destination is a mount point" : null;
  });

type StagingFolder =
  | { readonly kind: "staging"; readonly path: string; readonly name: string }
  | { readonly kind: "inPlace"; readonly reason: string };

/** Creates the staging sibling (non-recursively: the parent exists), or says to clone in place. */
const createStagingFolder = (
  destination: PreparedCloneDestination,
  provider: SourceControlProviderKind,
  allowStagingAt: (stagingPath: string) => Effect.Effect<boolean>,
): Effect.Effect<StagingFolder, SourceControlRepositoryError> =>
  Effect.gen(function* () {
    const blocked = yield* inPlaceReason(destination);
    if (blocked !== null) return { kind: "inPlace", reason: blocked } as const;
    for (let attempt = 0; ; attempt += 1) {
      const name = cloneStagingDirectoryName(destination.directoryName, {
        token: cloneStagingToken(),
      });
      const stagingPath = path.join(destination.parentPath, name);
      if (!(yield* allowStagingAt(stagingPath))) {
        return { kind: "inPlace", reason: "the destination is the workspace root" } as const;
      }
      liveStagingNames.add(name);
      const created = yield* Effect.tryPromise(() => mkdir(stagingPath)).pipe(
        Effect.as("created" as const),
        Effect.catch((error) => {
          liveStagingNames.delete(name);
          const code = errnoOf(error.cause);
          if (code === "EEXIST" && attempt < 4) return Effect.succeed("retry" as const);
          if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
            return Effect.succeed("unwritable" as const);
          }
          return Effect.fail(
            repositoryError(
              provider,
              `Could not create a working folder next to ${destination.destinationPath}: ${messageOf(error.cause)}`,
            ),
          );
        }),
      );
      if (created === "created") return { kind: "staging", path: stagingPath, name } as const;
      if (created === "unwritable") {
        return { kind: "inPlace", reason: "the parent folder is not writable" } as const;
      }
    }
  });

/**
 * Moves a finished staging folder onto the destination. On POSIX one rename does it: it replaces
 * an empty destination folder atomically and fails when the folder is no longer empty. Windows
 * cannot rename onto a folder, so the empty folder goes first, and comes back if the move fails.
 */
const publishStagingFolder = (
  stagingPath: string,
  destination: PreparedCloneDestination,
  provider: SourceControlProviderKind,
): Effect.Effect<void, SourceControlRepositoryError> =>
  Effect.tryPromise({
    try: async () => {
      if (process.platform !== "win32") {
        await rename(stagingPath, destination.destinationPath);
        return;
      }
      let removedEmptyFolder = false;
      try {
        await rmdir(destination.destinationPath);
        removedEmptyFolder = true;
      } catch (error) {
        if (errnoOf(error) !== "ENOENT") throw error;
      }
      try {
        await renameWithRetry(stagingPath, destination.destinationPath);
      } catch (error) {
        if (removedEmptyFolder) {
          await mkdir(destination.destinationPath).catch(() => undefined);
        }
        throw error;
      }
    },
    catch: (error) => {
      const code = errnoOf(error);
      return repositoryError(
        provider,
        code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOTDIR"
          ? `${destination.destinationPath} is no longer empty: something was written to it during the clone.`
          : `Could not move the clone into ${destination.destinationPath}: ${messageOf(error)}`,
      );
    },
  });

/**
 * Runs `run` against a hidden staging sibling of the destination and moves the result onto the
 * destination once `run` succeeds. On any other outcome (failure, interruption) the sibling is
 * removed; the destination is never deleted, and never written to except by the final move.
 * `run` gets the destination itself, as before staging existed, when the sibling is outside the
 * workspace access root (the destination IS the root), when the destination is a symbolic link
 * or a mount point, or when the parent folder is not writable.
 */
export const withCloneStaging = <A, E, R>(
  input: {
    readonly destination: PreparedCloneDestination;
    readonly provider: SourceControlProviderKind;
    readonly allowStagingAt: (stagingPath: string) => Effect.Effect<boolean>;
  },
  run: (target: CloneTarget) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SourceControlRepositoryError, R> =>
  Effect.gen(function* () {
    const { destination, provider } = input;
    yield* sweepLeftoverStaging(destination);
    let published = false;
    return yield* Effect.acquireUseRelease(
      createStagingFolder(destination, provider, input.allowStagingAt),
      (folder) => {
        if (folder.kind === "inPlace") {
          return Effect.logDebug("cloning into the destination itself", {
            destination: destination.destinationPath,
            reason: folder.reason,
          }).pipe(
            Effect.andThen(
              run({ parentPath: destination.parentPath, directoryName: destination.directoryName }),
            ),
          );
        }
        return run({ parentPath: destination.parentPath, directoryName: folder.name }).pipe(
          Effect.tap(() =>
            Effect.uninterruptible(
              publishStagingFolder(folder.path, destination, provider).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    published = true;
                  }),
                ),
              ),
            ),
          ),
        );
      },
      (folder) =>
        folder.kind === "inPlace"
          ? Effect.void
          : Effect.suspend(() =>
              published ? Effect.void : removeStagingDirectory(folder.path),
            ).pipe(Effect.ensuring(Effect.sync(() => liveStagingNames.delete(folder.name)))),
    );
  });

// ---------------------------------------------------------------------------------------------
// The git process
// ---------------------------------------------------------------------------------------------

/**
 * How a clone that did not fail ended: `complete`, or `checkoutFailed` when git exited non-zero
 * after it had fetched the whole repository (its HEAD resolves), for example because a required
 * smudge filter (LFS quota, LFS authentication) or a post-checkout hook failed. git keeps such a
 * repository; it is published, and the caller reports `gitMessage`.
 */
export type CloneRunOutcome =
  | { readonly kind: "complete" }
  | { readonly kind: "checkoutFailed"; readonly gitMessage: string | null };

const stallDetail = `The clone stopped: git printed nothing for ${CLONE_STALL_TIMEOUT_MS / 60_000} minutes. Check the network and try again.`;

/** Whether `target` holds a repository whose HEAD resolves to a commit. */
const hasResolvableHead = (
  git: Pick<GitVcsDriver.GitVcsDriverShape, "execute">,
  target: CloneTarget,
): Effect.Effect<boolean> => {
  const gitDir = path.join(target.parentPath, target.directoryName, ".git");
  return Effect.promise(() =>
    lstat(gitDir).then(
      () => true,
      () => false,
    ),
  ).pipe(
    Effect.flatMap((hasGitDir) =>
      hasGitDir
        ? git
            .execute({
              operation: "SourceControlRepositoryService.cloneRepository.headCheck",
              cwd: target.parentPath,
              // An explicit git dir: never discover a repository the parent folder belongs to.
              args: [`--git-dir=${gitDir}`, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
              allowNonZeroExit: true,
              timeoutMs: 30_000,
              maxOutputBytes: 4_096,
            })
            .pipe(
              Effect.map((result) => result.exitCode === 0),
              Effect.orElseSucceed(() => false),
            )
        : Effect.succeed(false),
    ),
  );
};

/**
 * `git clone --progress -- <remoteUrl> <target.directoryName>` in `target.parentPath`, failed
 * after {@link CLONE_STALL_TIMEOUT_MS} without output and otherwise unlimited in time.
 * Interrupting it stops git (SIGTERM to its process group; git removes what it fetched).
 */
export const runWatchedGitClone = (input: {
  readonly git: Pick<GitVcsDriver.GitVcsDriverShape, "execute">;
  readonly target: CloneTarget;
  readonly remoteUrl: string;
  /** The askpass environment, when the provider supplies clone credentials. */
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly provider: SourceControlProviderKind;
}): Effect.Effect<CloneRunOutcome, SourceControlRepositoryError> =>
  Clock.clockWith((clock) =>
    Effect.gen(function* () {
      const tail: string[] = [];
      let lastOutputAt = clock.currentTimeMillisUnsafe();
      const observe = (line: string) =>
        Effect.sync(() => {
          lastOutputAt = clock.currentTimeMillisUnsafe();
          const trimmed = line.trim();
          if (
            trimmed.length === 0 ||
            trimmed === "done." ||
            trimmed.startsWith("Cloning into") ||
            isGitCloneProgressLine(trimmed)
          ) {
            return;
          }
          // git echoes the remote URL in some failures; the tail becomes user-facing text.
          tail.push(redactDiagnosticText(trimmed).slice(0, CLONE_FAILURE_LINE_MAX_CHARS));
          if (tail.length > CLONE_FAILURE_TAIL_LINES) tail.shift();
        });

      const stallWatch = (): Effect.Effect<never, SourceControlRepositoryError> =>
        Effect.suspend(() => {
          const idleMs = clock.currentTimeMillisUnsafe() - lastOutputAt;
          return idleMs >= CLONE_STALL_TIMEOUT_MS
            ? Effect.fail(repositoryError(input.provider, stallDetail))
            : Effect.sleep(CLONE_STALL_TIMEOUT_MS - idleMs).pipe(Effect.andThen(stallWatch()));
        });

      const execute = input.git.execute({
        operation: "SourceControlRepositoryService.cloneRepository",
        cwd: input.target.parentPath,
        args: ["clone", "--progress", "--", input.remoteUrl, input.target.directoryName],
        env: { ...CLONE_ENV, ...input.env },
        // No deadline (an infinite timeout never fires): the stall watcher ends a dead clone,
        // the orphan grace an abandoned one.
        timeoutMs: Number.POSITIVE_INFINITY,
        maxOutputBytes: CLONE_KEPT_OUTPUT_BYTES,
        truncateOutputAtMaxBytes: true,
        progress: {
          splitStderrAtCarriageReturn: true,
          keepLineCallbacksAfterTruncation: true,
          onStderrLine: observe,
          onStdoutLine: observe,
        },
      });

      const result = yield* Effect.raceFirst(Effect.result(execute), stallWatch());
      if (Result.isSuccess(result)) return { kind: "complete" } as const;

      const error = result.failure;
      // The raw error holds the command line and all of stderr: logged redacted, never sent.
      yield* Effect.logWarning("repository clone failed", {
        detail: tailOfText(redactDiagnosticText(error.detail), CLONE_FAILURE_LOG_MAX_CHARS),
      });
      if (yield* hasResolvableHead(input.git, input.target)) {
        return {
          kind: "checkoutFailed",
          gitMessage: tail.length > 0 ? cloneFailureDetail(tail) : null,
        } as const;
      }
      return yield* repositoryError(
        input.provider,
        cloneFailureDetail(
          tail,
          error.detail.endsWith("failed to spawn.")
            ? "The repository could not be cloned: git could not be started."
            : undefined,
        ),
      );
    }),
  );

/**
 * One clone from start to published repository: checks the destination is still missing or empty
 * (again once a clone slot is free, since it may have changed while queued), then clones into
 * staging with the credentials `withCredentials` supplies.
 */
export const cloneIntoDestination = (input: {
  readonly git: Pick<GitVcsDriver.GitVcsDriverShape, "execute">;
  readonly destination: PreparedCloneDestination;
  readonly remoteUrl: string;
  readonly provider: SourceControlProviderKind;
  readonly checkDestination: Effect.Effect<void, SourceControlRepositoryError>;
  readonly allowStagingAt: (stagingPath: string) => Effect.Effect<boolean>;
  readonly withCredentials: <A, E>(
    use: (env: Readonly<Record<string, string>> | undefined) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | SourceControlRepositoryError>;
}): Effect.Effect<void, SourceControlRepositoryError> =>
  input.checkDestination.pipe(
    Effect.andThen(
      cloneSlots.withPermits(1)(
        Effect.gen(function* () {
          yield* input.checkDestination;
          const outcome = yield* withCloneStaging(
            {
              destination: input.destination,
              provider: input.provider,
              allowStagingAt: input.allowStagingAt,
            },
            (target) =>
              input.withCredentials((env) =>
                runWatchedGitClone({
                  git: input.git,
                  target,
                  remoteUrl: input.remoteUrl,
                  env,
                  provider: input.provider,
                }),
              ),
          );
          if (outcome.kind === "checkoutFailed") {
            return yield* repositoryError(
              input.provider,
              `The repository was cloned to ${input.destination.destinationPath}, but git failed after downloading it${outcome.gitMessage === null ? "." : `: ${outcome.gitMessage}`} Fix that in the folder, then add it as a project.`,
            );
          }
        }),
      ),
    ),
  );

// ---------------------------------------------------------------------------------------------
// Detached clones
// ---------------------------------------------------------------------------------------------

type CloneExit = Exit.Exit<SourceControlCloneRepositoryResult, SourceControlRepositoryError>;

interface RunningClone {
  fiber: Fiber.Fiber<SourceControlCloneRepositoryResult, SourceControlRepositoryError> | undefined;
  /** Requests waiting for it right now. */
  joiners: number;
}

export interface CloneJobs {
  /**
   * Joins the clone running under `key`; returns its finished outcome while the repository is
   * still at `destinationPath`; otherwise starts `clone` under `key` and joins it. Interrupting
   * the caller only leaves the clone.
   */
  readonly runOrJoin: (input: {
    readonly key: string;
    readonly destinationPath: string;
    readonly clone: Effect.Effect<SourceControlCloneRepositoryResult, SourceControlRepositoryError>;
  }) => Effect.Effect<SourceControlCloneRepositoryResult, SourceControlRepositoryError>;
}

/**
 * A clone's identity: the canonical destination and the exact remote URL git gets. Credentials
 * in the URL are part of it, so a request with other credentials neither joins this clone nor
 * receives its outcome (which echoes the URL).
 */
export const cloneJobKey = (
  destination: PreparedCloneDestination,
  remoteUrl: string,
): Effect.Effect<string> =>
  Effect.promise(async () => {
    const parent = await realpath(destination.parentPath).catch(() => destination.parentPath);
    return `${path.join(parent, destination.directoryName)}\n${remoteUrl}`;
  });

const hasRepositoryAt = (destinationPath: string): Effect.Effect<boolean> =>
  Effect.promise(() =>
    lstat(path.join(destinationPath, ".git")).then(
      () => true,
      () => false,
    ),
  );

/**
 * The service-lifetime registry of detached clones. Closing its scope (server shutdown) stops
 * every clone, which removes its staging folder.
 */
export const makeCloneJobs = Effect.gen(function* () {
  const clones = yield* FiberMap.make<
    string,
    SourceControlCloneRepositoryResult,
    SourceControlRepositoryError
  >();
  const orphanTimers = yield* FiberMap.make<string>();
  const running = new Map<string, RunningClone>();
  const finished = new Map<string, { readonly exit: CloneExit; readonly expiresAt: number }>();
  const registryLock = Semaphore.makeUnsafe(1);

  const settle = (key: string, job: RunningClone, exit: CloneExit) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) => {
      const registered = running.get(key) === job;
      if (registered) running.delete(key);
      // A stopped clone left nothing worth answering with.
      if (!Exit.hasInterrupts(exit)) {
        finished.set(key, { exit, expiresAt: now + CLONE_OUTCOME_RETENTION_MS });
      }
      // Its orphan timer has nothing left to stop. (A clone that is no longer registered was
      // stopped by that timer, or replaced: the timer under `key` is not its own to cancel.)
      return registered ? FiberMap.remove(orphanTimers, key) : Effect.void;
    });

  /**
   * Under the registry lock, like a request's lookup: a request that found the clone has also
   * counted itself as a joiner before this check can run.
   */
  const stopIfOrphaned = (key: string, job: RunningClone) =>
    registryLock
      .withPermits(1)(
        Effect.sync(() => {
          if (running.get(key) !== job || job.joiners > 0 || job.fiber === undefined) {
            return undefined;
          }
          // Out of the registry first, so a request from now on starts a fresh clone.
          running.delete(key);
          return job.fiber;
        }),
      )
      .pipe(
        Effect.flatMap((fiber) =>
          fiber === undefined
            ? Effect.void
            : Effect.logWarning("stopping a repository clone no request has waited for", {
                graceMinutes: CLONE_ORPHAN_GRACE_MS / 60_000,
              }).pipe(Effect.andThen(Fiber.interrupt(fiber))),
        ),
      );

  const leave = (key: string, job: RunningClone) =>
    Effect.suspend(() => {
      job.joiners -= 1;
      if (job.joiners > 0 || running.get(key) !== job) return Effect.void;
      return FiberMap.run(
        orphanTimers,
        key,
        Effect.sleep(CLONE_ORPHAN_GRACE_MS).pipe(Effect.andThen(stopIfOrphaned(key, job))),
      ).pipe(Effect.asVoid);
    });

  /** Runs under the registry lock, so the orphan timer cannot stop the clone in between. */
  const attach = (key: string, job: RunningClone) =>
    Effect.sync(() => {
      job.joiners += 1;
    }).pipe(Effect.andThen(FiberMap.remove(orphanTimers, key)), Effect.as(job));

  /** The running clone to join, a finished outcome, or a freshly started clone to join. */
  const lookUpOrStart = (input: {
    readonly key: string;
    readonly destinationPath: string;
    readonly clone: Effect.Effect<SourceControlCloneRepositoryResult, SourceControlRepositoryError>;
  }) =>
    registryLock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        for (const [key, outcome] of finished) {
          if (outcome.expiresAt <= now) finished.delete(key);
        }
        const active = running.get(input.key);
        if (active !== undefined) {
          const job = yield* attach(input.key, active);
          yield* Effect.logInfo("joining a repository clone that is already running");
          return { kind: "join", job } as const;
        }
        const outcome = finished.get(input.key);
        if (outcome !== undefined) {
          if (yield* hasRepositoryAt(input.destinationPath)) {
            return { kind: "finished", exit: outcome.exit } as const;
          }
          finished.delete(input.key);
        }
        const job: RunningClone = { fiber: undefined, joiners: 0 };
        running.set(input.key, job);
        job.fiber = yield* FiberMap.run(
          clones,
          input.key,
          Effect.interruptible(input.clone).pipe(
            Effect.onExit((exit) => settle(input.key, job, exit)),
          ),
        );
        return { kind: "join", job: yield* attach(input.key, job) } as const;
      }),
    );

  const runOrJoin: CloneJobs["runOrJoin"] = (input) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const found = yield* lookUpOrStart(input);
        if (found.kind === "finished") return yield* found.exit;
        const { job } = found;
        return yield* restore(Fiber.join(job.fiber!)).pipe(Effect.ensuring(leave(input.key, job)));
      }),
    );

  return { runOrJoin } satisfies CloneJobs;
});
