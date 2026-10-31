/**
 * flavorImport/flavorImportTablePolicy - What a copy of Ryco's database keeps when Ryco Nightly
 * takes it over (consumeFlavorImport.ts).
 *
 * Ryco Nightly is a node of its own: it pairs, enrolls and owns files on its own. The copy keeps
 * the person's work (projects, chats and their history, notes, tasks, statistics) and loses
 * everything that would let Nightly act as Ryco's node or act a second time on what Ryco still
 * runs: sessions and pairing links, Agent Control integrations and installations, Atlassian
 * connections, pull request watches, follow-up queues, restart continuations, provider session
 * bindings (Claude and Codex resume state), pending provider effects, storage and worktree
 * ownership and their journals. Schedules are paused, unfinished proposals, operations, runs and
 * context hand-offs are cancelled, chat goals are paused and usage-limited chats are no longer
 * resumed on their own.
 *
 * The scrub runs on the copy after it was migrated to this build's schema, so the map below
 * describes exactly the tables it meets. `flavorImportTablePolicy.test.ts` fails for a table of
 * the migrated schema that has no entry, so a new table must be classified here; a table the map
 * does not know (another branch's) is emptied.
 *
 * @module flavorImport/flavorImportTablePolicy
 */
import { Data, Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * `keep` copies every row, `clear` empties the table and `rewrite` runs the table's statements in
 * {@link FLAVOR_IMPORT_REWRITES}.
 */
export type FlavorImportTablePolicy = "keep" | "clear" | "rewrite";

export const FLAVOR_IMPORT_TABLE_POLICY = {
  // Schema bookkeeping, maintenance markers (Trash retirement, event log compaction) and
  // projector cursors: they describe the data, not the process.
  effect_sql_migrations: "keep",
  ryco_compatibility_repairs: "keep",
  lifecycle_markers: "keep",
  projection_state: "keep",
  statistics_partials_state: "keep",
  statistics_thread_partials: "keep",

  // The event log and the chats projected from it.
  orchestration_events: "keep",
  // Command receipts: startup settles unsent task starts with them.
  orchestration_command_receipts: "keep",
  projection_threads: "rewrite",
  projection_thread_messages: "keep",
  projection_message_chunks: "keep",
  projection_thread_activities: "keep",
  projection_thread_proposed_plans: "keep",
  // Startup clears pending requests of sessions that did not survive, through events.
  projection_thread_user_input_requests: "keep",
  projection_pending_approvals: "keep",
  // Startup settles the turns of sessions that claim to run.
  projection_turns: "keep",
  projection_thread_sessions: "rewrite",
  checkpoint_diff_blobs: "keep",
  provider_context_handoffs: "rewrite",
  // Full-text search over the messages, kept in step by triggers.
  projection_message_search: "keep",
  projection_message_search_config: "keep",
  projection_message_search_data: "keep",
  projection_message_search_ids: "keep",
  projection_message_search_idx: "keep",

  // Projects, workspaces, notes.
  projection_projects: "keep",
  projection_worktrees: "keep",
  worktree_notes: "keep",
  notes_documents: "keep",
  // Project memory is retired (migration 059): nothing reads these any more.
  project_memories: "keep",
  project_memory_settings: "keep",
  project_atlassian_links: "rewrite",
  // Worktree folder names per project; Nightly allocates under its own worktrees folder.
  managed_worktree_projects: "keep",

  // Local tasks and their delegation history; startup settles starts a stopped process left.
  local_tasks: "keep",
  local_task_delegations: "keep",

  // Credentials: Nightly pairs on its own, and a Ryco session or link never opens Nightly.
  auth_sessions: "clear",
  auth_pairing_links: "clear",
  // Their tokens stay in Ryco's secrets; Nightly connects on its own.
  atlassian_connections: "clear",
  atlassian_resources: "clear",

  // Provider runtime: two apps must never resume one Claude or Codex session, nor deliver a
  // turn Ryco already owns.
  provider_session_runtime: "clear",
  provider_effect_intents: "clear",
  restart_continuations: "clear",
  restart_shutdown_hints: "clear",
  thread_forks: "clear",
  session_imports: "clear",

  // Agent Control. External integrations hold credential hashes, and installation recovery
  // writes provider configuration into real workspaces.
  agent_control_audit: "keep",
  agent_control_proposals: "rewrite",
  agent_control_operations: "rewrite",
  agent_control_automations: "rewrite",
  agent_control_automation_runs: "rewrite",
  agent_control_automation_quarantine: "keep",
  agent_control_automation_read_state: "keep",
  // Delivers a delegated task's result into its origin chat, which would start a turn.
  agent_control_completion_returns: "clear",
  agent_control_mcp_installations: "clear",
  agent_control_external_integrations: "clear",
  agent_control_external_tasks: "clear",
  agent_control_external_audit: "clear",

  // Wakes chats on forge news or a watched command's output, and sends queued follow-ups: Ryco
  // does all three for its own chats, and a copied command watch would run its command again.
  projection_thread_command_watches: "clear",
  projection_thread_pull_request_watches: "clear",
  projection_thread_queue_entries: "clear",
  projection_thread_queue_holds: "clear",

  // Ownership and journals that move or delete real folders: Nightly never removes, relocates
  // or cleans up what Ryco created.
  storage_owned_entries: "clear",
  storage_cleanup_previews: "clear",
  storage_usage_history: "keep",
  managed_worktree_paths: "clear",
  managed_worktree_relocations: "clear",
  managed_worktree_editor_pins: "clear",
  project_relocations: "clear",
} as const satisfies Readonly<Record<string, FlavorImportTablePolicy>>;

export type FlavorImportTable = keyof typeof FLAVOR_IMPORT_TABLE_POLICY;
type RewrittenTable = {
  [Table in FlavorImportTable]: (typeof FLAVOR_IMPORT_TABLE_POLICY)[Table] extends "rewrite"
    ? Table
    : never;
}[FlavorImportTable];

interface Statement {
  readonly sql: string;
  readonly params: ReadonlyArray<string>;
}

/** Shown on runs Nightly cancelled; Ryco keeps running its own. */
export const FLAVOR_IMPORT_CANCELLED_DETAIL =
  "Copied from Ryco unfinished; Ryco Nightly does not run it.";

/** The statements of each `rewrite` table, given the time of the copy. */
export const FLAVOR_IMPORT_REWRITES: Readonly<
  Record<RewrittenTable, (now: string) => ReadonlyArray<Statement>>
> = {
  // Ryco keeps running its schedules: pause every one, as the unattended-failure pause does.
  agent_control_automations: (now) => [
    {
      sql: `UPDATE agent_control_automations SET
          definition_json = CASE WHEN json_valid(definition_json)
            THEN json_set(definition_json, '$.enabled', json('false')) ELSE definition_json END,
          enabled = 0, next_run_at = NULL, revision = revision + 1, updated_at = ?
        WHERE enabled = 1 OR next_run_at IS NOT NULL`,
      params: [now],
    },
  ],
  agent_control_automation_runs: (now) => [
    {
      sql: `UPDATE agent_control_automation_runs SET
          status = 'cancelled', safe_failure_detail = ?, updated_at = ?,
          completed_at = COALESCE(completed_at, ?)
        WHERE status IN ('materializing', 'pending-approval', 'approved', 'executing')`,
      params: [FLAVOR_IMPORT_CANCELLED_DETAIL, now, now],
    },
  ],
  agent_control_proposals: (now) => [
    {
      sql: `UPDATE agent_control_proposals SET
          status = 'cancelled', updated_at = ?, decided_at = COALESCE(decided_at, ?)
        WHERE status IN ('pending-user-approval', 'approved', 'executing')`,
      params: [now, now],
    },
  ],
  agent_control_operations: (now) => [
    {
      sql: `UPDATE agent_control_operations SET status = 'cancelled', updated_at = ?
        WHERE status IN ('pending', 'running', 'compensating')`,
      params: [now],
    },
  ],
  // No live session: no provider ids to resume and no active turn, so startup releases a session
  // that claims to run (settling its turn) and never captures it for an automatic continuation.
  projection_thread_sessions: () => [
    {
      sql: `UPDATE projection_thread_sessions SET
          provider_session_id = NULL, provider_thread_id = NULL, runtime_session_id = NULL,
          active_turn_id = NULL
        WHERE provider_session_id IS NOT NULL OR provider_thread_id IS NOT NULL
          OR runtime_session_id IS NOT NULL OR active_turn_id IS NOT NULL`,
      params: [],
    },
  ],
  // Startup recovery would prepare or dispatch an unfinished hand-off: a turn Ryco owns.
  provider_context_handoffs: (now) => [
    {
      sql: `UPDATE provider_context_handoffs SET status = 'failed', error = ?, updated_at = ?
        WHERE status IN ('requested', 'preparing', 'dispatching')`,
      params: [FLAVOR_IMPORT_CANCELLED_DETAIL, now],
    },
  ],
  // A goal pursued in Ryco is paused here, and a usage-limited chat waits for the person: neither
  // starts a turn in Nightly on its own while Ryco still works on it.
  projection_threads: () => [
    {
      sql: `UPDATE projection_threads
        SET goal_json = json_set(goal_json, '$.status', 'paused')
        WHERE json_valid(goal_json) AND json_extract(goal_json, '$.status') = 'active'`,
      params: [],
    },
    {
      sql: `UPDATE projection_threads
        SET usage_limit_json = json_set(usage_limit_json, '$.autoResume', json('false'))
        WHERE json_valid(usage_limit_json)`,
      params: [],
    },
  ],
  // The connections were not copied; the project's templates were.
  project_atlassian_links: () => [
    {
      sql: `UPDATE project_atlassian_links SET jira_connection_id = NULL, bitbucket_connection_id = NULL
        WHERE jira_connection_id IS NOT NULL OR bitbucket_connection_id IS NOT NULL`,
      params: [],
    },
  ],
};

export interface FlavorImportScrubReport {
  readonly cleared: ReadonlyArray<string>;
  readonly rewritten: ReadonlyArray<string>;
  /** Tables the map does not know (another branch's), emptied. */
  readonly unknownCleared: ReadonlyArray<string>;
}

export class FlavorImportScrubError extends Data.TaggedError("FlavorImportScrubError")<{
  readonly message: string;
}> {}

const quoteIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

const policyOf = (table: string): FlavorImportTablePolicy | undefined =>
  Object.hasOwn(FLAVOR_IMPORT_TABLE_POLICY, table)
    ? FLAVOR_IMPORT_TABLE_POLICY[table as FlavorImportTable]
    : undefined;

/**
 * Applies the map to the database behind `SqlClient`, a private copy no server has opened, in
 * one transaction. Foreign keys are off while it runs (an installation row and its integration
 * go together) and checked afterwards.
 */
export const scrubFlavorImportCopy = (now: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe("PRAGMA foreign_keys = OFF");
    const report = yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name
        `;
        const cleared: string[] = [];
        const rewritten: string[] = [];
        const unknownCleared: string[] = [];
        for (const { name } of rows) {
          const policy = policyOf(name);
          if (policy === "keep") continue;
          if (policy === "rewrite") {
            for (const statement of FLAVOR_IMPORT_REWRITES[name as RewrittenTable](now)) {
              yield* sql.unsafe(statement.sql, statement.params);
            }
            rewritten.push(name);
            continue;
          }
          yield* sql.unsafe(`DELETE FROM ${quoteIdentifier(name)}`);
          (policy === "clear" ? cleared : unknownCleared).push(name);
        }
        return { cleared, rewritten, unknownCleared } satisfies FlavorImportScrubReport;
      }),
    );
    const violations = yield* sql.unsafe<Record<string, unknown>>("PRAGMA foreign_key_check");
    yield* sql.unsafe("PRAGMA foreign_keys = ON");
    if (violations.length > 0) {
      return yield* new FlavorImportScrubError({
        message: `The copied database has ${violations.length} broken references after the scrub.`,
      });
    }
    return report;
  });
