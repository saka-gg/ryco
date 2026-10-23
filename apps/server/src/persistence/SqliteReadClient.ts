/**
 * SqliteReadClient - a read-only SQLite connection on a worker thread.
 *
 * `node:sqlite` is synchronous and the server owns one connection behind a
 * semaphore, so a heavy read (statistics over the whole history) stalls the
 * event loop and queues every other reader and writer behind it. WAL allows
 * concurrent readers, so heavy read paths run here instead: a second,
 * read-only connection opened inside a `worker_thread`. Statements execute on
 * the worker and rows come back as structured clones; the main thread only
 * pays for deserialising them. A read transaction (`withTransaction`) holds a
 * consistent WAL snapshot across several statements without touching the
 * writer's semaphore.
 *
 * Read-your-writes holds: a request is posted after the caller's own commit,
 * and a WAL read transaction sees every commit that precedes its first read.
 * A caller inside a transaction on the main connection must keep reading
 * there (uncommitted rows are invisible here); see {@link readClientFor}.
 *
 * Which reads run here: statistics, the daily recap, event-log compaction's
 * selection and receipt pages (persistence/Layers/EventLogCompaction.ts), and
 * the projection reads listed in `READ_WORKER_METHODS`
 * (orchestration/Layers/ProjectionSnapshotQuery.ts), which also records the
 * rule for adding one. Engine hydration, shell builds and event replay stay on
 * the main connection.
 *
 * The worker source is inlined and started with `eval: true`, so it needs no
 * separate bundle entry and runs the same from source, from the published CLI
 * bundle and in the packaged desktop backend (Electron with
 * ELECTRON_RUN_AS_NODE). It only uses `node:worker_threads` and `node:sqlite`.
 * Bun, in-memory databases, and a worker that cannot start or keeps crashing
 * fall back to the main connection, which keeps every caller correct.
 *
 * @module SqliteReadClient
 */
import { Worker } from "node:worker_threads";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Client from "effect/sql/SqlClient";
import type { Connection } from "effect/sql/SqlConnection";
import { SqlError, classifySqliteError } from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";

import { BLOCKING_BUSY_TIMEOUT_MS } from "./sqliteBusy.ts";

/**
 * The read client. Defaults to the main client, so code that reads through it
 * keeps working with any layer that only provides `SqlClient`.
 */
export class SqliteReadClient extends Context.Service<SqliteReadClient, Client.SqlClient>()(
  "ryco/persistence/SqliteReadClient",
) {}

/**
 * The client a read should use: the read client, unless the caller is inside a
 * transaction on the main connection (its uncommitted rows are only visible
 * there, and the fallback would wait for the semaphore that caller holds).
 */
export const readClientFor = (main: Client.SqlClient): Effect.Effect<Client.SqlClient> =>
  Effect.gen(function* () {
    if (Option.isSome(yield* Effect.serviceOption(main.transactionService))) return main;
    return Option.getOrElse(yield* Effect.serviceOption(SqliteReadClient), () => main);
  });

/** Worker statements: ASCII-only (the server bundle is kept Latin-1) and CommonJS (eval). */
const WORKER_SOURCE = String.raw`
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(workerData.filename, { readOnly: true });
db.exec("PRAGMA busy_timeout = " + workerData.busyTimeoutMs);
db.exec("PRAGMA query_only = ON");
db.exec("PRAGMA mmap_size = 268435456");
db.exec("PRAGMA cache_size = -32768");
const cache = new Map();
const CACHE_LIMIT = 200;
const prepare = (sql) => {
  let statement = cache.get(sql);
  if (statement !== undefined) {
    cache.delete(sql);
    cache.set(sql, statement);
    return statement;
  }
  statement = db.prepare(sql);
  cache.set(sql, statement);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return statement;
};
const execute = (message) => {
  const statement = message.prepared ? prepare(message.sql) : db.prepare(message.sql);
  statement.setReadBigInts(message.bigints);
  if (statement.columns().length === 0) {
    const result = statement.run(...message.params);
    return message.raw ? result : [];
  }
  if (!message.values) return statement.all(...message.params);
  statement.setReturnArrays(true);
  try {
    return statement.all(...message.params);
  } finally {
    statement.setReturnArrays(false);
  }
};
parentPort.on("message", (message) => {
  let reply;
  try {
    reply = { id: message.id, ok: true, rows: execute(message) };
  } catch (error) {
    reply = {
      id: message.id,
      ok: false,
      error: {
        message: String(error && error.message),
        code: error && error.code,
        errcode: error && error.errcode,
        errstr: error && error.errstr,
      },
    };
  }
  parentPort.postMessage(reply);
});
parentPort.postMessage({ ready: true });
`;

interface WorkerRequest {
  readonly id: number;
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;
  readonly prepared: boolean;
  readonly values: boolean;
  readonly raw: boolean;
  readonly bigints: boolean;
}

type WorkerReply =
  | { readonly ready: true }
  | { readonly id: number; readonly ok: true; readonly rows: ReadonlyArray<unknown> }
  | {
      readonly id: number;
      readonly ok: false;
      readonly error: {
        readonly message: string;
        readonly code?: unknown;
        readonly errcode?: unknown;
        readonly errstr?: unknown;
      };
    };

/** Consecutive start failures or crashes before the client stays on the main connection. */
const MAX_WORKER_FAILURES = 3;

export interface SqliteReadWorkerOptions {
  readonly filename: string;
  /** Test hook: the worker source. */
  readonly workerSource?: string;
}

/** Counters for tests and diagnostics. */
export interface SqliteReadWorkerStats {
  readonly workerStatements: number;
  readonly fallbackAcquisitions: number;
  readonly workerFailures: number;
}

interface PendingRequest {
  readonly resolve: (rows: ReadonlyArray<unknown>) => void;
  readonly reject: (error: SqlError) => void;
}

const workerError = (message: string, cause?: unknown) =>
  new SqlError({
    reason: classifySqliteError(cause ?? new Error(message), {
      message,
      operation: "execute",
    }),
  });

/**
 * Owns the worker: starts it lazily, restarts it after a crash, and gives up
 * (permanently falling back) after {@link MAX_WORKER_FAILURES} consecutive
 * failures.
 */
const makeWorkerHost = (options: SqliteReadWorkerOptions) => {
  let worker: Worker | undefined;
  let ready: Promise<boolean> | undefined;
  let failures = 0;
  let nextId = 0;
  let workerStatements = 0;
  let workerFailures = 0;
  let lastFailure: string | null = null;
  const pending = new Map<number, PendingRequest>();

  const failAll = (error: SqlError) => {
    const entries = [...pending.values()];
    pending.clear();
    for (const entry of entries) entry.reject(error);
  };

  const onFailure = (current: Worker, error: SqlError) => {
    if (worker !== current) return;
    worker = undefined;
    ready = undefined;
    failures += 1;
    workerFailures += 1;
    lastFailure = error.message;
    failAll(error);
    void current.terminate().catch(() => undefined);
  };

  const start = (): Promise<boolean> => {
    if (failures >= MAX_WORKER_FAILURES) return Promise.resolve(false);
    if (ready !== undefined) return ready;
    let current: Worker;
    try {
      current = new Worker(options.workerSource ?? WORKER_SOURCE, {
        eval: true,
        workerData: { filename: options.filename, busyTimeoutMs: BLOCKING_BUSY_TIMEOUT_MS },
      });
    } catch (cause) {
      failures += 1;
      workerFailures += 1;
      lastFailure = String(cause);
      return Promise.resolve(false);
    }
    // The reader must never keep the process alive.
    current.unref();
    worker = current;
    ready = new Promise<boolean>((resolve) => {
      current.on("message", (reply: WorkerReply) => {
        if ("ready" in reply) {
          failures = 0;
          resolve(true);
          return;
        }
        const entry = pending.get(reply.id);
        if (entry === undefined) return;
        pending.delete(reply.id);
        if (reply.ok) entry.resolve(reply.rows);
        else {
          // Rebuild the driver error so SQLite error classification sees its codes.
          const { message, ...codes } = reply.error;
          entry.reject(
            workerError("Failed to execute statement", Object.assign(new Error(message), codes)),
          );
        }
      });
      current.on("error", (cause) => {
        onFailure(current, workerError("SQLite read worker failed", cause));
        resolve(false);
      });
      current.on("exit", (code) => {
        onFailure(current, workerError(`SQLite read worker exited with code ${code}`));
        resolve(false);
      });
    });
    return ready;
  };

  const request = (input: Omit<WorkerRequest, "id">): Effect.Effect<ReadonlyArray<any>, SqlError> =>
    Effect.callback<ReadonlyArray<any>, SqlError>((resume) => {
      const current = worker;
      if (current === undefined) {
        resume(Effect.fail(workerError("SQLite read worker is not running")));
        return;
      }
      const id = nextId++;
      workerStatements += 1;
      pending.set(id, {
        resolve: (rows) => resume(Effect.succeed(rows)),
        reject: (error) => resume(Effect.fail(error)),
      });
      try {
        // A worker_threads port, not a window: there is no target origin.
        // oxlint-disable-next-line unicorn/require-post-message-target-origin
        current.postMessage({ ...input, id } satisfies WorkerRequest);
      } catch (cause) {
        pending.delete(id);
        resume(Effect.fail(workerError("Failed to send statement to SQLite read worker", cause)));
      }
      // An interrupted caller drops its reply; the worker still finishes the statement.
      return Effect.sync(() => pending.delete(id));
    });

  const close = Effect.promise(async () => {
    failures = MAX_WORKER_FAILURES;
    const current = worker;
    worker = undefined;
    ready = undefined;
    failAll(workerError("SQLite read worker closed"));
    if (current !== undefined) await current.terminate().catch(() => undefined);
  });

  return {
    start: Effect.promise(start),
    request,
    close,
    stats: () => ({ workerStatements, workerFailures }),
    lastFailure: () => lastFailure,
  };
};

const makeWorkerConnection = (host: ReturnType<typeof makeWorkerHost>): Connection => {
  const run = (
    sql: string,
    params: ReadonlyArray<unknown>,
    flags: { readonly prepared: boolean; readonly values: boolean; readonly raw: boolean },
  ) =>
    Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) =>
      host.request({
        sql,
        params,
        ...flags,
        bigints: Boolean(Context.get(fiber.context, Client.SafeIntegers)),
      }),
    );
  return {
    execute(sql, params, rowTransform) {
      const effect = run(sql, params, { prepared: true, values: false, raw: false });
      return rowTransform ? Effect.map(effect, rowTransform) : effect;
    },
    executeRaw(sql, params) {
      return run(sql, params, { prepared: true, values: false, raw: true });
    },
    executeValues(sql, params) {
      return run(sql, params, { prepared: true, values: true, raw: false });
    },
    executeValuesUnprepared(sql, params) {
      return run(sql, params, { prepared: false, values: true, raw: false });
    },
    executeUnprepared(sql, params, rowTransform) {
      const effect = run(sql, params ?? [], { prepared: false, values: false, raw: false });
      return rowTransform ? Effect.map(effect, rowTransform) : effect;
    },
    executeStream(_sql, _params) {
      return Stream.die("executeStream not implemented");
    },
  };
};

/**
 * A read client over a worker connection. Each acquisition (one statement or
 * one transaction) uses the worker when it is running and otherwise the main
 * connection, so a failed or crashed worker degrades to today's behaviour.
 */
export const makeSqliteReadWorkerClient = Effect.fn("makeSqliteReadWorkerClient")(function* (
  main: Client.SqlClient,
  options: SqliteReadWorkerOptions,
) {
  const host = makeWorkerHost(options);
  yield* Effect.addFinalizer(() => host.close);
  const workerConnection = makeWorkerConnection(host);
  const semaphore = yield* Semaphore.make(1);
  let fallbackAcquisitions = 0;
  let warnedFallback = false;
  // Reads stay correct on the main connection; say once why they no longer run off-thread.
  const fallback = Effect.suspend(() => {
    fallbackAcquisitions += 1;
    if (warnedFallback) return Effect.void;
    warnedFallback = true;
    return Effect.logWarning("SQLite read worker unavailable; reading on the main connection", {
      detail: host.lastFailure(),
    });
  });

  // A transaction holds the connection it started on for its whole scope.
  const transactionAcquirer: Effect.Effect<Connection, SqlError, Scope.Scope> =
    Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(Effect.scope, (scope) =>
        Effect.flatMap(restore(host.start), (started) => {
          if (!started) return Effect.andThen(fallback, restore(main.reserve));
          return restore(semaphore.take(1)).pipe(
            Effect.andThen(Scope.addFinalizer(scope, semaphore.release(1))),
            Effect.as(workerConnection),
          );
        }),
      ),
    );

  const client = yield* Client.make({
    acquirer: transactionAcquirer,
    transactionAcquirer,
    compiler: Statement.makeCompilerSqlite(),
    spanAttributes: [
      ["db.system.name", "sqlite"],
      ["db.connection", "read-worker"],
    ],
  });
  return Object.assign(client, {
    readWorkerStats: (): SqliteReadWorkerStats => ({
      ...host.stats(),
      fallbackAcquisitions,
    }),
  });
});

/** Whether this runtime can host the read worker for `filename`. */
export const canUseReadWorker = (filename: string): boolean =>
  process.versions.bun === undefined && filename !== ":memory:" && filename !== "";

/** Provides {@link SqliteReadClient}: a worker connection where supported, else the main client. */
export const layer = (filename: string): Layer.Layer<SqliteReadClient, never, Client.SqlClient> =>
  Layer.effect(
    SqliteReadClient,
    Effect.gen(function* () {
      const main = yield* Client.SqlClient;
      if (!canUseReadWorker(filename)) return main;
      return yield* makeSqliteReadWorkerClient(main, { filename });
    }),
  ).pipe(Layer.provide(Reactivity.layer));

/** Reads stay on the main connection (tests, in-memory databases). */
export const layerMain: Layer.Layer<SqliteReadClient, never, Client.SqlClient> = Layer.effect(
  SqliteReadClient,
  Effect.service(Client.SqlClient),
);
