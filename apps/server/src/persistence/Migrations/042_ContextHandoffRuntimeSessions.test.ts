import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("042_ContextHandoffRuntimeSessions", (it) => {
  it.effect("repairs the schema when another worktree already recorded migration id 42", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 41 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, created_at, name)
        VALUES (42, '2026-07-31T12:05:37.000Z', 'ProjectionThreadsSettled')
      `;

      yield* runMigrations({ toMigrationInclusive: 42 });

      const runtimeColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(provider_session_runtime)
      `;
      const projectionColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_sessions)
      `;
      const handoffTables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'provider_context_handoffs'
      `;
      assert.ok(runtimeColumns.some((column) => column.name === "runtime_session_id"));
      assert.ok(projectionColumns.some((column) => column.name === "runtime_session_id"));
      assert.strictEqual(handoffTables.length, 1);
    }),
  );

  it.effect(
    "adds nullable epoch columns and the server-local handoff table without losing rows",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 41 });

        yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id,
          provider_name,
          provider_instance_id,
          adapter_key,
          runtime_mode,
          status,
          last_seen_at,
          resume_cursor_json,
          runtime_payload_json
        ) VALUES (
          'legacy-thread',
          'codex',
          'codex_work',
          'codex',
          'full-access',
          'running',
          '2026-08-04T00:00:00.000Z',
          NULL,
          NULL
        )
      `;
        yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_instance_id,
          runtime_mode,
          token_mode,
          active_turn_id,
          last_error,
          updated_at
        ) VALUES (
          'legacy-thread',
          'idle',
          'codex',
          'codex_work',
          'full-access',
          'balanced',
          NULL,
          NULL,
          '2026-08-04T00:00:00.000Z'
        )
      `;

        yield* runMigrations({ toMigrationInclusive: 42 });

        const runtimeColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(provider_session_runtime)
      `;
        assert.ok(runtimeColumns.some((column) => column.name === "runtime_session_id"));
        const projectionColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_sessions)
      `;
        assert.ok(projectionColumns.some((column) => column.name === "runtime_session_id"));

        const legacyRuntime = yield* sql<{
          readonly threadId: string;
          readonly runtimeSessionId: string | null;
        }>`
        SELECT
          thread_id AS "threadId",
          runtime_session_id AS "runtimeSessionId"
        FROM provider_session_runtime
        WHERE thread_id = 'legacy-thread'
      `;
        assert.deepStrictEqual(legacyRuntime, [
          { threadId: "legacy-thread", runtimeSessionId: null },
        ]);

        const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'provider_context_handoffs'
      `;
        assert.strictEqual(tables.length, 1);
        const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(provider_context_handoffs)
      `;
        assert.ok(
          indexes.some(
            (index) => index.name === "idx_provider_context_handoffs_thread_status_created",
          ),
        );

        yield* sql`
        INSERT INTO provider_context_handoffs (
          handoff_id,
          thread_id,
          source_selection_json,
          target_selection_json,
          status,
          context_version,
          first_message_id,
          created_at,
          updated_at
        ) VALUES (
          'handoff-survives-reopen',
          'legacy-thread',
          '{"instanceId":"codex_work","model":"gpt-5.6"}',
          '{"instanceId":"claude_work","model":"claude-fable-5"}',
          'requested',
          1,
          'message-1',
          '2026-08-04T00:00:00.000Z',
          '2026-08-04T00:00:00.000Z'
        )
      `;
        yield* runMigrations({ toMigrationInclusive: 42 });
        const durableRows = yield* sql<{ readonly handoffId: string }>`
        SELECT handoff_id AS "handoffId"
        FROM provider_context_handoffs
      `;
        assert.deepStrictEqual(durableRows, [{ handoffId: "handoff-survives-reopen" }]);
      }),
  );
});
