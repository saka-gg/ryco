// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { MessageId, ThreadId } from "@ryco/contracts";
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
