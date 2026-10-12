import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { ensureProjectionProjectRepositoryIdentityColumns } from "./086_ProjectionProjectRepositoryIdentity.ts";

const COLUMNS = [
  "repository_identity_json",
  "repository_identity_fingerprint",
  "repository_identity_checked_at",
];

const projectColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_projects)`;
  return rows.map((row) => row.name);
});

it.layer(NodeSqliteClient.layerMemory())("086 persisted repository identity", (it) => {
  it.effect("adds nullable identity columns without a backfill, idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 85 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES ('existing', 'Existing', '/tmp/existing', '[]',
          '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')
      `;
      for (const column of COLUMNS) assert.notInclude(yield* projectColumns, column);

      yield* runMigrations({ toMigrationInclusive: 86 });
      for (const column of COLUMNS) assert.include(yield* projectColumns, column);
      const [row] = yield* sql<{
        readonly json: string | null;
        readonly checkedAt: string | null;
      }>`
        SELECT repository_identity_json AS json, repository_identity_checked_at AS "checkedAt"
        FROM projection_projects WHERE project_id = 'existing'
      `;
      // Never checked: the first identity sweep resolves it.
      assert.deepEqual(row, { json: null, checkedAt: null });
      assert.isFalse(yield* ensureProjectionProjectRepositoryIdentityColumns);
    }),
  );
});
