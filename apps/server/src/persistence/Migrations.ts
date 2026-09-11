/**
 * MigrationsLive - Migration runner with inline loader
 *
 * Uses Migrator.make with fromRecord to define migrations inline.
 * All migrations are statically imported - no dynamic file system loading.
 *
 * Migrations run automatically when the MigrationLayer is provided,
 * ensuring the database schema is always up-to-date before the application starts.
 */

import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";

// Import all migrations statically
import Migration0001 from "./Migrations/001_OrchestrationEvents.ts";
import Migration0002 from "./Migrations/002_OrchestrationCommandReceipts.ts";
import Migration0003 from "./Migrations/003_CheckpointDiffBlobs.ts";
import Migration0004 from "./Migrations/004_ProviderSessionRuntime.ts";
import Migration0005 from "./Migrations/005_Projections.ts";
import Migration0006 from "./Migrations/006_ProjectionThreadSessionRuntimeModeColumns.ts";
import Migration0007 from "./Migrations/007_ProjectionThreadMessageAttachments.ts";
import Migration0008 from "./Migrations/008_ProjectionThreadActivitySequence.ts";
import Migration0009 from "./Migrations/009_ProviderSessionRuntimeMode.ts";
import Migration0010 from "./Migrations/010_ProjectionThreadsRuntimeMode.ts";
import Migration0011 from "./Migrations/011_OrchestrationThreadCreatedRuntimeMode.ts";
import Migration0012 from "./Migrations/012_ProjectionThreadsInteractionMode.ts";
import Migration0013 from "./Migrations/013_ProjectionThreadProposedPlans.ts";
import Migration0014 from "./Migrations/014_ProjectionThreadProposedPlanImplementation.ts";
import Migration0015 from "./Migrations/015_ProjectionTurnsSourceProposedPlan.ts";
import Migration0016 from "./Migrations/016_CanonicalizeModelSelections.ts";
import Migration0017 from "./Migrations/017_ProjectionThreadsArchivedAt.ts";
import Migration0018 from "./Migrations/018_ProjectionThreadsArchivedAtIndex.ts";
import Migration0019 from "./Migrations/019_ProjectionSnapshotLookupIndexes.ts";
import Migration0020 from "./Migrations/020_AuthAccessManagement.ts";
import Migration0021 from "./Migrations/021_AuthSessionClientMetadata.ts";
import Migration0022 from "./Migrations/022_AuthSessionLastConnectedAt.ts";
import Migration0023 from "./Migrations/023_ProjectionThreadShellSummary.ts";
import Migration0024 from "./Migrations/024_BackfillProjectionThreadShellSummary.ts";
import Migration0025 from "./Migrations/025_CleanupInvalidProjectionPendingApprovals.ts";
import Migration0026 from "./Migrations/026_CanonicalizeModelSelectionOptions.ts";
import Migration0027 from "./Migrations/027_ProviderSessionRuntimeInstanceId.ts";
import Migration0028 from "./Migrations/028_ProjectionThreadSessionInstanceId.ts";
import Migration0029 from "./Migrations/029_ProjectionThreadDetailOrderingIndexes.ts";
import Migration0030 from "./Migrations/030_Worktrees.ts";
import Migration0031 from "./Migrations/031_WorktreeTitles.ts";
import Migration0032 from "./Migrations/032_ProjectCustomSystemPrompt.ts";
import Migration0033 from "./Migrations/033_ProjectMetadataDir.ts";
import Migration0034 from "./Migrations/034_ProjectAvatarAndPreferredRemote.ts";
import Migration0035 from "./Migrations/035_ProjectionThreadsTokenMode.ts";
import Migration0036 from "./Migrations/036_AtlassianConnections.ts";
import Migration0037 from "./Migrations/037_WorktreeSourceControlState.ts";
import Migration0038 from "./Migrations/038_WorktreeWorkItems.ts";
import Migration0039 from "./Migrations/039_WorktreeWorkItemStateNames.ts";
import Migration0040 from "./Migrations/040_ProjectionThreadsProjectUpdatedAtIndex.ts";
import Migration0041 from "./Migrations/041_ProjectionThreadsSubagentNesting.ts";
import Migration0042 from "./Migrations/042_ContextHandoffRuntimeSessions.ts";
import Migration0043 from "./Migrations/043_ContextHandoffDeliveryArtifact.ts";
import Migration0044 from "./Migrations/044_ProjectionThreadSummaryState.ts";
import Migration0045 from "./Migrations/045_ProjectionThreadHistoryPaginationIndexes.ts";
import Migration0046 from "./Migrations/046_ProjectionThreadMessageDispatchMode.ts";
import Migration0047 from "./Migrations/047_ProjectionThreadsGoal.ts";
import Migration0048 from "./Migrations/048_AgentControl.ts";
import Migration0049 from "./Migrations/049_AgentControlExternalMcp.ts";
import Migration0050 from "./Migrations/050_AgentControlAutomations.ts";
import Migration0051 from "./Migrations/051_AgentControlMcpInstallations.ts";
import Migration0052 from "./Migrations/052_ProjectionThreadsSettled.ts";
import Migration0054 from "./Migrations/054_ProjectionThreadsSnoozed.ts";
import Migration0053 from "./Migrations/053_ThreadPriorityRankings.ts";

/**
 * Migration loader with all migrations defined inline.
 *
 * Key format: "{id}_{name}" where:
 * - id: numeric migration ID (determines execution order)
 * - name: descriptive name for the migration
 *
 * Uses Migrator.fromRecord which parses the key format and
 * returns migrations sorted by ID.
 */
export const migrationEntries = [
  [1, "OrchestrationEvents", Migration0001],
  [2, "OrchestrationCommandReceipts", Migration0002],
  [3, "CheckpointDiffBlobs", Migration0003],
  [4, "ProviderSessionRuntime", Migration0004],
  [5, "Projections", Migration0005],
  [6, "ProjectionThreadSessionRuntimeModeColumns", Migration0006],
  [7, "ProjectionThreadMessageAttachments", Migration0007],
  [8, "ProjectionThreadActivitySequence", Migration0008],
  [9, "ProviderSessionRuntimeMode", Migration0009],
  [10, "ProjectionThreadsRuntimeMode", Migration0010],
  [11, "OrchestrationThreadCreatedRuntimeMode", Migration0011],
  [12, "ProjectionThreadsInteractionMode", Migration0012],
  [13, "ProjectionThreadProposedPlans", Migration0013],
  [14, "ProjectionThreadProposedPlanImplementation", Migration0014],
  [15, "ProjectionTurnsSourceProposedPlan", Migration0015],
  [16, "CanonicalizeModelSelections", Migration0016],
  [17, "ProjectionThreadsArchivedAt", Migration0017],
  [18, "ProjectionThreadsArchivedAtIndex", Migration0018],
  [19, "ProjectionSnapshotLookupIndexes", Migration0019],
  [20, "AuthAccessManagement", Migration0020],
  [21, "AuthSessionClientMetadata", Migration0021],
  [22, "AuthSessionLastConnectedAt", Migration0022],
  [23, "ProjectionThreadShellSummary", Migration0023],
  [24, "BackfillProjectionThreadShellSummary", Migration0024],
  [25, "CleanupInvalidProjectionPendingApprovals", Migration0025],
  [26, "CanonicalizeModelSelectionOptions", Migration0026],
  [27, "ProviderSessionRuntimeInstanceId", Migration0027],
  [28, "ProjectionThreadSessionInstanceId", Migration0028],
  [29, "ProjectionThreadDetailOrderingIndexes", Migration0029],
  [30, "Worktrees", Migration0030],
  [31, "WorktreeTitles", Migration0031],
  [32, "ProjectCustomSystemPrompt", Migration0032],
  [33, "ProjectMetadataDir", Migration0033],
  [34, "ProjectAvatarAndPreferredRemote", Migration0034],
  [35, "ProjectionThreadsTokenMode", Migration0035],
  [36, "AtlassianConnections", Migration0036],
  [37, "WorktreeSourceControlState", Migration0037],
  [38, "WorktreeWorkItems", Migration0038],
  [39, "WorktreeWorkItemStateNames", Migration0039],
  [40, "ProjectionThreadsProjectUpdatedAtIndex", Migration0040],
  [41, "ProjectionThreadsSubagentNesting", Migration0041],
  [42, "ContextHandoffRuntimeSessions", Migration0042],
  [43, "ContextHandoffDeliveryArtifact", Migration0043],
  [44, "ProjectionThreadSummaryState", Migration0044],
  [45, "ProjectionThreadHistoryPaginationIndexes", Migration0045],
  [46, "ProjectionThreadMessageDispatchMode", Migration0046],
  [47, "ProjectionThreadsGoal", Migration0047],
  [48, "AgentControl", Migration0048],
  [49, "AgentControlExternalMcp", Migration0049],
  [50, "AgentControlAutomations", Migration0050],
  [51, "AgentControlMcpInstallations", Migration0051],
  [52, "ProjectionThreadsSettled", Migration0052],
  [53, "ThreadPriorityRankings", Migration0053],
  [54, "ProjectionThreadsSnoozed", Migration0054],
] as const;

export const makeMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      migrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

/**
 * Migrator run function - no schema dumping needed
 * Uses the base Migrator.make without platform dependencies
 */
const run = Migrator.make({});

export interface RunMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

export const repairProjectionWorktreeTitleColumn = Effect.fn("repairProjectionWorktreeTitleColumn")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'projection_worktrees'
  `;
    if (tables.length === 0) {
      return;
    }

    const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_worktrees)
  `;
    if (columns.some((column) => column.name === "title")) {
      return;
    }

    yield* sql`ALTER TABLE projection_worktrees ADD COLUMN title TEXT`;
    yield* Effect.log("Repaired projection_worktrees.title column");
  },
);

export const repairProjectionProjectAvatarColumns = Effect.fn(
  "repairProjectionProjectAvatarColumns",
)(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'projection_projects'
  `;
  if (tables.length === 0) {
    return;
  }

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has("custom_avatar_content_hash")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN custom_avatar_content_hash TEXT`;
    yield* Effect.log("Repaired projection_projects.custom_avatar_content_hash column");
  }

  if (!columnNames.has("preferred_remote_name")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN preferred_remote_name TEXT`;
    yield* Effect.log("Repaired projection_projects.preferred_remote_name column");
  }
});

export const repairProjectionTokenModeColumns = Effect.fn("repairProjectionTokenModeColumns")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const projectionThreadTables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'projection_threads'
  `;
    if (projectionThreadTables.length > 0) {
      const columns = yield* sql<{ readonly name: string }>`
      PRAGMA table_info(projection_threads)
    `;
      if (!columns.some((column) => column.name === "token_mode")) {
        yield* sql`
        ALTER TABLE projection_threads
        ADD COLUMN token_mode TEXT NOT NULL DEFAULT 'balanced'
      `;
        yield* Effect.log("Repaired projection_threads.token_mode column");
      }
    }

    const projectionThreadSessionTables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'projection_thread_sessions'
  `;
    if (projectionThreadSessionTables.length === 0) {
      return;
    }

    const sessionColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_sessions)
  `;
    if (!sessionColumns.some((column) => column.name === "token_mode")) {
      yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN token_mode TEXT NOT NULL DEFAULT 'balanced'
    `;
      yield* Effect.log("Repaired projection_thread_sessions.token_mode column");
    }
  },
);

export const repairProjectionThreadSubagentNestingColumns = Effect.fn(
  "repairProjectionThreadSubagentNestingColumns",
)(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projectionThreadTables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'projection_threads'
  `;
  if (projectionThreadTables.length === 0) {
    return;
  }

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has("thread_kind")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN thread_kind TEXT NOT NULL DEFAULT 'normal'
    `;
    yield* Effect.log("Repaired projection_threads.thread_kind column");
  }

  if (!columnNames.has("visibility")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN visibility TEXT NOT NULL DEFAULT 'normal'
    `;
    yield* Effect.log("Repaired projection_threads.visibility column");
  }

  if (!columnNames.has("parent_thread_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN parent_thread_id TEXT
    `;
    yield* Effect.log("Repaired projection_threads.parent_thread_id column");
  }

  if (!columnNames.has("parent_subagent_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN parent_subagent_id TEXT
    `;
    yield* Effect.log("Repaired projection_threads.parent_subagent_id column");
  }
});

// Development worktrees can share one local database while carrying divergent
// migration 042 names. The Effect migrator keys progress by numeric id, so a
// database that already recorded another 042 would otherwise skip this feature's
// schema entirely. The migration is deliberately idempotent; run it as a repair
// after the ledger-driven pass just like the older compatibility repairs above.
export const repairContextHandoffRuntimeSessions = Effect.fn("repairContextHandoffRuntimeSessions")(
  function* () {
    yield* Migration0042;
  },
);

// Unlike schema checks, the summary backfill scans the entire activity history.
// Track its successful compatibility repair separately from the divergent
// numerical migration ledger, and commit the marker with the repaired data.
export const repairProjectionThreadSummaryState = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS ryco_compatibility_repairs (
      repair_key TEXT PRIMARY KEY
    )
  `;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const completed = yield* sql`
      SELECT repair_key FROM ryco_compatibility_repairs
      WHERE repair_key = 'projection-thread-summary-v1'
    `;
      const objects = yield* sql`
      SELECT name FROM sqlite_master WHERE name IN (
        'projection_thread_user_input_requests',
        'idx_projection_thread_user_input_requests_thread_pending',
        'idx_projection_thread_proposed_plans_thread_turn_updated'
      )
    `;
      if (completed.length > 0 && objects.length === 3) return;
      yield* Migration0044;
      yield* sql`
      INSERT OR IGNORE INTO ryco_compatibility_repairs (repair_key)
      VALUES ('projection-thread-summary-v1')
    `;
    }),
  );
});

// Worktrees can record different migrations 044 through 047. Preserve schema
// recovery without replaying the expensive data backfill on every startup.
export const repairProjectionThreadReadModelMigrations = Effect.fn(
  "repairProjectionThreadReadModelMigrations",
)(function* (toMigrationInclusive: number) {
  if (toMigrationInclusive >= 44) {
    yield* repairProjectionThreadSummaryState;
  }
  if (toMigrationInclusive >= 45) {
    yield* Migration0045;
  }
  if (toMigrationInclusive >= 46) {
    yield* Migration0046;
  }
  if (toMigrationInclusive >= 47) {
    yield* Migration0047;
  }
});

/**
 * Run all pending migrations.
 *
 * Creates the migrations tracking table (effect_sql_migrations) if it doesn't exist,
 * then runs any migrations with ID greater than the latest recorded migration.
 *
 * Returns array of [id, name] tuples for migrations that were run.
 *
 * @returns Effect containing array of executed migrations
 */
export const runMigrations = Effect.fn("runMigrations")(function* ({
  toMigrationInclusive,
}: RunMigrationsOptions = {}) {
  yield* Effect.log(
    toMigrationInclusive === undefined
      ? "Running all migrations..."
      : `Running migrations 1 through ${toMigrationInclusive}...`,
  );
  const executedMigrations = yield* run({
    loader: makeMigrationLoader(toMigrationInclusive),
  });
  if (toMigrationInclusive === undefined || toMigrationInclusive >= 31) {
    yield* repairProjectionWorktreeTitleColumn();
  }
  if (toMigrationInclusive === undefined || toMigrationInclusive >= 34) {
    yield* repairProjectionProjectAvatarColumns();
  }
  if (toMigrationInclusive === undefined || toMigrationInclusive >= 35) {
    yield* repairProjectionTokenModeColumns();
  }
  if (toMigrationInclusive === undefined || toMigrationInclusive >= 41) {
    yield* repairProjectionThreadSubagentNestingColumns();
  }
  if (toMigrationInclusive === undefined || toMigrationInclusive >= 42) {
    yield* repairContextHandoffRuntimeSessions();
  }
  if (toMigrationInclusive === undefined || toMigrationInclusive >= 44) {
    yield* repairProjectionThreadReadModelMigrations(toMigrationInclusive ?? 47);
  }
  yield* Effect.log("Migrations ran successfully").pipe(
    Effect.annotateLogs({
      migrations: executedMigrations.map(([id, name]) => `${id}_${name}`),
    }),
  );
  return executedMigrations;
});

/**
 * Layer that runs migrations when the layer is built.
 *
 * Use this to ensure migrations run before your application starts.
 * Migrations are run automatically - no separate script is needed.
 *
 * @example
 * ```typescript
 * import { MigrationsLive } from "@acme/db/Migrations"
 * import * as SqliteClient from "@acme/db/SqliteClient"
 *
 * // Migrations run automatically when SqliteClient is provided
 * const AppLayer = MigrationsLive.pipe(
 *   Layer.provideMerge(SqliteClient.layer({ filename: "database.sqlite" }))
 * )
 * ```
 */
export const MigrationsLive = Layer.effectDiscard(runMigrations());
