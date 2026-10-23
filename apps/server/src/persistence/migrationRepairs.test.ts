import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  findRepairsNeedingWrites,
  inspectMigrationLedger,
  isSqliteReadonlyError,
  latestMigrationId,
  migrationEntries,
  type MigrationRepair,
  runMigrations,
} from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

const schemaOf = (sql: SqlClient.SqlClient) =>
  sql<{ readonly name: string; readonly sql: string | null }>`
    SELECT name, sql FROM sqlite_master ORDER BY name`;

it.effect("finds no repair to run on a current database, without writing", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    const before = yield* schemaOf(sql);
    // Every repair's no-op path must be read-only, or a CLI next to a live
    // server would always count the database as needing an upgrade.
    assert.deepEqual(yield* findRepairsNeedingWrites(), []);
    assert.deepEqual(yield* schemaOf(sql), before);
    const queryOnly = yield* sql<{ readonly query_only: number }>`PRAGMA query_only`;
    assert.equal(queryOnly[0]?.query_only, 0);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("names a repair that would write, and leaves the database as it was", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* sql`ALTER TABLE projection_worktrees DROP COLUMN title`;
    const before = yield* schemaOf(sql);

    assert.deepEqual(yield* findRepairsNeedingWrites(), ["repairProjectionWorktreeTitleColumn"]);
    assert.deepEqual(yield* schemaOf(sql), before);
    // Writes work again afterwards: query_only is switched back off.
    yield* runMigrations();
    const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_worktrees)`;
    assert.isTrue(columns.some((column) => column.name === "title"));
    assert.deepEqual(yield* findRepairsNeedingWrites(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("stops at the first repair that would write, before one that depends on it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE notes (id INTEGER PRIMARY KEY)`;
    const repairs: ReadonlyArray<MigrationRepair> = [
      { name: "alreadyApplied", since: 1, run: () => sql`SELECT id FROM notes` },
      { name: "addsTitle", since: 1, run: () => sql`ALTER TABLE notes ADD COLUMN title TEXT` },
      // Reads the column the repair before it adds: fails on its own until that one ran.
      { name: "readsTitle", since: 1, run: () => sql`SELECT title FROM notes` },
    ];

    assert.deepEqual(yield* findRepairsNeedingWrites(undefined, repairs), ["addsTitle"]);
    // A failure that is not a blocked write is the database's own, and is reported.
    const broken = yield* findRepairsNeedingWrites(undefined, [repairs[0]!, repairs[2]!]).pipe(
      Effect.flip,
    );
    assert.equal(broken._tag, "SqlError");
    assert.isFalse(isSqliteReadonlyError(broken));
    const queryOnly = yield* sql<{ readonly query_only: number }>`PRAGMA query_only`;
    assert.equal(queryOnly[0]?.query_only, 0);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("reports where the ledger stands without changing it", () =>
  Effect.gen(function* () {
    const fresh = yield* inspectMigrationLedger();
    assert.equal(fresh.hasLedger, false);
    assert.equal(fresh.hasUserTables, false);
    assert.equal(fresh.latestApplied, 0);
    assert.equal(fresh.supported, latestMigrationId);
    assert.equal(fresh.pending.length, migrationEntries.length);
    assert.equal(fresh.pending.at(-1), latestMigrationId);

    yield* runMigrations({ toMigrationInclusive: latestMigrationId - 1 });
    const behind = yield* inspectMigrationLedger();
    assert.equal(behind.hasLedger, true);
    assert.equal(behind.hasUserTables, true);
    assert.equal(behind.latestApplied, latestMigrationId - 1);
    assert.deepEqual(behind.pending, [latestMigrationId]);
    assert.deepEqual(
      (yield* inspectMigrationLedger({ toMigrationInclusive: latestMigrationId - 1 })).pending,
      [],
    );

    yield* runMigrations();
    assert.deepEqual((yield* inspectMigrationLedger()).pending, []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it("recognizes SQLITE_READONLY from node:sqlite and bun:sqlite, wrapped or not", () => {
  const node = Object.assign(new Error("attempt to write a readonly database"), {
    code: "ERR_SQLITE_ERROR",
    errcode: 8,
  });
  const bun = Object.assign(new Error("attempt to write a readonly database"), {
    code: "SQLITE_READONLY",
    errno: 8,
  });
  assert.isTrue(isSqliteReadonlyError(node));
  assert.isTrue(isSqliteReadonlyError(bun));
  assert.isTrue(isSqliteReadonlyError({ reason: { cause: node } }));
  assert.isTrue(isSqliteReadonlyError({ cause: { cause: bun } }));
  assert.isFalse(
    isSqliteReadonlyError(
      Object.assign(new Error("busy"), { code: "ERR_SQLITE_ERROR", errcode: 5 }),
    ),
  );
  assert.isFalse(isSqliteReadonlyError(new Error("attempt to write a readonly database")));
});
