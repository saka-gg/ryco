import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import Migration0042 from "./042_ContextHandoffRuntimeSessions.ts";

export default Effect.gen(function* () {
  // Some development databases recorded a different historical migration at
  // numeric id 42. The migrator will therefore skip our idempotent handoff
  // migration, so restore its schema before migration 43 depends on it.
  yield* Migration0042;

  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(provider_context_handoffs)
  `;
  if (!columns.some((column) => column.name === "delivery_artifact_json")) {
    yield* sql`
      ALTER TABLE provider_context_handoffs
      ADD COLUMN delivery_artifact_json TEXT
    `;
  }
});
