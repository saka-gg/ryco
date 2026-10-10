import { CommandId, EventId, ProjectId } from "@ryco/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "ryco-project-kind-" })),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(MockProjectAvatarStoreLive),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
);

const now = "2026-10-08T10:00:00.000Z";
const later = "2026-10-08T11:00:00.000Z";
const chatId = ProjectId.make("project-chat");
const legacyId = ProjectId.make("project-legacy");

const eventBase = (id: string, projectId: ProjectId, occurredAt: string) => ({
  eventId: EventId.make(id),
  aggregateKind: "project" as const,
  aggregateId: projectId,
  occurredAt,
  commandId: CommandId.make(id),
  causationEventId: null,
  correlationId: CommandId.make(id),
  metadata: {},
});

it.layer(Layer.fresh(layer))("OrchestrationProjectionPipeline project kind", (it) => {
  it.effect("persists the kind, reads it back everywhere, and promotes a chat", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const snapshots = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const createdPayload = (projectId: ProjectId, title: string) => ({
        projectId,
        title,
        workspaceRoot: `/tmp/${projectId}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      });

      yield* eventStore.append({
        ...eventBase("evt-chat", chatId, now),
        type: "project.created",
        payload: { ...createdPayload(chatId, "Chat"), kind: "chat" },
      });
      // Written before kinds existed: no `kind` in the stored payload.
      yield* eventStore.append({
        ...eventBase("evt-legacy", legacyId, now),
        type: "project.created",
        payload: createdPayload(legacyId, "Legacy"),
      });
      yield* pipeline.bootstrap;

      const kinds = () =>
        sql<{ readonly projectId: string; readonly kind: string }>`
          SELECT project_id AS "projectId", kind FROM projection_projects ORDER BY project_id
        `;
      assert.deepEqual(yield* kinds(), [
        { projectId: "project-chat", kind: "chat" },
        { projectId: "project-legacy", kind: "project" },
      ]);

      const shellKinds = (yield* snapshots.getShellSnapshot()).projects.map(
        (project): readonly [string, string | undefined] => [project.id, project.kind],
      );
      assert.deepEqual(shellKinds.toSorted(), [
        ["project-chat", "chat"],
        ["project-legacy", "project"],
      ]);
      const commandModel = yield* snapshots.getCommandReadModel();
      assert.strictEqual(
        commandModel.projects.find((project) => project.id === chatId)?.kind,
        "chat",
      );
      const shell = yield* snapshots.getProjectShellById(chatId);
      assert.strictEqual(Option.getOrNull(shell)?.kind, "chat");

      // Title-only updates keep the kind; promotion flips it.
      yield* eventStore.append({
        ...eventBase("evt-rename", chatId, later),
        type: "project.meta-updated",
        payload: { projectId: chatId, title: "Renamed chat", updatedAt: later },
      });
      yield* pipeline.bootstrap;
      assert.strictEqual(
        Option.getOrNull(yield* snapshots.getProjectShellById(chatId))?.kind,
        "chat",
      );

      yield* eventStore.append({
        ...eventBase("evt-promote", chatId, later),
        type: "project.meta-updated",
        payload: {
          projectId: chatId,
          kind: "project",
          workspaceRoot: "/tmp/promoted",
          updatedAt: later,
        },
      });
      yield* pipeline.bootstrap;
      assert.deepEqual(yield* kinds(), [
        { projectId: "project-chat", kind: "project" },
        { projectId: "project-legacy", kind: "project" },
      ]);
      const promoted = Option.getOrNull(yield* snapshots.getProjectShellById(chatId));
      assert.strictEqual(promoted?.kind, "project");
      assert.strictEqual(promoted?.workspaceRoot, "/tmp/promoted");
      assert.strictEqual(promoted?.title, "Renamed chat");
    }),
  );
});
