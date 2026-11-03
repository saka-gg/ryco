import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The Hub account of a Hub-linked device, from the relay grant that linked it. The node asks
 * its Hub about each linked device by account, enrollment and key
 * (`@ryco/contracts/node-linked-access`): an enrollment id alone names a device only within
 * one account. NULL for links made before this column, and for locally verified devices.
 *
 * Idempotent, so it also runs as a repair after the ledger pass when another branch recorded
 * this migration id.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of ["auth_pairing_links", "auth_sessions"] as const) {
    const columns = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info(${table})
    `;
    if (!columns.some((column) => column.name === "link_account_id")) {
      yield* sql.unsafe(`ALTER TABLE ${table} ADD COLUMN link_account_id TEXT`);
    }
  }
});
