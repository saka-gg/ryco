import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE projection_worktrees ADD COLUMN work_item_provider TEXT`;
  yield* sql`ALTER TABLE projection_worktrees ADD COLUMN work_item_key TEXT`;
  yield* sql`ALTER TABLE projection_worktrees ADD COLUMN work_item_title TEXT`;
  yield* sql`ALTER TABLE projection_worktrees ADD COLUMN work_item_state TEXT`;
  yield* sql`ALTER TABLE projection_worktrees ADD COLUMN work_item_url TEXT`;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_worktrees_work_item_lookup
    ON projection_worktrees(project_id, work_item_provider, work_item_key)
    WHERE work_item_provider IS NOT NULL AND work_item_key IS NOT NULL
  `;
});
