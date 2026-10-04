import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const ROTATION_COLUMNS = ["chain_id", "chain_issued_at", "rotated_from", "superseded_at"];

const rotationColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(auth_sessions)`;
  return columns
    .map((column) => column.name)
    .filter((name) => ROTATION_COLUMNS.includes(name))
    .toSorted();
});

it.effect("keeps sessions paired before rotation as their own chain", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 71 });
    yield* sql`
      INSERT INTO auth_sessions (session_id, subject, role, method, issued_at, expires_at)
      VALUES ('paired', 'one-time-token', 'client', 'bearer-session-token',
        '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')
    `;

    yield* runMigrations({ toMigrationInclusive: 76 });
    yield* runMigrations({ toMigrationInclusive: 76 });

    assert.deepEqual(yield* rotationColumns, ROTATION_COLUMNS);
    const rows = yield* sql<{ chainId: string; chainIssuedAt: string; rotatedFrom: null }>`
      SELECT
        COALESCE(chain_id, session_id) AS "chainId",
        COALESCE(chain_issued_at, issued_at) AS "chainIssuedAt",
        rotated_from AS "rotatedFrom"
      FROM auth_sessions
    `;
    assert.deepEqual(rows, [
      { chainId: "paired", chainIssuedAt: "2026-09-01T00:00:00.000Z", rotatedFrom: null },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("adds the rotation columns when another branch recorded migration 76", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 71 });
    yield* sql`
      INSERT INTO effect_sql_migrations (migration_id, created_at, name)
      VALUES (76, 'now', 'ParallelBranchMigration')
    `;

    yield* runMigrations({ toMigrationInclusive: 76 });

    assert.deepEqual(yield* rotationColumns, ROTATION_COLUMNS);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
