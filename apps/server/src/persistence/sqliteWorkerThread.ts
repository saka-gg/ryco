/**
 * sqliteWorkerThread - supervises one inline `eval` worker thread that owns a
 * SQLite connection (the read worker in SqliteReadClient.ts, the checkpoint
 * worker in SqliteCheckpointWorker.ts).
 *
 * The worker starts lazily and announces itself with `{ ready: true }`. A start
 * that fails, an `error` or an `exit` counts as a failure; the next `start()`
 * starts a new worker, until {@link MAX_SQLITE_WORKER_FAILURES} consecutive
 * failures disable it for good (a successful ready handshake resets the
 * count). Callers keep their own protocol: they post to `current()` and get
 * every other message through `onMessage`.
 *
 * A ready worker never keeps the process alive: it is unref'd once the ready
 * handshake arrives, after its listeners (adding a `message` listener refs a
 * worker again). Until then it stays ref'd, so an awaited `start()` settles
 * even when nothing else keeps the event loop running. A host whose callers
 * await replies refs `current()` while replies are pending.
 *
 * Imports only `node:worker_threads`, so a child process can load it alone.
 *
 * @module sqliteWorkerThread
 */
import { Worker } from "node:worker_threads";

/** Consecutive start failures or crashes before a worker is disabled for good. */
export const MAX_SQLITE_WORKER_FAILURES = 3;

/**
 * Why a worker thread cannot open its own connection to `filename`, or
 * `undefined` when it can: an in-memory database exists only on its own
 * connection, and Bun's client does not run these `node:sqlite` workers.
 */
export const sqliteWorkerUnavailableReason = (filename: string): string | undefined => {
  if (filename === "" || filename === ":memory:") return "in-memory database";
  if (process.versions.bun !== undefined) return "Bun runtime";
  return undefined;
};

/** Why a worker stopped: it could not be built, it threw, or its thread exited. */
export type SqliteWorkerFailure =
  | { readonly kind: "construct"; readonly cause: unknown }
  | { readonly kind: "error"; readonly cause: unknown }
  | { readonly kind: "exit"; readonly code: number };

export interface SqliteWorkerThread {
  /** Starts the worker unless it runs or failed for good; resolves whether it is ready. */
  readonly start: () => Promise<boolean>;
  /** The ready worker, if any (callers post their own messages). */
  readonly current: () => Worker | undefined;
  /** True after too many consecutive failures, or after `close`. */
  readonly disabled: () => boolean;
  /** Terminates the worker and disables it. */
  readonly close: () => Promise<void>;
}

export interface SqliteWorkerThreadOptions {
  /** CommonJS source, run with `eval: true`; it posts `{ ready: true }` once set up. */
  readonly source: string;
  readonly workerData: unknown;
  /** Every message except the ready handshake. */
  readonly onMessage: (message: unknown) => void;
  /** Once per failed start, error or exit of a worker that was not closed on purpose. */
  readonly onFailure: (failure: SqliteWorkerFailure) => void;
}

const isReadyMessage = (message: unknown): boolean =>
  typeof message === "object" &&
  message !== null &&
  (message as { readonly ready?: unknown }).ready === true;

export const makeSqliteWorkerThread = (options: SqliteWorkerThreadOptions): SqliteWorkerThread => {
  let worker: Worker | undefined;
  let ready: Promise<boolean> | undefined;
  let isReady = false;
  let failures = 0;
  let closed = false;

  const disabled = () => closed || failures >= MAX_SQLITE_WORKER_FAILURES;

  const fail = (current: Worker, failure: SqliteWorkerFailure) => {
    // A stale worker (replaced, or closed on purpose) reports nothing.
    if (worker !== current) return;
    worker = undefined;
    ready = undefined;
    isReady = false;
    failures += 1;
    options.onFailure(failure);
    void current.terminate().catch(() => undefined);
  };

  const start = (): Promise<boolean> => {
    if (disabled()) return Promise.resolve(false);
    if (ready !== undefined) return ready;
    let current: Worker;
    try {
      current = new Worker(options.source, { eval: true, workerData: options.workerData });
    } catch (cause) {
      failures += 1;
      options.onFailure({ kind: "construct", cause });
      return Promise.resolve(false);
    }
    worker = current;
    ready = new Promise<boolean>((resolve) => {
      current.on("message", (message: unknown) => {
        if (worker !== current) return;
        if (isReadyMessage(message)) {
          failures = 0;
          isReady = true;
          current.unref();
          resolve(true);
          return;
        }
        options.onMessage(message);
      });
      current.on("error", (cause) => {
        fail(current, { kind: "error", cause });
        resolve(false);
      });
      current.on("exit", (code) => {
        fail(current, { kind: "exit", code });
        resolve(false);
      });
    });
    return ready;
  };

  const close = async () => {
    closed = true;
    const current = worker;
    worker = undefined;
    ready = undefined;
    isReady = false;
    if (current !== undefined) await current.terminate().catch(() => undefined);
  };

  return {
    start,
    current: () => (isReady ? worker : undefined),
    disabled,
    close,
  };
};
