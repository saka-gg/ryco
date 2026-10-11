import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS atlassian_connections (
      connection_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      status TEXT NOT NULL,
      products_json TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      account_name TEXT,
      account_email TEXT,
      avatar_url TEXT,
      base_url TEXT,
      expires_at TEXT,
      last_verified_at TEXT,
      readonly INTEGER NOT NULL DEFAULT 0,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_atlassian_connections_status
    ON atlassian_connections(status)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS atlassian_resources (
      resource_id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      product TEXT NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      cloud_id TEXT,
      workspace_slug TEXT,
      avatar_url TEXT,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_atlassian_resources_connection_product
    ON atlassian_resources(connection_id, product)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_atlassian_links (
      project_id TEXT PRIMARY KEY,
      jira_connection_id TEXT,
      bitbucket_connection_id TEXT,
      jira_cloud_id TEXT,
      jira_site_url TEXT,
      jira_project_keys_json TEXT NOT NULL,
      bitbucket_workspace TEXT,
      bitbucket_repo_slug TEXT,
      default_issue_type_name TEXT,
      branch_name_template TEXT NOT NULL,
      commit_message_template TEXT NOT NULL,
      pull_request_title_template TEXT NOT NULL,
      smart_linking_enabled INTEGER NOT NULL DEFAULT 1,
      auto_attach_work_items INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_atlassian_links_project
    ON project_atlassian_links(project_id)
  `;
});
