import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(NodeSqliteClient.layerMemory())("059_RetireProjectMemory", (it) => {
  it.effect(
    "starts repeatedly with enabled memory and crash claims without deleting saved data",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 58 });
        yield* sql`INSERT INTO projection_projects
          (project_id, title, workspace_root, scripts_json, created_at, updated_at)
          VALUES ('archived-project', 'Existing project', '/tmp/archived', '[]', 'then', 'then')`;
        yield* sql`INSERT INTO project_memory_settings
        (project_id, enabled, revision, dispatch_id, dispatch_owner_pid, dispatch_owner, dispatch_runtime_json)
        VALUES ('archived-project', 1, 7, 'pending', 123, 'prior-process', '{}')`;
        yield* sql`INSERT INTO project_memories
        (id, project_id, kind, text, revision, pinned, created_at, updated_at, affirmed_at, provenance_json)
        VALUES ('entry', 'archived-project', 'fact', 'Saved reference', 7, 0, 'then', 'then', 'then', '{}')`;
        const settings = yield* sql`SELECT * FROM project_memory_settings`;
        const memories = yield* sql`SELECT * FROM project_memories`;
        yield* runMigrations();
        yield* runMigrations();
        // Old claims must not block unrelated project lifecycle operations.
        yield* sql`UPDATE projection_projects SET deleted_at = 'now' WHERE project_id = 'archived-project'`;
        yield* sql`DELETE FROM projection_projects WHERE project_id = 'archived-project'`;
        assert.deepEqual(yield* sql`SELECT * FROM project_memory_settings`, settings);
        assert.deepEqual(yield* sql`SELECT * FROM project_memories`, memories);
        assert.deepEqual(
          yield* sql`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'project_memory_%'`,
          [],
        );
      }),
  );
});
