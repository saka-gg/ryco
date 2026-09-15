import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!columns.some((column) => column.name === "token_mode")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN token_mode TEXT NOT NULL DEFAULT 'off'
    `;
  }

  const sessionColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_sessions)
  `;
  if (!sessionColumns.some((column) => column.name === "token_mode")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN token_mode TEXT NOT NULL DEFAULT 'off'
    `;
  }
});
