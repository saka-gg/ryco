import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Durable external-integration identities, task reservations, and redacted audit metadata. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS agent_control_external_integrations (
      integration_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      client_kind TEXT NOT NULL CHECK (
        client_kind IN ('codex', 'claude-code', 'claude-desktop', 'generic-mcp')
      ),
      project_scope_json TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      rate_limit_per_minute INTEGER NOT NULL CHECK (rate_limit_per_minute > 0),
      active_task_limit INTEGER NOT NULL CHECK (active_task_limit > 0),
      active_task_count INTEGER NOT NULL DEFAULT 0 CHECK (active_task_count >= 0),
      expires_at TEXT,
      revoked_at TEXT,
      pairing_state TEXT NOT NULL CHECK (pairing_state IN ('unpaired', 'pending', 'paired')),
      pairing_code_hash TEXT,
      pairing_code_expires_at TEXT,
      paired_at TEXT,
      credential_audience TEXT,
      credential_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_control_external_credential_hash
    ON agent_control_external_integrations(credential_hash)
    WHERE credential_hash IS NOT NULL
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS agent_control_external_tasks (
      task_id TEXT PRIMARY KEY,
      integration_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      plan_digest TEXT NOT NULL,
      proposal_id TEXT,
      project_id TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      environment TEXT NOT NULL CHECK (environment IN ('local', 'worktree')),
      runtime_mode TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      released_at TEXT
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_control_external_task_request
    ON agent_control_external_tasks(integration_id, request_id)
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_control_external_task_proposal
    ON agent_control_external_tasks(proposal_id)
    WHERE proposal_id IS NOT NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_agent_control_external_task_recovery
    ON agent_control_external_tasks(released_at, updated_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS agent_control_external_audit (
      audit_id TEXT PRIMARY KEY,
      integration_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      request_id TEXT,
      project_id TEXT,
      runtime_mode TEXT,
      environment TEXT,
      proposal_id TEXT,
      operation_id TEXT,
      thread_id TEXT,
      outcome TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_agent_control_external_audit_integration_time
    ON agent_control_external_audit(integration_id, created_at DESC)
  `;
});
