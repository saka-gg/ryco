import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Agent Control foundation tables.
 *
 * `agent_control_proposals` rows are immutable where it matters: the plan
 * payload, digest, principal, and request identity are written once and
 * never updated — only `status`, `decided_at`, `result_json`, and
 * `updated_at` may change, via compare-and-set in the repository layer.
 *
 * `agent_control_audit` retains identifiers, bounded metadata, and an
 * audit-safe prompt summary only — never full prompts, plan payloads,
 * secrets, or credentials.
 *
 * These tables are independent of `projection_pending_approvals`, which
 * represents provider-native callback approvals.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS agent_control_proposals (
      proposal_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      principal_scope TEXT NOT NULL,
      principal_json TEXT NOT NULL,
      action_kind TEXT NOT NULL,
      plan_version INTEGER NOT NULL,
      plan_json TEXT NOT NULL,
      plan_digest TEXT NOT NULL,
      risk_tags_json TEXT NOT NULL,
      prompt_summary TEXT,
      status TEXT NOT NULL CHECK (
        status IN (
          'pending-user-approval',
          'approved',
          'rejected',
          'expired',
          'executing',
          'completed',
          'failed',
          'cancelled'
        )
      ),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      decided_at TEXT,
      result_json TEXT
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_control_proposals_scope_request
    ON agent_control_proposals(principal_scope, request_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_agent_control_proposals_status_expires
    ON agent_control_proposals(status, expires_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS agent_control_operations (
      operation_id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL,
      action_kind TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN (
          'pending',
          'running',
          'compensating',
          'completed',
          'failed',
          'cancelled'
        )
      ),
      attempt INTEGER NOT NULL DEFAULT 0,
      state_json TEXT NOT NULL,
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_control_operations_proposal
    ON agent_control_operations(proposal_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_agent_control_operations_recovery
    ON agent_control_operations(status, updated_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS agent_control_audit (
      audit_id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      principal_scope TEXT NOT NULL,
      prompt_summary TEXT,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_agent_control_audit_proposal
    ON agent_control_audit(proposal_id, created_at)
  `;
});
