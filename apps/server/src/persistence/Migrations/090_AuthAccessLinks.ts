import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const LINK_COLUMNS = [
  "link_trust_source",
  "link_enrollment_id",
  "link_client_fingerprint",
  "link_role",
] as const;

/**
 * Hub-linked direct access. A pairing grant the node issued over a trusted
 * native relay channel, and every session redeemed from it, records that
 * channel's device (Hub enrollment or client fingerprint) and effective role.
 * Rows without a link keep NULL in all four columns.
 *
 * Idempotent, so it also runs as a repair after the ledger pass when another
 * branch recorded this migration id.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  for (const table of ["auth_pairing_links", "auth_sessions"] as const) {
    const columns = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info(${table})
    `;
    const names = new Set(columns.map((column) => column.name));
    for (const column of LINK_COLUMNS) {
      if (!names.has(column)) {
        yield* sql.unsafe(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
      }
    }
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_link_enrollment
    ON auth_sessions(link_enrollment_id)
    WHERE link_enrollment_id IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_link_client
    ON auth_sessions(link_client_fingerprint)
    WHERE link_client_fingerprint IS NOT NULL
  `;
});
