import { constants } from "node:fs";
import { lstat, open, readFile, rm } from "node:fs/promises";
import { uptime } from "node:os";

/**
 * Which process may use one Hub node identity.
 *
 * Two backends sharing a state directory — the desktop app and a default
 * `ryco serve` both use `~/.ryco` — would authenticate as the same node, and
 * the Hub displaces whichever connected first. The identity file's own lock
 * serializes individual writes, not the lifetime of a connector, so nothing
 * locally stopped the second copy. This lock does: the first connector to start
 * holds it until it stops, and a second one learns at once that the identity is
 * in use, without a round trip to the Hub.
 *
 * `held` names a live holder. `unavailable` means the lock could not be read or
 * written at all; the connector carries on without it, because the lock only
 * diagnoses duplicates early — the Hub still arbitrates — and failing closed on
 * a lock-file problem would take the node offline for nothing.
 */
export type HubIdentityProcessLockResult = "acquired" | "held" | "unavailable";

export interface HubIdentityProcessLock {
  /** Idempotent while this process holds the lock. */
  readonly acquire: () => Promise<HubIdentityProcessLockResult>;
  /** Removes the lock only if it still names this process. */
  readonly release: () => Promise<void>;
}

/** Large enough for `<pid> <boot epoch ms>\n`, small enough to never read a stray file. */
const LOCK_FILE_MAX_BYTES = 64;
const LOCK_FILE_PATTERN = /^([1-9][0-9]{0,9}) ([0-9]{1,16})\n?$/;
/**
 * Two boot-time estimates further apart than this belong to different boots.
 * Generous, because the estimate moves with every wall-clock correction, and
 * mistaking a live holder for a stale one is the worse error.
 */
const BOOT_TIME_TOLERANCE_MS = 10 * 60_000;
/**
 * A lock file that cannot be parsed is either being written right now or was
 * left half-written by a crash. Only the second survives this long.
 */
const UNPARSEABLE_LOCK_GRACE_MS = 60_000;

const errorCode = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException | undefined)?.code;

/** Wall-clock time of this boot, in milliseconds. */
const defaultBootTime = (): number => Math.round(Date.now() - uptime() * 1_000);

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
  readonly processAlive?: (pid: number) => boolean;
}): HubIdentityProcessLock {
  const { path } = options;
  const pid = options.pid ?? process.pid;
  const now = options.now ?? Date.now;
  const bootTime = options.bootTime ?? defaultBootTime;
  const processAlive = options.processAlive ?? defaultProcessAlive;
  let held = false;

  const readHolder = async (): Promise<
    | { readonly kind: "absent" }
    | { readonly kind: "unparseable"; readonly mtimeMs: number; readonly ino: number }
    | {
        readonly kind: "holder";
        readonly pid: number;
        readonly bootTime: number;
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
      return { kind: "holder", pid: 0, bootTime: 0, ino: stats.ino };
    }
    const match = LOCK_FILE_PATTERN.exec(await readFile(path, "utf8"));
    if (match === null) return { kind: "unparseable", mtimeMs: stats.mtimeMs, ino: stats.ino };
    return {
      kind: "holder",
      pid: Number(match[1]),
      bootTime: Number(match[2]),
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
    const abandoned =
      // This process, from a connector that never released it.
      holder.pid === pid ||
      // A pid from an earlier boot can only be a reused one.
      Math.abs(holder.bootTime - bootTime()) > BOOT_TIME_TOLERANCE_MS ||
      !processAlive(holder.pid);
    return abandoned ? removeIfUnchanged(holder.ino) : false;
  };

  const create = async (): Promise<boolean> => {
    let handle;
    try {
      handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    } catch (error: unknown) {
      if (errorCode(error) === "EEXIST") return false;
      throw error;
    }
    try {
      await handle.writeFile(`${pid} ${bootTime()}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return true;
  };

  return {
    acquire: async () => {
      if (held) return "acquired";
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
    },
    release: async () => {
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
