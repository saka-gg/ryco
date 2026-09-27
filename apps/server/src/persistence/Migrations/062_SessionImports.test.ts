import { it, assert } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
it.layer(NodeSqliteClient.layerMemory())("062 session import migration", (it) => {
  it.effect("registers the ledger and preserves it across repeated migration runs", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 62 });
      yield* sql`INSERT INTO session_imports (source_key, source, thread_id, project_id, command_json, cursor_json, instance_id, target_cwd, provider_fingerprint, source_root, source_file, source_fingerprint) VALUES ('source', 'codex', 'thread', 'project', '{}', '{}', 'codex', '/fixture', 'fixture', '/fixture', '/fixture/source', 'hash')`;
      yield* runMigrations({ toMigrationInclusive: 62 });
      const rows = yield* sql<{ source_key: string }>`SELECT source_key FROM session_imports`;
      assert.deepEqual(rows, [{ source_key: "source" }]);
    }),
  );
});
