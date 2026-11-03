import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Where a fork carried from another node came from (`threads.forkCarried`): display-only
 * provenance as JSON (`ThreadForkOrigin`), NULL for a fork of a thread on this node. The carried
 * conversation itself lives in the row's plan, like any fork's inherited history, until the fork
 * settles. No new table, so the dev-home seed policy of `thread_forks` stays as it is.
 *
 * Idempotent, so it also runs as a repair after the ledger pass when another branch recorded
 * this migration id.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('thread_forks')
  `;
  if (columns.length > 0 && !columns.some((column) => column.name === "origin_json")) {
    yield* sql`ALTER TABLE thread_forks ADD COLUMN origin_json TEXT`;
  }
});
