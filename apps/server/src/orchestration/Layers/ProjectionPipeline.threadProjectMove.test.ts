import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderInstanceId,
  THREAD_MOVED_ACTIVITY_KIND,
  ThreadId,
} from "@ryco/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { ProjectAvatarStore } from "../../project/Services/ProjectAvatarStore.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const MockProjectAvatarStoreLive = Layer.succeed(ProjectAvatarStore, {
  write: () => Effect.die("ProjectAvatarStore.write not implemented in test"),
  read: () => Effect.succeed(null),
  remove: () => Effect.void,
});

const layer = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(RepositoryIdentityResolverLive),
  Layer.provideMerge(
    OrchestrationProjectionPipelineLive.pipe(
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "ryco-thread-move-" })),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(MockProjectAvatarStoreLive),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
);

const now = "2026-11-01T10:00:00.000Z";
const later = "2026-11-01T11:00:00.000Z";
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const threadId = ThreadId.make("thread-moved");

const eventBase = (
  id: string,
  aggregateKind: "project" | "thread",
  aggregateId: string,
  occurredAt: string,
) => ({
  eventId: EventId.make(id),
  aggregateKind,
  aggregateId: aggregateId as ProjectId,
  occurredAt,
  commandId: CommandId.make(id),
  causationEventId: null,
  correlationId: CommandId.make(id),
  metadata: {},
});

it.layer(Layer.fresh(layer))("OrchestrationProjectionPipeline thread project move", (it) => {
  it.effect(
    "persists the move, so a restart, reload or reconnect lists the thread in its new project",
    () =>
      Effect.gen(function* () {
        const eventStore = yield* OrchestrationEventStore;
        const pipeline = yield* OrchestrationProjectionPipeline;
        const snapshots = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;
        for (const [projectId, title] of [
          [projectA, "Alpha"],
          [projectB, "Beta"],
        ] as const) {
          yield* eventStore.append({
            ...eventBase(`evt-${projectId}`, "project", projectId, now),
            type: "project.created",
            payload: {
              projectId,
              title,
              workspaceRoot: `/tmp/${projectId}`,
              defaultModelSelection: null,
              scripts: [],
              createdAt: now,
              updatedAt: now,
            },
          });
        }
        yield* eventStore.append({
          ...eventBase("evt-thread", "thread", threadId, now),
          type: "thread.created",
          payload: {
            threadId,
            projectId: projectA,
            title: "Wrong project",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claude"),
              model: "claude-opus-5-5",
            },
            runtimeMode: "full-access",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: "feature/x",
            worktreePath: "/tmp/project-a-worktree",
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* eventStore.append({
          ...eventBase("evt-moved", "thread", threadId, later),
          type: "thread.project-moved",
          payload: {
            threadId,
            projectId: projectB,
            previousProjectId: projectA,
            previousWorktreePath: "/tmp/project-a-worktree",
            previousWorktreeId: null,
            previousBranch: "feature/x",
            movedAt: later,
          },
        });
        yield* eventStore.append({
          ...eventBase("evt-moved-activity", "thread", threadId, later),
          type: "thread.activity-appended",
          payload: {
            threadId,
            activity: {
              id: EventId.make("thread-moved:cmd"),
              tone: "info",
              kind: THREAD_MOVED_ACTIVITY_KIND,
              summary: "Moved to Beta",
              payload: {
                schemaVersion: 1,
                fromProjectId: projectA,
                fromProjectTitle: "Alpha",
                toProjectId: projectB,
                toProjectTitle: "Beta",
                fromWorktreePath: "/tmp/project-a-worktree",
                checkpointTurnCount: 0,
              },
              turnId: null,
              createdAt: later,
            },
          },
        });
        yield* pipeline.bootstrap;

        const rows = yield* sql<{
          readonly projectId: string;
          readonly worktreePath: string | null;
          readonly branch: string | null;
        }>`SELECT project_id AS "projectId", worktree_path AS "worktreePath", branch
         FROM projection_threads WHERE thread_id = ${threadId}`;
        assert.deepEqual(rows, [{ projectId: "project-b", worktreePath: null, branch: null }]);

        // What a reconnecting client receives.
        const shell = (yield* snapshots.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        );
        assert.strictEqual(shell?.projectId, projectB);
        assert.strictEqual(shell?.worktreePath, null);

        // What the decider reads after a restart: the thread and the move's record.
        const commandModel = yield* snapshots.getCommandReadModel();
        const commandThread = commandModel.threads.find((thread) => thread.id === threadId);
        assert.strictEqual(commandThread?.projectId, projectB);
        assert.deepEqual(
          commandThread?.activities.map((activity) => activity.kind),
          [THREAD_MOVED_ACTIVITY_KIND],
        );
        assert.strictEqual(
          Option.isSome(yield* snapshots.getFirstActiveThreadIdByProjectId(projectA)),
          false,
        );
      }),
  );
});
