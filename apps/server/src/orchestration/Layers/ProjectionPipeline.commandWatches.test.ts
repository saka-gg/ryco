import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ThreadCommandWatch,
} from "@ryco/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { ProjectAvatarStore } from "../../project/Services/ProjectAvatarStore.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "../projectorNames.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const layer = it.layer(
  OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provide(
      Layer.succeed(ProjectAvatarStore, {
        write: () => Effect.die("not in this test"),
        read: () => Effect.succeed(null),
        remove: () => Effect.void,
      }),
    ),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "ryco-projection-command-watches-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const watchId = "command-watch:1";
const createdAt = "2026-10-04T10:00:00.000Z";

const watch = (overrides: Partial<ThreadCommandWatch> = {}): ThreadCommandWatch => ({
  watchId,
  command: "gh api repos/o/r/issues/12/comments --jq '.[-1].body'",
  label: "Reply on #12",
  everyMinutes: 10,
  revision: 1,
  startedAt: "2026-10-04T10:05:00.000Z",
  runtimeMode: "full-access",
  worktreePath: "/tmp/command-watch",
  cwd: "/tmp/command-watch",
  lastOutputHash: null,
  wakes: 0,
  lastChangeAt: null,
  delivery: null,
  beforeWake: null,
  ...overrides,
});

const setup = (key: string) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const threadId = ThreadId.make(`thread-${key}`);
    const projectId = ProjectId.make(`project-${key}`);
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`cmd-project-${key}`),
      projectId,
      title: "Watch",
      workspaceRoot: `/tmp/project-${key}`,
      defaultModelSelection: null,
      createdAt,
    });
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`cmd-thread-${key}`),
      threadId,
      projectId,
      title: "Watch",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: "/tmp/command-watch",
      createdAt,
    });
    yield* engine.dispatch({
      type: "thread.command-watch.update",
      commandId: CommandId.make(`server:command-watch:${key}`),
      threadId,
      watchId,
      expectedRevision: null,
      expectedStartedAt: null,
      next: watch(),
      createdAt: "2026-10-04T10:05:00.000Z",
    });
    return threadId;
  });

const watchRow = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ readonly watchesJson: string; readonly activeCount: number }>`
      SELECT watches_json AS "watchesJson", active_count AS "activeCount"
      FROM projection_thread_command_watches WHERE thread_id = ${threadId}`;
  });

layer("command watch projection", (it) => {
  it.effect("stores the full state, shows shells only the count, and hydrates the engine", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionSnapshotQuery;
      const threadId = yield* setup("store");
      const [row] = yield* watchRow(threadId);
      assert.equal(row?.activeCount, 1);
      assert.deepEqual(JSON.parse(row!.watchesJson), { active: [watch()], ended: [] });

      const shell = Option.getOrThrow(yield* query.getThreadShellById(threadId));
      assert.equal(shell.commandWatchCount, 1);
      // Shells reach every client of the node: never the command.
      assert.notInclude(JSON.stringify(shell), "gh api");
      const snapshot = yield* query.getShellSnapshot();
      assert.equal(snapshot.threads.find((thread) => thread.id === threadId)?.commandWatchCount, 1);

      const readModel = yield* query.getCommandReadModel();
      assert.deepEqual(
        readModel.threads.find((thread) => thread.id === threadId)?.commandWatchState,
        { active: [watch()], ended: [] },
      );
    }),
  );

  it.effect(
    "keeps an ended watch, leaves the shell without the key, and drops the row on delete",
    () =>
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const query = yield* ProjectionSnapshotQuery;
        const threadId = yield* setup("delete");
        yield* engine.dispatch({
          type: "thread.trash",
          commandId: CommandId.make("cmd-trash"),
          threadId,
        });
        const [trashed] = yield* watchRow(threadId);
        assert.equal(trashed?.activeCount, 0);
        assert.equal(JSON.parse(trashed!.watchesJson).ended[0].reason, "trashed");
        const shells = yield* query.getShellSnapshot();
        const shell = shells.threads.find((thread) => thread.id === threadId);
        assert.isFalse(shell !== undefined && "commandWatchCount" in shell);

        yield* engine.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("cmd-delete"),
          threadId,
        });
        assert.deepEqual(yield* watchRow(threadId), []);
      }),
  );

  it.effect("a projector added by the upgrade rebuilds the table from the event log", () =>
    Effect.gen(function* () {
      const pipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const threadId = yield* setup("replay");
      const before = yield* watchRow(threadId);
      yield* sql`DELETE FROM projection_thread_command_watches`;
      yield* sql`DELETE FROM projection_state
        WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.threadCommandWatches}`;
      yield* pipeline.bootstrap;
      assert.deepEqual(yield* watchRow(threadId), before);
    }),
  );
});
