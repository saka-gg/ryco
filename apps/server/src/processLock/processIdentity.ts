/**
 * Who holds a lock file: is the process it names still the one that wrote it?
 *
 * A lock records its holder's pid together with this boot's identity and the
 * holder's start time. A pid alone is not enough: after a crash the pid may be
 * reused, and after a reboot every pid is someone else's. These are the shared
 * liveness primitives of the Hub identity lock and the database owner lock.
 *
 * @module processIdentity
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { uptime } from "node:os";
import { promisify } from "node:util";

/**
 * Two boot-time estimates further apart than this belong to different boots.
 * Generous, because the estimate moves with every wall-clock correction, and
 * mistaking a live holder for a stale one is the worse error. Only consulted
 * where the kernel has no boot id to compare.
 */
export const BOOT_TIME_TOLERANCE_MS = 10 * 60_000;
/**
 * A lock file that cannot be parsed is either being written right now or was
 * left half-written by a crash. Only the second survives this long.
 */
export const UNPARSEABLE_LOCK_GRACE_MS = 60_000;
/**
 * macOS start times are whole seconds from two sources: the holder's own
 * uptime-based estimate (rounded) and `ps -o lstart` (truncated). A process
 * that holds the pid now and started more than this after the recorded time is
 * another process.
 */
export const DARWIN_START_TIME_TOLERANCE_S = 2;

export const BOOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const START_TIME_PATTERN = /^[0-9]{1,20}$/;

const execFileAsync = promisify(execFile);

export const errorCode = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException | undefined)?.code;

/** Wall-clock time of this boot, in milliseconds. */
export const defaultBootTime = (): number => Math.round(Date.now() - uptime() * 1_000);

async function readBootId(): Promise<string | undefined> {
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

let bootIdLookup: Promise<string | undefined> | undefined;

/**
 * The kernel's own identifier for this boot, where the platform has one.
 * Looked up once per process: it cannot change while the process runs.
 *
 * Exact where the boot-time estimate is a heuristic: a board without a
 * real-time clock whose first network time sync lands after the service
 * started shifts that estimate by however wrong its clock was.
 */
export const defaultBootId = (): Promise<string | undefined> => (bootIdLookup ??= readBootId());

const DARWIN_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const DARWIN_LSTART_PATTERN =
  /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

/**
 * `ps -o lstart=` under `LC_ALL=C TZ=UTC0` ("Fri Oct 23 16:53:37 2026", with
 * trailing padding) as epoch seconds, or undefined when it is not that shape.
 */
export function parseDarwinPsLstart(output: string): string | undefined {
  const match = DARWIN_LSTART_PATTERN.exec(output.trim());
  if (match === null) return undefined;
  const month = DARWIN_MONTHS.indexOf(match[1]!);
  if (month < 0) return undefined;
  const epochMs = Date.UTC(
    Number(match[6]),
    month,
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  );
  return Number.isFinite(epochMs) ? String(Math.floor(epochMs / 1_000)) : undefined;
}

let darwinSelfStart: string | undefined;

/**
 * This process's start time on macOS, in epoch seconds, without running `ps`.
 * Estimated once, on the first call (at startup): the wall clock minus the
 * process uptime moves with every later clock step, so an estimate taken after
 * a long wait (a service waiting for the desktop app to quit) could fall
 * seconds before the start time `ps` reports, and this live process would look
 * like a reused pid to everyone else.
 */
export const darwinSelfStartTime = (): string =>
  (darwinSelfStart ??= String(Math.round((Date.now() - process.uptime() * 1_000) / 1_000)));

/**
 * When a process started: clock ticks since boot on Linux (a file read),
 * epoch seconds on macOS (this process from its uptime; others through `ps`),
 * and unknown elsewhere, where a live pid is taken at its word.
 *
 * What tells a reused pid from the holder: after a crash or a container
 * restart the old lock's pid can belong to any process.
 */
export async function defaultProcessStartTime(pid: number): Promise<string | undefined> {
  if (process.platform === "linux") {
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
  if (process.platform === "darwin") {
    if (pid === process.pid) return darwinSelfStartTime();
    try {
      const { stdout } = await execFileAsync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        env: { LC_ALL: "C", TZ: "UTC0" },
        timeout: 2_000,
      });
      return parseDarwinPsLstart(stdout);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Start the boot-id lookup a lock acquisition needs (an exec on macOS), so it
 * overlaps other startup work, and fix this process's macOS start estimate
 * while it is still close to the real start.
 */
export function prefetchProcessIdentity(): void {
  void defaultBootId();
  if (process.platform === "darwin") darwinSelfStartTime();
}

/**
 * Whether the start time a holder recorded for itself and the one read for its
 * pid now name the same process: exact on Linux; on macOS, unless the process
 * now holding the pid started more than {@link DARWIN_START_TIME_TOLERANCE_S}
 * after the recorded time; unknown (undefined) when either is missing or the
 * platform records none.
 *
 * The macOS comparison is one-sided on purpose. A holder records its start
 * from its uptime, which begins when its runtime initialized: at or after the
 * exec time `ps` reports, by however long that took (a loaded Electron launch
 * can take seconds). A reused pid belongs to a process that started after the
 * holder exited, so after the recorded time.
 */
export function isSameProcessStart(
  recorded: string | undefined,
  current: string | undefined,
  platform: NodeJS.Platform,
): boolean | undefined {
  if (recorded === undefined || current === undefined) return undefined;
  if (platform === "linux") return recorded === current;
  if (platform === "darwin") {
    if (!START_TIME_PATTERN.test(recorded) || !START_TIME_PATTERN.test(current)) return undefined;
    return Number(current) - Number(recorded) <= DARWIN_START_TIME_TOLERANCE_S;
  }
  return undefined;
}

export function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // EPERM is a live process owned by someone else; only ESRCH proves the
    // holder is gone.
    return errorCode(error) !== "ESRCH";
  }
}

/** What a lock file says about the process that wrote it. */
export interface RecordedProcess {
  readonly pid: number;
  readonly bootTime: number;
  readonly bootId: string | undefined;
  readonly startTime: string | undefined;
}

/** How the current machine and its processes look, injectable for tests. */
export interface ProcessProbe {
  readonly platform: NodeJS.Platform;
  readonly bootTime: () => number;
  readonly bootId: () => Promise<string | undefined>;
  readonly processAlive: (pid: number) => boolean;
  readonly processStartTime: (pid: number) => Promise<string | undefined>;
}

export const defaultProcessProbe: ProcessProbe = {
  platform: process.platform,
  bootTime: defaultBootTime,
  bootId: defaultBootId,
  processAlive: defaultProcessAlive,
  processStartTime: defaultProcessStartTime,
};

/**
 * True when the recorded process is certainly gone: it wrote the lock in an
 * earlier boot, its pid is dead, or that pid now belongs to a process that
 * started at another time. Anything uncertain counts as alive.
 */
export async function isHolderAbandoned(
  holder: RecordedProcess,
  probe: ProcessProbe,
): Promise<boolean> {
  const currentBootId = await probe.bootId();
  const sameBoot =
    holder.bootId !== undefined && currentBootId !== undefined
      ? holder.bootId === currentBootId
      : Math.abs(holder.bootTime - probe.bootTime()) <= BOOT_TIME_TOLERANCE_MS;
  // A pid from an earlier boot can only be a reused one.
  if (!sameBoot || !probe.processAlive(holder.pid)) return true;
  if (holder.startTime === undefined) return false;
  // A live pid that started at another time is a different process.
  const current = await probe.processStartTime(holder.pid);
  return isSameProcessStart(holder.startTime, current, probe.platform) === false;
}
