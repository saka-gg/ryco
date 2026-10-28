import {
  createLockFileExclusive,
  type LockFileIdentity,
  readLockFile,
  reclaimLockFile,
  removeLockFileIfUnchanged,
} from "../processLock/exclusiveLockFile.ts";
import {
  defaultBootId,
  defaultBootTime,
  defaultProcessAlive,
  defaultProcessStartTime,
  isHolderAbandoned,
  type RecordedProcess,
  UNPARSEABLE_LOCK_GRACE_MS,
} from "../processLock/processIdentity.ts";

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

/** Large enough for `<pid> <boot epoch ms> <boot id> <start time>\n`, small enough to never read a stray file. */
const LOCK_FILE_MAX_BYTES = 128;
/** The two trailing fields are absent from a lock written before they existed. */
const LOCK_FILE_PATTERN =
  /^([1-9][0-9]{0,9}) ([0-9]{1,16})(?: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|-) ([0-9]{1,20}|-))?\n?$/;

type HubLockRecord = RecordedProcess;

const decodeHubLockRecord = (content: string): HubLockRecord | undefined => {
  const match = LOCK_FILE_PATTERN.exec(content);
  if (match === null) return undefined;
  const optional = (value: string | undefined) =>
    value === undefined || value === "-" ? undefined : value;
  return {
    pid: Number(match[1]),
    bootTime: Number(match[2]),
    bootId: optional(match[3]),
    startTime: optional(match[4]),
  };
};

export function makeHubIdentityProcessLock(options: {
  readonly path: string;
  readonly pid?: number;
  readonly platform?: NodeJS.Platform;
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
  // A boot id cannot change while this process runs, so it is looked up once.
  let bootIdLookup: Promise<string | undefined> | undefined;
  const bootId = () => (bootIdLookup ??= (options.bootId ?? defaultBootId)());
  const probe = {
    platform: options.platform ?? process.platform,
    bootTime,
    bootId,
    processAlive: options.processAlive ?? defaultProcessAlive,
    processStartTime,
  };
  let held = false;
  let acquiring: Promise<HubIdentityProcessLockResult> | undefined;

  const readHolder = async () => {
    const read = await readLockFile(path, {
      maxBytes: LOCK_FILE_MAX_BYTES,
      decode: decodeHubLockRecord,
    });
    // A lock this process may not read cannot be judged: carry on without it.
    if (read.kind === "unreadable") throw new Error(`Cannot read ${path} (${read.code})`);
    return read;
  };

  const isStale = (mtimeMs: number) => now() - mtimeMs > UNPARSEABLE_LOCK_GRACE_MS;
  /** Throws when an abandoned lock cannot be removed. */
  const reclaim = async (judged: LockFileIdentity) =>
    (await reclaimLockFile(path, judged, isStale)) === "removed";

  /** True when the path is now free to create. */
  const clearIfAbandoned = async (): Promise<boolean> => {
    const holder = await readHolder();
    if (holder.kind === "absent") return true;
    if (holder.kind === "unparseable") return isStale(holder.mtimeMs) ? reclaim(holder) : false;
    // Not something this module wrote. Never delete it; report it as held so
    // a person looks at it rather than two connectors sharing an identity.
    if (holder.kind === "foreign") return false;
    // This process, from a connector that never released it.
    if (holder.record.pid === pid) return reclaim(holder);
    return (await isHolderAbandoned(holder.record, probe)) ? reclaim(holder) : false;
  };

  const create = async (): Promise<boolean> => {
    // Read before the file exists, so a half-written lock is never left behind
    // waiting on a lookup.
    const record = `${pid} ${bootTime()} ${(await bootId()) ?? "-"} ${
      (await processStartTime(pid)) ?? "-"
    }\n`;
    return createLockFileExclusive(path, record);
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
        if (holder.kind === "holder" && holder.record.pid === pid) {
          await removeLockFileIfUnchanged(path, holder);
        }
      } catch {
        // A lock this process cannot remove is reclaimed by the next start: its
        // pid will be dead.
      }
    },
  };
}
