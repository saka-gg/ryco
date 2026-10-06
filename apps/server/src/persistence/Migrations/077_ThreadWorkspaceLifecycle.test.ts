import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import ThreadWorkspaceLifecycle from "./077_ThreadWorkspaceLifecycle.ts";

const readSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threadColumns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(projection_threads)`;
  const worktreeColumns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(projection_worktrees)`;
  return {
    trashedAt: threadColumns.some((column) => column.name === "trashed_at"),
    checkoutRemovedAt: worktreeColumns.some((column) => column.name === "checkout_removed_at"),
    checkoutRemovalReason: worktreeColumns.some(
      (column) => column.name === "checkout_removal_reason",
    ),
  };
});

const ABSENT = { trashedAt: false, checkoutRemovedAt: false, checkoutRemovalReason: false };
const PRESENT = { trashedAt: true, checkoutRemovedAt: true, checkoutRemovalReason: true };

it.layer(NodeSqliteClient.layerMemory())("077 thread/workspace lifecycle", (it) => {
  it.effect("adds the columns, keeps legacy deletions permanent, and is idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 76 });
      assert.deepEqual(yield* readSchema, ABSENT);
      // A thread deleted before Trash existed: its assets are already gone.
      yield* sql`
        INSERT INTO projection_threads (thread_id, project_id, title, branch, worktree_path,
          latest_turn_id, created_at, updated_at, deleted_at)
        VALUES ('legacy-deleted', 'p', 'Legacy', NULL, NULL, NULL,
          '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
      `;
      yield* runMigrations({ toMigrationInclusive: 77 });
      assert.deepEqual(yield* readSchema, PRESENT);
      const rows = yield* sql<{
        readonly deletedAt: string | null;
        readonly trashedAt: string | null;
      }>`
        SELECT deleted_at AS "deletedAt", trashed_at AS "trashedAt"
        FROM projection_threads WHERE thread_id = 'legacy-deleted'
      `;
      // Not offered as recoverable: no promise to restore assets that no longer exist.
      assert.deepEqual(rows, [{ deletedAt: "2026-01-02T00:00:00.000Z", trashedAt: null }]);
      yield* ThreadWorkspaceLifecycle;
      yield* runMigrations();
      assert.deepEqual(yield* readSchema, PRESENT);
    }),
  );
});

it.layer(NodeSqliteClient.layerMemory())("077 repair", (it) => {
  it.effect("adds the columns when a later migration was recorded first", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 76 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (77, 'ThreadWorkspaceLifecycle')
      `;
      assert.deepEqual(yield* readSchema, ABSENT);
      yield* runMigrations();
      assert.deepEqual(yield* readSchema, PRESENT);
    }),
  );
});
