import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Bearer rotation for direct pairings. A rotated session links to the session
 * it replaced, and every session of one pairing shares that pairing's chain id
 * and original pairing time, which caps the chain's lifetime. A session is
 * superseded once its successor first authenticates.
 *
 * Rows from before rotation keep NULL here and read as their own chain: chain
 * id = session id, chain start = issued_at. Idempotent, so it also runs as a
 * repair after the ledger pass when another branch recorded this migration id.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const sessionColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_sessions)
  `;
  const columnNames = new Set(sessionColumns.map((column) => column.name));

  if (!columnNames.has("rotated_from")) {
    yield* sql`ALTER TABLE auth_sessions ADD COLUMN rotated_from TEXT`;
  }
  if (!columnNames.has("chain_id")) {
    yield* sql`ALTER TABLE auth_sessions ADD COLUMN chain_id TEXT`;
  }
  if (!columnNames.has("chain_issued_at")) {
    yield* sql`ALTER TABLE auth_sessions ADD COLUMN chain_issued_at TEXT`;
  }
  if (!columnNames.has("superseded_at")) {
    yield* sql`ALTER TABLE auth_sessions ADD COLUMN superseded_at TEXT`;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_chain
    ON auth_sessions(chain_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_rotated_from
    ON auth_sessions(rotated_from)
  `;
});
