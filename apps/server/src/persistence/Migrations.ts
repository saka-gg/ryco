import Migration0079, { ensureWorktreeNotesTable } from "./Migrations/079_WorktreeNotes.ts";
import Migration0078, {
  ensureManagedWorktreeNaming,
} from "./Migrations/078_ManagedWorktreeNaming.ts";
import Migration0080, {
  ensureProjectKindAndRelocations,
} from "./Migrations/080_ProjectKindAndRelocations.ts";
import Migration0081, { ensureNotesDocumentsTable } from "./Migrations/081_NotesDocuments.ts";
import Migration0071 from "./Migrations/071_StatisticsUsageHistory.ts";
import Migration0072, {
  ensureProjectionThreadLineageColumns,
} from "./Migrations/072_ProjectionThreadLineage.ts";
import Migration0073, {
  ensureProviderEffectIntentsTable,
} from "./Migrations/073_ProviderEffectIntents.ts";
import Migration0074, {
  ensureRestartContinuationTables,
} from "./Migrations/074_RestartContinuations.ts";
import Migration0070 from "./Migrations/070_LocalTasks.ts";
import Migration0069 from "./Migrations/069_DailyRecapIndexes.ts";
import Migration0068 from "./Migrations/068_ProjectionMessageSearch.ts";
import Migration0066 from "./Migrations/066_StorageLifecycle.ts";
import Migration0067 from "./Migrations/067_SessionImportRecovery.ts";
import Migration0062 from "./Migrations/062_SessionImports.ts";
import Migration0063 from "./Migrations/063_AgentControlCompletionReturns.ts";
import Migration0065 from "./Migrations/065_OptionalUserInput.ts";
import Migration0061 from "./Migrations/061_ProjectionMessageTextFallback.ts";
import Migration0060 from "./Migrations/060_ProjectionMessageChunks.ts";
import Migration0059 from "./Migrations/059_RetireProjectMemory.ts";
import Migration0058 from "./Migrations/058_ProjectMemory.ts";
import Migration0055 from "./Migrations/055_ApprovalResponseClaims.ts";
import Migration0056 from "./Migrations/056_UserInputResponseClaims.ts";
/**
 * Migration runner with inline loader
 *
 * Uses Migrator.make with fromRecord to define migrations inline.
 * All migrations are statically imported - no dynamic file system loading.
 *
 * `runMigrations` applies pending migrations and their idempotent repairs. The SQLite
 * persistence layer runs it while it is built, so the database schema is up to date
 * before the application starts.
 */

import { createHash } from "node:crypto";

import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { trackStartupPhase } from "../startupStallMonitor.ts";
import Migration0057 from "./Migrations/057_AutomationCentre.ts";

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
import Migration0075, {
  ensureProjectionThreadUsageLimitColumn,
} from "./Migrations/075_ProjectionThreadsUsageLimit.ts";
import Migration0076 from "./Migrations/076_AuthSessionRotation.ts";
import Migration0077, {
  ensureThreadWorkspaceLifecycleColumns,
} from "./Migrations/077_ThreadWorkspaceLifecycle.ts";
import Migration0082, {
  ensureWorktreePullRequestLinksColumn,
} from "./Migrations/082_WorktreePullRequestLinks.ts";
import Migration0083, {
  ensureProjectionThreadLineageForkColumns,
} from "./Migrations/083_ProjectionThreadLineageFork.ts";
import Migration0084, { ensureThreadForksTable } from "./Migrations/084_ThreadForks.ts";
import Migration0085, {
  ensureProjectionThreadActivityKindIndex,
} from "./Migrations/085_ProjectionThreadActivityKindIndex.ts";
import Migration0086, {
  ensureProjectionProjectRepositoryIdentityColumns,
} from "./Migrations/086_ProjectionProjectRepositoryIdentity.ts";
import Migration0087, {
  ensureProjectionThreadAnchorsAndStatisticsPartials,
} from "./Migrations/087_ProjectionThreadAnchorsAndStatisticsPartials.ts";
import Migration0088, {
  reprojectLegacyActivityPayloads,
} from "./Migrations/088_LegacyActivityPayloads.ts";
import Migration0089, { ensureLifecycleMarkersTable } from "./Migrations/089_RetireThreadTrash.ts";
import Migration0090 from "./Migrations/090_AuthAccessLinks.ts";
import Migration0091, {
  ensureGuardedLatestCompletedTurnTrigger,
} from "./Migrations/091_GuardedLatestCompletedTurnTrigger.ts";
import Migration0092, {
  ensureLocalTaskDelegationsTable,
} from "./Migrations/092_LocalTaskDelegations.ts";
import Migration0093, {
  dropUnusedOrchestrationIndexes,
} from "./Migrations/093_DropUnusedOrchestrationIndexes.ts";

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
  [55, "ApprovalResponseClaims", Migration0055],
  [56, "UserInputResponseClaims", Migration0056],
  [57, "AutomationCentre", Migration0057],
  [58, "ProjectMemory", Migration0058],
  [59, "RetireProjectMemory", Migration0059],
  [60, "ProjectionMessageChunks", Migration0060],
  [61, "ProjectionMessageTextFallback", Migration0061],
  [62, "SessionImports", Migration0062],
  [63, "AgentControlCompletionReturns", Migration0063],
  [65, "OptionalUserInput", Migration0065],
  [66, "StorageLifecycle", Migration0066],
  [67, "SessionImportRecovery", Migration0067],
  [68, "ProjectionMessageSearch", Migration0068],
  [69, "DailyRecapIndexes", Migration0069],
  [70, "LocalTasks", Migration0070],
  [71, "StatisticsUsageHistory", Migration0071],
  [72, "ProjectionThreadLineage", Migration0072],
  [73, "ProviderEffectIntents", Migration0073],
  [74, "RestartContinuations", Migration0074],
  [75, "ProjectionThreadsUsageLimit", Migration0075],
  [76, "AuthSessionRotation", Migration0076],
  [77, "ThreadWorkspaceLifecycle", Migration0077],
  [78, "ManagedWorktreeNaming", Migration0078],
  [79, "WorktreeNotes", Migration0079],
  [80, "ProjectKindAndRelocations", Migration0080],
  [81, "NotesDocuments", Migration0081],
  [82, "WorktreePullRequestLinks", Migration0082],
  [83, "ProjectionThreadLineageFork", Migration0083],
  [84, "ThreadForks", Migration0084],
  [85, "ProjectionThreadActivityKindIndex", Migration0085],
  [86, "ProjectionProjectRepositoryIdentity", Migration0086],
  [87, "ProjectionThreadAnchorsAndStatisticsPartials", Migration0087],
  [88, "LegacyActivityPayloads", Migration0088],
  [89, "RetireThreadTrash", Migration0089],
  [90, "AuthAccessLinks", Migration0090],
  [91, "GuardedLatestCompletedTurnTrigger", Migration0091],
  [92, "LocalTaskDelegations", Migration0092],
  [93, "DropUnusedOrchestrationIndexes", Migration0093],
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
  /** Where pre-upgrade backups of this database live, named in the schema-too-new error. */
  readonly backupsDir?: string | undefined;
}

/** The highest migration id this binary knows. */
export const SUPPORTED_MIGRATION_ID = Math.max(...migrationEntries.map(([id]) => id));

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

// Not a numbered migration: the Effect migrator skips ids at or below the latest
// applied one, so a late-landing number would be silently skipped on databases
// that already ran newer migrations. The PRAGMA guard makes this run once.
export const repairProjectionWorktreePrTerminalAtColumn = Effect.fn(
  "repairProjectionWorktreePrTerminalAtColumn",
)(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'projection_worktrees'
  `;
  if (tables.length === 0) {
    return;
  }

  yield* sql.withTransaction(
    Effect.gen(function* () {
      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_worktrees)
      `;
      if (columns.some((column) => column.name === "pr_terminal_at")) {
        return;
      }
      yield* sql`ALTER TABLE projection_worktrees ADD COLUMN pr_terminal_at TEXT`;
      // One-time backfill, only in the transaction that adds the column:
      // updated_at is the last time the row was written, an upper bound on when
      // the terminal state was first recorded. The next refresh corrects it to
      // the forge-reported close time where one exists.
      yield* sql`
        UPDATE projection_worktrees
        SET pr_terminal_at = updated_at
        WHERE pr_state IN ('merged', 'closed')
      `;
      yield* Effect.log("Repaired projection_worktrees.pr_terminal_at column");
    }),
  );
});

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
        ADD COLUMN token_mode TEXT NOT NULL DEFAULT 'off'
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
      ADD COLUMN token_mode TEXT NOT NULL DEFAULT 'off'
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

// Not only a numbered migration: the Effect migrator skips ids at or below the latest
// applied one, so a database that recorded a later migration before 075 landed would
// never get the column. The migration is idempotent; run it again as a repair.
export const repairProjectionThreadUsageLimitColumn = Effect.fn(
  "repairProjectionThreadUsageLimitColumn",
)(function* () {
  if (yield* ensureProjectionThreadUsageLimitColumn) {
    yield* Effect.log("Repaired projection_threads.usage_limit_json column");
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

// Branches developed in parallel claim the same next migration id, and the
// migrator keys progress by that id alone: a database that recorded another 076
// would skip bearer rotation's columns. The migration is idempotent; run it as a
// repair after the ledger pass.
export const repairAuthSessionRotationColumns = Effect.fn("repairAuthSessionRotationColumns")(
  function* () {
    yield* Migration0076;
  },
);

// Hub-linked direct access columns: run 090 again as a repair when another branch's
// 090 (or a later id) was recorded first.
export const repairAuthAccessLinkColumns = Effect.fn("repairAuthAccessLinkColumns")(function* () {
  yield* Migration0090;
});

// Project kinds and the chat relocation journal: run 080 again as a repair when another
// branch's 080 (or a later id) was recorded first.
export const repairProjectKindAndRelocations = Effect.fn("repairProjectKindAndRelocations")(
  function* () {
    if (yield* ensureProjectKindAndRelocations) {
      yield* Effect.log("Repaired project kind column and relocation journal");
    }
  },
);

// Trash and retained workspace records: run 077 again as a repair when a later id was
// recorded first (parallel branches claim the same next id).
export const repairThreadWorkspaceLifecycleColumns = Effect.fn(
  "repairThreadWorkspaceLifecycleColumns",
)(function* () {
  if (yield* ensureThreadWorkspaceLifecycleColumns) {
    yield* Effect.log("Repaired thread/workspace lifecycle columns");
  }
});

// Workspace pull request links: run 082 again as a repair when a later id was
// recorded first (parallel branches claim the same next id).
export const repairWorktreePullRequestLinksColumn = Effect.fn(
  "repairWorktreePullRequestLinksColumn",
)(function* () {
  if (yield* ensureWorktreePullRequestLinksColumn) {
    yield* Effect.log("Repaired workspace pull request links column");
  }
});

// Fork lineage provenance: run 083 again as a repair when a later id was recorded first
// (parallel branches claim the same next id).
export const repairProjectionThreadLineageForkColumns = Effect.fn(
  "repairProjectionThreadLineageForkColumns",
)(function* () {
  if (yield* ensureProjectionThreadLineageForkColumns) {
    yield* Effect.log("Repaired projection_threads fork lineage columns");
  }
});

// Activity kind index: run 085 again as a repair when a later id was recorded first
// (parallel branches claim the same next id).
export const repairProjectionThreadActivityKindIndex = Effect.fn(
  "repairProjectionThreadActivityKindIndex",
)(function* () {
  if (yield* ensureProjectionThreadActivityKindIndex) {
    yield* Effect.log("Repaired projection_thread_activities kind index");
  }
});

// Persisted repository identity: run 086 again as a repair when a later id was
// recorded first (parallel branches claim the same next id).
export const repairProjectionProjectRepositoryIdentityColumns = Effect.fn(
  "repairProjectionProjectRepositoryIdentityColumns",
)(function* () {
  if (yield* ensureProjectionProjectRepositoryIdentityColumns) {
    yield* Effect.log("Repaired projection_projects repository identity columns");
  }
});

// Thread anchor summaries and statistics partials: run 087 again as a repair when a later id
// was recorded first (parallel branches claim the same next id).
export const repairProjectionThreadAnchorsAndStatisticsPartials = Effect.fn(
  "repairProjectionThreadAnchorsAndStatisticsPartials",
)(function* () {
  if (yield* ensureProjectionThreadAnchorsAndStatisticsPartials) {
    yield* Effect.log("Repaired projection thread anchor summaries and statistics partials");
  }
});

// Legacy tool activity payloads: run 088 again as a repair when a later id was recorded
// first (parallel branches claim the same next id). Its completion marker keeps this to
// one lookup per boot once it has run.
export const repairLegacyActivityPayloads = Effect.fn("repairLegacyActivityPayloads")(function* () {
  const rewritten = yield* reprojectLegacyActivityPayloads;
  if (rewritten > 0) {
    yield* Effect.log(`Re-projected ${rewritten} legacy tool activity payloads`);
  }
});

// Lifecycle markers: run 089 again as a repair when a later id was recorded first (parallel
// branches claim the same next id).
export const repairLifecycleMarkersTable = Effect.fn("repairLifecycleMarkersTable")(function* () {
  if (yield* ensureLifecycleMarkersTable) {
    yield* Effect.log("Repaired lifecycle markers table");
  }
});

// Guarded latest-completed turn trigger: run 091 again as a repair when a later id was recorded
// first (parallel branches claim the same next id). It must run after the 087 repair, which
// recreates the unguarded trigger when it is missing.
export const repairGuardedLatestCompletedTurnTrigger = Effect.fn(
  "repairGuardedLatestCompletedTurnTrigger",
)(function* () {
  if (yield* ensureGuardedLatestCompletedTurnTrigger) {
    yield* Effect.log("Repaired guarded projection_turns latest-completed trigger");
  }
});

// Local task chat starts: run 092 again as a repair when a later id was recorded first
// (parallel branches claim the same next id). Its backfill commits with the table, so this is
// one lookup per boot once it has run.
export const repairLocalTaskDelegationsTable = Effect.fn("repairLocalTaskDelegationsTable")(
  function* () {
    if (yield* ensureLocalTaskDelegationsTable) {
      yield* Effect.log("Repaired local task delegations table");
    }
  },
);

// Unused orchestration indexes: run 093 again as a repair when a later id was recorded first
// (parallel branches claim the same next id). One catalog lookup per boot once they are gone.
export const repairUnusedOrchestrationIndexes = Effect.fn("repairUnusedOrchestrationIndexes")(
  function* () {
    if (yield* dropUnusedOrchestrationIndexes) {
      yield* Effect.log("Dropped unused orchestration indexes");
    }
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
      const columns = yield* sql<{
        name: string;
      }>`PRAGMA table_info(projection_thread_user_input_requests)`;
      if (columns.some((column) => column.name === "identity_json")) {
        // Migration 056 owns modern callback state. The legacy backfill has a
        // different key and must never overwrite durable response claims.
        yield* sql`CREATE INDEX IF NOT EXISTS idx_projection_thread_user_input_requests_thread_pending
          ON projection_thread_user_input_requests(thread_id, is_pending)`;
        yield* sql`CREATE INDEX IF NOT EXISTS idx_projection_thread_proposed_plans_thread_turn_updated
          ON projection_thread_proposed_plans(thread_id, turn_id, updated_at DESC, plan_id DESC)`;
      } else {
        yield* Migration0044;
      }
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
 * Idempotent repairs that run after every ledger pass, in this order, each once migrations
 * through `since` are applied. Repairs ship the schema changes the numbered ledger cannot
 * deliver reliably (see `repairProjectionWorktreePrTerminalAtColumn`), so a new repair is an
 * upgrade like a new migration: {@link inspectMigrationLedger} reports the ones this database
 * has never completed, a pre-upgrade backup is taken for them too, and a process that does not
 * own the database refuses to run them under a live server (migrationOwnershipPolicy.ts).
 *
 * `key` is recorded in `ryco_compatibility_repairs` once the repair has run, and is part of
 * {@link migrationSchemaDigest}. Never rename one: a renamed key counts as a new repair (one
 * extra backup, and CLIs refuse to migrate next to a server without it until that server is
 * updated). Changing what a repair writes needs a new key: outside the owner's own migration
 * pass, which re-runs every repair, a recorded key is never checked again. A repair that covers
 * several migrations names the last in `through`: a pass bounded below it runs part of the
 * repair and records nothing.
 *
 * Every repair also has a read-only check in compatibilityRepairChecks.ts (keyed by `key`): true
 * exactly when running it would write nothing. Releases before the records ran every repair and
 * recorded none, so on a database without any record those checks decide what is pending.
 */
const compatibilityRepairs = [
  { key: "projection-worktree-title", since: 31, run: () => repairProjectionWorktreeTitleColumn() },
  {
    key: "projection-project-avatar",
    since: 34,
    run: () => repairProjectionProjectAvatarColumns(),
  },
  { key: "projection-token-mode", since: 35, run: () => repairProjectionTokenModeColumns() },
  // 037 introduced pr_state, which the backfill reads.
  {
    key: "projection-worktree-pr-terminal-at",
    since: 37,
    run: () => repairProjectionWorktreePrTerminalAtColumn(),
  },
  {
    key: "projection-thread-subagent-nesting",
    since: 41,
    run: () => repairProjectionThreadSubagentNestingColumns(),
  },
  {
    key: "context-handoff-runtime-sessions",
    since: 42,
    run: () => repairContextHandoffRuntimeSessions(),
  },
  {
    key: "projection-thread-read-model",
    since: 44,
    through: 47,
    run: (toMigrationInclusive: number | undefined) =>
      repairProjectionThreadReadModelMigrations(toMigrationInclusive ?? 47),
  },
  // 072-074 are skipped by the migrator when a later number was recorded first.
  { key: "projection-thread-lineage", since: 72, run: () => ensureProjectionThreadLineageColumns },
  { key: "provider-effect-intents", since: 73, run: () => ensureProviderEffectIntentsTable },
  { key: "restart-continuations", since: 74, run: () => ensureRestartContinuationTables },
  {
    key: "projection-thread-usage-limit",
    since: 75,
    run: () => repairProjectionThreadUsageLimitColumn(),
  },
  { key: "auth-session-rotation", since: 76, run: () => repairAuthSessionRotationColumns() },
  {
    key: "thread-workspace-lifecycle",
    since: 77,
    run: () => repairThreadWorkspaceLifecycleColumns(),
  },
  { key: "managed-worktree-naming", since: 78, run: () => ensureManagedWorktreeNaming },
  // 079 is skipped by the migrator when a later number was recorded first, including development
  // databases that recorded projectless chats' schema as 079 before it moved to 080.
  { key: "worktree-notes", since: 79, run: () => ensureWorktreeNotesTable },
  {
    key: "project-kind-and-relocations",
    since: 80,
    run: () => repairProjectKindAndRelocations(),
  },
  { key: "notes-documents", since: 81, run: () => ensureNotesDocumentsTable },
  {
    key: "worktree-pull-request-links",
    since: 82,
    run: () => repairWorktreePullRequestLinksColumn(),
  },
  {
    key: "projection-thread-lineage-fork",
    since: 83,
    run: () => repairProjectionThreadLineageForkColumns(),
  },
  // 084 is skipped by the migrator when a later number was recorded first.
  { key: "thread-forks", since: 84, run: () => ensureThreadForksTable },
  {
    key: "projection-thread-activity-kind-index",
    since: 85,
    run: () => repairProjectionThreadActivityKindIndex(),
  },
  {
    key: "projection-project-repository-identity",
    since: 86,
    run: () => repairProjectionProjectRepositoryIdentityColumns(),
  },
  {
    key: "projection-thread-anchors-and-statistics",
    since: 87,
    run: () => repairProjectionThreadAnchorsAndStatisticsPartials(),
  },
  { key: "legacy-activity-payloads", since: 88, run: () => repairLegacyActivityPayloads() },
  { key: "lifecycle-markers", since: 89, run: () => repairLifecycleMarkersTable() },
  { key: "auth-access-links", since: 90, run: () => repairAuthAccessLinkColumns() },
  {
    key: "guarded-latest-completed-turn-trigger",
    since: 91,
    run: () => repairGuardedLatestCompletedTurnTrigger(),
  },
  { key: "local-task-delegations", since: 92, run: () => repairLocalTaskDelegationsTable() },
  { key: "unused-orchestration-indexes", since: 93, run: () => repairUnusedOrchestrationIndexes() },
] as const;

export type CompatibilityRepairKey = (typeof compatibilityRepairs)[number]["key"];

/** The repairs a pass through `toMigrationInclusive` (all when undefined) runs, in order. */
const repairsThrough = (toMigrationInclusive: number | undefined) =>
  compatibilityRepairs.filter(
    (repair) => toMigrationInclusive === undefined || toMigrationInclusive >= repair.since,
  );

/** `ryco_compatibility_repairs` key recording that a compatibility repair has run. */
export const compatibilityRepairMarker = (key: string) => `schema-repair:${key}`;

/** What the next {@link runMigrations} would do to this database, read without changing it. */
export interface MigrationLedgerInspection {
  /** The `effect_sql_migrations` ledger table exists. */
  readonly hasLedger: boolean;
  /** Any table besides the ledger and SQLite's own exists. */
  readonly hasUserTables: boolean;
  /** Highest recorded migration id, 0 when none. */
  readonly latestApplied: number;
  /** Highest migration id this binary knows. */
  readonly supported: number;
  /** Migration ids the ledger pass would apply. */
  readonly pending: ReadonlyArray<number>;
  /**
   * Keys of compatibility repairs this binary runs that never completed on this database, except
   * the ones in `repairsRecognised`.
   */
  readonly repairsPending: ReadonlyArray<string>;
  /**
   * Keys of repairs never recorded here whose effect the database already has: not pending, and
   * recorded by the next pass. Only a database without any repair record (last run by a release
   * from before them) with no migration pending is checked; otherwise the records are the rule.
   */
  readonly repairsRecognised: ReadonlyArray<string>;
  /** An empty database: nothing to upgrade or back up. */
  readonly fresh: boolean;
  /** The recorded schema is newer than this binary supports; migrating is refused. */
  readonly tooNew: boolean;
}

/**
 * The repair checks (compatibilityRepairChecks.ts) are needed once per database, so they stay off
 * the boot path. Without them (an install missing the chunk) every unrecorded repair stays pending.
 */
const findAppliedRepairs = (
  keys: ReadonlyArray<CompatibilityRepairKey>,
  records: ReadonlySet<string>,
) =>
  Effect.tryPromise(() => import("./compatibilityRepairChecks.ts")).pipe(
    Effect.matchEffect({
      onFailure: () => Effect.succeed<ReadonlyArray<string>>([]),
      onSuccess: (checks) => checks.findAppliedRepairs(keys, records),
    }),
  );

export const inspectMigrationLedger = Effect.fn("inspectMigrationLedger")(function* ({
  toMigrationInclusive,
}: Pick<RunMigrationsOptions, "toMigrationInclusive"> = {}) {
  const sql = yield* SqlClient.SqlClient;
  const tables = new Set(
    (yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 7) != 'sqlite_'
    `).map((row) => row.name),
  );
  const hasLedger = tables.has("effect_sql_migrations");
  const hasUserTables = [...tables].some((name) => name !== "effect_sql_migrations");
  const latestApplied = hasLedger
    ? ((yield* sql<{
        readonly id: number | null;
      }>`SELECT max(migration_id) AS id FROM effect_sql_migrations`)[0]?.id ?? 0)
    : 0;
  // Repairs' own completion markers too, which the repair checks read.
  const records = new Set(
    tables.has("ryco_compatibility_repairs")
      ? (yield* sql<{ readonly repair_key: string }>`
          SELECT repair_key FROM ryco_compatibility_repairs
        `).map((row) => row.repair_key)
      : [],
  );
  const pending = migrationEntries
    .map(([id]) => id)
    .filter(
      (id) =>
        id > latestApplied && (toMigrationInclusive === undefined || id <= toMigrationInclusive),
    );
  const unrecorded = repairsThrough(toMigrationInclusive)
    .map((repair) => repair.key)
    .filter((key) => !records.has(compatibilityRepairMarker(key)));
  // Releases before the records ran every repair at each start and recorded none. On such a
  // database, a repair whose effect is there would write nothing but its record. A database with
  // any record keeps the records as the rule.
  const recognised: ReadonlyArray<string> =
    pending.length === 0 &&
    hasUserTables &&
    unrecorded.length > 0 &&
    ![...records].some((key) => key.startsWith(compatibilityRepairMarker("")))
      ? yield* findAppliedRepairs(unrecorded, records)
      : [];
  return {
    hasLedger,
    hasUserTables,
    latestApplied,
    supported: SUPPORTED_MIGRATION_ID,
    pending,
    repairsPending: unrecorded.filter((key) => !recognised.includes(key)),
    repairsRecognised: recognised,
    fresh: !hasUserTables && latestApplied === 0,
    tooNew: latestApplied > SUPPORTED_MIGRATION_ID,
  } satisfies MigrationLedgerInspection;
});

/** Records that `keys` have run, in one write, and only when one is new. */
const recordCompatibilityRepairs = Effect.fn("recordCompatibilityRepairs")(function* (
  keys: ReadonlyArray<string>,
) {
  if (keys.length === 0) return;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS ryco_compatibility_repairs (
      repair_key TEXT PRIMARY KEY
    )
  `;
  const markers = keys.map(compatibilityRepairMarker);
  const recorded = new Set(
    (yield* sql<{ readonly repair_key: string }>`
      SELECT repair_key FROM ryco_compatibility_repairs WHERE ${sql.in("repair_key", markers)}
    `).map((row) => row.repair_key),
  );
  const missing = markers.filter((marker) => !recorded.has(marker));
  if (missing.length === 0) return;
  yield* sql`INSERT OR IGNORE INTO ryco_compatibility_repairs ${sql.insert(
    missing.map((repair_key) => ({ repair_key })),
  )}`;
});

/** The refusal for a database whose schema is newer than this binary supports. */
export const describeSchemaTooNew = (input: {
  readonly latest: number;
  readonly supported: number;
  readonly backupsDir?: string | undefined;
}) =>
  `Database schema ${input.latest} is newer than this binary supports (${input.supported}). ` +
  `Use a Ryco build that supports schema ${input.latest}. To keep using this build, restore a ` +
  `backup taken before the upgrade into a separate data directory` +
  (input.backupsDir
    ? `; backups are in ${input.backupsDir}. \`ryco db list\` shows them`
    : `. \`ryco db list\` shows the backups`) +
  // Without them, the command looks in the default data directory, not this server's.
  ` (pass the server's \`--base-dir\` or \`--dev-url\`, if it uses one), and ` +
  `\`ryco db restore <file> --into <new directory>\` restores one without touching this database.`;

/**
 * Whether the next {@link runMigrations} would upgrade this database: a numbered migration is
 * pending, or a compatibility repair this binary runs was never recorded here and is not
 * recognised as applied (`repairsRecognised`). Recording an applied repair is not an upgrade: it
 * needs no backup, and it waits for the next process that migrates anyway. The one answer to "is
 * there an upgrade to do?", for the pre-upgrade backup and for the ownership policy, read
 * from the ledger, the repair records and (on a database without records) the schema, without
 * running anything.
 */
export const isUpgradePending = (
  ledger: Pick<MigrationLedgerInspection, "pending" | "repairsPending">,
): boolean => ledger.pending.length > 0 || ledger.repairsPending.length > 0;

/**
 * Future binaries can fail closed on downgrade. This cannot retrofit a check into already
 * shipped binaries that ignore newer migration records. `backupsDir` is named in the message.
 */
export const failIfSchemaTooNew = (ledger: MigrationLedgerInspection, backupsDir?: string) =>
  ledger.tooNew
    ? Effect.fail(
        new Migrator.MigrationError({
          kind: "BadState",
          message: describeSchemaTooNew({
            latest: ledger.latestApplied,
            supported: ledger.supported,
            backupsDir,
          }),
        }),
      )
    : Effect.void;

/**
 * Identifies schema code by its numbered migrations and the keys of its compatibility repairs,
 * the identities recorded in a database. Two binaries with the same digest upgrade a database
 * the same way, whatever their package versions (development branches share a version but not
 * their migrations).
 */
export const schemaDigestOf = (input: {
  readonly migrations: ReadonlyArray<readonly [number, string, ...Array<unknown>]>;
  readonly repairKeys: ReadonlyArray<string>;
}): string =>
  createHash("sha256")
    .update(
      JSON.stringify([input.migrations.map(([id, name]) => `${id}_${name}`), input.repairKeys]),
    )
    .digest("hex")
    .slice(0, 16);

/** This binary's {@link schemaDigestOf}, recorded in the database owner lock. */
export const migrationSchemaDigest: string = schemaDigestOf({
  migrations: migrationEntries,
  repairKeys: compatibilityRepairs.map((repair) => repair.key),
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
  backupsDir,
}: RunMigrationsOptions = {}) {
  yield* Effect.log(
    toMigrationInclusive === undefined
      ? "Running all migrations..."
      : `Running migrations 1 through ${toMigrationInclusive}...`,
  );
  yield* failIfSchemaTooNew(yield* inspectMigrationLedger({ toMigrationInclusive }), backupsDir);
  // Named separately for the startup stall monitor: the ledger pass and the post-ledger repairs
  // (some backfill whole tables once) are the two places a slow boot stalls in here.
  const executedMigrations = yield* trackStartupPhase(
    "persistence.migrations.ledger",
    run({ loader: makeMigrationLoader(toMigrationInclusive) }),
  );
  yield* trackStartupPhase(
    "persistence.migrations.repairs",
    Effect.gen(function* () {
      const repairs = repairsThrough(toMigrationInclusive);
      for (const repair of repairs) {
        yield* repair.run(toMigrationInclusive);
      }
      yield* recordCompatibilityRepairs(
        repairs
          .filter(
            (repair) =>
              toMigrationInclusive === undefined ||
              !("through" in repair) ||
              toMigrationInclusive >= repair.through,
          )
          .map((repair) => repair.key),
      );
    }),
  );
  yield* Effect.log("Migrations ran successfully").pipe(
    Effect.annotateLogs({
      migrations: executedMigrations.map(([id, name]) => `${id}_${name}`),
    }),
  );
  return executedMigrations;
});
