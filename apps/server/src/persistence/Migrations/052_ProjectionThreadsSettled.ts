import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has("settled_override")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN settled_override TEXT`;
  }

  if (!columnNames.has("settled_at")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN settled_at TEXT`;
  }
});
