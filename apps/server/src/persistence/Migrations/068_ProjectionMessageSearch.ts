import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Index only settled, ordinary TEXT bodies. Streaming chunks and lossless JSON
// fallback bodies retain their existing search path, without reindexing deltas.
// Contentless trigrams omit bodies, token positions, and per-document lengths.
// Stable integer ids survive VACUUM, unlike the message table's implicit rowid.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE projection_message_search_ids (
      search_id INTEGER PRIMARY KEY,
      message_id TEXT NOT NULL UNIQUE
    )
  `;
  yield* sql`
    CREATE VIRTUAL TABLE projection_message_search USING fts5(
      text, content='', tokenize='trigram', detail='none', columnsize=0
    )
  `;
  yield* sql`
    CREATE INDEX idx_projection_messages_search_fallback
    ON projection_thread_messages(message_id)
    WHERE is_streaming <> 0 OR text_json IS NOT NULL
  `;
  yield* sql`
    INSERT INTO projection_message_search_ids(message_id)
    SELECT message_id FROM projection_thread_messages
    WHERE is_streaming = 0 AND text_json IS NULL
  `;
  yield* sql`
    INSERT INTO projection_message_search(rowid, text)
    SELECT ids.search_id, messages.text
    FROM projection_message_search_ids ids
    JOIN projection_thread_messages messages ON messages.message_id = ids.message_id
  `;
  yield* sql`
    CREATE TRIGGER projection_message_search_insert AFTER INSERT ON projection_thread_messages
    WHEN new.is_streaming = 0 AND new.text_json IS NULL
    BEGIN
      INSERT INTO projection_message_search_ids(message_id) VALUES(new.message_id);
      INSERT INTO projection_message_search(rowid, text)
      SELECT search_id, new.text FROM projection_message_search_ids WHERE message_id = new.message_id;
    END
  `;
  yield* sql`
    CREATE TRIGGER projection_message_search_delete BEFORE DELETE ON projection_thread_messages
    WHEN old.is_streaming = 0 AND old.text_json IS NULL
    BEGIN
      INSERT INTO projection_message_search(projection_message_search, rowid, text)
      SELECT 'delete', search_id, old.text FROM projection_message_search_ids WHERE message_id = old.message_id;
      DELETE FROM projection_message_search_ids WHERE message_id = old.message_id;
    END
  `;
  yield* sql`
    CREATE TRIGGER projection_message_search_update AFTER UPDATE OF message_id, text, text_json, is_streaming ON projection_thread_messages
    WHEN old.message_id IS NOT new.message_id OR old.text IS NOT new.text
      OR old.text_json IS NOT new.text_json OR old.is_streaming IS NOT new.is_streaming
    BEGIN
      INSERT INTO projection_message_search(projection_message_search, rowid, text)
      SELECT 'delete', search_id, old.text FROM projection_message_search_ids WHERE message_id = old.message_id;
      DELETE FROM projection_message_search_ids WHERE message_id = old.message_id;
      INSERT INTO projection_message_search_ids(message_id)
      SELECT new.message_id WHERE new.is_streaming = 0 AND new.text_json IS NULL;
      INSERT INTO projection_message_search(rowid, text)
      SELECT search_id, new.text FROM projection_message_search_ids WHERE message_id = new.message_id;
    END
  `;
});
