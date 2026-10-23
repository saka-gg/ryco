/**
 * Heap snapshots of a live server on `kill -USR2 <pid>`.
 *
 * The snapshot goes to the logs directory as `server-<pid>-<time>.heapsnapshot` (mode 0600: it
 * holds tokens and thread content). Writing one blocks the event loop for seconds to a minute and
 * needs about the heap's size in free memory, so requests are serialized with a cooldown, refused
 * when the disk is low, and old snapshots beyond the newest few are removed first. Every failure is
 * logged; none stops the server.
 *
 * Windows has no SIGUSR2; the handler is not installed there.
 *
 * @module HeapSnapshot
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeV8 from "node:v8";

import { Data, Effect, Layer, type Scope } from "effect";

import { ServerConfig } from "../config.ts";
import { trackStartupPhase } from "../startupStallMonitor.ts";

export const HEAP_SNAPSHOT_SIGNAL = "SIGUSR2";
/** Snapshots kept on disk, the new one included. */
export const HEAP_SNAPSHOT_RETAINED = 3;
export const HEAP_SNAPSHOT_COOLDOWN_MS = 10_000;
/** Free space to leave on the disk beyond the snapshot's expected size. */
export const HEAP_SNAPSHOT_FREE_DISK_RESERVE_BYTES = 1024 ** 3;
/** A `.partial` this old is never a write in progress (writing keeps updating its mtime). */
const STALE_PARTIAL_AGE_MS = 10 * 60_000;
const SNAPSHOT_FILE_PATTERN = /^server-(\d+)-.+\.heapsnapshot$/u;
const PARTIAL_FILE_PATTERN = /^server-(\d+)-.+\.heapsnapshot\.partial$/u;
export const HEAP_SNAPSHOT_PHASE = "server.heap-snapshot";

export interface HeapSnapshotDeps {
  readonly platform: NodeJS.Platform;
  readonly logsDir: string;
  readonly pid: number;
  readonly nowMs: () => number;
  /** `v8.getHeapStatistics().total_heap_size`. */
  readonly heapTotalBytes: () => number;
  /** Free bytes available to this user on the disk holding `directory`; rejects when unknown. */
  readonly freeDiskBytes: (directory: string) => Promise<number>;
  /** `v8.writeHeapSnapshot`: synchronous, blocks the event loop. */
  readonly writeSnapshot: (filePath: string) => void;
  readonly isProcessAlive: (pid: number) => boolean;
}

interface SnapshotFile {
  readonly path: string;
  readonly pid: number;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

export const heapSnapshotFileName = (pid: number, nowMs: number) =>
  `server-${pid}-${new Date(nowMs).toISOString().replaceAll(":", "-")}.heapsnapshot`;

class HeapSnapshotStepError extends Data.TaggedError("HeapSnapshotStepError")<{
  readonly step: string;
  readonly cause: unknown;
}> {
  override get message() {
    const cause = this.cause;
    const detail =
      cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause);
    return `${this.step}: ${detail}`;
  }
}

const attempt = <A>(step: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new HeapSnapshotStepError({ step, cause }),
  });

const listSnapshotFiles = async (logsDir: string) => {
  const snapshots: Array<SnapshotFile> = [];
  const partials: Array<SnapshotFile> = [];
  for (const entry of await NodeFS.promises.readdir(logsDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const snapshotMatch = SNAPSHOT_FILE_PATTERN.exec(entry.name);
    const partialMatch = snapshotMatch === null ? PARTIAL_FILE_PATTERN.exec(entry.name) : null;
    const match = snapshotMatch ?? partialMatch;
    if (match === null) continue;
    const filePath = NodePath.join(logsDir, entry.name);
    try {
      const stat = await NodeFS.promises.lstat(filePath);
      if (!stat.isFile()) continue;
      const file = {
        path: filePath,
        pid: Number(match[1]),
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
      };
      (snapshotMatch !== null ? snapshots : partials).push(file);
    } catch {
      // Removed between readdir and lstat.
    }
  }
  return { snapshots, partials };
};

export interface HeapSnapshotTaker {
  /** Writes one snapshot unless one was just written or the disk is low. Never fails. */
  readonly take: Effect.Effect<void>;
}

export const makeHeapSnapshotTaker = (deps: HeapSnapshotDeps): HeapSnapshotTaker => {
  let inProgress = false;
  let writeAttempted = false;
  let lastWrittenAtMs: number | null = null;

  const removeFiles = (files: ReadonlyArray<SnapshotFile>, message: string) =>
    Effect.forEach(
      files,
      (file) =>
        attempt("remove", () => NodeFS.promises.rm(file.path, { force: true })).pipe(
          Effect.andThen(Effect.logInfo(message, { path: file.path, sizeBytes: file.sizeBytes })),
          Effect.catch((error) =>
            Effect.logWarning("Could not remove an old heap snapshot", {
              path: file.path,
              cause: error.message,
            }),
          ),
        ),
      { discard: true },
    );

  const write = Effect.gen(function* () {
    const listed = yield* attempt("list", () => listSnapshotFiles(deps.logsDir)).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Heap snapshot refused: cannot list the logs directory", {
          logsDir: deps.logsDir,
          cause: error.message,
        }).pipe(Effect.as(null)),
      ),
    );
    if (listed === null) return;

    const nowMs = deps.nowMs();
    // Keep the newest snapshots so that, with the new one, HEAP_SNAPSHOT_RETAINED remain.
    const oldSnapshots = listed.snapshots
      .toSorted((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(HEAP_SNAPSHOT_RETAINED - 1);
    // Leftovers of writes that died (an OOM kill mid-write leaves a heap-sized file). No write of
    // this process is running here, and another process's write keeps its file's mtime fresh.
    const stalePartials = listed.partials.filter(
      (file) =>
        file.pid === deps.pid ||
        !deps.isProcessAlive(file.pid) ||
        nowMs - file.mtimeMs > STALE_PARTIAL_AGE_MS,
    );
    const reclaimableBytes = [...oldSnapshots, ...stalePartials].reduce(
      (sum, file) => sum + file.sizeBytes,
      0,
    );

    const neededBytes = 2 * deps.heapTotalBytes() + HEAP_SNAPSHOT_FREE_DISK_RESERVE_BYTES;
    const freeBytes = yield* attempt("statfs", () => deps.freeDiskBytes(deps.logsDir)).pipe(
      Effect.catch((error) =>
        Effect.logInfo("Could not read free disk space; writing the heap snapshot anyway", {
          logsDir: deps.logsDir,
          cause: error.message,
        }).pipe(Effect.as(null)),
      ),
    );
    // Old snapshots are removed only when the new one will be written, so a refusal keeps them.
    if (freeBytes !== null && freeBytes + reclaimableBytes < neededBytes) {
      yield* Effect.logWarning("Heap snapshot refused: low disk space", {
        freeBytes,
        reclaimableBytes,
        neededBytes,
        logsDir: deps.logsDir,
      });
      return;
    }

    yield* removeFiles(oldSnapshots, "Removed an old heap snapshot");
    yield* removeFiles(stalePartials, "Removed an unfinished heap snapshot");

    writeAttempted = true;
    const finalPath = NodePath.join(deps.logsDir, heapSnapshotFileName(deps.pid, nowMs));
    const partialPath = `${finalPath}.partial`;
    yield* Effect.logInfo("Writing heap snapshot; the server pauses until it is done", {
      path: finalPath,
      heapTotalBytes: deps.heapTotalBytes(),
    });
    const startedAtMs = performance.now();
    const written = yield* Effect.gen(function* () {
      // Created owner-only before the snapshot is written into it: the write reuses the file.
      yield* attempt("create", async () => {
        const handle = await NodeFS.promises.open(partialPath, "wx", 0o600);
        await handle.close();
      });
      yield* trackStartupPhase(
        HEAP_SNAPSHOT_PHASE,
        Effect.try({
          try: () => deps.writeSnapshot(partialPath),
          catch: (cause) => new HeapSnapshotStepError({ step: "write", cause }),
        }),
      );
      const durationMs = Math.round(performance.now() - startedAtMs);
      return yield* attempt("finish", async () => {
        await NodeFS.promises.chmod(partialPath, 0o600);
        const { size } = await NodeFS.promises.stat(partialPath);
        await NodeFS.promises.rename(partialPath, finalPath);
        return { sizeBytes: size, durationMs };
      });
    }).pipe(
      Effect.catch((error) =>
        attempt("cleanup", () => NodeFS.promises.rm(partialPath, { force: true })).pipe(
          Effect.ignore,
          Effect.andThen(
            Effect.logWarning("Heap snapshot failed", {
              path: finalPath,
              cause: error.message,
            }),
          ),
          Effect.as(null),
        ),
      ),
    );
    if (written === null) return;
    yield* Effect.annotateCurrentSpan({
      "heapSnapshot.path": finalPath,
      "heapSnapshot.sizeBytes": written.sizeBytes,
      "heapSnapshot.durationMs": written.durationMs,
    });
    yield* Effect.logInfo("Wrote heap snapshot", {
      path: finalPath,
      sizeBytes: written.sizeBytes,
      durationMs: written.durationMs,
    });
  });

  const take = Effect.suspend(() => {
    if (inProgress) {
      return Effect.logInfo("Heap snapshot request ignored: one is being written");
    }
    if (lastWrittenAtMs !== null && deps.nowMs() - lastWrittenAtMs < HEAP_SNAPSHOT_COOLDOWN_MS) {
      // The write is synchronous, so a second signal sent during it arrives right after: the
      // cooldown coalesces it.
      return Effect.logInfo("Heap snapshot request ignored: one was just written");
    }
    inProgress = true;
    writeAttempted = false;
    return write.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          inProgress = false;
          // A refusal (low disk) starts no cooldown: the operator may free space and retry.
          if (writeAttempted) lastWrittenAtMs = deps.nowMs();
        }),
      ),
      Effect.withSpan("server.heapSnapshot", { root: true }),
    );
  });

  return { take };
};

const isProcessAlive = (pid: number) => {
  // 0 and negative pids address process groups.
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export const makeDefaultHeapSnapshotDeps = (logsDir: string): HeapSnapshotDeps => ({
  platform: process.platform,
  logsDir,
  pid: process.pid,
  nowMs: Date.now,
  heapTotalBytes: () => NodeV8.getHeapStatistics().total_heap_size,
  freeDiskBytes: async (directory) => {
    const stats = await NodeFS.promises.statfs(directory);
    return Number(stats.bavail) * Number(stats.bsize);
  },
  writeSnapshot: (filePath) => {
    NodeV8.writeHeapSnapshot(filePath);
  },
  isProcessAlive,
});

/**
 * Installs the SIGUSR2 handler for the life of the enclosing scope. Installing it also keeps the
 * signal from terminating the process (its default action).
 */
export const installHeapSnapshotSignalHandler = (
  deps: HeapSnapshotDeps,
  signal: NodeJS.Signals = HEAP_SNAPSHOT_SIGNAL,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    if (deps.platform === "win32") return;
    const taker = makeHeapSnapshotTaker(deps);
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const handler = () => {
          runFork(taker.take);
        };
        process.on(signal, handler);
        return handler;
      }),
      (handler) => Effect.sync(() => process.off(signal, handler)),
    );
  });

/**
 * `kill -USR2 <server pid>` writes a heap snapshot into the logs directory. Only the server layer
 * provides this; CLI subcommands never register the handler.
 */
export const HeapSnapshotLive: Layer.Layer<never, never, ServerConfig> = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    yield* installHeapSnapshotSignalHandler(makeDefaultHeapSnapshotDeps(config.logsDir));
  }),
);
