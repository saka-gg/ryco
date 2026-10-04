import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readFile, rm } from "node:fs/promises";
import { uptime } from "node:os";
import { promisify } from "node:util";

/**
 * Which process may use one Hub node identity.
 *
 * Two backends sharing a state directory — the desktop app and a default
 * `ryco serve` both use `~/.ryco` — would authenticate as the same node, and
 * the Hub displaces whichever connected first. The identity file's own lock
 * serializes individual writes, not the lifetime of a connector, so nothing
 * locally stopped the second copy. This lock does: the first backend to start
 * its connector holds it until it stops, and a second one learns at once that
 * the identity is in use, without a round trip to the Hub.
 *
 * `held` names a live holder. `unavailable` means the lock could not be read or
 * written at all; the connector carries on without it, because the lock only
 * diagnoses duplicates early — the Hub still arbitrates — and failing closed on
 * a lock-file problem would take the node offline for nothing.
 */
export type HubIdentityProcessLockResult = "acquired" | "held" | "unavailable";

export interface HubIdentityProcessLock {
  /**
   * Idempotent while this process holds the lock, and single-flight: callers
   * racing each other share one attempt rather than mistaking this process's
   * half-written lock for another's.
   */
  readonly acquire: () => Promise<HubIdentityProcessLockResult>;
  /**
   * Removes the lock only if it still names this process. Waits for an attempt
   * already in flight, so a release always wins over an acquire it raced.
   */
  readonly release: () => Promise<void>;
}

/** Large enough for `<pid> <boot epoch ms> <boot id> <start ticks>\n`, small enough to never read a stray file. */
const LOCK_FILE_MAX_BYTES = 128;
/** The two trailing fields are absent from a lock written before they existed. */
const LOCK_FILE_PATTERN =
  /^([1-9][0-9]{0,9}) ([0-9]{1,16})(?: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|-) ([0-9]{1,20}|-))?\n?$/;
const BOOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const START_TIME_PATTERN = /^[0-9]{1,20}$/;
/**
 * Two boot-time estimates further apart than this belong to different boots.
 * Generous, because the estimate moves with every wall-clock correction, and
 * mistaking a live holder for a stale one is the worse error. Only consulted
 * where the kernel has no boot id to compare.
 */
const BOOT_TIME_TOLERANCE_MS = 10 * 60_000;
/**
 * A lock file that cannot be parsed is either being written right now or was
 * left half-written by a crash. Only the second survives this long.
 */
const UNPARSEABLE_LOCK_GRACE_MS = 60_000;

const execFileAsync = promisify(execFile);

const errorCode = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException | undefined)?.code;

/** Wall-clock time of this boot, in milliseconds. */
const defaultBootTime = (): number => Math.round(Date.now() - uptime() * 1_000);

/**
 * The kernel's own identifier for this boot, where the platform has one.
 *
 * Exact where the boot-time estimate is a heuristic: a board without a
 * real-time clock whose first network time sync lands after the service
 * started shifts that estimate by however wrong its clock was.
 */
async function defaultBootId(): Promise<string | undefined> {
  try {
    let raw: string | undefined;
    if (process.platform === "linux") {
      raw = await readFile("/proc/sys/kernel/random/boot_id", "utf8");
    } else if (process.platform === "darwin") {
      raw = (
        await execFileAsync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
          timeout: 2_000,
        })
      ).stdout;
    }
    const value = raw?.trim().toLowerCase();
    return value !== undefined && BOOT_ID_PATTERN.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * When a process started, in clock ticks since boot. Linux only, where reading
 * it is a file read; elsewhere a live pid is taken at its word.
 *
 * What tells a reused pid from the holder: after a container restart the old
 * lock's pid can belong to any process the new server spawned.
 */
async function defaultProcessStartTime(pid: number): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    // Field 22. The command name before it is parenthesized and may itself
    // contain spaces and parentheses, so count from the last `)`.
    const startTime = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    return startTime !== undefined && START_TIME_PATTERN.test(startTime) ? startTime : undefined;
  } catch {
    return undefined;
  }
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // EPERM is a live process owned by someone else; only ESRCH proves the
    // holder is gone.
    return errorCode(error) !== "ESRCH";
  }
}

export function makeHubIdentityProcessLock(options: {
  readonly path: string;
  readonly pid?: number;
  readonly now?: () => number;
  readonly bootTime?: () => number;
  readonly bootId?: () => Promise<string | undefined>;
  readonly processStartTime?: (pid: number) => Promise<string | undefined>;
  readonly processAlive?: (pid: number) => boolean;
}): HubIdentityProcessLock {
  const { path } = options;
  const pid = options.pid ?? process.pid;
  const now = options.now ?? Date.now;
  const bootTime = options.bootTime ?? defaultBootTime;
  const processStartTime = options.processStartTime ?? defaultProcessStartTime;
  const processAlive = options.processAlive ?? defaultProcessAlive;
  // A boot id cannot change while this process runs, so it is looked up once.
  let bootIdLookup: Promise<string | undefined> | undefined;
  const bootId = () => (bootIdLookup ??= (options.bootId ?? defaultBootId)());
  let held = false;
  let acquiring: Promise<HubIdentityProcessLockResult> | undefined;

  const readHolder = async (): Promise<
    | { readonly kind: "absent" }
    | { readonly kind: "unparseable"; readonly mtimeMs: number; readonly ino: number }
    | {
        readonly kind: "holder";
        readonly pid: number;
        readonly bootTime: number;
        readonly bootId: string | undefined;
        readonly startTime: string | undefined;
        readonly ino: number;
      }
  > => {
    let stats;
    try {
      stats = await lstat(path);
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return { kind: "absent" };
      throw error;
    }
    if (!stats.isFile() || stats.size > LOCK_FILE_MAX_BYTES) {
      // Not something this module wrote. Never delete it; report it as held so
      // a person looks at it rather than two connectors sharing an identity.
      return {
        kind: "holder",
        pid: 0,
        bootTime: 0,
        bootId: undefined,
        startTime: undefined,
        ino: stats.ino,
      };
    }
    let content;
    try {
      content = await readFile(path, "utf8");
    } catch (error: unknown) {
      // Released, or reclaimed by a racing process, since the `lstat`: the path
      // is free, not unreadable — reporting it as an unusable lock would carry
      // on without one while the racing process takes it.
      if (errorCode(error) === "ENOENT") return { kind: "absent" };
      throw error;
    }
    const match = LOCK_FILE_PATTERN.exec(content);
    if (match === null) return { kind: "unparseable", mtimeMs: stats.mtimeMs, ino: stats.ino };
    const optional = (value: string | undefined) =>
      value === undefined || value === "-" ? undefined : value;
    return {
      kind: "holder",
      pid: Number(match[1]),
      bootTime: Number(match[2]),
      bootId: optional(match[3]),
      startTime: optional(match[4]),
      ino: stats.ino,
    };
  };

  /** Remove the lock file only if it is still the one that was judged abandoned. */
  const removeIfUnchanged = async (ino: number): Promise<boolean> => {
    try {
      const current = await lstat(path);
      if (current.ino !== ino) return false;
      await rm(path);
      return true;
    } catch (error: unknown) {
      return errorCode(error) === "ENOENT";
    }
  };

  /** True when the path is now free to create. */
  const clearIfAbandoned = async (): Promise<boolean> => {
    const holder = await readHolder();
    if (holder.kind === "absent") return true;
    if (holder.kind === "unparseable") {
      return now() - holder.mtimeMs > UNPARSEABLE_LOCK_GRACE_MS
        ? removeIfUnchanged(holder.ino)
        : false;
    }
    if (holder.pid === 0) return false;
    // This process, from a connector that never released it.
    if (holder.pid === pid) return removeIfUnchanged(holder.ino);
    const currentBootId = await bootId();
    const sameBoot =
      holder.bootId !== undefined && currentBootId !== undefined
        ? holder.bootId === currentBootId
        : Math.abs(holder.bootTime - bootTime()) <= BOOT_TIME_TOLERANCE_MS;
    // A pid from an earlier boot can only be a reused one.
    let abandoned = !sameBoot || !processAlive(holder.pid);
    if (!abandoned && holder.startTime !== undefined) {
      // A live pid that started at another time is a different process.
      const startTime = await processStartTime(holder.pid);
      abandoned = startTime !== undefined && startTime !== holder.startTime;
    }
    return abandoned ? removeIfUnchanged(holder.ino) : false;
  };

  const create = async (): Promise<boolean> => {
    // Read before the file exists, so a half-written lock is never left behind
    // waiting on a lookup.
    const record = `${pid} ${bootTime()} ${(await bootId()) ?? "-"} ${
      (await processStartTime(pid)) ?? "-"
    }\n`;
    let handle;
    try {
      handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    } catch (error: unknown) {
      if (errorCode(error) === "EEXIST") return false;
      throw error;
    }
    try {
      await handle.writeFile(record);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return true;
  };

  const tryAcquire = async (): Promise<HubIdentityProcessLockResult> => {
    try {
      // Two tries: the second follows clearing an abandoned lock, which a
      // racing process may have recreated first.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (await create()) {
          held = true;
          return "acquired";
        }
        if (!(await clearIfAbandoned())) return "held";
      }
      return "held";
    } catch {
      return "unavailable";
    }
  };

  return {
    acquire: () => {
      if (held) return Promise.resolve("acquired");
      acquiring ??= tryAcquire().finally(() => {
        acquiring = undefined;
      });
      return acquiring;
    },
    release: async () => {
      await acquiring;
      if (!held) return;
      held = false;
      try {
        const holder = await readHolder();
        if (holder.kind === "holder" && holder.pid === pid) await removeIfUnchanged(holder.ino);
      } catch {
        // A lock this process cannot remove is reclaimed by the next start: its
        // pid will be dead.
      }
    },
  };
}
