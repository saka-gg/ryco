import { ThreadId } from "@ryco/contracts";
import { deriveBackgroundWork } from "@ryco/shared/backgroundWork";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolver } from "../../project/Services/RepositoryIdentityResolver.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";

const layer = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(Layer.succeed(RepositoryIdentityResolver, { resolve: () => Effect.succeed(null) })),
  Layer.provideMerge(SqlitePersistenceMemory),
);
const threadId = ThreadId.make("background-window");
const at = "2026-09-15T00:00:00.000Z";
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM projection_thread_activities WHERE thread_id = ${threadId}`;
  yield* sql`DELETE FROM projection_thread_sessions WHERE thread_id = ${threadId}`;
  yield* sql`DELETE FROM projection_threads WHERE thread_id = ${threadId}`;
  yield* sql`DELETE FROM projection_projects WHERE project_id = 'bg-project'`;
  yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,default_model_selection_json,scripts_json,created_at,updated_at)
    VALUES ('bg-project','Project','/tmp/bg','{"provider":"codex","model":"gpt-5-codex"}','[]',${at},${at})`;
  yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,runtime_mode,interaction_mode,created_at,updated_at)
    VALUES (${threadId},'bg-project','Background','{"provider":"codex","model":"gpt-5-codex"}','full-access','default',${at},${at})`;
  yield* sql`INSERT INTO projection_thread_sessions (thread_id,status,provider_name,runtime_session_id,updated_at)
    VALUES (${threadId},'ready','codex','epoch',${at})`;
});
const insert = (n: number, kind: string, payload: Record<string, unknown>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_thread_activities (activity_id,thread_id,turn_id,tone,kind,summary,payload_json,sequence,created_at)
    VALUES (${`bg-${n}`},${threadId},NULL,'info',${kind},'Background work',${JSON.stringify(payload)},${n},${at})`;
  });
const task = (id: string, overrides = {}) => ({
  taskId: id,
  runtimeSessionId: "epoch",
  agentKind: "background",
  taskType: "local_bash",
  isBackgrounded: true,
  canStop: true,
  detail: `Check ${id}`,
  ...overrides,
});
const window = Effect.gen(function* () {
  const query = yield* ProjectionSnapshotQuery;
  return yield* query.getThreadWindow!({
    threadId,
    limits: { messages: 1, activities: 2, proposedPlans: 1, checkpoints: 1 },
  });
});

it.layer(layer)("bounded background snapshot evidence", (it) => {
  it.effect("restores old unfinished details without moving the transcript pagination cursor", () =>
    Effect.gen(function* () {
      yield* setup;
      yield* insert(1, "task.started", task("live"));
      yield* insert(2, "task.started", task("settled"));
      yield* insert(3, "task.completed", task("settled", { status: "completed" }));
      yield* insert(4, "task.updated", task("live", { status: "idle" }));
      yield* insert(5, "task.progress", task("live", { detail: "Paused check" }));
      for (let i = 6; i <= 20; i++) yield* insert(i, "tool.completed", {});
      const result = yield* window;
      const work = deriveBackgroundWork(result.thread.activities);
      assert.deepEqual(
        work.tasks.map((row) => row.id),
        ["live"],
      );
      assert.equal(work.tasks[0]?.status, "idle");
      assert.isFalse(work.detailsOmitted);
      assert.equal(result.thread.activities.length, 3);
      assert.isTrue(result.history.activities.hasMoreBefore);
      const query = yield* ProjectionSnapshotQuery;
      const cursor = result.history.activities.oldestCursor;
      assert.isNotNull(cursor);
      const page = yield* query.getThreadHistoryPage!({
        threadId,
        collection: "activities",
        mode: { kind: "before", cursor: cursor! },
        limit: 2,
      });
      assert.equal(page.collection, "activities");
      if (page.collection !== "activities") return;
      assert.deepEqual(
        page.items.map((row) => row.id),
        ["bg-17", "bg-18"],
      );
    }),
  );

  it.effect("caps detail at 100 and preserves latest foreground and terminal transitions", () =>
    Effect.gen(function* () {
      yield* setup;
      for (let i = 1; i <= 101; i++) yield* insert(i, "task.started", task(`task-${i}`));
      const full = yield* window;
      assert.lengthOf(deriveBackgroundWork(full.thread.activities).tasks, 100);
      assert.isTrue(deriveBackgroundWork(full.thread.activities).detailsOmitted);
      yield* insert(102, "task.updated", task("task-1", { isBackgrounded: false }));
      yield* insert(103, "task.completed", task("task-2", { status: "stopped" }));
      const settled = deriveBackgroundWork((yield* window).thread.activities);
      assert.lengthOf(settled.tasks, 99);
      assert.isFalse(settled.detailsOmitted);
    }),
  );

  it.effect(
    "reports unknown omitted history at the scan bound and never revives a settled old task",
    () =>
      Effect.gen(function* () {
        yield* setup;
        yield* insert(1, "task.started", task("old"));
        yield* insert(2, "task.completed", task("old", { status: "completed" }));
        for (let i = 3; i <= 1024; i++) yield* insert(i, "tool.completed", {});
        assert.isFalse(deriveBackgroundWork((yield* window).thread.activities).detailsOmitted);
        yield* insert(1025, "task.progress", task("old"));
        const work = deriveBackgroundWork((yield* window).thread.activities);
        assert.deepEqual(work.tasks, []);
        assert.isTrue(work.detailsOmitted);
        // Current-epoch boundary makes old omitted history irrelevant after restart.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE projection_thread_sessions SET runtime_session_id = 'new' WHERE thread_id = ${threadId}`;
        yield* insert(1026, "background-work.session-boundary", {
          runtimeSessionId: "new",
          state: "started",
        });
        assert.deepEqual(deriveBackgroundWork((yield* window).thread.activities), {
          tasks: [],
          detailsOmitted: false,
        });
      }),
  );

  it.effect(
    "bounds oversized payloads and uses the existing history index for the input scan",
    () =>
      Effect.gen(function* () {
        yield* setup;
        yield* insert(1, "task.started", task("large", { detail: "x".repeat(5000) }));
        for (let i = 2; i <= 5; i++) yield* insert(i, "tool.completed", {});
        const work = deriveBackgroundWork((yield* window).thread.activities);
        assert.deepEqual(work.tasks, []);
        assert.isTrue(work.detailsOmitted);
        const sql = yield* SqlClient.SqlClient;
        const plan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN SELECT activity_id
      FROM projection_thread_activities INDEXED BY idx_projection_thread_activities_thread_sequence_created_id
      WHERE thread_id = ${threadId} ORDER BY sequence DESC, created_at DESC, activity_id DESC LIMIT 1025`;
        assert.isTrue(
          plan.some((row) =>
            row.detail.includes(
              "COVERING INDEX idx_projection_thread_activities_thread_sequence_created_id",
            ),
          ),
        );
        assert.isFalse(plan.some((row) => row.detail.includes("TEMP B-TREE")));
      }),
  );
});
