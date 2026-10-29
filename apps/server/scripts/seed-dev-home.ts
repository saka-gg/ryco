/**
 * Seeds a new dev home's database from a pruned copy of another dev database; run with Node
 * (server runtime).
 *
 *   node apps/server/scripts/seed-dev-home.ts --source ~/.ryco/dev/state.sqlite \
 *     --state-dir ~/.ryco/dev-homes/<worktree>-<hash>/dev [--threads-per-project 10] [--json] \
 *     [--allow-userdata-source]
 *
 * scripts/dev-runner.ts runs this on the first start of a linked git worktree's own home, so the
 * worktree's dev server opens with the main dev home's projects and recent conversations instead
 * of an empty first run. The copy is made for this checkout:
 *
 * - The source is opened read-only and copied with `VACUUM INTO`: a consistent snapshot even while
 *   the main dev server writes. The source database file is never written (SQLite may create its
 *   `-wal`/`-shm` beside it, as any reader does).
 * - The copy is migrated to this checkout's schema before it is pruned, so the seeded server's
 *   first boot runs no migrations. A source this checkout cannot migrate safely (a newer schema,
 *   or a migration id recorded under another branch's name, which the migrator would skip) is
 *   skipped, never copied.
 * - Every repository project stays, plus per project the most recently updated settled thread
 *   families. Every table is classified in SEED_TABLE_POLICY; any other table (another branch's)
 *   is emptied. Nothing that lets a server act on its own survives: no auth sessions, provider
 *   runtime bindings or intents, automations, MCP installations, restart continuations, storage
 *   ownership or relocation journals, and no running, pending, usage-limited, archived or trashed
 *   threads.
 * - The result is compacted, switched to WAL, made private (0600) and published with a hard link,
 *   so a database that appeared meanwhile (another runner, a `dev:server` that started first) is
 *   never replaced.
 *
 * Never reads ~/.ryco/userdata. Exit codes: 0 seeded, or skipped because the home already has a
 * database; 3 skipped on purpose (the reason is printed); 1 failure.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

import { Data, Effect, Layer, Logger } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationEntries, runMigrations } from "../src/persistence/Migrations.ts";
import * as NodeSqliteClient from "../src/persistence/NodeSqliteClient.ts";

const DEFAULT_THREADS_PER_PROJECT = 10;
/** Headroom kept free on the disk beyond the seed's own peak use. */
const FREE_SPACE_MARGIN_BYTES = 64 * 1024 * 1024;
/** A temp file older than this belongs to no running seed, whatever its pid says. */
const STALE_TEMP_AGE_MS = 60 * 60 * 1000;
const SEED_TEMP_FILE =
  /^state\.sqlite\.seed-(\d+)-[0-9a-f]+\.(?:tmp|final)(?:-journal|-wal|-shm)?$/;
const SQLITE_SIDECARS = ["", "-journal", "-wal", "-shm"] as const;

/** scripts/dev-runner.ts keeps a copy of this value (it must not import server code). */
export const SEED_SKIPPED_EXIT_CODE = 3;

/** A thread count the prune can interpolate into SQL: a non-negative safe integer. */
export const isValidThreadsPerProject = (value: number) =>
  Number.isSafeInteger(value) && value >= 0;

export type SeedSkipReason =
  | "target-exists"
  | "source-missing"
  | "source-is-production"
  | "source-is-target"
  | "insufficient-space"
  | "schema-newer"
  | "slot-collision"
  | "foreign-key-check";

export type SeedDevHomeResult =
  | {
      readonly _tag: "Seeded";
      readonly databasePath: string;
      readonly sourcePath: string;
      readonly sourceBytes: number;
      /** The migrated, pruned copy before compaction; with sizeBytes, the seed's peak disk use. */
      readonly copyBytes: number;
      readonly sizeBytes: number;
      readonly projects: number;
      readonly threads: number;
      readonly worktrees: number;
      readonly events: number;
      readonly executedMigrations: ReadonlyArray<string>;
      /** Tables this checkout does not know (another branch's), emptied rather than copied. */
      readonly clearedUnknownTables: ReadonlyArray<string>;
      /** Triggers this checkout's migrations do not create, dropped before pruning. */
      readonly droppedTriggers: ReadonlyArray<string>;
      readonly copiedSideFiles: ReadonlyArray<string>;
      readonly timingsMs: {
        readonly copy: number;
        readonly migrate: number;
        readonly prune: number;
        readonly compact: number;
      };
      readonly durationMs: number;
    }
  | { readonly _tag: "Skipped"; readonly reason: SeedSkipReason; readonly detail: string };

export class SeedDevHomeError extends Data.TaggedError("SeedDevHomeError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * How the seed treats each table of this checkout's schema. `keep` copies all rows, `by-*` keeps
 * the rows of kept threads/projects/worktrees/messages, `events` keeps the event streams of kept
 * aggregates, and `clear` empties the table. The `projection_message_search*` tables are derived
 * (migration 068's triggers keep them in step with projection_thread_messages) and never touched.
 * Any table missing here is emptied; seed-dev-home.test.ts fails for a table on main that is.
 */
export type SeedTablePolicy =
  | "keep"
  | "by-thread"
  | "by-project"
  | "by-worktree"
  | "by-message"
  | "events"
  | "clear";

export const SEED_TABLE_POLICY: Readonly<Record<string, SeedTablePolicy>> = {
  // Schema bookkeeping and projector cursors.
  effect_sql_migrations: "keep",
  ryco_compatibility_repairs: "keep",
  lifecycle_markers: "keep",
  projection_state: "keep",
  statistics_partials_state: "keep",

  projection_threads: "by-thread",
  projection_thread_messages: "by-thread",
  projection_thread_activities: "by-thread",
  projection_thread_proposed_plans: "by-thread",
  projection_thread_user_input_requests: "by-thread",
  projection_pending_approvals: "by-thread",
  projection_turns: "by-thread",
  projection_thread_sessions: "by-thread",
  checkpoint_diff_blobs: "by-thread",
  statistics_thread_partials: "by-thread",
  provider_context_handoffs: "by-thread",

  projection_projects: "by-project",
  project_memories: "by-project",
  worktree_notes: "by-project",
  notes_documents: "by-project",

  projection_worktrees: "by-worktree",
  projection_message_chunks: "by-message",
  orchestration_events: "events",

  // Credentials: a seeded home pairs on its own.
  auth_sessions: "clear",
  auth_pairing_links: "clear",
  atlassian_connections: "clear",
  atlassian_resources: "clear",
  project_atlassian_links: "clear",
  // Provider runtime bindings and recoverable work: two servers must never resume one session.
  provider_session_runtime: "clear",
  provider_effect_intents: "clear",
  restart_continuations: "clear",
  restart_shutdown_hints: "clear",
  orchestration_command_receipts: "clear",
  // Agent Control: automations would run, and MCP installation recovery writes provider config
  // into real workspaces.
  agent_control_audit: "clear",
  agent_control_operations: "clear",
  agent_control_proposals: "clear",
  agent_control_external_audit: "clear",
  agent_control_external_integrations: "clear",
  agent_control_external_tasks: "clear",
  agent_control_automations: "clear",
  agent_control_automation_runs: "clear",
  agent_control_mcp_installations: "clear",
  agent_control_automation_quarantine: "clear",
  agent_control_automation_read_state: "clear",
  agent_control_completion_returns: "clear",
  // Pull request watches: the seeded server would read the forge on its own and wake agents in
  // the copied chats.
  projection_thread_pull_request_watches: "clear",
  // Follow-up queues: the seeded server would hold and then send the copied chats' queued
  // messages.
  projection_thread_queue_entries: "clear",
  projection_thread_queue_holds: "clear",
  // Ownership and journals that move or delete real directories.
  storage_owned_entries: "clear",
  storage_usage_history: "clear",
  storage_cleanup_previews: "clear",
  managed_worktree_projects: "clear",
  managed_worktree_paths: "clear",
  managed_worktree_editor_pins: "clear",
  managed_worktree_relocations: "clear",
  project_relocations: "clear",
  thread_forks: "clear",
  session_imports: "clear",
  // Task files are not copied.
  local_tasks: "clear",
  local_task_delegations: "clear",
  // Holds a dispatch owner's pid and runtime.
  project_memory_settings: "clear",
};

/** The FTS5 index of message text and its shadow tables: maintained by triggers. */
export const isDerivedSeedTable = (name: string) => /^projection_message_search(?:_|$)/.test(name);

type CompatibilityResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "schema-newer" | "slot-collision";
      readonly detail: string;
    };

/**
 * Whether this checkout's migrator can bring a database with the `source` ledger to its own
 * schema. Divergence at or below the last id both ledgers agree on is accepted: those are
 * historic branch migrations the server's repairs absorb (and the shared dev database has them).
 * Every id above it must be this checkout's own migration under the same name. A higher id is a
 * newer schema; a different (or missing) one is a slot the migrator would skip silently.
 */
export function checkSeedCompatibility(
  source: ReadonlyArray<{ readonly id: number; readonly name: string }>,
  checkout: ReadonlyArray<readonly [number, string, ...unknown[]]>,
): CompatibilityResult {
  const checkoutNames = new Map<number, string>(checkout.map(([id, name]) => [id, name]));
  const checkoutMax = checkout.reduce((max, [id]) => Math.max(max, id), 0);
  let agreed = 0;
  for (const { id, name } of source) {
    if (checkoutNames.get(id) === name) agreed = Math.max(agreed, id);
  }
  const unmatched = source.filter(({ id }) => id > agreed).toSorted((a, b) => a.id - b.id);
  const newest = unmatched.at(-1);
  if (newest !== undefined && newest.id > checkoutMax) {
    return {
      ok: false,
      reason: "schema-newer",
      detail: `the source database is at schema ${newest.id} (${newest.name}), newer than this checkout (${checkoutMax})`,
    };
  }
  const first = unmatched[0];
  if (first !== undefined) {
    const own = checkoutNames.get(first.id);
    return {
      ok: false,
      reason: "slot-collision",
      detail:
        own === undefined
          ? `the source database recorded migration ${first.id} as ${first.name}; this checkout has no migration ${first.id}`
          : `the source database recorded migration ${first.id} as ${first.name}; this checkout's ${first.id} is ${own}, which the migrator would skip`,
    };
  }
  return { ok: true };
}

const tryFs = <A>(message: string, run: () => A) =>
  Effect.try({ try: run, catch: (cause) => new SeedDevHomeError({ message, cause }) });

const errorCode = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause
    ? String((cause as { readonly code: unknown }).code)
    : undefined;

const fileSize = (file: string) => {
  try {
    return NodeFs.statSync(file).size;
  } catch {
    return 0;
  }
};

const realPathOrResolved = (file: string) => {
  try {
    return NodeFs.realpathSync(file);
  } catch {
    return NodePath.resolve(file);
  }
};

const isInside = (child: string, parent: string) => {
  const relative = NodePath.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};

const isPidAlive = (pid: number) => {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return errorCode(cause) === "EPERM";
  }
};

const removeDatabaseFiles = (file: string) => {
  for (const suffix of SQLITE_SIDECARS) {
    NodeFs.rmSync(`${file}${suffix}`, { force: true });
  }
};

/** Temp files of seeds that died (or are older than any live seed could be). */
const removeStaleTemps = (stateDir: string) => {
  for (const entry of NodeFs.readdirSync(stateDir)) {
    const match = SEED_TEMP_FILE.exec(entry);
    if (!match) continue;
    const file = NodePath.join(stateDir, entry);
    const pid = Number(match[1]);
    let ageMs = 0;
    try {
      ageMs = Date.now() - NodeFs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (!isPidAlive(pid) || ageMs > STALE_TEMP_AGE_MS) {
      NodeFs.rmSync(file, { force: true });
    }
  }
};

const readLedger = (db: DatabaseSync) => {
  const ledger = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'")
    .get();
  if (ledger === undefined) return [];
  return db
    .prepare("SELECT migration_id AS id, name FROM effect_sql_migrations ORDER BY migration_id")
    .all() as Array<{ readonly id: number; readonly name: string }>;
};

const count = (db: DatabaseSync, query: string) =>
  Number((db.prepare(query).get() as { readonly count: number | bigint }).count);

const columnNames = (db: DatabaseSync, table: string) =>
  new Set(
    (db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );

const quoteIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** A connection whose migration logs stay quiet: the seed prints its own summary. */
const sqliteWithoutLogs = (filename: string) =>
  Layer.merge(NodeSqliteClient.layer({ filename }), Logger.layer([]));

/** The tables and triggers this checkout's migrations create, from an empty in-memory database. */
export const loadCheckoutSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  const rows = yield* sql<{ readonly type: string; readonly name: string }>`
    SELECT type, name FROM sqlite_master
    WHERE type IN ('table', 'trigger') AND name NOT LIKE 'sqlite_%'
  `;
  return {
    tables: new Set(rows.filter((row) => row.type === "table").map((row) => row.name)),
    triggers: new Set(rows.filter((row) => row.type === "trigger").map((row) => row.name)),
  };
}).pipe(Effect.provide(sqliteWithoutLogs(":memory:")));

const migrateCopy = (filename: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // A throwaway copy: no rollback journal, no syncs.
    yield* sql`PRAGMA journal_mode = OFF`;
    yield* sql`PRAGMA synchronous = OFF`;
    yield* sql`PRAGMA foreign_keys = ON`;
    const executed = yield* runMigrations();
    return executed.map(([id, name]) => `${id}_${name}`);
  }).pipe(Effect.provide(sqliteWithoutLogs(filename)));

interface PruneSummary {
  readonly clearedUnknownTables: ReadonlyArray<string>;
  readonly droppedTriggers: ReadonlyArray<string>;
  readonly keptProjects: ReadonlyArray<{ readonly id: string; readonly hasAvatar: boolean }>;
  readonly foreignKeyViolations: ReadonlyArray<string>;
}

/** Selects what the seed keeps and deletes the rest, on this checkout's schema. */
const prune = (
  db: DatabaseSync,
  input: { readonly threadsPerProject: number; readonly checkoutTriggers: ReadonlySet<string> },
): PruneSummary => {
  db.exec("PRAGMA foreign_keys = OFF");

  // Another branch's triggers would fire on this checkout's tables during the prune (and later in
  // the seeded server), writing into tables that were just emptied.
  const droppedTriggers: Array<string> = [];
  const triggers = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
    .all() as Array<{ name: string }>;
  for (const { name } of triggers) {
    if (input.checkoutTriggers.has(name)) continue;
    db.exec(`DROP TRIGGER IF EXISTS ${quoteIdentifier(name)}`);
    droppedTriggers.push(name);
  }

  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TEMP TABLE seed_kept_projects AS
        SELECT project_id FROM projection_projects
        WHERE deleted_at IS NULL AND COALESCE(kind, 'project') = 'project';

      -- Each thread's family root: follow subagent and fork parents to a thread without one.
      -- UNION (not UNION ALL) stops cycles; a thread whose chain reaches a missing row or a cycle
      -- has no root, so its family is dropped.
      CREATE TEMP TABLE seed_thread_roots AS
        WITH RECURSIVE walk(thread_id, ancestor_id) AS (
          SELECT thread_id, thread_id FROM projection_threads
          UNION
          SELECT walk.thread_id, COALESCE(parent.parent_thread_id, parent.lineage_parent_thread_id)
          FROM walk JOIN projection_threads parent ON parent.thread_id = walk.ancestor_id
          WHERE COALESCE(parent.parent_thread_id, parent.lineage_parent_thread_id) IS NOT NULL
        )
        SELECT walk.thread_id, walk.ancestor_id AS root_id
        FROM walk JOIN projection_threads root ON root.thread_id = walk.ancestor_id
        WHERE COALESCE(root.parent_thread_id, root.lineage_parent_thread_id) IS NULL;

      -- Settled, visible threads of kept projects that nothing would resume on boot. COALESCE:
      -- MIN() below skips NULLs, so an undecidable member must count as ineligible.
      CREATE TEMP TABLE seed_families AS
        SELECT roots.thread_id, roots.root_id, thread.updated_at,
          COALESCE(thread.deleted_at IS NULL AND thread.trashed_at IS NULL AND thread.archived_at IS NULL
            AND thread.usage_limit_json IS NULL
            AND thread.pending_approval_count = 0 AND thread.pending_user_input_count = 0
            AND thread.project_id IN (SELECT project_id FROM seed_kept_projects)
            AND NOT EXISTS (SELECT 1 FROM projection_thread_sessions session
              WHERE session.thread_id = thread.thread_id
                AND session.status IN ('starting', 'running'))
            AND NOT EXISTS (SELECT 1 FROM projection_turns turn
              WHERE turn.thread_id = thread.thread_id AND turn.state IN ('pending', 'running'))
            AND NOT EXISTS (SELECT 1 FROM provider_context_handoffs handoff
              WHERE handoff.thread_id = thread.thread_id
                AND handoff.status IN ('preparing', 'dispatching')), 0) AS eligible
        FROM seed_thread_roots roots
        JOIN projection_threads thread ON thread.thread_id = roots.thread_id;

      CREATE TEMP TABLE seed_kept_roots AS
        SELECT root_id FROM (
          SELECT families.root_id, ROW_NUMBER() OVER (
            PARTITION BY root.project_id
            ORDER BY MAX(families.updated_at) DESC, families.root_id) AS rank
          FROM seed_families families
          JOIN projection_threads root ON root.thread_id = families.root_id
          GROUP BY families.root_id, root.project_id
          HAVING MIN(families.eligible) = 1)
        WHERE rank <= ${input.threadsPerProject};

      CREATE TEMP TABLE seed_kept_threads AS
        SELECT thread_id FROM seed_families
        WHERE root_id IN (SELECT root_id FROM seed_kept_roots);

      CREATE TEMP TABLE seed_kept_worktrees AS
        SELECT worktree_id FROM projection_worktrees
        WHERE worktree_id IN (SELECT worktree_id FROM projection_threads
            WHERE thread_id IN (SELECT thread_id FROM seed_kept_threads)
              AND worktree_id IS NOT NULL)
          OR (origin = 'main' AND project_id IN (SELECT project_id FROM seed_kept_projects));
    `);

    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    const policyOf = (name: string): SeedTablePolicy | "derived" | "unknown" =>
      isDerivedSeedTable(name) ? "derived" : (SEED_TABLE_POLICY[name] ?? "unknown");
    const tablesWith = (policy: SeedTablePolicy | "unknown") =>
      tables.filter((name) => policyOf(name) === policy);

    // Order matters. Emptied tables go first, so nothing below trips over their rows. Threads go
    // before their rows: the message and turn triggers that update their thread then match
    // nothing. Projects go last.
    const clearedUnknownTables = tablesWith("unknown");
    for (const name of [...tablesWith("clear"), ...clearedUnknownTables]) {
      db.exec(`DELETE FROM ${quoteIdentifier(name)}`);
    }
    db.exec(
      "DELETE FROM projection_threads WHERE thread_id NOT IN (SELECT thread_id FROM seed_kept_threads)",
    );
    for (const name of tablesWith("by-thread")) {
      if (name === "projection_threads") continue;
      db.exec(
        `DELETE FROM ${quoteIdentifier(name)} WHERE thread_id NOT IN (SELECT thread_id FROM seed_kept_threads)`,
      );
    }
    for (const name of tablesWith("by-message")) {
      db.exec(
        `DELETE FROM ${quoteIdentifier(name)} WHERE message_id NOT IN (SELECT message_id FROM projection_thread_messages)`,
      );
    }
    for (const name of tablesWith("events")) {
      db.exec(`
        DELETE FROM ${quoteIdentifier(name)} WHERE NOT (
          (aggregate_kind = 'thread' AND stream_id IN (SELECT thread_id FROM seed_kept_threads))
          OR (aggregate_kind = 'project'
            AND stream_id IN (SELECT project_id FROM seed_kept_projects))
          OR (aggregate_kind = 'worktree'
            AND stream_id IN (SELECT worktree_id FROM seed_kept_worktrees)))
      `);
    }
    for (const name of tablesWith("by-worktree")) {
      db.exec(
        `DELETE FROM ${quoteIdentifier(name)} WHERE worktree_id NOT IN (SELECT worktree_id FROM seed_kept_worktrees)`,
      );
    }
    const byProject = tablesWith("by-project");
    for (const name of [
      ...byProject.filter((name) => name !== "projection_projects"),
      ...byProject.filter((name) => name === "projection_projects"),
    ]) {
      db.exec(
        `DELETE FROM ${quoteIdentifier(name)} WHERE project_id NOT IN (SELECT project_id FROM seed_kept_projects)`,
      );
    }

    // Provider identifiers of kept sessions. Resume state lives in provider_session_runtime
    // (emptied above), and the startup reconciler releases the stale sessions themselves. Only
    // columns this schema has are touched.
    const sessionColumns = columnNames(db, "projection_thread_sessions");
    const identifierColumns = [
      "provider_session_id",
      "provider_thread_id",
      "runtime_session_id",
      "active_turn_id",
    ].filter((column) => sessionColumns.has(column));
    if (identifierColumns.length > 0) {
      db.exec(
        `UPDATE projection_thread_sessions SET ${identifierColumns
          .map((column) => `${column} = NULL`)
          .join(", ")}`,
      );
    }

    const avatarColumn = columnNames(db, "projection_projects").has("custom_avatar_content_hash");
    const keptProjects = (
      db
        .prepare(
          avatarColumn
            ? "SELECT project_id AS id, custom_avatar_content_hash IS NOT NULL AS hasAvatar FROM projection_projects"
            : "SELECT project_id AS id, 0 AS hasAvatar FROM projection_projects",
        )
        .all() as Array<{ id: string; hasAvatar: number }>
    ).map((row) => ({ id: row.id, hasAvatar: Boolean(row.hasAvatar) }));

    db.exec("COMMIT");

    const foreignKeyViolations = [
      ...new Set(
        (db.prepare("PRAGMA foreign_key_check").all() as Array<{ table: string }>).map(
          (row) => row.table,
        ),
      ),
    ];
    db.exec("PRAGMA foreign_keys = ON");
    return { clearedUnknownTables, droppedTriggers, keptProjects, foreignKeyViolations };
  } catch (cause) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw cause;
  }
};

/**
 * Links `final` to `target`, which fails rather than replace a database that exists. Returns
 * false when the target exists. File systems without hard links fall back to a rename after an
 * existence check.
 */
const publish = (final: string, target: string): boolean => {
  if (NodeFs.existsSync(`${target}-wal`)) return false;
  try {
    NodeFs.linkSync(final, target);
  } catch (cause) {
    const code = errorCode(cause);
    if (code === "EEXIST") return false;
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EXDEV" && code !== "ENOSYS") {
      throw cause;
    }
    if (NodeFs.existsSync(target)) return false;
    NodeFs.renameSync(final, target);
    return true;
  }
  NodeFs.rmSync(final, { force: true });
  return true;
};

/**
 * Keybindings and the kept projects' avatars. Nothing else: settings.json holds secret
 * references and Hub, Agent Control and retention settings; secrets, Hub identity files and the
 * environment id belong to the source node; attachments and task files are not copied.
 */
const copySideFiles = (input: {
  readonly sourceStateDir: string;
  readonly stateDir: string;
  readonly avatarProjectIds: ReadonlyArray<string>;
}): ReadonlyArray<string> => {
  const copied: Array<string> = [];
  const copy = (relative: string) => {
    const from = NodePath.join(input.sourceStateDir, relative);
    const to = NodePath.join(input.stateDir, relative);
    // Project ids name the avatar files; one with `..` or a separator must not leave either dir.
    if (!isInside(from, input.sourceStateDir) || !isInside(to, input.stateDir)) return;
    if (!NodeFs.existsSync(from)) return;
    try {
      NodeFs.mkdirSync(NodePath.dirname(to), { recursive: true });
      NodeFs.copyFileSync(from, to, NodeFs.constants.COPYFILE_EXCL);
      copied.push(relative);
    } catch {
      // Best effort: the seeded home works without them.
    }
  };
  copy("keybindings.json");
  for (const projectId of input.avatarProjectIds) {
    copy(NodePath.join("project-avatars", `${projectId}.png`));
  }
  return copied;
};

export interface SeedDevHomeInput {
  /** The dev database to copy, normally ~/.ryco/dev/state.sqlite. */
  readonly sourcePath: string;
  /** The new home's state directory (`<home>/dev`); its state.sqlite must not exist yet. */
  readonly stateDir: string;
  readonly threadsPerProject?: number;
  /** The production home whose `userdata` is never read. Defaults to ~/.ryco. */
  readonly productionHome?: string;
  /** Allow a source in some other directory named `userdata` (a fixture home, for example). */
  readonly allowUserdataSource?: boolean;
  /** Test hook: runs just before the seeded database is published. */
  readonly beforePublish?: Effect.Effect<void>;
}

const skipped = (reason: SeedSkipReason, detail: string): SeedDevHomeResult => ({
  _tag: "Skipped",
  reason,
  detail,
});

export const seedDevHome = Effect.fn("seedDevHome")(function* (
  input: SeedDevHomeInput,
): Effect.fn.Return<SeedDevHomeResult, SeedDevHomeError> {
  const startedAt = performance.now();
  const threadsPerProject = input.threadsPerProject ?? DEFAULT_THREADS_PER_PROJECT;
  if (!isValidThreadsPerProject(threadsPerProject)) {
    return yield* Effect.fail(
      new SeedDevHomeError({
        message: `threadsPerProject must be a non-negative integer, got ${threadsPerProject}`,
      }),
    );
  }
  const sourcePath = NodePath.resolve(input.sourcePath);
  if (!NodeFs.existsSync(sourcePath)) {
    return skipped("source-missing", `no database at ${sourcePath}`);
  }
  const realSource = realPathOrResolved(sourcePath);
  const productionUserdata = realPathOrResolved(
    NodePath.join(input.productionHome ?? NodePath.join(NodeOS.homedir(), ".ryco"), "userdata"),
  );
  if (isInside(realSource, productionUserdata)) {
    return skipped(
      "source-is-production",
      `seeding never reads your real Ryco data (${productionUserdata}). Point RYCO_DEV_SEED_SOURCE at a dev database.`,
    );
  }
  if (
    NodePath.basename(NodePath.dirname(realSource)) === "userdata" &&
    !input.allowUserdataSource
  ) {
    return skipped(
      "source-is-production",
      `${realSource} is in a production state directory (userdata). Pass --allow-userdata-source if it is a copy you may read.`,
    );
  }

  yield* tryFs(`Failed to create ${input.stateDir}`, () =>
    NodeFs.mkdirSync(input.stateDir, { recursive: true }),
  );
  const stateDir = realPathOrResolved(input.stateDir);
  const target = NodePath.join(stateDir, "state.sqlite");
  if (realSource === realPathOrResolved(target)) {
    return skipped("source-is-target", `${realSource} is the database being seeded`);
  }
  if (NodeFs.existsSync(target) || NodeFs.existsSync(`${target}-wal`)) {
    return skipped("target-exists", `${target} already exists`);
  }

  yield* tryFs("Failed to remove stale seed files", () => removeStaleTemps(stateDir));
  const sourceBytes = fileSize(realSource);
  // The copy (at most the source plus its WAL) and the compacted result (at most the copy) exist
  // together for a moment. The copy keeps no rollback journal.
  const neededBytes = 2 * (sourceBytes + fileSize(`${realSource}-wal`)) + FREE_SPACE_MARGIN_BYTES;
  const free = yield* tryFs(`Failed to read free space in ${stateDir}`, () => {
    const stats = NodeFs.statfsSync(stateDir);
    return stats.bavail * stats.bsize;
  });
  if (free < neededBytes) {
    return skipped(
      "insufficient-space",
      `seeding needs ${formatBytes(neededBytes)} free in ${stateDir}; ${formatBytes(free)} is free`,
    );
  }

  const tempBase = NodePath.join(
    stateDir,
    `state.sqlite.seed-${process.pid}-${NodeCrypto.randomBytes(4).toString("hex")}`,
  );
  const temp = `${tempBase}.tmp`;
  const final = `${tempBase}.final`;

  return yield* Effect.gen(function* () {
    // 1. Snapshot the source.
    let phaseStartedAt = performance.now();
    const preflight = yield* tryFs(`Failed to copy ${realSource}`, () => {
      const source = new DatabaseSync(realSource, { readOnly: true });
      try {
        source.exec("PRAGMA busy_timeout = 5000");
        // Fails fast, before writing a copy. The copy's own ledger is checked again below.
        const compatibility = checkSeedCompatibility(readLedger(source), migrationEntries);
        if (compatibility.ok) source.prepare("VACUUM INTO ?").run(temp);
        return compatibility;
      } finally {
        source.close();
      }
    });
    if (!preflight.ok) return skipped(preflight.reason, preflight.detail);
    // The source may have moved on between the two reads.
    const copied = yield* tryFs(`Failed to read the copy of ${realSource}`, () => {
      const copy = new DatabaseSync(temp, { readOnly: true });
      try {
        return checkSeedCompatibility(readLedger(copy), migrationEntries);
      } finally {
        copy.close();
      }
    });
    if (!copied.ok) return skipped(copied.reason, copied.detail);
    const copyMs = performance.now() - phaseStartedAt;

    // 2. Bring the copy to this checkout's schema, so pruning sees the schema the server will.
    phaseStartedAt = performance.now();
    const executedMigrations = yield* migrateCopy(temp).pipe(
      Effect.mapError(
        (cause) =>
          new SeedDevHomeError({ message: `Failed to migrate the copy: ${cause.message}`, cause }),
      ),
    );
    const checkoutSchema = yield* loadCheckoutSchema.pipe(
      Effect.mapError(
        (cause) =>
          new SeedDevHomeError({ message: "Failed to read this checkout's schema", cause }),
      ),
    );
    const migrateMs = performance.now() - phaseStartedAt;

    // 3. Prune, then compact into a fresh file.
    phaseStartedAt = performance.now();
    const pruned = yield* tryFs("Failed to prune the copy", () => {
      const db = new DatabaseSync(temp);
      try {
        // The server's own page cache size: the prune rewrites most pages of the big tables, and
        // the 2 MiB default spills them mid-transaction (prune 1.6-2.5 s vs 1.2-1.4 s on a 277 MB
        // fixture, for about 35 MB more memory).
        db.exec("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA cache_size = -32768;");
        return prune(db, { threadsPerProject, checkoutTriggers: checkoutSchema.triggers });
      } finally {
        db.close();
      }
    });
    if (pruned.foreignKeyViolations.length > 0) {
      return skipped(
        "foreign-key-check",
        `the pruned copy breaks foreign keys in ${pruned.foreignKeyViolations.join(", ")}`,
      );
    }
    const pruneMs = performance.now() - phaseStartedAt;

    const copyBytes = fileSize(temp);
    phaseStartedAt = performance.now();
    const counts = yield* tryFs("Failed to compact the copy", () => {
      const db = new DatabaseSync(temp);
      try {
        db.prepare("VACUUM INTO ?").run(final);
      } finally {
        db.close();
      }
      removeDatabaseFiles(temp);
      const result = new DatabaseSync(final);
      try {
        result.exec("PRAGMA journal_mode = WAL");
        return {
          projects: count(result, "SELECT COUNT(*) AS count FROM projection_projects"),
          threads: count(result, "SELECT COUNT(*) AS count FROM projection_threads"),
          worktrees: count(result, "SELECT COUNT(*) AS count FROM projection_worktrees"),
          events: count(result, "SELECT COUNT(*) AS count FROM orchestration_events"),
        };
      } finally {
        result.close();
      }
    });
    yield* tryFs("Failed to restrict the seeded database", () => NodeFs.chmodSync(final, 0o600));
    const compactMs = performance.now() - phaseStartedAt;

    // 4. Publish, never replacing a database that appeared meanwhile.
    if (input.beforePublish !== undefined) yield* input.beforePublish;
    const published = yield* tryFs(`Failed to publish ${target}`, () => publish(final, target));
    if (!published) {
      return skipped("target-exists", `${target} appeared while seeding; it was left as it is`);
    }

    const copiedSideFiles = copySideFiles({
      sourceStateDir: NodePath.dirname(realSource),
      stateDir,
      avatarProjectIds: pruned.keptProjects
        .filter((project) => project.hasAvatar)
        .map((project) => project.id),
    });

    return {
      _tag: "Seeded",
      databasePath: target,
      sourcePath: realSource,
      sourceBytes,
      copyBytes,
      sizeBytes: fileSize(target),
      ...counts,
      executedMigrations,
      clearedUnknownTables: pruned.clearedUnknownTables,
      droppedTriggers: pruned.droppedTriggers,
      copiedSideFiles,
      timingsMs: {
        copy: Math.round(copyMs),
        migrate: Math.round(migrateMs),
        prune: Math.round(pruneMs),
        compact: Math.round(compactMs),
      },
      durationMs: Math.round(performance.now() - startedAt),
    } satisfies SeedDevHomeResult;
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        removeDatabaseFiles(temp);
        removeDatabaseFiles(final);
      }),
    ),
  );
});

function formatBytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function formatSeedResult(result: SeedDevHomeResult): string {
  if (result._tag === "Skipped") {
    return `[seed-dev-home] skipped (${result.reason}): ${result.detail}`;
  }
  const number = new Intl.NumberFormat("en-US");
  const parts = [
    `[seed-dev-home] seeded ${result.databasePath} from ${result.sourcePath} in ${(result.durationMs / 1000).toFixed(1)} s:`,
    `${number.format(result.projects)} projects, ${number.format(result.threads)} threads, ${number.format(result.events)} events`,
    `(${formatBytes(result.sourceBytes)} -> ${formatBytes(result.sizeBytes)}).`,
    result.executedMigrations.length > 0
      ? `Migrations applied: ${result.executedMigrations.join(", ")}.`
      : "No migrations needed.",
  ];
  if (result.clearedUnknownTables.length > 0) {
    parts.push(
      `Emptied tables this checkout does not know: ${result.clearedUnknownTables.join(", ")}.`,
    );
  }
  return parts.join(" ");
}

// import.meta.filename is the entry's real path, so compare real paths: run through a symlink
// (macOS `/tmp`), a resolved-path check would skip the CLI and exit 0 as if it had seeded.
const isMain =
  process.argv[1] !== undefined && realPathOrResolved(process.argv[1]) === import.meta.filename;
if (isMain) {
  const { values } = parseArgs({
    options: {
      source: { type: "string" },
      "state-dir": { type: "string" },
      "threads-per-project": { type: "string", default: String(DEFAULT_THREADS_PER_PROJECT) },
      json: { type: "boolean", default: false },
      "allow-userdata-source": { type: "boolean", default: false },
    },
  });
  const threadsPerProject = Number(values["threads-per-project"]);
  if (!values.source || !values["state-dir"] || !isValidThreadsPerProject(threadsPerProject)) {
    console.error(
      "Usage: node apps/server/scripts/seed-dev-home.ts --source <db> --state-dir <dir> [--threads-per-project <non-negative integer, default 10>] [--json] [--allow-userdata-source]",
    );
    process.exit(2);
  }
  const exit = await Effect.runPromiseExit(
    seedDevHome({
      sourcePath: values.source,
      stateDir: values["state-dir"],
      threadsPerProject,
      allowUserdataSource: values["allow-userdata-source"],
    }),
  );
  if (exit._tag === "Failure") {
    console.error(`[seed-dev-home] failed: ${String(exit.cause)}`);
    process.exit(1);
  }
  const result = exit.value;
  console.log(values.json ? JSON.stringify(result, null, 2) : formatSeedResult(result));
  process.exit(
    result._tag === "Seeded" || result.reason === "target-exists" ? 0 : SEED_SKIPPED_EXIT_CODE,
  );
}
