import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import ProjectionThreadLineageFork from "./083_ProjectionThreadLineageFork.ts";

const readColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
  const names = new Set(columns.map((column) => column.name));
  return {
    sourceMessageId: names.has("lineage_source_message_id"),
    sourceTurnId: names.has("lineage_source_turn_id"),
  };
});

it.layer(NodeSqliteClient.layerMemory())("083 projection thread fork lineage", (it) => {
  it.effect("adds nullable fork provenance columns, and is a no-op when run again", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 82 });
      assert.deepEqual(yield* readColumns, { sourceMessageId: false, sourceTurnId: false });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, branch, worktree_path, latest_turn_id,
          latest_user_message_at, pending_approval_count, pending_user_input_count,
          has_actionable_proposed_plan, created_at, updated_at, archived_at, deleted_at
        ) VALUES (
          'thread-existing', 'project', 'Existing', '{}', 'full-access', 'default',
          NULL, NULL, NULL, NULL, 0, 0, 0,
          '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', NULL, NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 83 });
      assert.deepEqual(yield* readColumns, { sourceMessageId: true, sourceTurnId: true });
      const rows = yield* sql<{
        readonly sourceMessageId: string | null;
        readonly sourceTurnId: string | null;
      }>`
        SELECT
          lineage_source_message_id AS "sourceMessageId",
          lineage_source_turn_id AS "sourceTurnId"
        FROM projection_threads
      `;
      assert.deepEqual(rows, [{ sourceMessageId: null, sourceTurnId: null }]);

      yield* ProjectionThreadLineageFork;
      yield* runMigrations();
      assert.deepEqual(yield* readColumns, { sourceMessageId: true, sourceTurnId: true });
    }),
  );
});

it.layer(NodeSqliteClient.layerMemory())("083 repair", (it) => {
  it.effect("adds the columns when a later migration was recorded first and 083 was skipped", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 82 });
      // A build that shipped a higher id before 083: the migrator now skips 083.
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (83, 'ProjectionThreadLineageFork')
      `;
      assert.deepEqual(yield* readColumns, { sourceMessageId: false, sourceTurnId: false });
      yield* runMigrations();
      assert.deepEqual(yield* readColumns, { sourceMessageId: true, sourceTurnId: true });
    }),
  );
});
