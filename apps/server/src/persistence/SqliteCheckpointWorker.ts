/**
 * SqliteCheckpointWorker - WAL checkpoints on a worker thread.
 *
 * `node:sqlite` is synchronous, and SQLite runs its automatic checkpoint inside
 * the commit that pushes the WAL past `wal_autocheckpoint` frames: copying
 * those pages into the database and syncing it blocked the event loop for a
 * few milliseconds (more on Linux) about every 1,000 frames. Here a second,
 * `query_only` connection on a worker thread runs the checkpoints instead:
 *
 * - After every autocommit statement, the writer reads the WAL's frame counts
 *   with `PRAGMA wal_checkpoint(NOOP)` (about 0.5 us, never blocks). Once
 *   {@link CHECKPOINT_FRAMES} frames wait, it asks the worker for a PASSIVE
 *   checkpoint. At most one request is in flight; requests made meanwhile
 *   collapse into one re-check. The request follows the commit that crossed
 *   the threshold, so the worker starts at once, in the gap before the next
 *   commit (waiting for a longer gap measured worse).
 * - Frames committed while a checkpoint runs get up to {@link CATCH_UP_PASSES}
 *   more PASSIVE passes while each makes progress, and the worker checkpoints
 *   the rest once the WAL stops growing for {@link CHECKPOINT_IDLE_MS}. Once
 *   nothing is behind, the writer restarts the WAL at its next write and
 *   `journal_size_limit` bounds the file. A WAL that never empties only grows,
 *   and commits got slower with it (measure-sqlite-checkpoints.ts).
 * - A read on the read worker holds a snapshot that checkpoints cannot copy
 *   past; when one ends, the read client calls `walReaderReleased` and a
 *   checkpoint that was blocked is retried at once instead of after a backoff.
 * - The writer keeps SQLite's own autocheckpoint as a backstop at
 *   {@link WRITER_BACKSTOP_FRAMES}. It still runs on the main thread when the
 *   worker cannot keep up: writes with no pause, a long read transaction, one
 *   transaction larger than the backstop, or a WAL left over from a crash.
 * - The worker uses PASSIVE only: it never waits for the writer or for
 *   readers, and never changes data.
 *
 * Falls back to SQLite's default (autocheckpoint 1,000 on the writer) when the
 * worker cannot start or keeps crashing, and when its checkpoints keep
 * failing. Not used in the macOS desktop runtime or with SQLite before 3.54 on
 * macOS ({@link macOsCheckpointWorkerReason}: it measured slower there), where
 * `wal_checkpoint(NOOP)` is missing (SQLite before 3.51 parses it as PASSIVE),
 * under Bun, or for in-memory databases.
 *
 * Imports no `node:sqlite`: the writer is reached through closures.
 *
 * @module SqliteCheckpointWorker
 */
import { BLOCKING_BUSY_TIMEOUT_MS } from "./sqliteBusy.ts";
import {
  MAX_SQLITE_WORKER_FAILURES,
  makeSqliteWorkerThread,
  sqliteWorkerUnavailableReason,
  type SqliteWorkerFailure,
} from "./sqliteWorkerThread.ts";

/** SQLite's default wal_autocheckpoint, in frames: the worker's PASSIVE threshold. */
export const CHECKPOINT_FRAMES = 1_000;
/** The writer's own autocheckpoint while the worker owns checkpoints. */
export const WRITER_BACKSTOP_FRAMES = 10_000;
/** How long the WAL must stop growing before the worker checkpoints the rest. */
export const CHECKPOINT_IDLE_MS = 100;
/** The main thread skips requests this long after a checkpoint made no progress. */
export const BLOCKED_BACKOFF_MS = 250;
/** The worker retries a blocked checkpoint after this, doubling up to the max. */
export const BLOCKED_RETRY_MS = 250;
export const BLOCKED_RETRY_MAX_MS = 2_000;
/** After a failed start or a crash, wait this long before starting another worker. */
export const START_RETRY_MS = 1_000;
/**
 * Extra PASSIVE passes for frames committed while a checkpoint ran, as long as each one makes
 * progress: without them a steadily written WAL rarely empties, so it only grows.
 */
export const CATCH_UP_PASSES = 3;
/** Consecutive failed checkpoints before the writer takes checkpoints back. */
export const MAX_CHECKPOINT_ERRORS = 3;

const parseSqliteVersion = (version: string) => {
  const match = /^(\d+)\.(\d+)(?:\.\d+)*$/.exec(version.trim());
  return match === null ? undefined : { major: Number(match[1]), minor: Number(match[2]) };
};

const atLeast = (version: string, major: number, minor: number): boolean => {
  const parsed = parseSqliteVersion(version);
  if (parsed === undefined) return false;
  return parsed.major > major || (parsed.major === major && parsed.minor >= minor);
};

/** Whether SQLite `version` (as `sqlite_version()` reports it) has `wal_checkpoint(NOOP)`. */
export const supportsNoopCheckpoint = (version: string): boolean => atLeast(version, 3, 51);

/**
 * Why macOS keeps the writer's own checkpoints, or `undefined` where the worker measured faster
 * there. A checkpoint inside the commit only costs a few milliseconds on an APFS SSD, and the
 * worker's concurrent copy and fsync can slow the writer's other commits by more than that. In the
 * desktop runtime (Electron 44.7: Node 24.21, SQLite 3.53.4) main-thread time per commit rose about
 * 50% and every tail got worse; with Node 24.22 (SQLite 3.54.0) the worker was faster on every
 * measure (measure-sqlite-checkpoints.ts). Which difference matters is not known, so macOS uses the
 * worker only with both: outside Electron and on SQLite 3.54 or later.
 */
export const macOsCheckpointWorkerReason = (input: {
  readonly electron: boolean;
  readonly sqliteVersion: string;
}): string | undefined => {
  if (input.electron) return "macOS desktop runtime: the writer's own checkpoints measured faster";
  if (!atLeast(input.sqliteVersion, 3, 54)) {
    return `SQLite ${input.sqliteVersion} on macOS: the writer's own checkpoints measured faster`;
  }
  return undefined;
};

/**
 * Why a connection cannot hand its checkpoints to a worker, or `undefined` when
 * it can.
 */
export const checkpointWorkerUnavailableReason = (input: {
  readonly filename: string;
  readonly readonly: boolean;
  readonly image: boolean;
  readonly hasIsTransaction: boolean;
  readonly sqliteVersion: string;
  readonly platform: string;
  /** Running in Electron (`ELECTRON_RUN_AS_NODE`, the desktop backend). */
  readonly electron: boolean;
  /** {@link SqliteCheckpointWorkerOptions.anyPlatform}. */
  readonly anyPlatform: boolean;
}): string | undefined => {
  const unavailable = sqliteWorkerUnavailableReason(input.filename);
  if (unavailable !== undefined) return unavailable;
  if (input.image) return "in-memory database";
  if (input.readonly) return "read-only connection";
  if (input.platform === "darwin" && !input.anyPlatform) {
    const reason = macOsCheckpointWorkerReason(input);
    if (reason !== undefined) return reason;
  }
  if (!input.hasIsTransaction) return "node:sqlite has no isTransaction";
  if (!supportsNoopCheckpoint(input.sqliteVersion)) {
    return `SQLite ${input.sqliteVersion} has no NOOP checkpoint`;
  }
  return undefined;
};

/**
 * The worker: checkpoints only. ASCII-only (the server bundle is kept Latin-1)
 * and CommonJS (eval). `blocked` means the checkpoint failed or left frames it
 * could not copy (another checkpointer, or a reader still using them).
 */
export const CHECKPOINT_WORKER_SOURCE = String.raw`
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(workerData.filename);
db.exec("PRAGMA busy_timeout = " + workerData.busyTimeoutMs);
// This connection only checkpoints: SQLite refuses any data change on it.
db.exec("PRAGMA query_only = ON");
const mode = String(db.prepare("PRAGMA journal_mode").get().journal_mode).toLowerCase();
if (mode !== "wal") throw new Error("database uses journal_mode " + mode + ", not wal");
const frames = db.prepare("PRAGMA wal_checkpoint(NOOP)");
const passive = db.prepare("PRAGMA wal_checkpoint(PASSIVE)");
let timer;
let lastLog = -1;
let retryMs = workerData.blockedRetryMs;
let busy = false;
let complete = false;
const checkpoint = () => {
  const result = passive.get();
  busy = result.busy !== 0;
  // The pass's own counts: it copied every frame the WAL held while it ran. That is not
  // blocked, even if the writer restarted the WAL and refilled it before the next NOOP.
  complete = !busy && result.log >= 0 && result.checkpointed >= result.log;
};
const arm = (after, blocked) => {
  clearTimeout(timer);
  timer = undefined;
  if (blocked) {
    timer = setTimeout(onTimer, retryMs);
    retryMs = Math.min(retryMs * 2, workerData.blockedRetryMaxMs);
    return;
  }
  retryMs = workerData.blockedRetryMs;
  if (after !== undefined && after.log > after.checkpointed) {
    timer = setTimeout(onTimer, workerData.idleMs);
  }
};
const run = (requested, remainder) => {
  let before;
  let after;
  let ran = false;
  let ms = 0;
  let error = null;
  busy = false;
  complete = false;
  try {
    before = frames.get();
    const behind = before.log - before.checkpointed;
    if (behind >= workerData.thresholdFrames || (remainder && behind > 0)) {
      const startedAt = performance.now();
      checkpoint();
      ran = true;
      after = frames.get();
      // Commits that landed while it ran left a few frames behind. Copy them too while that
      // makes progress: once nothing is behind, the writer restarts the WAL at its next commit
      // instead of growing it.
      let progress = before.checkpointed;
      for (
        let pass = 0;
        pass < workerData.catchUpPasses &&
        !busy &&
        after.log >= before.log &&
        after.log > after.checkpointed &&
        after.checkpointed > progress;
        pass += 1
      ) {
        progress = after.checkpointed;
        checkpoint();
        after = frames.get();
      }
      ms = performance.now() - startedAt;
    } else {
      after = frames.get();
    }
    lastLog = after.log;
  } catch (cause) {
    error = String((cause && cause.message) || cause);
  }
  // A smaller log means the writer restarted the WAL meanwhile: everything was copied.
  const blocked =
    error !== null ||
    (ran &&
      !complete &&
      after.log >= before.log &&
      after.log > after.checkpointed &&
      (busy || after.checkpointed <= before.checkpointed));
  parentPort.postMessage({
    type: "checked",
    requested,
    ran,
    ms,
    blocked,
    error,
    log: after ? after.log : -1,
    checkpointed: after ? after.checkpointed : -1,
  });
  arm(after, blocked);
};
const onTimer = () => {
  timer = undefined;
  let state;
  try {
    state = frames.get();
  } catch (cause) {
    arm(undefined, true);
    return;
  }
  if (state.log <= state.checkpointed) {
    arm(state, false);
    return;
  }
  // Writes still arrive: wait for a pause before checkpointing the rest.
  if (state.log !== lastLog) {
    lastLog = state.log;
    timer = setTimeout(onTimer, workerData.idleMs);
    return;
  }
  run(false, true);
};
// The writer asks right after the commit that crossed the threshold: start at once, in the gap
// before its next commit.
parentPort.on("message", (message) => {
  if (!message || message.type !== "check") return;
  clearTimeout(timer);
  timer = undefined;
  run(true, false);
});
parentPort.postMessage({ ready: true });
`;

/**
 * Implemented by the Node client (NodeSqliteClient.ts). A reader's snapshot is what blocks a
 * checkpoint most often, so the read worker (SqliteReadClient.ts) reports each read it ends.
 */
export interface WalReaderReleased {
  /** A read on another connection ended; a checkpoint it blocked can go through now. */
  readonly walReaderReleased: () => void;
}

/** The client's {@link WalReaderReleased} hook, if it has one (Bun's client has none). */
export const walReaderReleasedHook = (client: unknown): (() => void) | undefined => {
  const hook = (client as Partial<WalReaderReleased> | null | undefined)?.walReaderReleased;
  return typeof hook === "function" ? hook : undefined;
};

/** Frame counts from `PRAGMA wal_checkpoint(NOOP)`. */
export interface WalFrames {
  readonly log: number;
  readonly checkpointed: number;
}

/** Test hooks; production uses the defaults. */
export interface SqliteCheckpointWorkerOptions {
  readonly workerSource?: string | undefined;
  /** Defaults to {@link CHECKPOINT_FRAMES}. */
  readonly thresholdFrames?: number | undefined;
  /** Defaults to {@link CHECKPOINT_IDLE_MS}. */
  readonly idleMs?: number | undefined;
  /** Defaults to {@link START_RETRY_MS}. */
  readonly startRetryMs?: number | undefined;
  /** Defaults to {@link CATCH_UP_PASSES}; 0 checkpoints the rest only after a pause. */
  readonly catchUpPasses?: number | undefined;
  /** Replaces `sqlite_version()` in the support check. */
  readonly sqliteVersion?: string | undefined;
  /**
   * Use the worker also where macOS keeps the writer's own checkpoints
   * ({@link macOsCheckpointWorkerReason}; tests and measurements).
   */
  readonly anyPlatform?: boolean | undefined;
}

/** Counters for tests, measurements and diagnostics. */
export interface SqliteCheckpointWorkerStats {
  /** NOOP probes the writer ran. */
  readonly probes: number;
  /** `check` messages posted to the worker. */
  readonly requests: number;
  /** Replies with `ran` (requested or idle). */
  readonly checkpoints: number;
  /** Checkpoints of the rest after writes paused. */
  readonly idleCheckpoints: number;
  /** Replies that left frames behind (another checkpointer, a reader) or failed. */
  readonly blocked: number;
  /** Replies with an error. */
  readonly errors: number;
  /** Successful ready handshakes. */
  readonly workerStarts: number;
  /** Failed starts and crashes. */
  readonly workerFailures: number;
  /** Gave up: the writer is back on SQLite's default autocheckpoint. */
  readonly fallback: boolean;
  /** A worker is ready. */
  readonly running: boolean;
  /** A `check` request awaits its reply. */
  readonly inFlight: boolean;
}

export interface WalCheckpointer {
  /** Call after every statement on the writer; never throws. */
  readonly afterStatement: () => void;
  /**
   * A read transaction on another connection ended. If a reader blocked the last checkpoint,
   * drop the backoff and check again now instead of after it; never throws.
   */
  readonly readerReleased: () => void;
  /** Stops the worker; call before the writer closes. */
  readonly close: () => Promise<void>;
  readonly stats: () => SqliteCheckpointWorkerStats;
}

interface CheckedReply {
  readonly type: "checked";
  readonly requested: boolean;
  readonly ran: boolean;
  readonly blocked: boolean;
  readonly error: string | null;
}

const isCheckedReply = (message: unknown): message is CheckedReply =>
  typeof message === "object" &&
  message !== null &&
  (message as { readonly type?: unknown }).type === "checked";

const describeFailure = (failure: SqliteWorkerFailure): string => {
  if (failure.kind === "exit") return `SQLite checkpoint worker exited with code ${failure.code}`;
  const cause = failure.cause;
  const detail = cause instanceof Error ? cause.message : String(cause);
  return failure.kind === "construct"
    ? `SQLite checkpoint worker could not start: ${detail}`
    : `SQLite checkpoint worker failed: ${detail}`;
};

/**
 * The writer's side. The worker starts lazily, at the first request, so a
 * connection that never lets {@link CHECKPOINT_FRAMES} frames pile up never
 * starts a thread.
 */
export const makeWalCheckpointer = (input: {
  readonly filename: string;
  /** The writer's `PRAGMA wal_checkpoint(NOOP)`; `undefined` when it fails. */
  readonly probe: () => WalFrames | undefined;
  readonly isTransaction: () => boolean;
  readonly setAutocheckpoint: (frames: number) => void;
  /** After every ready handshake. */
  readonly onStarted: (starts: number) => void;
  /** Once, when the writer takes checkpoints back for good. */
  readonly onFallback: (reason: string) => void;
  readonly options: SqliteCheckpointWorkerOptions;
}): WalCheckpointer => {
  const options = input.options;
  const thresholdFrames = options.thresholdFrames ?? CHECKPOINT_FRAMES;
  const startRetryMs = options.startRetryMs ?? START_RETRY_MS;

  let state: "idle" | "starting" | "in-flight" = "idle";
  let pending = false;
  let blockedUntil = 0;
  // The last checkpoint was blocked without an error: most likely by a reader's snapshot.
  let blockedByReader = false;
  let stopped = false;
  let fallback = false;
  let consecutiveErrors = 0;
  // Failures since a worker last answered a check. The supervisor forgives failures once a new
  // worker is ready, so a worker that starts but dies on every check would otherwise be
  // restarted forever while the writer stays on the backstop.
  let failuresSinceReply = 0;
  let probes = 0;
  let requests = 0;
  let checkpoints = 0;
  let idleCheckpoints = 0;
  let blocked = 0;
  let errors = 0;
  let workerStarts = 0;
  let workerFailures = 0;

  const giveUp = (reason: string) => {
    if (fallback) return;
    fallback = true;
    state = "idle";
    pending = false;
    try {
      input.setAutocheckpoint(CHECKPOINT_FRAMES);
    } catch {
      // The writer is closing; nothing is left to checkpoint for.
    }
    void thread.close();
    input.onFallback(reason);
  };

  const onFailure = (failure: SqliteWorkerFailure) => {
    workerFailures += 1;
    failuresSinceReply += 1;
    pending = false;
    // A crash loses the request in flight; a failed start resolves `start` itself.
    if (state === "in-flight") state = "idle";
    blockedByReader = false;
    if (thread.disabled() || failuresSinceReply >= MAX_SQLITE_WORKER_FAILURES) {
      if (!stopped) giveUp(describeFailure(failure));
      return;
    }
    blockedUntil = performance.now() + startRetryMs;
  };

  const onReply = (reply: CheckedReply) => {
    failuresSinceReply = 0;
    if (reply.requested && state === "in-flight") state = "idle";
    if (reply.ran) {
      checkpoints += 1;
      if (!reply.requested) idleCheckpoints += 1;
    }
    if (reply.blocked) blocked += 1;
    blockedUntil = reply.blocked ? performance.now() + BLOCKED_BACKOFF_MS : 0;
    blockedByReader = reply.blocked && reply.error === null;
    if (reply.error !== null) {
      errors += 1;
      consecutiveErrors += 1;
      if (consecutiveErrors >= MAX_CHECKPOINT_ERRORS) {
        giveUp(`checkpoint failed ${consecutiveErrors} times in a row: ${reply.error}`);
        return;
      }
    } else if (reply.ran) {
      consecutiveErrors = 0;
    }
    if (pending && state === "idle") {
      pending = false;
      afterStatement();
    }
  };

  const thread = makeSqliteWorkerThread({
    source: options.workerSource ?? CHECKPOINT_WORKER_SOURCE,
    workerData: {
      filename: input.filename,
      busyTimeoutMs: BLOCKING_BUSY_TIMEOUT_MS,
      thresholdFrames,
      idleMs: options.idleMs ?? CHECKPOINT_IDLE_MS,
      blockedRetryMs: BLOCKED_RETRY_MS,
      blockedRetryMaxMs: BLOCKED_RETRY_MAX_MS,
      catchUpPasses: options.catchUpPasses ?? CATCH_UP_PASSES,
    },
    onMessage: (message) => {
      if (stopped || fallback || !isCheckedReply(message)) return;
      onReply(message);
    },
    onFailure,
  });

  const request = () => {
    const worker = thread.current();
    if (worker === undefined) {
      state = "starting";
      void thread.start().then((ready) => {
        state = "idle";
        pending = false;
        if (!ready || stopped || fallback) return;
        workerStarts += 1;
        input.onStarted(workerStarts);
        // Writes may have gone on meanwhile; ask with the current counts.
        afterStatement();
      });
      return;
    }
    state = "in-flight";
    requests += 1;
    try {
      // A worker_threads port, not a window: there is no target origin.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      worker.postMessage({ type: "check" });
    } catch {
      state = "idle";
    }
  };

  function afterStatement(): void {
    if (stopped || fallback) return;
    try {
      // Inside a transaction the NOOP would fail (the table is locked); its COMMIT asks.
      if (input.isTransaction()) return;
      probes += 1;
      const frames = input.probe();
      if (frames === undefined || frames.log - frames.checkpointed < thresholdFrames) return;
      if (performance.now() < blockedUntil) return;
      if (state !== "idle") {
        pending = true;
        return;
      }
      request();
    } catch {
      // Checkpoints are best effort; the writer's backstop still bounds the WAL.
    }
  }

  const readerReleased = () => {
    if (!blockedByReader || stopped || fallback) return;
    blockedByReader = false;
    blockedUntil = 0;
    afterStatement();
  };

  const close = async () => {
    stopped = true;
    pending = false;
    await thread.close();
  };

  return {
    afterStatement,
    readerReleased,
    close,
    stats: () => ({
      probes,
      requests,
      checkpoints,
      idleCheckpoints,
      blocked,
      errors,
      workerStarts,
      workerFailures,
      fallback,
      running: thread.current() !== undefined,
      inFlight: state === "in-flight",
    }),
  };
};
