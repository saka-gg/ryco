import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE agent_control_automation_runs ADD COLUMN retry_of_run_id TEXT`;
  yield* sql`CREATE TABLE agent_control_automation_read_state (
    run_id TEXT PRIMARY KEY, read_updated_at TEXT NOT NULL
  )`;
  // Keep damaged rows intact, but stop them starving bounded scheduler batches.
  yield* sql`CREATE TABLE agent_control_automation_quarantine (
    kind TEXT NOT NULL, id TEXT NOT NULL, project_id TEXT NOT NULL,
    PRIMARY KEY (kind, id)
  )`;
});
