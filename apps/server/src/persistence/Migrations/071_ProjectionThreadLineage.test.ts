import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const LINEAGE_COLUMNS = [
  "lineage_parent_thread_id",
  "lineage_root_thread_id",
  "lineage_relationship",
] as const;

const lineageColumnNames = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
  return columns
    .map((column) => column.name)
    .filter((name) => (LINEAGE_COLUMNS as ReadonlyArray<string>).includes(name))
    .toSorted();
});

const lineageIndexCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'index' AND name = 'projection_threads_lineage_parent'
  `;
  return rows.length;
});

it.layer(NodeSqliteClient.layerMemory())("071 projection thread lineage migration", (it) => {
  it.effect("adds nullable lineage columns and a partial index without touching rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 70 });
      assert.deepStrictEqual(yield* lineageColumnNames, []);

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at,
          parent_thread_id
        )
        VALUES (
          'thread-legacy',
          'project-1',
          'Legacy thread',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          NULL,
          NULL,
          'thread-stale-subagent-parent'
        )
      `;
      const before = yield* sql`
        SELECT thread_id, title, parent_thread_id FROM projection_threads
      `;

      yield* runMigrations({ toMigrationInclusive: 71 });
      assert.deepStrictEqual(yield* lineageColumnNames, [...LINEAGE_COLUMNS].toSorted());
      assert.strictEqual(yield* lineageIndexCount, 1);
      assert.deepStrictEqual(
        yield* sql`SELECT thread_id, title, parent_thread_id FROM projection_threads`,
        before,
      );
      const lineage = yield* sql<{
        readonly lineage_parent_thread_id: string | null;
        readonly lineage_root_thread_id: string | null;
        readonly lineage_relationship: string | null;
      }>`
        SELECT lineage_parent_thread_id, lineage_root_thread_id, lineage_relationship
        FROM projection_threads
      `;
      assert.deepStrictEqual(lineage, [
        {
          lineage_parent_thread_id: null,
          lineage_root_thread_id: null,
          lineage_relationship: null,
        },
      ]);

      yield* runMigrations({ toMigrationInclusive: 71 });
      assert.deepStrictEqual(yield* lineageColumnNames, [...LINEAGE_COLUMNS].toSorted());
      assert.strictEqual(yield* lineageIndexCount, 1);
    }),
  );

  it.effect("restores the columns as a repair when a later migration was recorded first", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      // Simulate a database that recorded 071 (or a later id) without the schema:
      // the migrator will not rerun 071, so only the repair hook can restore it.
      yield* sql`DROP INDEX projection_threads_lineage_parent`;
      yield* sql`ALTER TABLE projection_threads DROP COLUMN lineage_parent_thread_id`;
      yield* sql`ALTER TABLE projection_threads DROP COLUMN lineage_root_thread_id`;
      yield* sql`ALTER TABLE projection_threads DROP COLUMN lineage_relationship`;
      assert.deepStrictEqual(yield* lineageColumnNames, []);

      yield* runMigrations();
      assert.deepStrictEqual(yield* lineageColumnNames, [...LINEAGE_COLUMNS].toSorted());
      assert.strictEqual(yield* lineageIndexCount, 1);
    }),
  );
});
