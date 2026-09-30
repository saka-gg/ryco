import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE session_imports ADD COLUMN native_file TEXT`;
  yield* sql`ALTER TABLE session_imports ADD COLUMN native_fingerprint TEXT`;
});
