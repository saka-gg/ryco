import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(NodeSqliteClient.layerMemory())("066 storage migration", (it) => {
  it.effect(
    "preserves provider history and introduces no automatic ownership of existing installs",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 65 });
        yield* sql`INSERT INTO provider_session_runtime (thread_id, provider_name, provider_instance_id, adapter_key, runtime_mode, status, last_seen_at, resume_cursor_json, runtime_payload_json) VALUES ('historical-fixture', 'codex', 'codex', 'codex', 'full-access', 'stopped', '2020-01-01T00:00:00Z', '{"fixture":"retained"}', NULL)`;
        const before = yield* sql`SELECT * FROM provider_session_runtime`;
        yield* runMigrations({ toMigrationInclusive: 66 });
        assert.deepEqual(yield* sql`SELECT * FROM provider_session_runtime`, before);
        assert.strictEqual((yield* sql`SELECT * FROM storage_owned_entries`).length, 0);
        const indexes = yield* sql<{
          name: string;
        }>`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'storage_pending_turns'`;
        assert.strictEqual(indexes.length, 1);
        yield* sql`INSERT INTO storage_usage_history (sampled_at, project_id, measured_bytes, incomplete_entries) VALUES ('2020-01-01T00:00:00Z', NULL, 1234, 1)`;
        yield* runMigrations({ toMigrationInclusive: 66 });
        assert.deepEqual(yield* sql`SELECT * FROM provider_session_runtime`, before);
        assert.strictEqual(
          (yield* sql<{
            measured_bytes: number;
          }>`SELECT measured_bytes FROM storage_usage_history`)[0]!.measured_bytes,
          1234,
        );
      }),
  );
});
