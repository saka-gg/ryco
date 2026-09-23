import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Additive migration: retain saved text and projector cursors. A resumed body is
// moved into a prefix chunk by the repository in the next event transaction.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN text_json TEXT`;
  yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN text_event_sequence INTEGER NOT NULL DEFAULT 0`;
  yield* sql`
    CREATE TABLE projection_message_chunks (
      message_id TEXT NOT NULL REFERENCES projection_thread_messages(message_id) ON DELETE CASCADE,
      event_sequence INTEGER NOT NULL,
      text_json TEXT NOT NULL,
      PRIMARY KEY (message_id, event_sequence)
    ) WITHOUT ROWID
  `;
});
