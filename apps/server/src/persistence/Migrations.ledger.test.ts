import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  compatibilityRepairMarker,
  inspectMigrationLedger,
  runMigrations,
  SUPPORTED_MIGRATION_ID,
} from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

it.effect("inspects what the next migration pass would do without changing anything", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fresh = yield* inspectMigrationLedger();
    assert.isTrue(fresh.fresh);
    assert.isFalse(fresh.hasLedger);
    assert.equal(fresh.latestApplied, 0);
    assert.equal(fresh.supported, SUPPORTED_MIGRATION_ID);
    assert.equal(fresh.pending.at(-1), SUPPORTED_MIGRATION_ID);
    assert.isAbove(fresh.repairsPending.length, 0);
    assert.deepEqual(yield* sql`SELECT name FROM sqlite_master`, []);

    yield* runMigrations({ toMigrationInclusive: SUPPORTED_MIGRATION_ID - 1 });
    const behind = yield* inspectMigrationLedger();
    assert.isFalse(behind.fresh);
    assert.isTrue(behind.hasLedger);
    assert.equal(behind.latestApplied, SUPPORTED_MIGRATION_ID - 1);
    assert.deepEqual(behind.pending, [SUPPORTED_MIGRATION_ID]);
    // Only the repair that arrives with the pending migration has never run.
    assert.deepEqual(behind.repairsPending, ["unused-orchestration-indexes"]);

    yield* runMigrations();
    const current = yield* inspectMigrationLedger();
    assert.deepEqual(current.pending, []);
    assert.deepEqual(current.repairsPending, []);
    assert.isFalse(current.tooNew);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("records each compatibility repair once, and a repeat pass writes nothing", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    const markers = yield* sql<{ readonly repair_key: string }>`
      SELECT repair_key FROM ryco_compatibility_repairs
      WHERE repair_key LIKE ${compatibilityRepairMarker("%")} ORDER BY repair_key
    `;
    assert.isAbove(markers.length, 20);
    const [before] = yield* sql<{ readonly changes: number }>`SELECT total_changes() AS changes`;
    yield* runMigrations();
    const [after] = yield* sql<{ readonly changes: number }>`SELECT total_changes() AS changes`;
    assert.equal(after?.changes, before?.changes);

    // A repair the database has not seen (a newer binary's) is pending until it runs.
    yield* sql`DELETE FROM ryco_compatibility_repairs WHERE repair_key = ${compatibilityRepairMarker("thread-forks")}`;
    assert.deepEqual((yield* inspectMigrationLedger()).repairsPending, ["thread-forks"]);
    yield* runMigrations();
    assert.deepEqual((yield* inspectMigrationLedger()).repairsPending, []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("records no repair that a bounded pass ran only part of", () =>
  Effect.gen(function* () {
    // The read-model repair covers 044-047; a pass through 45 runs only its first half.
    yield* runMigrations({ toMigrationInclusive: 45 });
    const partial = (yield* inspectMigrationLedger()).repairsPending;
    assert.include(partial, "projection-thread-read-model");
    assert.notInclude(partial, "context-handoff-runtime-sessions");
    yield* runMigrations();
    assert.deepEqual((yield* inspectMigrationLedger()).repairsPending, []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("names the backups directory when it refuses a newer schema", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    const future = SUPPORTED_MIGRATION_ID + 2;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, created_at, name) VALUES (${future}, 'now', 'FutureSchema')`;
    assert.isTrue((yield* inspectMigrationLedger()).tooNew);
    const result = yield* runMigrations({ backupsDir: "/home/me/.ryco/userdata/backups" }).pipe(
      Effect.result,
    );
    assert.equal(result._tag, "Failure");
    if (result._tag !== "Failure") return;
    const message = String(result.failure);
    assert.match(message, /newer than this binary supports/);
    assert.include(message, `Use a Ryco build that supports schema ${future}`);
    assert.include(message, "backups are in /home/me/.ryco/userdata/backups");
    assert.include(message, "separate data directory");
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
