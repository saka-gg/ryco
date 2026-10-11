import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Recoverable provider-native installations of the external Agent Control bridge. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS agent_control_mcp_installations (
      installation_id TEXT PRIMARY KEY,
      integration_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      provider_driver TEXT NOT NULL,
      server_name TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN (
        'planned', 'credential-written', 'provider-written', 'verifying', 'connected',
        'repair-needed', 'disconnecting', 'disconnected', 'revoked'
      )),
      desired_fingerprint TEXT,
      native_fingerprint TEXT,
      last_error TEXT,
      owns_native_config INTEGER NOT NULL DEFAULT 0 CHECK (owns_native_config IN (0, 1)),
      preserved_user_changes INTEGER NOT NULL DEFAULT 0 CHECK (
        preserved_user_changes IN (0, 1)
      ),
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      connected_at TEXT,
      FOREIGN KEY (integration_id)
        REFERENCES agent_control_external_integrations(integration_id)
        ON DELETE RESTRICT
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_control_mcp_installations_active_target
    ON agent_control_mcp_installations(workspace_id, server_name)
    WHERE state NOT IN ('disconnected', 'revoked')
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_agent_control_mcp_installations_recovery
    ON agent_control_mcp_installations(state, updated_at)
  `;
});
