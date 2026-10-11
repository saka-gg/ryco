import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;
  if (!columns.some((column) => column.name === "dispatch_mode")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN dispatch_mode TEXT
    `;
  }
});
