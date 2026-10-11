import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Durable, bounded Agent Control schedule definitions and occurrence history. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS agent_control_automations (
      automation_id TEXT PRIMARY KEY,
      principal_json TEXT NOT NULL,
      project_id TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      cancelled INTEGER NOT NULL CHECK (cancelled IN (0, 1)),
      cancelled_at TEXT,
      next_run_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_agent_control_automations_project
    ON agent_control_automations(project_id, provider_instance_id, updated_at DESC)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_agent_control_automations_due
    ON agent_control_automations(enabled, cancelled, next_run_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS agent_control_automation_runs (
      run_id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      automation_revision INTEGER NOT NULL CHECK (automation_revision > 0),
      project_id TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      scheduled_for TEXT NOT NULL,
      coalesced_occurrences INTEGER NOT NULL DEFAULT 0 CHECK (coalesced_occurrences >= 0),
      status TEXT NOT NULL CHECK (
        status IN (
          'materializing',
          'pending-approval',
          'approved',
          'executing',
          'completed',
          'failed',
          'rejected',
          'expired',
          'cancelled'
        )
      ),
      proposal_id TEXT,
      safe_failure_detail TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_control_automation_runs_occurrence
    ON agent_control_automation_runs(automation_id, automation_revision, scheduled_for)
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_control_automation_runs_proposal
    ON agent_control_automation_runs(proposal_id)
    WHERE proposal_id IS NOT NULL
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_control_automation_runs_one_active
    ON agent_control_automation_runs(automation_id)
    WHERE status IN ('materializing', 'pending-approval', 'approved', 'executing')
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_agent_control_automation_runs_history
    ON agent_control_automation_runs(automation_id, created_at DESC)
  `;
});
