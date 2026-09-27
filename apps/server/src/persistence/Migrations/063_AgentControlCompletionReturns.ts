import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE agent_control_completion_returns (
    child_thread_id TEXT PRIMARY KEY,
    proposal_id TEXT NOT NULL,
    status TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    next_check_at TEXT NOT NULL,
    record_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX agent_control_completion_returns_due
    ON agent_control_completion_returns(status, next_check_at)`;
  yield* sql`CREATE INDEX agent_control_completion_returns_proposal
    ON agent_control_completion_returns(proposal_id)`;
});
