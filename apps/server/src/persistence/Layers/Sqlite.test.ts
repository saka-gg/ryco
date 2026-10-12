// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { MAIN_CONNECTION_BUSY_TIMEOUT_MS } from "../sqliteBusy.ts";
import { makeSqlitePersistenceLive, SqlitePersistenceMemory } from "./Sqlite.ts";

const lockHolderSource = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("BEGIN IMMEDIATE");
process.stdout.write("locked\\n");
setTimeout(() => {
  db.exec("COMMIT");
  db.close();
}, Number(process.argv[2]));
`;

const spawnWriteLockHolder = (dbPath: string, holdMs: number) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve, reject) => {
        const holder = NodeChildProcess.spawn(
          process.execPath,
          ["-e", lockHolderSource, dbPath, String(holdMs)],
          { stdio: ["ignore", "pipe", "ignore"] },
        );
        holder.stdout.once("data", () => resolve());
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
  }).pipe(
    Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});
