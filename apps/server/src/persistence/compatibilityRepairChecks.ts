/**
 * compatibilityRepairChecks - Whether a database already has each compatibility repair's effect.
 *
 * A database last run by a release from before repair records has no `schema-repair:*` record in
 * `ryco_compatibility_repairs`, although that release ran every repair at each start. For such a
 * database only (`inspectMigrationLedger`), a repair whose effect is already there is not pending:
 * the next pass would write nothing but its record, so it needs no backup and no ownership.
 *
 * Each check mirrors its repair's own guards over one read of the schema: it is true exactly when
 * running the repair would write nothing. A repair whose effect cannot be read that exactly
 * answers "unknown" and stays pending until a pass records it. A repair's writes never change
 * under its key (Migrations.ts), so neither does its check; a new repair needs one here (the table
 * is keyed by the repair keys).
 *
 * Loaded only for such a database, off the boot path.
 *
 * @module compatibilityRepairChecks
 */
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { CompatibilityRepairKey } from "./Migrations.ts";
import { COLUMNS as REPOSITORY_IDENTITY_COLUMNS } from "./Migrations/086_ProjectionProjectRepositoryIdentity.ts";
import {
  COLUMNS as ANCHOR_COLUMNS,
  REQUIRED_TABLES as ANCHOR_TABLES,
  TRIGGERS as ANCHOR_TRIGGERS,
} from "./Migrations/087_ProjectionThreadAnchorsAndStatisticsPartials.ts";
import { LEGACY_ACTIVITY_PAYLOADS_REPAIR_KEY } from "./Migrations/088_LegacyActivityPayloads.ts";
import { LINK_COLUMNS } from "./Migrations/090_AuthAccessLinks.ts";
import { GUARD, TRIGGER_NAME } from "./Migrations/091_GuardedLatestCompletedTurnTrigger.ts";
import { UNUSED_INDEXES } from "./Migrations/093_DropUnusedOrchestrationIndexes.ts";
import { THREAD_PRIORITY_TABLES } from "./Migrations/DropThreadPriorityTables.ts";

/** A repair's effect is present (true), missing (false), or cannot be read exactly. */
export type RepairApplied = boolean | "unknown";

type SchemaObjectType = "table" | "index" | "trigger";

/** The schema as the checks read it, without writing. */
export interface SchemaCatalog {
  /** A table, index or trigger: its table (`tbl_name`) and, for a trigger, its SQL. */
  readonly object: (
    type: SchemaObjectType,
    name: string,
  ) => { readonly table: string; readonly sql: string | null } | undefined;
  readonly has: (type: SchemaObjectType, name: string) => boolean;
  /** Whether an object of any type is named `name`. */
  readonly named: (name: string) => boolean;
  /** Whether `table` exists and has every one of `columns`. */
  readonly hasColumns: (table: string, columns: ReadonlyArray<string>) => boolean;
  /** Every `ryco_compatibility_repairs` key, repairs' own completion markers included. */
  readonly records: ReadonlySet<string>;
}

/** One `sqlite_master` scan and one `pragma_table_info` join over its ordinary tables. */
export const readSchemaCatalog = Effect.fn("readSchemaCatalog")(function* (
  records: ReadonlySet<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly type: string;
    readonly name: string;
    readonly tbl_name: string;
    readonly sql: string | null;
  }>`SELECT type, name, tbl_name, CASE WHEN type = 'trigger' THEN sql END AS sql FROM sqlite_master`;
  // Virtual tables are skipped: listing their columns would need their module.
  const columnRows = yield* sql<{ readonly table_name: string; readonly column_name: string }>`
    SELECT m.name AS table_name, p.name AS column_name
    FROM sqlite_master AS m JOIN pragma_table_info(m.name) AS p
    WHERE m.type = 'table' AND m.sql NOT LIKE 'CREATE VIRTUAL TABLE%'
  `;
  const objects = new Map(
    rows.map((row) => [`${row.type}:${row.name}`, { table: row.tbl_name, sql: row.sql }]),
  );
  const names = new Set(rows.map((row) => row.name));
  const columns = new Map<string, Set<string>>();
  for (const row of columnRows) {
    const set = columns.get(row.table_name) ?? new Set<string>();
    set.add(row.column_name);
    columns.set(row.table_name, set);
  }
  const object: SchemaCatalog["object"] = (type, name) => objects.get(`${type}:${name}`);
  return {
    object,
    has: (type, name) => object(type, name) !== undefined,
    named: (name) => names.has(name),
    hasColumns: (table, wanted) => {
      const present = columns.get(table);
      return present !== undefined && wanted.every((column) => present.has(column));
    },
    records,
  } satisfies SchemaCatalog;
});

const tables = (c: SchemaCatalog, names: ReadonlyArray<string>) =>
  names.every((name) => c.has("table", name));
const indexes = (c: SchemaCatalog, names: ReadonlyArray<string>) =>
  names.every((name) => c.has("index", name));
/** The repairs that skip a missing table: absent, or it has `columns`. */
const columnsUnlessAbsent = (c: SchemaCatalog, table: string, columns: ReadonlyArray<string>) =>
  !c.has("table", table) || c.hasColumns(table, columns);

/**
 * Per repair key: whether running that repair would write nothing. The repair bodies are in
 * Migrations.ts and the migration each one names.
 */
const checks: Record<CompatibilityRepairKey, (c: SchemaCatalog) => RepairApplied> = {
  "projection-worktree-title": (c) => columnsUnlessAbsent(c, "projection_worktrees", ["title"]),
  "projection-project-avatar": (c) =>
    columnsUnlessAbsent(c, "projection_projects", [
      "custom_avatar_content_hash",
      "preferred_remote_name",
    ]),
  "projection-token-mode": (c) =>
    columnsUnlessAbsent(c, "projection_threads", ["token_mode"]) &&
    columnsUnlessAbsent(c, "projection_thread_sessions", ["token_mode"]),
  // Its backfill runs only in the transaction that adds the column.
  "projection-worktree-pr-terminal-at": (c) =>
    columnsUnlessAbsent(c, "projection_worktrees", ["pr_terminal_at"]),
  "projection-thread-subagent-nesting": (c) =>
    columnsUnlessAbsent(c, "projection_threads", [
      "thread_kind",
      "visibility",
      "parent_thread_id",
      "parent_subagent_id",
    ]),
  // 042 alters both tables without a table guard.
  "context-handoff-runtime-sessions": (c) =>
    c.hasColumns("provider_session_runtime", ["runtime_session_id"]) &&
    c.hasColumns("projection_thread_sessions", ["runtime_session_id"]) &&
    c.has("table", "provider_context_handoffs") &&
    indexes(c, [
      "idx_provider_context_handoffs_thread_status_created",
      "idx_provider_session_runtime_epoch",
      "idx_projection_thread_sessions_epoch",
    ]),
  // The summary repair skips its 044 backfill only with its own completion marker and these three
  // objects (of any type); then 045's indexes, 046's and 047's columns.
  "projection-thread-read-model": (c) =>
    c.records.has("projection-thread-summary-v1") &&
    [
      "projection_thread_user_input_requests",
      "idx_projection_thread_user_input_requests_thread_pending",
      "idx_projection_thread_proposed_plans_thread_turn_updated",
    ].every(c.named) &&
    indexes(c, [
      "idx_projection_thread_proposed_plans_thread_created_id",
      "idx_projection_thread_activities_history_order",
      "idx_projection_turns_thread_checkpoint_order",
    ]) &&
    c.hasColumns("projection_thread_messages", ["dispatch_mode"]) &&
    c.hasColumns("projection_threads", ["goal_json"]),
  "projection-thread-lineage": (c) =>
    !c.has("table", "projection_threads") ||
    (c.hasColumns("projection_threads", [
      "lineage_parent_thread_id",
      "lineage_root_thread_id",
      "lineage_relationship",
    ]) &&
      c.has("index", "projection_threads_lineage_parent")),
  "provider-effect-intents": (c) =>
    c.has("table", "provider_effect_intents") &&
    c.has("index", "provider_effect_intents_thread_kind"),
  "restart-continuations": (c) =>
    tables(c, ["restart_continuations", "restart_shutdown_hints"]) &&
    indexes(c, ["restart_continuations_pending", "restart_continuations_settled"]),
  "projection-thread-usage-limit": (c) =>
    !c.has("table", "projection_threads") ||
    (c.hasColumns("projection_threads", ["usage_limit_json"]) &&
      c.has("index", "idx_projection_threads_usage_limited")),
  "auth-session-rotation": (c) =>
    c.hasColumns("auth_sessions", [
      "rotated_from",
      "chain_id",
      "chain_issued_at",
      "superseded_at",
    ]) && indexes(c, ["idx_auth_sessions_chain", "idx_auth_sessions_rotated_from"]),
  "thread-workspace-lifecycle": (c) =>
    (!c.has("table", "projection_threads") ||
      (c.hasColumns("projection_threads", ["trashed_at"]) &&
        c.has("index", "idx_projection_threads_trashed"))) &&
    columnsUnlessAbsent(c, "projection_worktrees", [
      "checkout_removed_at",
      "checkout_removal_reason",
    ]),
  "managed-worktree-naming": (c) =>
    tables(c, [
      "managed_worktree_projects",
      "managed_worktree_paths",
      "managed_worktree_editor_pins",
      "managed_worktree_relocations",
    ]),
  // It also drops the index the covering one replaced.
  "worktree-notes": (c) =>
    c.has("table", "worktree_notes") &&
    !c.has("index", "worktree_notes_project_created") &&
    c.has("index", "worktree_notes_project_created_id"),
  "project-kind-and-relocations": (c) =>
    columnsUnlessAbsent(c, "projection_projects", ["kind"]) &&
    c.hasColumns("project_relocations", ["title"]) &&
    c.has("index", "idx_project_relocations_state"),
  // The repair creates the table only; folding 079's notes is the numbered migration's.
  "notes-documents": (c) => c.has("table", "notes_documents"),
  "worktree-pull-request-links": (c) =>
    columnsUnlessAbsent(c, "projection_worktrees", ["pull_requests_json"]),
  "projection-thread-lineage-fork": (c) =>
    columnsUnlessAbsent(c, "projection_threads", [
      "lineage_source_message_id",
      "lineage_source_turn_id",
    ]),
  "thread-forks": (c) =>
    c.has("table", "thread_forks") && c.has("index", "thread_forks_unfinished"),
  "projection-thread-activity-kind-index": (c) =>
    !c.has("table", "projection_thread_activities") ||
    (c.has("index", "idx_projection_thread_activities_kind_order") &&
      !c.has("index", "idx_projection_thread_activities_thread_sequence")),
  "projection-project-repository-identity": (c) =>
    columnsUnlessAbsent(c, "projection_projects", REPOSITORY_IDENTITY_COLUMNS),
  // Its backfill runs only with the columns it adds.
  "projection-thread-anchors-and-statistics": (c) =>
    tables(c, ["statistics_thread_partials", "statistics_partials_state"]) &&
    (!tables(c, ANCHOR_TABLES) ||
      (c.hasColumns("projection_threads", ANCHOR_COLUMNS) &&
        ANCHOR_TRIGGERS.every(([name]) => c.has("trigger", name)))),
  // Its completion marker, written with the rewritten rows.
  "legacy-activity-payloads": (c) =>
    !c.has("table", "projection_thread_activities") ||
    c.records.has(LEGACY_ACTIVITY_PAYLOADS_REPAIR_KEY),
  "lifecycle-markers": (c) => c.has("table", "lifecycle_markers"),
  "auth-access-links": (c) =>
    c.hasColumns("auth_pairing_links", LINK_COLUMNS) &&
    c.hasColumns("auth_sessions", LINK_COLUMNS) &&
    indexes(c, ["idx_auth_sessions_link_enrollment", "idx_auth_sessions_link_client"]),
  // Replaces the trigger only while it exists without the guard.
  "guarded-latest-completed-turn-trigger": (c) => {
    const trigger = c.object("trigger", TRIGGER_NAME);
    return trigger === undefined || trigger.sql?.includes(GUARD) === true;
  },
  // The table and its backfill commit together.
  "local-task-delegations": (c) => c.has("table", "local_task_delegations"),
  "unused-orchestration-indexes": (c) =>
    !UNUSED_INDEXES.some((name) =>
      ["orchestration_events", "orchestration_command_receipts"].includes(
        c.object("index", name)?.table ?? "",
      ),
    ),
  "drop-thread-priority-tables": (c) =>
    !THREAD_PRIORITY_TABLES.some((name) => c.has("table", name)),
  // The table and its partial index; no backfill.
  "pull-request-watches": (c) =>
    c.has("table", "projection_thread_pull_request_watches") &&
    c.has("index", "idx_projection_thread_pull_request_watches_active"),
};

/** Of `keys`, the repairs whose effect this database already has, read without writing. */
export const findAppliedRepairs = Effect.fn("findAppliedRepairs")(function* (
  keys: ReadonlyArray<CompatibilityRepairKey>,
  records: ReadonlySet<string>,
) {
  const catalog = yield* readSchemaCatalog(records);
  return keys.filter((key) => checks[key](catalog) === true);
});
