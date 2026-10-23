// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { databaseBackupsDirectory } from "../databaseBackups.ts";
import { runMigrations, SUPPORTED_MIGRATION_ID } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { MAIN_CONNECTION_BUSY_TIMEOUT_MS } from "../sqliteBusy.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
  SqlitePersistenceMemoryFresh,
} from "./Sqlite.ts";

const lockHolderSource = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("BEGIN IMMEDIATE");
process.stdout.write("locked\\n");
setTimeout(() => {
  db.exec("COMMIT");
  process.stdout.write("released " + Date.now() + "\\n");
  db.close();
}, Number(process.argv[2]));
`;

/** Resolves once the child holds the write lock; `released` gives its wall-clock release time. */
const spawnWriteLockHolder = (dbPath: string, holdMs: number) =>
  Effect.promise(
    () =>
      new Promise<{ readonly released: Promise<number> }>((resolve, reject) => {
        const holder = NodeChildProcess.spawn(
          process.execPath,
          ["-e", lockHolderSource, dbPath, String(holdMs)],
          { stdio: ["ignore", "pipe", "ignore"] },
        );
        let output = "";
        const released = new Promise<number>((resolveReleased, rejectReleased) => {
          holder.stdout.on("data", (chunk: Buffer) => {
            output += chunk.toString("utf8");
            if (output.includes("locked\n")) resolve({ released });
            const match = /released (\d+)\n/.exec(output);
            if (match) resolveReleased(Number(match[1]));
          });
          // "close", not "exit": the last output can arrive after the process exited.
          holder.on("close", () => rejectReleased(new Error("lock holder exited unreleased")));
        });
        // Callers that only need the lock never await the release.
        released.catch(() => undefined);
        holder.on("error", reject);
        holder.on("exit", () =>
          reject(new Error("lock holder exited before acquiring the write lock")),
        );
      }),
  );

it.effect("waits out a concurrent writer instead of failing with SQLITE_BUSY", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-sqlite-busy-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE busy_probe(id INTEGER PRIMARY KEY)`;
    yield* spawnWriteLockHolder(dbPath, 300);
    yield* sql`INSERT INTO busy_probe(id) VALUES (${1})`;
    const rows = yield* sql<{ readonly id: number }>`SELECT id FROM busy_probe`;
    assert.deepEqual([...rows], [{ id: 1 }]);
  }).pipe(
    Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("keeps the event loop running while it waits for another process's write lock", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-sqlite-busy-loop-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE busy_probe(id INTEGER PRIMARY KEY)`;
    yield* spawnWriteLockHolder(dbPath, 600);
    let lastTick = performance.now();
    let maxGapMs = 0;
    const interval = setInterval(() => {
      const now = performance.now();
      maxGapMs = Math.max(maxGapMs, now - lastTick);
      lastTick = now;
    }, 5);
    const startedAt = performance.now();
    yield* sql`INSERT INTO busy_probe(id) VALUES (${1})`.pipe(
      Effect.ensuring(Effect.sync(() => clearInterval(interval))),
    );
    // The insert waited for the lock holder...
    assert.isAbove(performance.now() - startedAt, 300);
    // ...without one synchronous sleep: busy_timeout used to block the loop for the whole wait.
    assert.isBelow(maxGapMs, 250);
  }).pipe(
    Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("backs up before migrating while another process holds the write lock", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-sqlite-backup-busy-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");

  return Effect.gen(function* () {
    // A database one migration behind, as an upgrade finds it.
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* runMigrations({ toMigrationInclusive: SUPPORTED_MIGRATION_ID - 1 });
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
    const holder = yield* spawnWriteLockHolder(dbPath, 600);
    // Wall-clock time, comparable with the holder's release time.
    let lastTick = Date.now();
    const gaps: Array<{ readonly startedAt: number; readonly ms: number }> = [];
    const interval = setInterval(() => {
      const now = Date.now();
      gaps.push({ startedAt: lastTick, ms: now - lastTick });
      lastTick = now;
    }, 5);
    const startedAt = performance.now();
    yield* Effect.void.pipe(
      Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
      Effect.ensuring(Effect.sync(() => clearInterval(interval))),
    );
    // The snapshot waited for the writer's lock and still produced a backup...
    assert.isAbove(performance.now() - startedAt, 300);
    const backups = NodeFS.readdirSync(databaseBackupsDirectory(dbPath));
    assert.equal(backups.length, 1, backups.join(", "));
    assert.match(backups[0]!, /^state-v\d{3}-before-v\d{3}-\d{8}T\d{9}Z\.sqlite$/);
    // ...without blocking the event loop while it waited. Only gaps that began while the lock
    // was held count: the migration after the release runs synchronously by design.
    const releasedAt = yield* Effect.promise(() => holder.released);
    const waitingGaps = gaps.filter((gap) => gap.startedAt < releasedAt - 50);
    assert.isAbove(waitingGaps.length, 0);
    assert.isBelow(Math.max(...waitingGaps.map((gap) => gap.ms)), 250);
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect(
  "applies a short busy_timeout in the shared persistence setup (retried asynchronously)",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly timeout: number }>`PRAGMA busy_timeout`;
      assert.equal(rows[0]?.timeout, MAIN_CONNECTION_BUSY_TIMEOUT_MS);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("applies the A/B-tested read tuning to file databases", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-sqlite-tuning-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [cache] = yield* sql<{ readonly cache_size: number }>`PRAGMA cache_size`;
    assert.equal(cache?.cache_size, -32768);
    const [mmap] = yield* sql<{ readonly mmap_size: number }>`PRAGMA mmap_size`;
    // SQLite caps the request at its compile-time maximum; it is never left at 0 (off).
    assert.isAbove(mmap?.mmap_size ?? 0, 0);
    assert.isAtMost(mmap?.mmap_size ?? 0, 268435456);
    const [synchronous] = yield* sql<{ readonly synchronous: number }>`PRAGMA synchronous`;
    // Durability is unchanged (FULL), see docs/streaming-sqlite.md.
    assert.equal(synchronous?.synchronous, 2);
    const [journalLimit] = yield* sql<{
      readonly journal_size_limit: number;
    }>`PRAGMA journal_size_limit`;
    assert.equal(journalLimit?.journal_size_limit, 67108864);
  }).pipe(
    Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

const withTempDatabase = <E>(
  prefix: string,
  test: (dbPath: string) => Effect.Effect<void, E, SqlClient.SqlClient>,
  prepare?: (dbPath: string) => void,
) => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  prepare?.(dbPath);
  return test(dbPath).pipe(
    Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
};

const readModes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [vacuum] = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
  const [journal] = yield* sql<{ readonly journal_mode: string }>`PRAGMA journal_mode`;
  const [ledger] = yield* sql<{
    readonly migrations: number;
  }>`SELECT count(*) AS migrations FROM effect_sql_migrations`;
  return {
    autoVacuum: vacuum?.auto_vacuum,
    journalMode: journal?.journal_mode,
    migrations: Number(ledger?.migrations ?? 0),
  };
});

it.effect("creates new database files with incremental auto-vacuum, in WAL mode", () =>
  withTempDatabase("ryco-sqlite-new-", () =>
    Effect.gen(function* () {
      const modes = yield* readModes;
      assert.equal(modes.autoVacuum, 2);
      assert.equal(modes.journalMode, "wal");
      assert.isAbove(modes.migrations, 0);
    }),
  ),
);

it.effect("treats an empty database file as new", () =>
  withTempDatabase(
    "ryco-sqlite-empty-",
    () =>
      Effect.gen(function* () {
        const modes = yield* readModes;
        assert.equal(modes.autoVacuum, 2);
        assert.equal(modes.journalMode, "wal");
      }),
    (dbPath) => NodeFS.writeFileSync(dbPath, ""),
  ),
);

it.effect("keeps the auto-vacuum mode of an existing database and migrates it as before", () =>
  withTempDatabase(
    "ryco-sqlite-existing-",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const modes = yield* readModes;
        assert.equal(modes.autoVacuum, 0);
        assert.equal(modes.journalMode, "wal");
        assert.isAbove(modes.migrations, 0);
        const rows = yield* sql<{ readonly id: number }>`SELECT id FROM legacy_probe`;
        assert.deepEqual([...rows], [{ id: 1 }]);
      }),
    (dbPath) => {
      // A database written before this change: tables exist, auto_vacuum NONE, WAL.
      const db = new DatabaseSync(dbPath);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec(
        "CREATE TABLE legacy_probe(id INTEGER PRIMARY KEY); INSERT INTO legacy_probe VALUES (1)",
      );
      db.close();
    },
  ),
);

const schemaAndLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const schema =
    yield* sql`SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`;
  const ledger =
    yield* sql`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
  return { schema, ledger };
});

it.effect.runIf(NodeSqliteClient.supportsDatabaseImages)(
  "starts in-memory databases from an image equal to a freshly migrated database",
  () =>
    Effect.gen(function* () {
      const fresh = yield* schemaAndLedger.pipe(Effect.provide(SqlitePersistenceMemoryFresh));
      const copied = yield* schemaAndLedger.pipe(Effect.provide(SqlitePersistenceMemory));
      assert.isAbove(fresh.ledger.length, 0);
      assert.deepEqual(copied, fresh);
    }),
);

it.effect("gives every in-memory database a copy of its own", () =>
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE isolation_probe(id INTEGER PRIMARY KEY)`;
      yield* sql`INSERT INTO isolation_probe(id) VALUES (${1})`;
    }).pipe(Effect.provide(SqlitePersistenceMemory));
    const probes = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql`SELECT name FROM sqlite_master WHERE name = 'isolation_probe'`;
    }).pipe(Effect.provide(SqlitePersistenceMemory));
    assert.deepEqual([...probes], []);
  }),
);
