import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_worktrees)
  `;
  if (columns.some((column) => column.name === "title")) {
    return;
  }
  yield* sql`ALTER TABLE projection_worktrees ADD COLUMN title TEXT`;
});
