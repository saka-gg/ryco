// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { MessageId, OrchestrationThreadHistoryError, ThreadId } from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import {
  SqliteReadClient,
  type SqliteReadWorkerStats,
} from "../../persistence/SqliteReadClient.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const MODEL = '{"instanceId":"codex","model":"gpt-5-codex"}';
const NOW = "2026-10-01T00:00:00.000Z";

const withFileDatabase = <A, E>(
  body: Effect.Effect<A, E, ProjectionSnapshotQuery | SqlClient.SqlClient | SqliteReadClient>,
) => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-projection-reader-"));
  return body.pipe(
    Effect.provide(
      OrchestrationProjectionSnapshotQueryLive.pipe(
        Layer.provide(ThreadBackgroundLiveness.layer),
        Layer.provideMerge(
          makeSqlitePersistenceLive(NodePath.join(tempDir, "state.sqlite")).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    ),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
};

const workerStatements = Effect.map(
  Effect.service(SqliteReadClient),
  (reader) =>
    (reader as unknown as { readWorkerStats: () => SqliteReadWorkerStats }).readWorkerStats()
      .workerStatements,
);

const insertMessage = (sql: SqlClient.SqlClient, messageId: string, text: string, at: string) =>
  sql`
    INSERT INTO projection_thread_messages (
      message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
    ) VALUES (${messageId}, 'thread-1', NULL, 'user', ${text}, 0, ${at}, ${at})
  `;

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model_selection_json, scripts_json,
      created_at, updated_at, deleted_at
    ) VALUES ('project-1', 'Project', '/project', NULL, '[]', ${NOW}, ${NOW}, NULL)
  `;
  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
      created_at, updated_at, deleted_at
    ) VALUES (
      'thread-1', 'project-1', 'Thread', ${MODEL}, 'full-access', 'default', ${NOW}, ${NOW}, NULL
    )
  `;
  yield* insertMessage(sql, "message-1", "rhubarb crumble recipe", "2026-10-01T00:00:01.000Z");
});

it.effect("runs history pages and message search on the read worker", () =>
  withFileDatabase(
    Effect.gen(function* () {
      yield* seed;
      const query = yield* ProjectionSnapshotQuery;

      const before = yield* workerStatements;
      const found = yield* query.searchThreadMessages({ query: "rhubarb", limit: 10 });
      assert.deepEqual(
        found.map((result) => result.messageId),
        ["message-1"],
      );
      const afterSearch = yield* workerStatements;
      assert.isAbove(afterSearch, before);

      const page = yield* query.getThreadHistoryPage!({
        threadId: ThreadId.make("thread-1"),
        collection: "messages",
        mode: { kind: "around", anchorId: MessageId.make("message-1") },
        limit: 10,
      });
      assert.equal(page.collection, "messages");
      assert.isAbove(yield* workerStatements, afterSearch);

      // Engine hydration keeps reading on the main connection.
      const beforeHydration = yield* workerStatements;
      yield* query.getCommandReadModel();
      assert.equal(yield* workerStatements, beforeHydration);
    }),
  ),
);

it.effect("reads thread windows on the read worker, matching the main connection", () =>
  withFileDatabase(
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* insertMessage(sql, "message-2", "second message", "2026-10-01T00:00:02.000Z");
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
        ) VALUES (
          'activity-1', 'thread-1', NULL, 'info', 'tool.completed', 'Ran a tool', '{}',
          '2026-10-01T00:00:03.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id, thread_id, turn_id, plan_markdown, created_at, updated_at
        ) VALUES (
          'plan-1', 'thread-1', NULL, '# Plan', '2026-10-01T00:00:04.000Z',
          '2026-10-01T00:00:04.000Z'
        )
      `;
      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        yield* sql`
          INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
          VALUES (${projector}, 7, ${NOW})
        `;
      }
      const query = yield* ProjectionSnapshotQuery;
      const input = {
        threadId: ThreadId.make("thread-1"),
        limits: { messages: 10, proposedPlans: 10, activities: 10, checkpoints: 10 },
      };

      const beforeWorkerRead = yield* workerStatements;
      const onWorker = yield* query.getThreadWindow!(input);
      assert.isAbove(yield* workerStatements, beforeWorkerRead);

      // Inside a main-connection transaction the same read stays on that connection.
      const beforeMainRead = yield* workerStatements;
      const onMain = yield* sql.withTransaction(query.getThreadWindow!(input));
      assert.equal(yield* workerStatements, beforeMainRead);

      assert.deepEqual(onWorker, onMain);
      assert.equal(onWorker.snapshotSequence, 7);
      assert.deepEqual(
        onWorker.thread.messages.map((message) => message.id),
        ["message-1", "message-2"],
      );
      assert.deepEqual(
        onWorker.thread.activities.map((activity) => activity.id),
        ["activity-1"],
      );
      assert.deepEqual(
        onWorker.thread.proposedPlans.map((plan) => plan.id),
        ["plan-1"],
      );
      assert.equal(onWorker.workspaceCwd, "/project");
    }),
  ),
);

it.effect("reports a missing thread from the read worker like the main connection", () =>
  withFileDatabase(
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const query = yield* ProjectionSnapshotQuery;
      const input = {
        threadId: ThreadId.make("thread-missing"),
        limits: { messages: 10, proposedPlans: 10, activities: 10, checkpoints: 10 },
      };

      const beforeWorkerRead = yield* workerStatements;
      const onWorker = yield* Effect.flip(query.getThreadWindow!(input));
      assert.isAbove(yield* workerStatements, beforeWorkerRead);
      const onMain = yield* Effect.flip(sql.withTransaction(query.getThreadWindow!(input)));

      assert.deepEqual(onWorker, onMain);
      assert.deepEqual(
        onWorker,
        new OrchestrationThreadHistoryError({
          reason: "thread-not-found",
          threadId: input.threadId,
        }),
      );
    }),
  ),
);

it.effect("keeps reads inside a main-connection transaction on that connection", () =>
  withFileDatabase(
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const query = yield* ProjectionSnapshotQuery;
      const before = yield* workerStatements;
      const found = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* insertMessage(sql, "message-2", "rhubarb jam", "2026-10-01T00:00:02.000Z");
          // Uncommitted: only the main connection sees it.
          return yield* query.searchThreadMessages({ query: "rhubarb", limit: 10 });
        }),
      );
      assert.deepEqual(
        found.map((result) => result.messageId),
        ["message-2", "message-1"],
      );
      assert.equal(yield* workerStatements, before);
    }),
  ),
);
