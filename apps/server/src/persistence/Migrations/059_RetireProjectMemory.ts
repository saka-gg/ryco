import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Keep migration 058 and all saved rows, including crash-claim evidence, intact.
// No runtime now reads or mutates these tables. Retire triggers which otherwise
// block project operations or silently delete archived memory on project deletion.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TRIGGER IF EXISTS project_memory_cap`;
  yield* sql`DROP TRIGGER IF EXISTS project_memory_delete_guard`;
  yield* sql`DROP TRIGGER IF EXISTS project_memory_soft_delete_guard`;
  yield* sql`DROP TRIGGER IF EXISTS project_memory_project_deleted`;
  yield* sql`DROP TRIGGER IF EXISTS project_memory_project_removed`;
});
