// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Logger } from "effect";

import * as NodeSqliteClient from "./NodeSqliteClient.ts";
import {
  CHECKPOINT_WORKER_SOURCE,
  checkpointWorkerUnavailableReason,
  supportsNoopCheckpoint,
  type SqliteCheckpointWorkerOptions,
  type SqliteCheckpointWorkerStats,
  type WalFrames,
} from "./SqliteCheckpointWorker.ts";

const runtimeSqliteVersion = (() => {
  const db = new DatabaseSync(":memory:");
  try {
    return String(
      (db.prepare("SELECT sqlite_version() AS version").get() as { version: unknown }).version,
    );
  } finally {
    db.close();
  }
})();
const hasNoopCheckpoint = supportsNoopCheckpoint(runtimeSqliteVersion);

const FALLBACK_WARNING =
  "SQLite checkpoint worker unavailable; checkpoints run on the main connection";

interface Writer {
  readonly dbPath: string;
  readonly tempDir: string;
  readonly sql: NodeSqliteClient.SqliteClient;
  /** The checkpointer's counters; fails the test when the connection has none. */
  readonly stats: () => SqliteCheckpointWorkerStats;
  /** Frame counts read on a separate connection, so reading them sends the worker nothing. */
  readonly frames: () => WalFrames;
}

const sleep = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

/** Polls `check` every 20 ms until it holds; fails after a generous deadline. */
const waitUntil = (label: string, check: () => boolean) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 20_000;
    while (!check()) {
      if (Date.now() > deadline) return yield* Effect.die(new Error(`timed out: ${label}`));
      yield* sleep(20);
    }
  });

/** One autocommit statement that appends about `rows` WAL frames (one 3.5 KB row per page). */
const writeFrames = (sql: NodeSqliteClient.SqliteClient, rows: number) =>
  sql.unsafe(
    `WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < ${rows}) ` +
      `INSERT INTO t(v) SELECT randomblob(3500) FROM c`,
  );

const autocheckpoint = (sql: NodeSqliteClient.SqliteClient) =>
  Effect.map(
    sql<{ readonly wal_autocheckpoint: number }>`PRAGMA wal_autocheckpoint`,
    (rows) => rows[0]?.wal_autocheckpoint,
  );

const writerFrames = (sql: NodeSqliteClient.SqliteClient) =>
  Effect.map(
    sql<{ readonly log: number; readonly checkpointed: number }>`PRAGMA wal_checkpoint(NOOP)`,
    (rows) => rows[0]!,
  );

/**
 * Runs `body` against a file database whose writer has the given checkpoint
 * worker setting, in WAL mode with a table `t`.
 */
const withWriter = <A, E>(
  walCheckpointWorker:
    | boolean
    | SqliteCheckpointWorkerOptions
    | ((tempDir: string) => SqliteCheckpointWorkerOptions),
  body: (writer: Writer) => Effect.Effect<A, E>,
  logger?: Logger.Logger<unknown, void>,
) => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-sqlite-checkpoint-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const requested =
    typeof walCheckpointWorker === "function" ? walCheckpointWorker(tempDir) : walCheckpointWorker;
  // The worker is off in parts of macOS by default; these tests exercise it everywhere.
  const setting =
    requested === false ? false : { anyPlatform: true, ...(requested === true ? {} : requested) };
  let probe: DatabaseSync | undefined;
  const layer = NodeSqliteClient.layer({ filename: dbPath, walCheckpointWorker: setting }).pipe(
    Layer.provide(logger ? Logger.layer([logger], { mergeWithExisting: false }) : Layer.empty),
  );
  return Effect.gen(function* () {
    const sql = yield* NodeSqliteClient.SqliteClient;
    yield* sql`PRAGMA journal_mode = WAL`;
    yield* sql`CREATE TABLE t(id INTEGER PRIMARY KEY, v BLOB NOT NULL)`;
    probe = new DatabaseSync(dbPath);
    const noop = probe.prepare("PRAGMA wal_checkpoint(NOOP)");
    return yield* body({
      dbPath,
      tempDir,
      sql,
      stats: () => {
        const stats = sql.walCheckpointStats();
        if (stats === undefined) throw new Error("this connection has no checkpoint worker");
        return stats;
      },
      frames: () => noop.get() as unknown as WalFrames,
    });
  }).pipe(
    Effect.provide(layer),
    Effect.ensuring(
      Effect.sync(() => {
        probe?.close();
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    ),
  );
};

/** A worker that reports every check as done without checkpointing anything. */
const NEVER_CHECKPOINTS = `
const { parentPort } = require("node:worker_threads");
parentPort.on("message", () => {
  parentPort.postMessage({ type: "checked", requested: true, ran: false, ms: 0, blocked: false, error: null, log: -1, checkpointed: -1 });
});
parentPort.postMessage({ ready: true });
`;

describe("supportsNoopCheckpoint", () => {
  it("accepts SQLite 3.51 and later only", () => {
    assert.isFalse(supportsNoopCheckpoint("3.50.4"));
    assert.isTrue(supportsNoopCheckpoint("3.51.0"));
    assert.isTrue(supportsNoopCheckpoint("3.53.4"));
    assert.isTrue(supportsNoopCheckpoint("3.100.0"));
    assert.isTrue(supportsNoopCheckpoint("4.0.0"));
    assert.isFalse(supportsNoopCheckpoint("garbage"));
    assert.isFalse(supportsNoopCheckpoint(""));
  });

  it("uses the worker for writable file databases where it measured faster", () => {
    const file = {
      filename: "/data/state.sqlite",
      readonly: false,
      image: false,
      hasIsTransaction: true,
      sqliteVersion: "3.53.4",
      platform: "linux",
      electron: false,
      anyPlatform: false,
    };
    assert.isUndefined(checkpointWorkerUnavailableReason(file));
    assert.equal(
      checkpointWorkerUnavailableReason({ ...file, filename: ":memory:" }),
      "in-memory database",
    );
    assert.equal(checkpointWorkerUnavailableReason({ ...file, image: true }), "in-memory database");
    assert.equal(
      checkpointWorkerUnavailableReason({ ...file, readonly: true }),
      "read-only connection",
    );
    assert.equal(
      checkpointWorkerUnavailableReason({ ...file, hasIsTransaction: false }),
      "node:sqlite has no isTransaction",
    );
    assert.equal(
      checkpointWorkerUnavailableReason({ ...file, sqliteVersion: "3.50.4" }),
      "SQLite 3.50.4 has no NOOP checkpoint",
    );
    // macOS keeps the writer's own checkpoints where they measured faster: the desktop runtime
    // and SQLite before 3.54. Tests and measurements can override.
    const mac = { ...file, platform: "darwin", sqliteVersion: "3.54.0" };
    assert.isUndefined(checkpointWorkerUnavailableReason(mac));
    assert.equal(
      checkpointWorkerUnavailableReason({ ...mac, electron: true }),
      "macOS desktop runtime: the writer's own checkpoints measured faster",
    );
    assert.equal(
      checkpointWorkerUnavailableReason({ ...mac, sqliteVersion: "3.53.4" }),
      "SQLite 3.53.4 on macOS: the writer's own checkpoints measured faster",
    );
    assert.isUndefined(
      checkpointWorkerUnavailableReason({ ...mac, electron: true, anyPlatform: true }),
    );
    // Elsewhere the version and runtime do not matter.
    assert.isUndefined(checkpointWorkerUnavailableReason({ ...file, electron: true }));
    assert.isUndefined(checkpointWorkerUnavailableReason({ ...file, platform: "win32" }));
  });

  it("keeps the worker source ASCII-only (the server bundle is Latin-1)", () => {
    const nonAscii = [...CHECKPOINT_WORKER_SOURCE].filter((char) => char.charCodeAt(0) > 0x7f);
    assert.deepEqual(nonAscii, []);
  });
});

describe.runIf(hasNoopCheckpoint)("SQLite checkpoint worker", () => {
  it.live("keeps checkpoints off the writer while the worker runs", () =>
    withWriter({ workerSource: NEVER_CHECKPOINTS }, ({ sql }) =>
      Effect.gen(function* () {
        yield* writeFrames(sql, 3_000);
        const frames = yield* writerFrames(sql);
        assert.isAtLeast(frames.log, 3_000);
        // SQLite's default autocheckpoint (1,000) would have copied all of it inside the commit.
        assert.equal(frames.checkpointed, 0);
        assert.equal(yield* autocheckpoint(sql), 10_000);
      }),
    ),
  );

  it.live("checkpoints a long WAL on the worker", () =>
    withWriter(true, ({ sql, stats, frames }) =>
      Effect.gen(function* () {
        yield* writeFrames(sql, 3_000);
        yield* waitUntil("worker checkpoint", () => frames().checkpointed >= 3_000);
        assert.equal(frames().checkpointed, frames().log);
        assert.equal(stats().workerStarts, 1);
        assert.isAtLeast(stats().checkpoints, 1);
        assert.isFalse(stats().fallback);
        assert.isTrue(stats().running);
      }),
    ),
  );

  it.live("checkpoints the rest once writes pause, so the WAL restarts", () =>
    withWriter({ idleMs: 50 }, ({ dbPath, sql, stats, frames }) =>
      Effect.gen(function* () {
        yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
        yield* writeFrames(sql, 500);
        // A reader keeps the requested checkpoint from copying past these 500 frames.
        const reader = new DatabaseSync(dbPath);
        try {
          reader.exec("BEGIN");
          reader.prepare("SELECT count(*) AS total FROM t").get();
          yield* writeFrames(sql, 1_500);
          yield* waitUntil("requested checkpoint", () => stats().checkpoints >= 1);
          assert.isBelow(frames().checkpointed, frames().log);
        } finally {
          reader.exec("COMMIT");
          reader.close();
        }
        // No writer statement asks again: the worker catches up on its own.
        yield* waitUntil(
          "idle checkpoint",
          () => frames().checkpointed === frames().log && stats().idleCheckpoints >= 1,
        );
        const before = frames().log;
        yield* sql`INSERT INTO t(v) VALUES (x'00')`;
        assert.isBelow(frames().log, before);
      }),
    ),
  );

  it.live("never starts a worker for a short writer", () =>
    withWriter(true, ({ sql, stats, frames }) =>
      Effect.gen(function* () {
        yield* writeFrames(sql, 200);
        assert.isBelow(frames().log, 1_000);
        assert.isAbove(stats().probes, 0);
        assert.equal(stats().requests, 0);
        assert.equal(stats().workerStarts, 0);
        assert.isFalse(stats().running);
      }),
    ),
  );

  it.live("stays out of open transactions and sends one request per commit", () =>
    withWriter({ workerSource: NEVER_CHECKPOINTS }, ({ sql, stats }) =>
      Effect.gen(function* () {
        const probesBefore = stats().probes;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            for (let batch = 0; batch < 5; batch += 1) {
              yield* writeFrames(sql, 600);
              assert.equal(stats().probes, probesBefore);
              assert.equal(stats().requests, 0);
            }
          }),
        );
        assert.equal(stats().probes, probesBefore + 1);
        yield* waitUntil("one request", () => stats().requests >= 1 && !stats().inFlight);
        assert.equal(stats().requests, 1);
      }),
    ),
  );

  it.live("keeps one request in flight", () =>
    withWriter(
      (tempDir) => ({
        // Holds every reply until the test creates the release file.
        workerSource: `
const fs = require("node:fs");
const { parentPort } = require("node:worker_threads");
const release = ${JSON.stringify(NodePath.join(tempDir, "release"))};
let held = 0;
const reply = () => {
  if (!fs.existsSync(release)) { setTimeout(reply, 5); return; }
  for (; held > 0; held -= 1) {
    parentPort.postMessage({ type: "checked", requested: true, ran: false, ms: 0, blocked: false, error: null, log: -1, checkpointed: -1 });
  }
};
parentPort.on("message", () => { held += 1; if (held === 1) reply(); });
parentPort.postMessage({ ready: true });
`,
      }),
      ({ tempDir, sql, stats }) =>
        Effect.gen(function* () {
          yield* writeFrames(sql, 1_500);
          yield* waitUntil("first request", () => stats().requests === 1);
          for (let commit = 0; commit < 4; commit += 1) yield* writeFrames(sql, 1_500);
          assert.equal(stats().requests, 1);
          assert.isTrue(stats().inFlight);
          NodeFS.writeFileSync(NodePath.join(tempDir, "release"), "");
          // The four commits collapse into one re-check after the reply.
          yield* waitUntil("re-check", () => stats().requests === 2 && !stats().inFlight);
          assert.equal(stats().requests, 2);
        }),
    ),
  );

  it.live("backs off while a reader pins the WAL and catches up after it ends", () =>
    withWriter(true, ({ dbPath, sql, stats, frames }) =>
      Effect.gen(function* () {
        yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
        const reader = new DatabaseSync(dbPath);
        try {
          // A snapshot from before these frames: no checkpoint may copy any of them.
          reader.exec("BEGIN");
          reader.prepare("SELECT count(*) AS total FROM t").get();
          yield* writeFrames(sql, 3_000);
          yield* waitUntil("blocked checkpoint", () => stats().blocked >= 1);
          assert.isBelow(frames().checkpointed, frames().log);
        } finally {
          reader.exec("COMMIT");
          reader.close();
        }
        yield* waitUntil("catch-up", () => frames().checkpointed === frames().log);
        assert.isFalse(stats().fallback);
      }),
    ),
  );

  it.live("checks again at once when a reader that blocked the checkpoint ends", () =>
    withWriter(
      {
        // The first check is blocked (as by a reader's snapshot); later ones go through.
        workerSource: `
const { parentPort } = require("node:worker_threads");
let checks = 0;
parentPort.on("message", () => {
  checks += 1;
  parentPort.postMessage({ type: "checked", requested: true, ran: true, ms: 0, blocked: checks === 1, error: null, log: -1, checkpointed: -1 });
});
parentPort.postMessage({ ready: true });
`,
      },
      ({ sql, stats }) =>
        Effect.gen(function* () {
          yield* writeFrames(sql, 1_500);
          yield* waitUntil("blocked check", () => stats().blocked === 1 && !stats().inFlight);
          assert.equal(stats().requests, 1);
          // Without the hook the next request waits for the 250 ms backoff and a later statement.
          sql.walReaderReleased();
          assert.equal(stats().requests, 2);
          yield* waitUntil("second reply", () => !stats().inFlight);
          // Only a blocked checkpoint is retried early.
          sql.walReaderReleased();
          assert.equal(stats().requests, 2);
        }),
    ),
  );

  it.live("falls back to SQLite's checkpoints when the worker cannot start", () => {
    const messages: string[] = [];
    const logger = Logger.make(({ message }) => {
      messages.push(String(message));
    });
    return withWriter(
      { workerSource: "throw new Error('no worker here')", startRetryMs: 10 },
      ({ sql, stats }) =>
        Effect.gen(function* () {
          for (let attempt = 1; attempt <= 3; attempt += 1) {
            yield* writeFrames(sql, 1_500);
            yield* waitUntil(`failed start ${attempt}`, () => stats().workerFailures === attempt);
            // Past the retry delay before the next commit asks again.
            yield* sleep(20);
          }
          assert.isTrue(stats().fallback);
          assert.equal(stats().workerFailures, 3);
          assert.equal(stats().workerStarts, 0);
          assert.equal(yield* autocheckpoint(sql), 1_000);
          // The writer checkpoints itself again, inside the commit, and keeps writing.
          yield* writeFrames(sql, 100);
          const frames = yield* writerFrames(sql);
          assert.equal(frames.checkpointed, frames.log);
          assert.equal(messages.filter((message) => message.includes(FALLBACK_WARNING)).length, 1);
        }),
      logger,
    );
  });

  it.live("falls back when the worker's checkpoints keep failing", () =>
    withWriter(
      {
        workerSource: `
const { parentPort } = require("node:worker_threads");
const failed = (requested) => ({ type: "checked", requested, ran: false, ms: 0, blocked: true, error: "disk I/O error", log: -1, checkpointed: -1 });
// Like the real worker: the requested check fails, then its own retries fail too.
parentPort.on("message", () => {
  parentPort.postMessage(failed(true));
  parentPort.postMessage(failed(false));
  parentPort.postMessage(failed(false));
});
parentPort.postMessage({ ready: true });
`,
      },
      ({ sql, stats }) =>
        Effect.gen(function* () {
          yield* writeFrames(sql, 1_500);
          yield* waitUntil("fallback", () => stats().fallback);
          assert.equal(stats().errors, 3);
          assert.equal(yield* autocheckpoint(sql), 1_000);
          assert.isFalse(stats().running);
        }),
    ),
  );

  it.live("restarts a worker that crashed", () =>
    withWriter(
      (tempDir) => ({
        startRetryMs: 10,
        // The first worker dies on its first check; later ones are the real worker.
        workerSource: `
const crashed = ${JSON.stringify(NodePath.join(tempDir, "crashed"))};
if (!require("node:fs").existsSync(crashed)) {
  require("node:fs").writeFileSync(crashed, "");
  const { parentPort } = require("node:worker_threads");
  parentPort.on("message", () => process.exit(1));
  parentPort.postMessage({ ready: true });
} else {
${CHECKPOINT_WORKER_SOURCE}
}
`,
      }),
      ({ sql, stats, frames }) =>
        Effect.gen(function* () {
          yield* writeFrames(sql, 1_500);
          yield* waitUntil("crash", () => stats().workerFailures === 1);
          yield* sleep(20);
          yield* writeFrames(sql, 100);
          yield* waitUntil(
            "checkpoint after restart",
            () => frames().checkpointed === frames().log,
          );
          assert.equal(stats().workerFailures, 1);
          assert.equal(stats().workerStarts, 2);
          assert.isAtLeast(stats().checkpoints, 1);
          assert.isFalse(stats().fallback);
        }),
    ),
  );

  it.live("falls back when every new worker dies on its first check", () =>
    withWriter(
      {
        startRetryMs: 10,
        // Starts fine, so the supervisor forgives each crash; it never answers a check.
        workerSource: `
const { parentPort } = require("node:worker_threads");
parentPort.on("message", () => process.exit(1));
parentPort.postMessage({ ready: true });
`,
      },
      ({ sql, stats }) =>
        Effect.gen(function* () {
          yield* writeFrames(sql, 1_500);
          for (let attempt = 1; attempt < 3; attempt += 1) {
            yield* waitUntil(`crash ${attempt}`, () => stats().workerFailures === attempt);
            assert.isFalse(stats().fallback);
            // Past the retry delay; the next commit starts another worker.
            yield* sleep(20);
            yield* writeFrames(sql, 10);
          }
          yield* waitUntil("third crash", () => stats().workerFailures === 3);
          assert.isTrue(stats().fallback);
          assert.equal(stats().workerStarts, 3);
          assert.equal(yield* autocheckpoint(sql), 1_000);
          // The writer checkpoints itself again, inside the commit.
          yield* writeFrames(sql, 10);
          const frames = yield* writerFrames(sql);
          assert.equal(frames.checkpointed, frames.log);
        }),
    ),
  );

  it.live("stops the worker before the writer closes", () => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-sqlite-checkpoint-"));
    const dbPath = NodePath.join(tempDir, "state.sqlite");
    let stats: (() => SqliteCheckpointWorkerStats | undefined) | undefined;
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const sql = yield* NodeSqliteClient.SqliteClient;
        yield* sql`PRAGMA journal_mode = WAL`;
        yield* sql`CREATE TABLE t(id INTEGER PRIMARY KEY, v BLOB NOT NULL)`;
        yield* writeFrames(sql, 3_000);
        stats = sql.walCheckpointStats;
        yield* waitUntil("worker checkpoint", () => (stats?.()?.checkpoints ?? 0) >= 1);
        assert.isTrue(NodeFS.existsSync(`${dbPath}-wal`));
      }).pipe(
        Effect.provide(
          NodeSqliteClient.layer({ filename: dbPath, walCheckpointWorker: { anyPlatform: true } }),
        ),
      );
      // The worker stopped first, so the writer was the last connection to close: it
      // checkpointed and removed the WAL.
      assert.isFalse(stats?.()?.running);
      assert.isFalse(NodeFS.existsSync(`${dbPath}-wal`));
    }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("leaves older SQLite on its own autocheckpoint", () =>
    withWriter({ sqliteVersion: "3.50.4" }, ({ sql }) =>
      Effect.gen(function* () {
        assert.isUndefined(sql.walCheckpointStats());
        assert.equal(yield* autocheckpoint(sql), 1_000);
        yield* writeFrames(sql, 1_500);
        const frames = yield* writerFrames(sql);
        assert.equal(frames.checkpointed, frames.log);
      }),
    ),
  );
});
