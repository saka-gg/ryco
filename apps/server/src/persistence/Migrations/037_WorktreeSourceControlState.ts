import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_worktrees)
  `;
  const names = new Set(columns.map((column) => column.name));

  if (!names.has("pr_state")) {
    yield* sql`ALTER TABLE projection_worktrees ADD COLUMN pr_state TEXT`;
  }
  if (!names.has("pr_is_draft")) {
    yield* sql`ALTER TABLE projection_worktrees ADD COLUMN pr_is_draft INTEGER`;
  }
  if (!names.has("issue_state")) {
    yield* sql`ALTER TABLE projection_worktrees ADD COLUMN issue_state TEXT`;
  }
});
