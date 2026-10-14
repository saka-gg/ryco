import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const LINK_COLUMNS = [
  "link_client_fingerprint",
  "link_enrollment_id",
  "link_role",
  "link_trust_source",
];

const linkColumns = (table: "auth_pairing_links" | "auth_sessions") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const columns = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info(${table})
    `;
    return columns
      .map((column) => column.name)
      .filter((name) => LINK_COLUMNS.includes(name))
      .toSorted();
  });

it.effect("adds link columns to pairing links and sessions, leaving existing rows unlinked", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 89 });
    yield* sql`
      INSERT INTO auth_sessions (session_id, subject, role, method, issued_at, expires_at)
      VALUES ('paired', 'one-time-token', 'client', 'bearer-session-token',
        '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')
    `;

    yield* runMigrations({ toMigrationInclusive: 90 });
    yield* runMigrations({ toMigrationInclusive: 90 });

    assert.deepEqual(yield* linkColumns("auth_pairing_links"), LINK_COLUMNS);
    assert.deepEqual(yield* linkColumns("auth_sessions"), LINK_COLUMNS);
    const rows = yield* sql<{ readonly linkTrustSource: string | null }>`
      SELECT link_trust_source AS "linkTrustSource" FROM auth_sessions
    `;
    assert.deepEqual(rows, [{ linkTrustSource: null }]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("adds the link columns when another branch recorded migration 90", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 89 });
    yield* sql`
      INSERT INTO effect_sql_migrations (migration_id, created_at, name)
      VALUES (90, 'now', 'ParallelBranchMigration')
    `;

    yield* runMigrations({ toMigrationInclusive: 90 });

    assert.deepEqual(yield* linkColumns("auth_sessions"), LINK_COLUMNS);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
