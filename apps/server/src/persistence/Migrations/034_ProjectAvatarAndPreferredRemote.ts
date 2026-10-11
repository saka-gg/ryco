import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has("custom_avatar_content_hash")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN custom_avatar_content_hash TEXT
    `;
  }

  if (!columnNames.has("preferred_remote_name")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN preferred_remote_name TEXT
    `;
  }
});
