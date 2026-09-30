import { it, assert } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
it.layer(NodeSqliteClient.layerMemory())("067 session import recovery", (it) => {
  it.effect("upgrades existing uncertain/copied ledgers without resetting identity or phase", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 62 });
      for (const phase of ["forking", "copied", "prepared"]) {
        yield* sql`INSERT INTO session_imports (source_key, source, thread_id, project_id, command_json, cursor_json, instance_id, target_cwd, provider_fingerprint, source_root, source_file, source_fingerprint, phase) VALUES (${phase}, 'codex', ${phase}, 'target', '{}', '{"threadId":"synthetic"}', 'codex', '/synthetic', 'config', '/synthetic/store', '/synthetic/store/source', 'source', ${phase})`;
      }
      // Upgrade a node with the first workflow migration already applied.
      yield* runMigrations({ toMigrationInclusive: 66 });
      yield* sql`INSERT INTO storage_owned_entries (id, path, category, identity_json, created_at, state) VALUES ('synthetic-storage', '/synthetic/checkout', 'worktree', '{}', '2026-01-01', 'removing')`;
      yield* runMigrations({ toMigrationInclusive: 67 });
      yield* runMigrations({ toMigrationInclusive: 67 });
      assert.deepEqual(yield* sql`SELECT id, state FROM storage_owned_entries`, [
        { id: "synthetic-storage", state: "removing" },
      ]);
      assert.deepEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'storage_%' ORDER BY name`,
        [
          "storage_owned_entries_path_nocase",
          "storage_owned_entries_state",
          "storage_pending_turns",
          "storage_usage_history_project_time",
        ].map((name) => ({ name })),
      );
      const rows = yield* sql<{
        phase: string;
        native_file: string | null;
        native_fingerprint: string | null;
        cursor_json: string;
      }>`SELECT phase, native_file, native_fingerprint, cursor_json FROM session_imports ORDER BY phase`;
      assert.deepEqual(
        rows,
        ["copied", "forking", "prepared"].map((phase) => ({
          phase,
          native_file: null,
          native_fingerprint: null,
          cursor_json: '{"threadId":"synthetic"}',
        })),
      );
    }),
  );
});
