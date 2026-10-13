// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";

import { makeSqlitePersistenceLive } from "./Layers/Sqlite.ts";
import {
  makeSqliteReadWorkerClient,
  readClientFor,
  SqliteReadClient,
  type SqliteReadWorkerStats,
} from "./SqliteReadClient.ts";

const withTempDatabase = <A, E>(
  body: (dbPath: string) => Effect.Effect<A, E, SqlClient.SqlClient | SqliteReadClient>,
) => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-sqlite-read-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  return body(dbPath).pipe(
    Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
};

const statsOf = (client: SqlClient.SqlClient): SqliteReadWorkerStats =>
  (client as unknown as { readWorkerStats: () => SqliteReadWorkerStats }).readWorkerStats();

/** A query that keeps SQLite busy for a while without touching any table. */
const SLOW_COUNT = `
  WITH RECURSIVE counter(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM counter WHERE n < 2000000)
  SELECT COUNT(*) AS total FROM counter
`;

it.effect("reads committed rows on a worker connection", () =>
  withTempDatabase(() =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const reader = yield* SqliteReadClient;
      assert.notStrictEqual(reader, sql);
      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries(name) VALUES (${"alpha"}), (${"beta"})`;

      const rows = yield* reader<{ readonly id: number; readonly name: string }>`
        SELECT id, name FROM entries ORDER BY id
      `;
      assert.deepEqual(
        rows.map((row) => [row.id, row.name]),
        [
          [1, "alpha"],
          [2, "beta"],
        ],
      );
      const values = yield* reader`SELECT name FROM entries ORDER BY id`.values;
      assert.deepEqual(values, [["alpha"], ["beta"]]);
      // Read-your-writes: a commit is visible to the very next read.
      yield* sql`INSERT INTO entries(name) VALUES (${"gamma"})`;
      const [count] = yield* reader<{
        readonly total: number;
      }>`SELECT COUNT(*) AS total FROM entries`;
      assert.equal(count?.total, 3);
      assert.isAtLeast(statsOf(reader).workerStatements, 3);
      assert.equal(statsOf(reader).fallbackAcquisitions, 0);
    }),
  ),
);

it.effect("refuses writes on the worker connection", () =>
  withTempDatabase(() =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const reader = yield* SqliteReadClient;
      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY)`;
      const result = yield* reader`INSERT INTO entries(id) VALUES (1)`.pipe(Effect.flip);
      assert.match(String((result.reason.cause as Error).message), /readonly/i);
      const [count] = yield* sql<{ readonly total: number }>`SELECT COUNT(*) AS total FROM entries`;
      assert.equal(count?.total, 0);
    }),
  ),
);

it.effect("keeps a consistent snapshot across a read transaction while the writer commits", () =>
  withTempDatabase(() =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const reader = yield* SqliteReadClient;
      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY)`;
      yield* sql`INSERT INTO entries(id) VALUES (1)`;
      const [before, after] = yield* reader.withTransaction(
        Effect.gen(function* () {
          const [first] = yield* reader<{ readonly total: number }>`
            SELECT COUNT(*) AS total FROM entries
          `;
          // The writer is not blocked by the open read transaction.
          yield* sql`INSERT INTO entries(id) VALUES (2)`;
          const [second] = yield* reader<{ readonly total: number }>`
            SELECT COUNT(*) AS total FROM entries
          `;
          return [first?.total, second?.total] as const;
        }),
      );
      assert.equal(before, 1);
      assert.equal(after, 1);
      const [latest] = yield* reader<{
        readonly total: number;
      }>`SELECT COUNT(*) AS total FROM entries`;
      assert.equal(latest?.total, 2);
    }),
  ),
);

it.effect("does not block the event loop or the main connection during a heavy read", () =>
  withTempDatabase(() =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const reader = yield* SqliteReadClient;
      yield* reader`SELECT 1`;
      let lastTick = performance.now();
      let maxGapMs = 0;
      const interval = setInterval(() => {
        const now = performance.now();
        maxGapMs = Math.max(maxGapMs, now - lastTick);
        lastTick = now;
      }, 5);
      const startedAt = performance.now();
      const heavy = yield* Effect.forkChild(reader.unsafe(SLOW_COUNT));
      // The main connection answers while the worker computes.
      yield* sql`SELECT 1`;
      const mainLatencyMs = performance.now() - startedAt;
      const rows = yield* Fiber.join(heavy);
      const heavyMs = performance.now() - startedAt;
      clearInterval(interval);
      assert.equal((rows[0] as { total: number }).total, 2_000_000);
      assert.isBelow(mainLatencyMs, heavyMs);
      assert.isBelow(maxGapMs, Math.max(100, heavyMs / 2));
    }),
  ),
);

it.effect("stays on the main connection inside a main-connection transaction", () =>
  withTempDatabase(() =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY)`;
      const outside = yield* readClientFor(sql);
      assert.notStrictEqual(outside, sql);
      const seen = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO entries(id) VALUES (1)`;
          const client = yield* readClientFor(sql);
          assert.strictEqual(client, sql);
          const [row] = yield* client<{ readonly total: number }>`
            SELECT COUNT(*) AS total FROM entries
          `;
          return row?.total;
        }),
      );
      assert.equal(seen, 1);
    }),
  ),
);

it.effect("falls back to the main connection when the worker cannot start", () =>
  withTempDatabase((dbPath) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY)`;
      yield* sql`INSERT INTO entries(id) VALUES (7)`;
      const reader = yield* makeSqliteReadWorkerClient(sql, {
        filename: dbPath,
        workerSource: "throw new Error('no sqlite here')",
      });
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const rows = yield* reader<{ readonly id: number }>`SELECT id FROM entries`;
        assert.deepEqual(
          rows.map((row) => row.id),
          [7],
        );
      }
      const stats = statsOf(reader);
      assert.equal(stats.workerStatements, 0);
      assert.equal(stats.fallbackAcquisitions, 4);
      assert.equal(stats.workerFailures, 3);
    }).pipe(Effect.scoped, Effect.provide(Reactivity.layer)),
  ),
);
