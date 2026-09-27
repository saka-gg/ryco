import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE session_imports (
    source_key TEXT PRIMARY KEY, source TEXT NOT NULL, thread_id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL, command_json TEXT NOT NULL, cursor_json TEXT NOT NULL,
    instance_id TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0, phase TEXT NOT NULL DEFAULT 'copied', target_cwd TEXT NOT NULL, provider_fingerprint TEXT NOT NULL, source_root TEXT NOT NULL, source_file TEXT NOT NULL, source_fingerprint TEXT NOT NULL
  )`;
});
