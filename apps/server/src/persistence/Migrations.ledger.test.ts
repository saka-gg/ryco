import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  compatibilityRepairMarker,
  describeSchemaTooNew,
  inspectMigrationLedger,
  isUpgradePending,
  migrationEntries,
  migrationSchemaDigest,
  runMigrations,
  schemaDigestOf,
  SUPPORTED_MIGRATION_ID,
} from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

it.effect("inspects what the next migration pass would do without changing anything", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fresh = yield* inspectMigrationLedger();
    assert.isTrue(fresh.fresh);
    assert.isFalse(fresh.hasLedger);
    assert.isFalse(fresh.hasUserTables);
    assert.equal(fresh.latestApplied, 0);
    assert.equal(fresh.supported, SUPPORTED_MIGRATION_ID);
    assert.equal(fresh.pending.length, migrationEntries.length);
    assert.equal(fresh.pending.at(-1), SUPPORTED_MIGRATION_ID);
    assert.isAbove(fresh.repairsPending.length, 0);
    assert.isTrue(isUpgradePending(fresh));
    assert.deepEqual(yield* sql`SELECT name FROM sqlite_master`, []);
    const throughPrevious = (yield* inspectMigrationLedger({
      toMigrationInclusive: SUPPORTED_MIGRATION_ID - 1,
    })).repairsPending;
    // Derived, so that a new migration or repair does not break this test; may be empty.
    const arrivingWithLatest = fresh.repairsPending.filter((key) => !throughPrevious.includes(key));

    yield* runMigrations({ toMigrationInclusive: SUPPORTED_MIGRATION_ID - 1 });
    const behind = yield* inspectMigrationLedger();
    assert.isFalse(behind.fresh);
    assert.isTrue(behind.hasLedger);
    assert.isTrue(behind.hasUserTables);
    assert.equal(behind.latestApplied, SUPPORTED_MIGRATION_ID - 1);
    assert.deepEqual(behind.pending, [SUPPORTED_MIGRATION_ID]);
    // Only the repairs that arrive with the pending migration have never run.
    assert.deepEqual(behind.repairsPending, arrivingWithLatest);
    assert.isTrue(isUpgradePending(behind));
    // Bounded to what it already has, nothing is pending.
    const bounded = yield* inspectMigrationLedger({
      toMigrationInclusive: SUPPORTED_MIGRATION_ID - 1,
    });
    assert.deepEqual(bounded.pending, []);
    assert.deepEqual(bounded.repairsPending, []);
    assert.isFalse(isUpgradePending(bounded));

    yield* runMigrations();
    const current = yield* inspectMigrationLedger();
    assert.deepEqual(current.pending, []);
    assert.deepEqual(current.repairsPending, []);
    assert.isFalse(current.tooNew);
    assert.isFalse(isUpgradePending(current));
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("records each compatibility repair once, and a repeat pass writes nothing", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    const markers = yield* sql<{ readonly repair_key: string }>`
      SELECT repair_key FROM ryco_compatibility_repairs
      WHERE repair_key LIKE ${compatibilityRepairMarker("%")} ORDER BY repair_key
    `;
    assert.isAbove(markers.length, 20);
    const [before] = yield* sql<{ readonly changes: number }>`SELECT total_changes() AS changes`;
    const schemaBefore = yield* sql`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`;
    yield* runMigrations();
    const [after] = yield* sql<{ readonly changes: number }>`SELECT total_changes() AS changes`;
    assert.equal(after?.changes, before?.changes);
    // Every repair finds its work done: a process that skips the pass misses nothing.
    assert.deepEqual(
      yield* sql`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`,
      schemaBefore,
    );

    // A repair the database has not seen (a newer binary's) is pending until it runs.
    yield* sql`DELETE FROM ryco_compatibility_repairs WHERE repair_key = ${compatibilityRepairMarker("thread-forks")}`;
    assert.deepEqual((yield* inspectMigrationLedger()).repairsPending, ["thread-forks"]);
    yield* runMigrations();
    assert.deepEqual((yield* inspectMigrationLedger()).repairsPending, []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

/** As a release from before repair records left a database: every repair ran, none is recorded. */
const forgetRepairRecords = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM ryco_compatibility_repairs WHERE repair_key LIKE ${compatibilityRepairMarker("%")}`;
});

it.effect("recognises the repairs a release from before repair records applied", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const keys = (yield* inspectMigrationLedger()).repairsPending;
    yield* runMigrations();
    yield* forgetRepairRecords;

    const inspected = yield* inspectMigrationLedger();
    assert.deepEqual(inspected.pending, []);
    assert.deepEqual(inspected.repairsPending, []);
    assert.deepEqual(inspected.repairsRecognised, keys);
    assert.isFalse(isUpgradePending(inspected));

    // The next pass writes their records and nothing else.
    const schemaBefore = yield* sql`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`;
    const [before] = yield* sql<{ readonly changes: number }>`SELECT total_changes() AS changes`;
    yield* runMigrations();
    const [after] = yield* sql<{ readonly changes: number }>`SELECT total_changes() AS changes`;
    assert.equal((after?.changes ?? 0) - (before?.changes ?? 0), keys.length);
    assert.deepEqual(
      yield* sql`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`,
      schemaBefore,
    );
    const recorded = yield* inspectMigrationLedger();
    assert.deepEqual(recorded.repairsPending, []);
    assert.deepEqual(recorded.repairsRecognised, []);

    // A database with any record keeps the records as the rule.
    yield* forgetRepairRecords;
    yield* sql`INSERT INTO ryco_compatibility_repairs (repair_key) VALUES (${compatibilityRepairMarker("thread-forks")})`;
    const partlyRecorded = yield* inspectMigrationLedger();
    assert.deepEqual(
      partlyRecorded.repairsPending,
      keys.filter((key) => key !== "thread-forks"),
    );
    assert.deepEqual(partlyRecorded.repairsRecognised, []);

    // So does a database with a migration pending.
    yield* forgetRepairRecords;
    yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = ${SUPPORTED_MIGRATION_ID}`;
    const behind = yield* inspectMigrationLedger();
    assert.deepEqual(behind.pending, [SUPPORTED_MIGRATION_ID]);
    assert.deepEqual(behind.repairsPending, keys);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

/**
 * One effect of each repair, undone: what a database from before repair records would lack if that
 * repair had never run there. 091's undo puts back an unguarded trigger: a missing trigger is 087's.
 */
const undoRepairEffect: Record<string, string | ReadonlyArray<string>> = {
  "projection-worktree-title": "ALTER TABLE projection_worktrees DROP COLUMN title",
  "projection-project-avatar": "ALTER TABLE projection_projects DROP COLUMN preferred_remote_name",
  "projection-token-mode": "ALTER TABLE projection_thread_sessions DROP COLUMN token_mode",
  "projection-worktree-pr-terminal-at":
    "ALTER TABLE projection_worktrees DROP COLUMN pr_terminal_at",
  "projection-thread-subagent-nesting":
    "ALTER TABLE projection_threads DROP COLUMN parent_subagent_id",
  "context-handoff-runtime-sessions": "DROP INDEX idx_projection_thread_sessions_epoch",
  "projection-thread-read-model": "DROP INDEX idx_projection_turns_thread_checkpoint_order",
  "projection-thread-lineage": "DROP INDEX projection_threads_lineage_parent",
  "provider-effect-intents": "DROP INDEX provider_effect_intents_thread_kind",
  "restart-continuations": "DROP TABLE restart_shutdown_hints",
  "projection-thread-usage-limit": "DROP INDEX idx_projection_threads_usage_limited",
  "auth-session-rotation": "DROP INDEX idx_auth_sessions_rotated_from",
  "thread-workspace-lifecycle":
    "ALTER TABLE projection_worktrees DROP COLUMN checkout_removal_reason",
  "managed-worktree-naming": "DROP TABLE managed_worktree_editor_pins",
  "worktree-notes": "CREATE INDEX worktree_notes_project_created ON worktree_notes(project_id)",
  "project-kind-and-relocations": "DROP INDEX idx_project_relocations_state",
  "notes-documents": "DROP TABLE notes_documents",
  "worktree-pull-request-links": "ALTER TABLE projection_worktrees DROP COLUMN pull_requests_json",
  "projection-thread-lineage-fork":
    "ALTER TABLE projection_threads DROP COLUMN lineage_source_turn_id",
  "thread-forks": "DROP INDEX thread_forks_unfinished",
  "projection-thread-activity-kind-index":
    "CREATE INDEX idx_projection_thread_activities_thread_sequence ON projection_thread_activities(thread_id, sequence)",
  "projection-project-repository-identity":
    "ALTER TABLE projection_projects DROP COLUMN repository_identity_checked_at",
  "projection-thread-anchors-and-statistics":
    "DROP TRIGGER projection_thread_messages_user_anchor_delete",
  "legacy-activity-payloads":
    "DELETE FROM ryco_compatibility_repairs WHERE repair_key = 'legacy-activity-payloads-v1'",
  "lifecycle-markers": "DROP TABLE lifecycle_markers",
  "auth-access-links": "DROP INDEX idx_auth_sessions_link_client",
  "guarded-latest-completed-turn-trigger": [
    "DROP TRIGGER projection_turns_latest_completed_update",
    `CREATE TRIGGER projection_turns_latest_completed_update AFTER UPDATE OF state ON projection_turns
     BEGIN SELECT 1; END`,
  ],
  "local-task-delegations": "DROP TABLE local_task_delegations",
  "unused-orchestration-indexes":
    "CREATE INDEX idx_orch_events_command_id ON orchestration_events(command_id)",
  "drop-thread-priority-tables": "CREATE TABLE thread_priority_batches (slot INTEGER)",
  "pull-request-watches": "DROP INDEX idx_projection_thread_pull_request_watches_active",
  "follow-up-queue": "DROP INDEX idx_projection_thread_queue_entries_position",
  "auth-access-link-account": "ALTER TABLE auth_sessions DROP COLUMN link_account_id",
  "command-watches": "DROP INDEX idx_projection_thread_command_watches_active",
  "thread-fork-origin": "ALTER TABLE thread_forks DROP COLUMN origin_json",
};

it.effect("finds exactly the repair whose effect a database from before the records lacks", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const keys = (yield* inspectMigrationLedger()).repairsPending;
    assert.sameMembers(Object.keys(undoRepairEffect), [...keys]);
    yield* runMigrations();
    for (const key of keys) {
      yield* forgetRepairRecords;
      for (const statement of [undoRepairEffect[key]!].flat()) yield* sql.unsafe(statement);
      assert.deepEqual((yield* inspectMigrationLedger()).repairsPending, [key], key);
      // The repair puts it back, and then the database has every effect again.
      yield* runMigrations();
      yield* forgetRepairRecords;
      assert.deepEqual((yield* inspectMigrationLedger()).repairsPending, [], key);
    }
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("records no repair that a bounded pass ran only part of", () =>
  Effect.gen(function* () {
    // The read-model repair covers 044-047; a pass through 45 runs only its first half.
    yield* runMigrations({ toMigrationInclusive: 45 });
    const partial = (yield* inspectMigrationLedger()).repairsPending;
    assert.include(partial, "projection-thread-read-model");
    assert.notInclude(partial, "context-handoff-runtime-sessions");
    yield* runMigrations();
    assert.deepEqual((yield* inspectMigrationLedger()).repairsPending, []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("names the backups directory when it refuses a newer schema", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    const future = SUPPORTED_MIGRATION_ID + 2;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, created_at, name) VALUES (${future}, 'now', 'FutureSchema')`;
    assert.isTrue((yield* inspectMigrationLedger()).tooNew);
    const result = yield* runMigrations({ backupsDir: "/home/me/.ryco/userdata/backups" }).pipe(
      Effect.result,
    );
    assert.equal(result._tag, "Failure");
    if (result._tag !== "Failure") return;
    const message = String(result.failure);
    assert.match(message, /newer than this binary supports/);
    assert.include(message, `Use a Ryco build that supports schema ${future}`);
    assert.include(message, "backups are in /home/me/.ryco/userdata/backups");
    assert.include(message, "separate data directory");
    // The commands that list and restore them.
    assert.include(message, "`ryco db list` shows them");
    // A dev or custom-directory server's backups are not in the default data directory.
    assert.include(message, "pass the server's `--base-dir` or `--dev-url`, if it uses one");
    assert.include(message, "`ryco db restore <file> --into <new directory>`");
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it("names the restore commands without a backups directory too", () => {
  const message = describeSchemaTooNew({ latest: 95, supported: 93 });
  assert.include(message, "separate data directory. `ryco db list` shows the backups");
  assert.include(message, "`ryco db restore <file> --into <new directory>` restores one");
});

it("digests the migrations and repair keys, so a new repair changes it", () => {
  const repairKeys = ["projection-worktree-title", "thread-forks"];
  const digest = schemaDigestOf({ migrations: migrationEntries, repairKeys });
  assert.match(digest, /^[0-9a-f]{16}$/);
  // Two binaries with the same migrations and repairs agree.
  assert.equal(
    schemaDigestOf({ migrations: migrationEntries, repairKeys: [...repairKeys] }),
    digest,
  );
  // A binary with one more repair (or one more migration) runs other schema code.
  assert.notEqual(
    schemaDigestOf({ migrations: migrationEntries, repairKeys: [...repairKeys, "new-repair"] }),
    digest,
  );
  assert.notEqual(
    schemaDigestOf({
      migrations: [...migrationEntries, [SUPPORTED_MIGRATION_ID + 1, "Next"]],
      repairKeys,
    }),
    digest,
  );
});

it.effect("digests this binary's own repair keys", () =>
  Effect.gen(function* () {
    // A fresh database has every repair pending, in order: this binary's keys.
    const { repairsPending } = yield* inspectMigrationLedger();
    assert.equal(
      migrationSchemaDigest,
      schemaDigestOf({ migrations: migrationEntries, repairKeys: repairsPending }),
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
