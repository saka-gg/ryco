/**
 * providerInstallLock - The host-wide provider install lock, loaded on first use.
 *
 * Every Ryco process on this host (Desktop's backend, a CLI service, Nightly, dev servers)
 * shares one lock folder, so two of them never run an installer on the same target at once
 * (`npm i -g` on one prefix, `brew upgrade`), and a session start does not launch a CLI that
 * is being replaced.
 *
 * A lock is a series of generation files `<key>.lock.<N>`. Only creating the next generation
 * exclusively elects an owner: its record is written to a temp file opened `wx`, then
 * `link()`ed to `N+1`, which fails when a contender got there first (rename would overwrite
 * it). The record's first line lists the pids that keep it held (this server, then the
 * installer child), the second names the owning run. A record is held while any of its pids
 * lives and it is younger than `MAX_LOCK_AGE` (older, until a contender has seen it unchanged for
 * `EXPIRED_TAKEOVER_GRACE`: its owner may have slept); a finished run writes `released`. The
 * highest generation stays after release, so a delayed contender cannot reuse its number.
 *
 * Nothing in the folder is followed: records are opened with O_NOFOLLOW after an `lstat`, a
 * link or any other entry that is not a plain record counts as held until it is an hour old,
 * and the folder itself must be a real directory this user owns (0700, records 0600). A stale
 * or forged record can only delay an install; its age and pid liveness free it.
 *
 * The folder is the platform's per-user cache folder, never RYCO_HOME, so stable, Nightly, CLI
 * and dev nodes on one host take the same locks.
 *
 * @module providerInstallLock
 */
import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import * as NodeFs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { Cause, Clock, Data, Duration, Effect, Option } from "effect";

import type { ProviderMaintenanceCapabilities } from "./providerMaintenance.ts";

/**
 * A record older than this no longer holds, live pids or not: a hung or paused owner is taken
 * over. Ryco's installer times out after 5 minutes, far below it; the generation handshake
 * fences an owner that resumes during the takeover.
 */
export const MAX_LOCK_AGE = Duration.hours(1);
const MAX_LOCK_AGE_MS = Duration.toMillis(MAX_LOCK_AGE);
/**
 * An expired record whose pid still lives is taken over only once it has stayed unchanged this
 * long on the contender's own monotonic clock. Its age is wall-clock time, which runs on while
 * the host sleeps (or jumps with the clock): an owner frozen mid-install by a closed lid looks
 * hours old at wake, while its installer, and the installer's 5 minute timeout, only resume
 * then. A resumed owner rewrites its record once its installer ends; a hung one never does.
 */
export const EXPIRED_TAKEOVER_GRACE = Duration.minutes(10);
const EXPIRED_TAKEOVER_GRACE_NANOS = Duration.toNanosUnsafe(EXPIRED_TAKEOVER_GRACE);
export const IDLE_POLL_INTERVAL = Duration.seconds(1);
/**
 * The longest a provider launch waits for its installer's lock. Ryco's installer times out after
 * 5 minutes and verification follows; a lock held past this is stale or forged (it frees itself
 * after `MAX_LOCK_AGE`), and the launch goes ahead.
 */
export const LAUNCH_WAIT = Duration.minutes(10);
/** A record is two short lines; anything larger is not one Ryco wrote and is never read. */
const MAX_RECORD_BYTES = 4_096;
/** File names stop at 255 bytes: longer encoded keys keep a prefix and a digest. */
const MAX_ENCODED_KEY_LENGTH = 160;
const NO_FOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const CREATE_EXCLUSIVE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW;
const RECORD_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const POSIX = process.platform !== "win32";

export class ProviderInstallLockError extends Data.TaggedError("ProviderInstallLockError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** The file operations the lock uses. Tests wrap single operations to stage races. */
export interface ProviderInstallLockFiles {
  readonly readdir: (directory: string) => Promise<ReadonlyArray<string>>;
  readonly lstat: (file: string) => Promise<Stats>;
  readonly open: (file: string, flags: number, mode?: number) => Promise<NodeFs.FileHandle>;
  readonly link: (existingFile: string, newFile: string) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly unlink: (file: string) => Promise<void>;
  readonly mkdir: (
    directory: string,
    options: { readonly recursive: true; readonly mode: number },
  ) => Promise<unknown>;
  readonly chmod: (file: string, mode: number) => Promise<void>;
}

export const nodeProviderInstallLockFiles: ProviderInstallLockFiles = {
  readdir: (directory) => NodeFs.readdir(directory),
  lstat: (file) => NodeFs.lstat(file),
  open: (file, flags, mode) => NodeFs.open(file, flags, mode),
  link: (existingFile, newFile) => NodeFs.link(existingFile, newFile),
  rename: (from, to) => NodeFs.rename(from, to),
  unlink: (file) => NodeFs.unlink(file),
  mkdir: (directory, options) => NodeFs.mkdir(directory, options),
  chmod: (file, mode) => NodeFs.chmod(file, mode),
};

export interface ProviderInstallLockOptions {
  /** The host's shared lock folder when omitted; tests pass a temp directory. */
  readonly directory?: string | undefined;
  readonly files?: ProviderInstallLockFiles;
}

/** The lock folder every Ryco process of this user shares: the platform's cache folder. */
export function resolveProviderInstallLockDirectory(input: {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
}): string {
  if (input.platform === "win32") {
    const localAppData = input.env.LOCALAPPDATA?.trim();
    const base =
      localAppData && path.win32.isAbsolute(localAppData)
        ? localAppData
        : path.win32.join(input.homeDirectory, "AppData", "Local");
    return path.win32.join(base, "ryco", "provider-install");
  }
  if (input.platform === "darwin") {
    return path.posix.join(input.homeDirectory, "Library", "Caches", "ryco", "provider-install");
  }
  // The XDG Base Directory spec ignores a relative path.
  const cacheHome = input.env.XDG_CACHE_HOME?.trim();
  const base =
    cacheHome && path.posix.isAbsolute(cacheHome)
      ? cacheHome
      : path.posix.join(input.homeDirectory, ".cache");
  return path.posix.join(base, "ryco", "provider-install");
}

/** The lock; the boot facade (`Services/ProviderInstallLock.ts`) loads it on first use. */
export interface ProviderInstallLockRuntime {
  /**
   * Runs `run` holding the lock for `lockKey` (a maintenance action's `lockKey`), or returns
   * `None` without running when another process holds it. `run` calls `recordChildPid` with
   * the installer's pid once it spawns, so an installer that outlives this server keeps the
   * lock held until it exits; a failure there means the installer must not continue.
   */
  readonly tryRun: <A, E, R>(
    lockKey: string,
    run: (
      recordChildPid: (pid: number) => Effect.Effect<void, ProviderInstallLockError>,
    ) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E | ProviderInstallLockError, R>;
  /**
   * `tryRun`, waiting while another process holds the lock: `onHeld` runs each time it is found
   * held, then the lock is tried again once it frees.
   */
  readonly runWhenFree: <A, E, R>(
    lockKey: string,
    onHeld: Effect.Effect<unknown>,
    run: (
      recordChildPid: (pid: number) => Effect.Effect<void, ProviderInstallLockError>,
    ) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ProviderInstallLockError, R>;
  /**
   * Completes once no process holds `lockKey` (no lock at all when omitted), or when the lock
   * folder cannot be read. Polls every second.
   */
  readonly untilIdle: (lockKey?: string) => Effect.Effect<void>;
  /**
   * Holds a provider process launch while its installer's lock is held. An empty folder costs
   * one readdir and `capabilities` are not even read; no installer waits for nothing. Gives up
   * after `LAUNCH_WAIT`, and goes ahead when the folder cannot be read. An expired record does
   * not hold a launch, even within its `EXPIRED_TAKEOVER_GRACE`.
   */
  readonly beforeLaunch: (
    capabilities: Effect.Effect<ProviderMaintenanceCapabilities>,
  ) => Effect.Effect<void>;
  /** Whether any lock is held right now. A failed read is an error, not "free". */
  readonly anyHeld: Effect.Effect<boolean, ProviderInstallLockError>;
  /** Whether `lockKey` is held right now. A failed read is an error, not "free". */
  readonly isHeld: (lockKey: string) => Effect.Effect<boolean, ProviderInstallLockError>;
}

/** The record name stem for a maintenance `lockKey`: URI-encoded, digest-shortened when long. */
export function providerInstallLockName(lockKey: string): string {
  const encoded = encodeURIComponent(lockKey);
  if (encoded.length <= MAX_ENCODED_KEY_LENGTH) return `${encoded}.lock`;
  const digest = createHash("sha256").update(lockKey).digest("hex").slice(0, 32);
  return `${encoded.slice(0, MAX_ENCODED_KEY_LENGTH - digest.length - 1)}~${digest}.lock`;
}

function errorCode(cause: unknown): string | undefined {
  return typeof cause === "object" && cause !== null && "code" in cause
    ? String((cause as { readonly code: unknown }).code)
    : undefined;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM: the process exists but belongs to someone else.
    return errorCode(cause) === "EPERM";
  }
}

const GENERATION_NAME = /^(.+\.lock)\.([1-9]\d*)$/u;

function parseGeneration(name: string) {
  const match = GENERATION_NAME.exec(name);
  if (!match) return undefined;
  const generation = Number(match[2]);
  return Number.isSafeInteger(generation) ? { key: match[1]!, generation, name } : undefined;
}

/** What the folder holds under one name, read without following anything. */
type LockEntry =
  | {
      readonly kind: "record";
      readonly contents: string;
      readonly mtimeMs: number;
      readonly ino: number;
    }
  | { readonly kind: "other"; readonly mtimeMs: number; readonly ino: number };

interface LockRecord {
  /** Changes whenever the entry is rewritten, replaced or touched. */
  readonly identity: string;
  readonly held: boolean;
  /** Too old to hold although a recorded pid still lives: its owner may resume. */
  readonly expiredLive: boolean;
}

function classify(entry: LockEntry, nowMs: number): LockRecord {
  const expired = nowMs - entry.mtimeMs >= MAX_LOCK_AGE_MS;
  if (entry.kind === "other") {
    // Never opened: a link or anything else holds (fails closed) until it is an hour old.
    return { identity: `${entry.ino}:${entry.mtimeMs}:other`, held: !expired, expiredLive: false };
  }
  // The first line holds pids; the second identifies the owning run, including within one server.
  const [pids = ""] = entry.contents.split("\n");
  const recorded = pids.split(" ").map(Number);
  const valid = (pid: number) => Number.isSafeInteger(pid) && pid > 0;
  const live = recorded.some((pid) => valid(pid) && isPidAlive(pid));
  return {
    identity: `${entry.ino}:${entry.mtimeMs}:${entry.contents}`,
    held: !expired && pids !== "released" && (live || recorded.some((pid) => !valid(pid))),
    expiredLive: expired && live,
  };
}

async function readEntry(
  files: ProviderInstallLockFiles,
  file: string,
): Promise<LockEntry | undefined> {
  let info: Stats;
  try {
    info = await files.lstat(file);
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return undefined;
    throw cause;
  }
  const other = (stats: Stats): LockEntry => ({
    kind: "other",
    mtimeMs: stats.mtimeMs,
    ino: stats.ino,
  });
  if (!info.isFile() || info.size > MAX_RECORD_BYTES) return other(info);
  let handle: NodeFs.FileHandle;
  try {
    handle = await files.open(file, constants.O_RDONLY | NO_FOLLOW);
  } catch (cause) {
    const code = errorCode(cause);
    if (code === "ENOENT") return undefined;
    // Swapped for a link after the lstat (FreeBSD reports EMLINK).
    if (code === "ELOOP" || code === "EMLINK") return other(info);
    throw cause;
  }
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== info.dev ||
      opened.ino !== info.ino ||
      opened.size > MAX_RECORD_BYTES
    ) {
      return other(opened);
    }
    const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_RECORD_BYTES) return other(opened);
    return {
      kind: "record",
      contents: buffer.subarray(0, length).toString("utf8"),
      mtimeMs: opened.mtimeMs,
      ino: opened.ino,
    };
  } finally {
    await handle.close();
  }
}

function directoryProblem(info: Stats): string | undefined {
  if (info.isSymbolicLink()) return "it is a link";
  if (!info.isDirectory()) return "it is not a folder";
  if (POSIX && typeof process.getuid === "function" && info.uid !== process.getuid()) {
    return "it belongs to another user";
  }
  return undefined;
}

class RefusedDirectory extends Error {}

/** What a run that holds the lock last wrote; only that run's fiber reads and writes it. */
interface OwnerState {
  readonly file: string;
  pid: number | undefined;
  contents: string;
}

export function makeProviderInstallLock(
  options: ProviderInstallLockOptions = {},
): ProviderInstallLockRuntime {
  const directory =
    options.directory ??
    resolveProviderInstallLockDirectory({
      platform: process.platform,
      env: process.env,
      homeDirectory: homedir(),
    });
  const files = options.files ?? nodeProviderInstallLockFiles;

  const lockError = (cause: unknown) =>
    new ProviderInstallLockError({
      message: `Ryco could not use its provider install lock folder ${directory}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      cause,
    });
  const call = <A>(run: () => Promise<A>): Effect.Effect<A, ProviderInstallLockError> =>
    Effect.tryPromise({ try: run, catch: lockError });
  const removeQuietly = (file: string) =>
    files.unlink(file).catch((cause: unknown) => {
      if (errorCode(cause) !== "ENOENT") throw cause;
    });
  const remove = (file: string) => call(() => removeQuietly(file));
  const join = (name: string) => path.join(directory, name);

  const ensureDirectory = call(async () => {
    await files.mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
    const info = await files.lstat(directory);
    const problem = directoryProblem(info);
    if (problem !== undefined) throw new RefusedDirectory(problem);
    if (POSIX && (info.mode & 0o077) !== 0) await files.chmod(directory, DIRECTORY_MODE);
  });

  /** The folder's names; none when it does not exist yet. A link or foreign folder is an error. */
  const readNames = call(async () => {
    let info: Stats;
    try {
      info = await files.lstat(directory);
    } catch (cause) {
      if (errorCode(cause) === "ENOENT") return [];
      throw cause;
    }
    const problem = directoryProblem(info);
    if (problem !== undefined) throw new RefusedDirectory(problem);
    return files.readdir(directory);
  });

  const generations = readNames.pipe(
    Effect.map((names) =>
      names.flatMap((name) => {
        const parsed = parseGeneration(name);
        return parsed ? [parsed] : [];
      }),
    ),
  );

  const inspect = (file: string) => call(() => readEntry(files, file));

  const readRecord = (file: string) =>
    Effect.gen(function* () {
      const entry = yield* inspect(file);
      if (entry === undefined) return undefined;
      return classify(entry, yield* Clock.currentTimeMillis);
    });

  /** When this process first saw each expired record whose pid lives, as it still is. */
  const expiredSightings = new Map<string, { readonly identity: string; readonly since: bigint }>();

  /**
   * `readRecord`, except that an expired record whose pid lives still holds until this process
   * has seen it unchanged for `EXPIRED_TAKEOVER_GRACE`.
   */
  const observeRecord = (file: string) =>
    Effect.gen(function* () {
      const record = yield* readRecord(file);
      if (record === undefined || !record.expiredLive) {
        expiredSightings.delete(file);
        return record;
      }
      const now = yield* Clock.monotonicTimeNanos;
      const seen = expiredSightings.get(file);
      if (seen === undefined || seen.identity !== record.identity) {
        expiredSightings.set(file, { identity: record.identity, since: now });
        return { ...record, held: true };
      }
      return now - seen.since >= EXPIRED_TAKEOVER_GRACE_NANOS ? record : { ...record, held: true };
    });

  /** Publishes a complete record exclusively; a paused writer must never look abandoned. */
  const createExclusively = (file: string, contents: string, owner: string) =>
    call(async () => {
      const temporary = `${file}.${owner}.tmp`;
      let created = false;
      try {
        const handle = await files.open(temporary, CREATE_EXCLUSIVE, RECORD_MODE);
        created = true;
        try {
          await handle.writeFile(contents, "utf8");
        } finally {
          await handle.close();
        }
        // Unlike rename, link cannot overwrite another contender's generation.
        await files.link(temporary, file);
        return true;
      } catch (cause) {
        if (created && errorCode(cause) === "EEXIST") return false;
        throw cause;
      } finally {
        if (created) await removeQuietly(temporary).catch(() => undefined);
      }
    });

  /**
   * Written aside and renamed over the record, so a failed write (disk full) leaves the
   * previous complete record instead of an empty, held file.
   */
  const replace = (file: string, contents: string, owner: string) =>
    call(async () => {
      const temporary = `${file}.${owner}.tmp`;
      await removeQuietly(temporary);
      let created = false;
      try {
        const handle = await files.open(temporary, CREATE_EXCLUSIVE, RECORD_MODE);
        created = true;
        try {
          await handle.writeFile(contents, "utf8");
        } finally {
          await handle.close();
        }
        await files.rename(temporary, file);
        created = false;
      } finally {
        if (created) await removeQuietly(temporary).catch(() => undefined);
      }
    });

  /**
   * Only exclusive creation elects an owner. The highest generation is retained even after
   * release, so a delayed reclaimer cannot reuse its number.
   */
  const acquire = Effect.fn("ProviderInstallLock.acquire")(function* (
    key: string,
    contents: string,
    owner: string,
  ) {
    yield* ensureDirectory;
    const previous = (yield* generations).filter((entry) => entry.key === key);
    const highest = previous.reduce((max, entry) => Math.max(max, entry.generation), 0);
    const previousFile = highest > 0 ? join(`${key}.${highest}`) : undefined;
    const previousRecord =
      previousFile === undefined ? undefined : yield* observeRecord(previousFile);
    if (previousRecord?.held) return undefined;
    const next = highest + 1;
    if (!Number.isSafeInteger(next)) {
      return yield* lockError(new Error(`no generation follows ${key}.${highest}`));
    }
    const file = join(`${key}.${next}`);
    if (!(yield* createExclusively(file, contents, owner))) return undefined;
    const backOff = remove(file).pipe(Effect.as(undefined));
    return yield* Effect.gen(function* () {
      // Our directory snapshot may predate a successor that already pruned this number. A
      // recreated lower generation must never run an installer.
      if ((yield* generations).some((entry) => entry.key === key && entry.generation > next)) {
        return yield* backOff;
      }
      if (
        previousFile !== undefined &&
        (previousRecord === undefined || previousRecord.expiredLive)
      ) {
        // On one host these fs operations are linearizable: an owner writes N then reads the
        // directory; a successor links N+1 then reads N. At least one sees the other, so both
        // can back off but cannot both start installers.
        const current = yield* readRecord(previousFile);
        if (
          current !== undefined &&
          (previousRecord === undefined || current.identity !== previousRecord.identity)
        ) {
          // Restore N as highest; a released N+1 would hide its resumed owner.
          return yield* backOff;
        }
      }
      // A rejected successor can disappear after another contender snapshots it. That contender
      // must not skip the resumed owner below the missing generation.
      for (const entry of previous) {
        if (entry.generation < highest && (yield* observeRecord(join(entry.name)))?.held) {
          return yield* backOff;
        }
      }
      yield* Effect.forEach(previous, (entry) => remove(join(entry.name)).pipe(Effect.ignore), {
        discard: true,
      });
      return file;
    }).pipe(Effect.onError(() => remove(file).pipe(Effect.ignore)));
  });

  const ownershipLost = (message: string) => new ProviderInstallLockError({ message });

  const recordChildPid = (state: OwnerState, key: string, owner: string) => (pid: number) =>
    Effect.gen(function* () {
      const current = yield* inspect(state.file);
      if (current?.kind !== "record" || current.contents !== state.contents) {
        return yield* ownershipLost(
          "Another process took over this CLI's install lock before the installer started.",
        );
      }
      const next = `${process.pid} ${pid}\n${owner}`;
      yield* replace(state.file, next, owner);
      state.pid = pid;
      state.contents = next;
      const generation = parseGeneration(path.basename(state.file))!.generation;
      if (
        (yield* generations).some((entry) => entry.key === key && entry.generation > generation)
      ) {
        return yield* ownershipLost(
          "This CLI's install lock expired before the installer started.",
        );
      }
    }).pipe(Effect.uninterruptible);

  const release = (state: OwnerState, owner: string) =>
    Effect.gen(function* () {
      const current = yield* inspect(state.file);
      if (current?.kind !== "record" || current.contents !== state.contents) return;
      // Once `run` ends, only an installer that has not exited yet keeps the lock held.
      const holder = state.pid !== undefined && isPidAlive(state.pid) ? state.pid : "released";
      yield* replace(state.file, `${holder}\n${owner}`, owner);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider install lock could not be released", {
          directory,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const tryRun: ProviderInstallLockRuntime["tryRun"] = (lockKey, run) =>
    Effect.suspend(() => {
      const key = providerInstallLockName(lockKey);
      const owner = randomUUID();
      const contents = `${process.pid}\n${owner}`;
      return Effect.acquireUseRelease(
        acquire(key, contents, owner).pipe(
          Effect.map((file): OwnerState | undefined =>
            file === undefined ? undefined : { file, pid: undefined, contents },
          ),
        ),
        (state) =>
          state === undefined
            ? Effect.succeedNone
            : run(recordChildPid(state, key, owner)).pipe(Effect.map(Option.some)),
        (state) => (state === undefined ? Effect.void : release(state, owner)),
      );
    });

  /**
   * `launch` reads an expired record whose pid lives as free at once: a launch must not wait out
   * the takeover grace of a stale record, and at worst starts a CLI a woken owner is replacing.
   */
  const isHeld = (lockKey: string | undefined, launch = false) =>
    Effect.gen(function* () {
      const key = lockKey === undefined ? undefined : providerInstallLockName(lockKey);
      const read = launch ? readRecord : observeRecord;
      // Every generation counts: a provisional successor must not hide a resumed older owner.
      for (const entry of yield* generations) {
        if (key !== undefined && entry.key !== key) continue;
        if ((yield* read(join(entry.name)))?.held) return true;
      }
      return false;
    });

  const pollUntilIdle = (lockKey: string | undefined, launch = false): Effect.Effect<void> =>
    Effect.suspend(() =>
      isHeld(lockKey, launch).pipe(
        Effect.orElseSucceed(() => false),
        Effect.flatMap((held) =>
          held
            ? Effect.sleep(IDLE_POLL_INTERVAL).pipe(Effect.andThen(pollUntilIdle(lockKey, launch)))
            : Effect.void,
        ),
      ),
    );

  const runWhenFree: ProviderInstallLockRuntime["runWhenFree"] = (lockKey, onHeld, run) =>
    tryRun(lockKey, run).pipe(
      Effect.flatMap(
        Option.match({
          onSome: Effect.succeed,
          onNone: () =>
            onHeld.pipe(
              Effect.andThen(Effect.sleep(IDLE_POLL_INTERVAL)),
              Effect.andThen(pollUntilIdle(lockKey)),
              Effect.andThen(Effect.suspend(() => runWhenFree(lockKey, onHeld, run))),
            ),
        }),
      ),
    );

  const beforeLaunch: ProviderInstallLockRuntime["beforeLaunch"] = (capabilities) =>
    Effect.gen(function* () {
      // One readdir: with nothing in the folder, no installer holds anything.
      const empty = yield* readNames.pipe(
        Effect.map((names) => names.length === 0),
        Effect.orElseSucceed(() => false),
      );
      if (empty) return;
      const key = (yield* capabilities).update?.lockKey;
      if (key === undefined) return;
      const startedAt = yield* Clock.currentTimeMillis;
      const idle = yield* pollUntilIdle(key, true).pipe(Effect.timeoutOption(LAUNCH_WAIT));
      const waitedMs = (yield* Clock.currentTimeMillis) - startedAt;
      if (Option.isNone(idle)) {
        yield* Effect.logWarning("provider launch stopped waiting for its install lock", {
          lockKey: key,
          waitedMs,
        });
      } else if (waitedMs >= 1_000) {
        yield* Effect.logInfo("provider launch waited for a provider CLI install", {
          lockKey: key,
          waitedMs,
        });
      }
    });

  return {
    tryRun,
    runWhenFree,
    untilIdle: (lockKey) => pollUntilIdle(lockKey),
    beforeLaunch,
    anyHeld: isHeld(undefined),
    isHeld: (lockKey) => isHeld(lockKey),
  };
}
