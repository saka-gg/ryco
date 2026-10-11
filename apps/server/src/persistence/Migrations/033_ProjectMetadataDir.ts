import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;

  if (columns.some((column) => column.name === "project_metadata_dir")) {
    return;
  }

  yield* sql`
    ALTER TABLE projection_projects
    ADD COLUMN project_metadata_dir TEXT NOT NULL DEFAULT '.ryco'
  `;
});
