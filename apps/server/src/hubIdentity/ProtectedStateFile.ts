import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { syncDirectory } from "../fsDurability.ts";

// The owner-only, crash-atomic JSON record discipline the node's durable
// security state is held under.
//
// Extracted from `LocalHubIdentityState` rather than copied, because there is
// now more than one such record — the Hub identity state, the §6.4 prekey slots,
// the §7.5 continuity lineage, and its §5.7 anchor — and four copies of a
// crash-atomicity argument are four chances for one of them to drift. This module owns the file rules only:
// directory ownership and mode, the single-writer lock with abandoned-lock
// reclaim, the temporary-file/fsync/rename/directory-fsync write, and the size
// and shape bounds a read enforces before any parser sees a byte. Every schema,
// every compare-and-update rule, and every domain error code belongs to the
// caller.

/**
 * The four conditions a caller must be able to tell apart.
 *
 * They exist because the callers' own error unions already distinguish them:
 * an unavailable directory is an environment problem, a held lock is a retry, a
 * failed parse is corruption, and a refused write is neither of those.
 */
export type ProtectedStateFileFailure = "unavailable" | "locked" | "corrupt" | "operation_failed";

/**
 * The internal signal.
 *
 * This module never throws the caller's error type directly from its inner
 * helpers, because `withLock` runs caller-supplied work whose own failures must
 * pass through untouched. Raising a private marker and converting it once, at
 * the public boundary, is what keeps the two apart.
 */
class ProtectedStateFileSignal extends Error {
  readonly failure: ProtectedStateFileFailure;

  constructor(failure: ProtectedStateFileFailure) {
    super("Protected state file operation failed.");
    this.name = "ProtectedStateFileSignal";
    this.failure = failure;
  }
}

function raise(failure: ProtectedStateFileFailure): never {
  throw new ProtectedStateFileSignal(failure);
}

/**
 * How long a lock acquisition waits before it gives up.
 *
 * Long enough to outlast any operation this module guards — each one is a
 * bounded read, an in-memory transform, and one fsync-and-rename — and short
 * enough that a genuinely stuck holder is reported rather than waited on
 * forever.
 */
const LOCK_WAIT_MS = 2_000;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Poll bounds for the CROSS-PROCESS half of that wait.
 *
 * Only one waiter per process ever polls (see `ProcessLockQueue`), so this paces
 * a wait on another process's holder and nothing else.
 */
const LOCK_POLL_MIN_MS = 2;
const LOCK_POLL_MAX_MS = 50;

/** How many times a reclaimed lock may be retried without pausing. */
const LOCK_RECLAIM_RETRIES = 4;

/**
 * The in-process half of the lock: one FIFO queue per lock path.
 *
 * WHY THIS EXISTS. The durable lock is an `O_EXCL` file, and the only way to
 * wait on one is to poll. Polling is fine against another PROCESS — there is no
 * cheaper way to learn that a foreign holder finished — but it is the wrong
 * mechanism for two callers inside one process, which is the contended case
 * that actually happens: `readE2eeContinuity` and the prekey advertisement run
 * on the per-channel path, so a burst of new channels is a burst of same-process
 * acquisitions of the same three records. Left to the poll alone, each waiter
 * backs off to `LOCK_POLL_MAX_MS` and the burst serializes at roughly one
 * acquisition per poll interval, with no ordering: a late arrival that happens
 * to wake first wins, and an early one can be passed over repeatedly.
 *
 * Queueing them here makes the handoff immediate — the next waiter is resumed in
 * the same turn the holder releases, with no timer in between — and makes it
 * FAIR, because the queue is first-in-first-out and a release hands ownership
 * directly to the head rather than reopening a race. The file lock still governs
 * cross-process exclusion; this only decides which local caller gets to hold it.
 *
 * KEYED BY PATH, not by instance, because two `ProtectedStateFile` handles on
 * one path in one process are the same contention (tests open a record twice;
 * so does a reopened store). The deadline is shared with the cross-process wait,
 * so total wait time is still bounded by `LOCK_WAIT_MS` and a reentrant call
 * still reports `locked` at that deadline rather than deadlocking.
 */
interface QueuedWaiter {
  wake: () => void;
  cancelled: boolean;
}

class ProcessLockQueue {
  private held = false;
  private readonly waiters: QueuedWaiter[] = [];
  private readonly onIdle: () => void;

  constructor(onIdle: () => void) {
    this.onIdle = onIdle;
  }

  /** `false` when the deadline passed before this caller reached the head. */
  async acquire(deadline: number): Promise<boolean> {
    if (!this.held) {
      this.held = true;
      return true;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    const waiter: QueuedWaiter = { wake: () => undefined, cancelled: false };
    const handed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        waiter.cancelled = true;
        resolve(false);
      }, remaining);
      waiter.wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.waiters.push(waiter);
    });
    if (!handed) this.forget(waiter);
    return handed;
  }

  /** Hand ownership to the head of the queue, or go idle. */
  release(): void {
    for (;;) {
      const next = this.waiters.shift();
      if (next === undefined) break;
      if (next.cancelled) continue;
      // Ownership passes directly: `held` stays true, so no third caller can
      // slip in between the release and the resumption.
      next.wake();
      return;
    }
    this.held = false;
    this.onIdle();
  }

  private forget(waiter: QueuedWaiter): void {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
    if (!this.held && this.waiters.length === 0) this.onIdle();
  }
}

const PROCESS_LOCK_QUEUES = new Map<string, ProcessLockQueue>();

function processLockQueue(lockPath: string): ProcessLockQueue {
  const existing = PROCESS_LOCK_QUEUES.get(lockPath);
  if (existing !== undefined) return existing;
  // Dropped again once nothing holds or wants it, so the map cannot grow with
  // every record a long-lived process ever opens.
  const created = new ProcessLockQueue(() => {
    if (PROCESS_LOCK_QUEUES.get(lockPath) === created) PROCESS_LOCK_QUEUES.delete(lockPath);
  });
  PROCESS_LOCK_QUEUES.set(lockPath, created);
  return created;
}

export interface ProtectedStateFile {
  readonly path: string;
  /**
   * Run one operation as the single writer for this path.
   *
   * Waits for a held lock rather than failing on contact. The callers of this
   * module include the capability-advertisement path, which reads durable
   * security state on every new channel: an advertisement that failed because
   * some other operation held the lock for a millisecond would be a
   * self-inflicted §5.5 U2 (`statement-unavailable`), and under effective
   * `requireE2EE` that is a fatal channel disposition. So contention waits, up
   * to `LOCK_WAIT_MS`, and only a lock still held at that deadline reports
   * `locked`.
   *
   * Same-process contention is queued rather than polled: waiters are served
   * first-in-first-out and the release hands the lock to the next one in the
   * same turn, so a burst of channel setups costs one handoff each instead of
   * one poll interval each.
   *
   * Still NOT reentrant: a nested call joins the queue behind the holder it is
   * nested inside and then reports `locked` at the deadline. Every public operation
   * of a consumer takes the lock exactly once, at its outermost step. Waiting
   * rather than hanging is deliberate — a reentrant misuse stays a loud,
   * bounded failure instead of becoming a deadlock.
   */
  readonly withLock: <A>(operation: () => Promise<A>) => Promise<A>;
  /** `null` when the file does not exist. Any other failure is `corrupt`. */
  readonly readJson: () => Promise<unknown>;
  readonly writeJson: (value: unknown) => Promise<void>;
}

async function assertStateDirectory(path: string, requireSecureMode: boolean): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return raise("unavailable");
    }
    if (process.platform !== "win32") {
      const uid = process.getuid?.();
      if (
        uid === undefined ||
        stat.uid !== uid ||
        (requireSecureMode && (stat.mode & 0o777) !== 0o700)
      ) {
        return raise("unavailable");
      }
    }
  } catch (error: unknown) {
    if (error instanceof ProtectedStateFileSignal) throw error;
    return raise("unavailable");
  }
}

/**
 * Open a durable record under the owner-only state directory.
 *
 * `maxBytes` bounds both directions and deliberately reports differently: a
 * stored file above the bound is `corrupt` — nothing this process wrote could be
 * that large — while a proposed value above it is `operation_failed`, a refused
 * write that leaves the previous contents intact.
 */
export async function openProtectedStateFile(options: {
  readonly path: string;
  readonly maxBytes: number;
  readonly fail: (failure: ProtectedStateFileFailure) => never;
}): Promise<ProtectedStateFile> {
  const { path, maxBytes } = options;
  const convert = <A>(operation: () => Promise<A>): Promise<A> =>
    operation().catch((error: unknown) => {
      if (error instanceof ProtectedStateFileSignal) return options.fail(error.failure);
      throw error;
    });

  const directory = dirname(path);
  await convert(async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 }).catch(() => raise("unavailable"));
    await assertStateDirectory(directory, false);
    if (process.platform !== "win32") {
      await chmod(directory, 0o700).catch(() => raise("unavailable"));
    }
    await assertStateDirectory(directory, true);
  });

  const lockPath = `${path}.lock`;

  const readJson = (): Promise<unknown> =>
    convert(async () => {
      try {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes) {
          return raise("corrupt");
        }
        if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) {
          return raise("corrupt");
        }
        const bytes = await readFile(path);
        if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) return raise("corrupt");
        return JSON.parse(bytes.toString("utf8")) as unknown;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        if (error instanceof ProtectedStateFileSignal) throw error;
        return raise("corrupt");
      }
    });

  const writeJson = (value: unknown): Promise<void> =>
    convert(async () => {
      const encoded = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
      if (encoded.byteLength > maxBytes) return raise("operation_failed");
      const temporaryPath = `${path}.${randomUUID()}.tmp`;
      let file;
      try {
        file = await open(
          temporaryPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600,
        );
        await file.writeFile(encoded);
        await file.sync();
        await file.close();
        file = undefined;
        await rename(temporaryPath, path);
        if (process.platform !== "win32") await chmod(path, 0o600);
        await syncDirectory(directory);
      } catch (error: unknown) {
        await file?.close().catch(() => undefined);
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        if (error instanceof ProtectedStateFileSignal) throw error;
        return raise("operation_failed");
      }
    });

  const reclaimAbandonedLock = async (): Promise<boolean> => {
    let initial;
    try {
      initial = await lstat(lockPath);
      if (
        !initial.isFile() ||
        initial.isSymbolicLink() ||
        initial.nlink !== 1 ||
        initial.size < 2 ||
        initial.size > 32 ||
        (process.platform !== "win32" && (initial.mode & 0o777) !== 0o600)
      ) {
        return false;
      }
      const rawPid = (await readFile(lockPath, "utf8")).trim();
      if (!/^[1-9][0-9]{0,19}$/.test(rawPid)) return false;
      const pid = Number(rawPid);
      if (!Number.isSafeInteger(pid)) return false;
      try {
        process.kill(pid, 0);
        return false;
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ESRCH") return false;
      }
      const current = await lstat(lockPath);
      if (current.dev !== initial.dev || current.ino !== initial.ino) return false;
      await rm(lockPath);
      return true;
    } catch (error: unknown) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  };

  /**
   * Take the durable lock, waiting out contention until `deadline`.
   *
   * Every failure to acquire is either a dead holder — reclaimed and retried at
   * once — or a live one, which is waited on. Reclaim-driven retries are
   * counted so that two processes racing to recreate the same lock cannot spin:
   * past the bound they fall back to the same paced wait as ordinary
   * contention, and the deadline governs both.
   *
   * Reached by at most one caller per process at a time — the in-process queue
   * orders the rest — so the paced poll below is only ever waiting on a holder
   * in another process, which is the one case that cannot be handed off.
   */
  const acquireLock = async (deadline: number) => {
    let delay = LOCK_POLL_MIN_MS;
    let reclaims = 0;
    for (;;) {
      try {
        return await open(
          lockPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600,
        );
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return raise("unavailable");
        if (reclaims < LOCK_RECLAIM_RETRIES && (await reclaimAbandonedLock())) {
          reclaims += 1;
          continue;
        }
        if (Date.now() >= deadline) return raise("locked");
        await sleep(delay);
        delay = Math.min(delay * 2, LOCK_POLL_MAX_MS);
      }
    }
  };

  const withLock = <A>(operation: () => Promise<A>): Promise<A> =>
    convert(async () => {
      const deadline = Date.now() + LOCK_WAIT_MS;
      const queue = processLockQueue(lockPath);
      // Ordered locally first, so the durable lock is contended by at most one
      // caller per process and the rest are handed the file in arrival order.
      if (!(await queue.acquire(deadline))) return raise("locked");
      try {
        const lock = await acquireLock(deadline);
        try {
          await lock.writeFile(`${process.pid}\n`);
          await lock.sync();
          return await operation();
        } finally {
          await lock.close().catch(() => undefined);
          await rm(lockPath, { force: true }).catch(() => undefined);
        }
      } finally {
        // Released after the lock file is gone, so the waiter this wakes finds
        // the path free rather than starting a poll it does not need.
        queue.release();
      }
    });

  return { path, withLock, readJson, writeJson };
}
