import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Scan saved bodies once, so ordinary reads need neither a NUL scan nor JSON.
// SQL encoding retains bytes after NUL that native TEXT reads can truncate.
// Existing fallback values may preserve lone surrogates: never replace them.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE projection_thread_messages SET text_json = json_quote(text)
    WHERE text_json IS NULL AND instr(text, char(0)) > 0`;
});
