import { OrchestrationArchivedThreadStub, OrchestrationThreadShell } from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlStatement from "effect/sql/Statement";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolver } from "../../project/Services/RepositoryIdentityResolver.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import {
  ProjectionSnapshotQuery,
  readStubbedShellSnapshot,
  stubArchivedThreads,
  toArchivedThreadStub,
} from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

// A fresh database per test: `updatedAt` is a maximum over whole tables, so rows another test
// wrote would hide whether archived threads' latest turns still count.
const freshQuery = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provideMerge(
    Layer.succeed(RepositoryIdentityResolver, { resolve: () => Effect.die("no git on reads") }),
  ),
  Layer.provideMerge(SqlitePersistenceMemory),
);

const MODEL = '{"instanceId":"codex","model":"gpt-5-codex"}';
const T0 = "2026-10-01T00:00:00.000Z";

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model_selection_json, scripts_json,
      created_at, updated_at
    ) VALUES ('project-1', 'Project', '/tmp/project-1', ${MODEL}, '[]', ${T0}, ${T0})
  `;
  const thread = (id: string, archivedAt: string | null, lineageParent: string | null = null) =>
    sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        branch, worktree_path, created_at, updated_at, archived_at, latest_user_message_at,
        lineage_parent_thread_id, lineage_root_thread_id, lineage_relationship
      ) VALUES (
        ${id}, 'project-1', ${`Title ${id}`}, ${MODEL}, 'full-access', 'default',
        ${`branch-${id}`}, ${`/tmp/wt-${id}`}, ${T0}, ${T0}, ${archivedAt}, ${T0},
        ${lineageParent}, ${lineageParent}, ${lineageParent === null ? null : "delegated"}
      )
    `;
  yield* thread("live", null);
  yield* thread("archived", "2026-10-02T00:00:00.000Z");
  yield* thread("archived-child", "2026-10-03T00:00:00.000Z", "live");
  // Both threads have a session and a latest turn; the archived one's turn is the newest
  // write anywhere, so it alone moves `updatedAt`.
  for (const [id, completedAt] of [
    ["live", "2026-10-04T00:00:00.000Z"],
    ["archived", "2098-01-01T00:00:00.000Z"],
  ] as const) {
    yield* sql`
      INSERT INTO projection_turns (
        thread_id, turn_id, pending_message_id, state, requested_at, started_at, completed_at,
        checkpoint_files_json
      ) VALUES (
        ${id}, ${`turn-${id}`}, ${`message-${id}`}, 'completed', ${T0}, ${T0}, ${completedAt}, '[]'
      )
    `;
    yield* sql`UPDATE projection_threads SET latest_turn_id = ${`turn-${id}`}
      WHERE thread_id = ${id}`;
    yield* sql`
      INSERT INTO projection_thread_sessions (thread_id, status, runtime_mode, updated_at)
      VALUES (${id}, 'stopped', 'full-access', ${T0})
    `;
  }
});

it.effect("builds archived threads as stubs, with the full shell's sequence and version", () =>
  Effect.gen(function* () {
    yield* seed;
    const query = yield* ProjectionSnapshotQuery;
    const full = yield* query.getShellSnapshot();
    const stubbed = yield* readStubbedShellSnapshot(query);

    assert.equal(stubbed.snapshotSequence, full.snapshotSequence);
    // The archived thread's latest turn still counts toward the version.
    assert.equal(full.updatedAt, "2098-01-01T00:00:00.000Z");
    assert.equal(stubbed.updatedAt, full.updatedAt);
    assert.deepEqual(stubbed.projects, full.projects);
    assert.deepEqual(stubbed.worktrees, full.worktrees);
    // Unarchived threads are the very same full shells; every live thread is present once.
    assert.deepEqual(
      stubbed.threads,
      full.threads.filter((thread) => thread.archivedAt === null),
    );
    assert.deepEqual(
      [
        ...stubbed.threads.map((thread) => thread.id),
        ...stubbed.archivedThreadStubs.map((stub) => stub.id),
      ].toSorted(),
      full.threads.map((thread) => thread.id).toSorted(),
    );
    // Each stub is exactly what the full archived shell projects to.
    const byId = (left: { readonly id: string }, right: { readonly id: string }) =>
      left.id.localeCompare(right.id);
    assert.deepEqual(
      stubbed.archivedThreadStubs.toSorted(byId),
      full.threads
        .filter((thread) => thread.archivedAt !== null)
        .map((thread) => toArchivedThreadStub({ ...thread, archivedAt: thread.archivedAt! }))
        .toSorted(byId),
    );
    const child = stubbed.archivedThreadStubs.find((stub) => stub.id === "archived-child");
    assert.equal(child?.lineage?.parentThreadId, "live");
    assert.equal(child?.branch, "branch-archived-child");
    assert.equal(child?.worktreePath, "/tmp/wt-archived-child");
    // The stub field set is exactly the contract's.
    assert.deepEqual(
      Object.keys(stubbed.archivedThreadStubs[0]!).toSorted(),
      Object.keys(OrchestrationArchivedThreadStub.fields).toSorted(),
    );
    // Already in decoded form, like the full shell.
    for (const stub of stubbed.archivedThreadStubs) {
      assert.deepEqual(Schema.decodeUnknownSync(OrchestrationArchivedThreadStub)(stub), stub);
    }
    for (const thread of stubbed.threads) {
      assert.deepEqual(Schema.decodeUnknownSync(OrchestrationThreadShell)(thread), thread);
    }
    // The test-double fallback splits a full shell the same way.
    assert.deepEqual(
      stubArchivedThreads(full).archivedThreadStubs.toSorted(byId),
      stubbed.archivedThreadStubs.toSorted(byId),
    );
  }).pipe(Effect.provide(freshQuery)),
);

it.effect("does not read archived threads' sessions or latest turns for a stubbed shell", () =>
  Effect.gen(function* () {
    yield* seed;
    const query = yield* ProjectionSnapshotQuery;
    const statements: string[] = [];
    const capture: SqlStatement.Transformer = (statement) =>
      Effect.sync(() => {
        statements.push(statement.compile()[0]);
        return statement;
      });
    yield* readStubbedShellSnapshot(query).pipe(
      Effect.provideService(SqlStatement.CurrentTransformer, capture),
    );
    const sessions = statements.find((statement) =>
      statement.includes("FROM projection_thread_sessions"),
    );
    assert.include(sessions ?? "", "archived_at IS NULL");
    assert.isTrue(
      statements.some(
        (statement) =>
          statement.includes("turns.pending_message_id") &&
          statement.includes("archived_at IS NULL"),
      ),
    );
    // The full shell still reads them all.
    statements.length = 0;
    yield* query
      .getShellSnapshot()
      .pipe(Effect.provideService(SqlStatement.CurrentTransformer, capture));
    assert.isFalse(statements.some((statement) => statement.includes("archived_at IS NULL")));
  }).pipe(Effect.provide(freshQuery)),
);

it.effect("keeps the full and the stubbed shell builds apart when both are asked at once", () =>
  Effect.gen(function* () {
    yield* seed;
    const query = yield* ProjectionSnapshotQuery;
    const [full, stubbed, full2, stubbed2] = yield* Effect.all(
      [
        query.getShellSnapshot(),
        readStubbedShellSnapshot(query),
        query.getShellSnapshot(),
        readStubbedShellSnapshot(query),
      ],
      { concurrency: "unbounded" },
    );
    for (const snapshot of [full, full2]) {
      assert.equal(snapshot.threads.length, 3);
      assert.isFalse("archivedThreadStubs" in snapshot);
    }
    for (const snapshot of [stubbed, stubbed2]) {
      assert.equal(snapshot.threads.length, 1);
      assert.equal(snapshot.archivedThreadStubs.length, 2);
    }
  }).pipe(Effect.provide(freshQuery)),
);
