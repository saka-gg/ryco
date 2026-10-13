/**
 * How much disk a checkout takes. A dependency-heavy checkout holds hundreds of
 * thousands of entries, so POSIX nodes ask `du` (one child, no event-loop or
 * libuv pool work); Windows has no `du`, so a bounded walk sums apparent sizes.
 * Measurements are cached per path and run a few at a time: reopening the
 * Projects map answers from the cache instead of walking every checkout again.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { runProcess } from "../processRunner.ts";
import { containsPath } from "./checkoutInspection.ts";

export interface DiskUsageMeasurement {
  /** Null when nothing could be measured (missing, unreadable, timed out with no answer). */
  readonly bytes: number | null;
  /** Some entries were skipped or the walk stopped early: `bytes` is a lower bound. */
  readonly partial: boolean;
}

const MEASURE_TIMEOUT_MS = 120_000;
const WALK_ENTRY_LIMIT = 2_000_000;

/** `du -skx`: allocated kilobytes, symbolic links not followed, one file system. */
async function measureWithDu(root: string): Promise<DiskUsageMeasurement> {
  const result = await runProcess("du", ["-skx", root], {
    allowNonZeroExit: true,
    timeoutMs: MEASURE_TIMEOUT_MS,
    shell: false,
    outputMode: "truncate",
    maxBufferBytes: 64 * 1024,
  });
  // The summary is the last line; unreadable entries add stderr lines and exit 1.
  const lastLine = result.stdout.trim().split("\n").at(-1) ?? "";
  const kilobytes = Number.parseInt(lastLine.split(/\s/)[0] ?? "", 10);
  if (result.timedOut || !Number.isFinite(kilobytes) || kilobytes < 0)
    return { bytes: null, partial: true };
  return { bytes: kilobytes * 1024, partial: result.code !== 0 };
}

/** Apparent sizes, links not followed; stops at a time and entry limit. */
async function measureByWalking(root: string): Promise<DiskUsageMeasurement> {
  const deadline = Date.now() + MEASURE_TIMEOUT_MS;
  let remaining = WALK_ENTRY_LIMIT;
  let bytes = 0;
  let partial = false;
  try {
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory()) return { bytes: rootStat.size, partial: false };
  } catch {
    return { bytes: null, partial: true };
  }
  const pending = [root];
  while (pending.length > 0) {
    if (remaining <= 0 || Date.now() >= deadline) {
      partial = true;
      break;
    }
    const current = pending.pop()!;
    let directory;
    try {
      directory = await fs.opendir(current);
    } catch {
      partial = true;
      continue;
    }
    for await (const entry of directory) {
      remaining -= 1;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (entry.isSymbolicLink()) continue;
      try {
        bytes += (await fs.lstat(entryPath)).size;
      } catch {
        partial = true;
      }
    }
  }
  return { bytes, partial };
}

export const measureDiskUsage = (root: string): Promise<DiskUsageMeasurement> =>
  process.platform === "win32" ? measureByWalking(root) : measureWithDu(root);

/**
 * Each path's own usage: a checkout nested inside another (a worktree kept
 * under the project folder) is subtracted from the nearest checkout holding it,
 * so the totals count every byte once.
 */
export function exclusiveDiskUsage(
  measured: ReadonlyArray<{ readonly path: string; readonly usage: DiskUsageMeasurement }>,
): DiskUsageMeasurement[] {
  const result = measured.map(({ usage }) => ({ ...usage }));
  measured.forEach((child, childIndex) => {
    let parentIndex = -1;
    measured.forEach((candidate, index) => {
      if (index === childIndex || !containsPath(candidate.path, child.path)) return;
      if (containsPath(child.path, candidate.path)) return; // The same folder twice.
      if (parentIndex === -1 || containsPath(measured[parentIndex]!.path, candidate.path))
        parentIndex = index;
    });
    if (parentIndex === -1) return;
    const parent = result[parentIndex]!;
    const childBytes = child.usage.bytes;
    if (parent.bytes === null) return;
    if (childBytes === null) {
      // The parent's figure still holds the unmeasured child: no longer exact.
      parent.partial = true;
      return;
    }
    parent.bytes = Math.max(0, parent.bytes - childBytes);
  });
  return result;
}

interface CachedMeasurement {
  readonly measuredAtMs: number;
  readonly usage: Promise<DiskUsageMeasurement>;
  settled: boolean;
}

export interface DiskUsageCache {
  /** The path's usage, measured at most once per TTL unless `refresh` asks again. */
  readonly read: (
    root: string,
    refresh: boolean,
  ) => Promise<{ readonly usage: DiskUsageMeasurement; readonly measuredAtMs: number }>;
}

export function makeDiskUsageCache(options?: {
  readonly measure?: (root: string) => Promise<DiskUsageMeasurement>;
  readonly ttlMs?: number;
  readonly concurrency?: number;
  readonly now?: () => number;
  readonly maxEntries?: number;
}): DiskUsageCache {
  const measure = options?.measure ?? measureDiskUsage;
  const ttlMs = options?.ttlMs ?? 10 * 60_000;
  const concurrency = options?.concurrency ?? 2;
  const now = options?.now ?? Date.now;
  const maxEntries = options?.maxEntries ?? 512;
  const entries = new Map<string, CachedMeasurement>();
  const waiting: Array<() => void> = [];
  let running = 0;

  const limited = async (root: string): Promise<DiskUsageMeasurement> => {
    if (running >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
    running += 1;
    try {
      return await measure(root);
    } catch {
      return { bytes: null, partial: true };
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  };

  return {
    read: async (root, refresh) => {
      const key = path.resolve(root);
      const cached = entries.get(key);
      // An in-flight measurement is shared, refresh or not: it is the newest one.
      if (cached && (!cached.settled || (!refresh && now() - cached.measuredAtMs < ttlMs))) {
        return { usage: await cached.usage, measuredAtMs: cached.measuredAtMs };
      }
      const usage = limited(key);
      const next: CachedMeasurement = { measuredAtMs: now(), usage, settled: false };
      void usage.then(() => {
        next.settled = true;
      });
      entries.delete(key);
      entries.set(key, next);
      if (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
      return { usage: await usage, measuredAtMs: next.measuredAtMs };
    },
  };
}
