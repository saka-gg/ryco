/**
 * Startup recovery against the real journal, orchestration engine and projections: the
 * server-internal `project.meta.update { kind: "project" }` that finishes an interrupted
 * promotion must pass the decider and land in the projection.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId } from "@ryco/contracts";
import { Effect, Layer, Option } from "effect";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { ProjectRelocationRepositoryLive } from "../persistence/Layers/ProjectRelocations.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectRelocationRepository } from "../persistence/Services/ProjectRelocations.ts";
import { RepositoryIdentityResolverLive } from "./Layers/RepositoryIdentityResolver.ts";
import { ProjectAvatarStore } from "./Services/ProjectAvatarStore.ts";
import { recoverProjectRelocations } from "./chatPromotion.ts";

const layer = it.layer(
  Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    ProjectionProjectRepositoryLive,
    ProjectRelocationRepositoryLive,
  ).pipe(
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provide(
      Layer.succeed(ProjectAvatarStore, {
        write: () => Effect.die("not implemented"),
        read: () => Effect.succeed(null),
        remove: () => Effect.void,
      }),
    ),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "ryco-chat-recovery-" })),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("recoverProjectRelocations with the real engine", (it) => {
  it.effect("turns the chat into a project at its moved folder", () =>
    Effect.gen(function* () {
      const scratch = yield* Effect.promise(async () =>
        realpath(await mkdtemp(path.join(tmpdir(), "ryco-chat-recovery-"))),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => rm(scratch, { recursive: true, force: true })),
      );
      const source = path.join(scratch, "chats", "2026-10-08-plan-0a1b2c3d");
      const destination = path.join(scratch, "Code", "plan");
      yield* Effect.promise(async () => {
        await mkdir(source, { recursive: true });
        await mkdir(path.dirname(destination), { recursive: true });
      });

      const engine = yield* OrchestrationEngineService;
      const projects = yield* ProjectionProjectRepository;
      const relocations = yield* ProjectRelocationRepository;
      const projectId = ProjectId.make("project-chat-recovery");
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("chat-recovery-create"),
        projectId,
        kind: "chat",
        title: "Plan",
        workspaceRoot: source,
        createdAt: "2026-10-08T10:00:00.000Z",
      });
      // The process stopped right after renaming the folder.
      yield* relocations.create({
        relocationId: "relocation-chat-recovery",
        projectId,
        sourcePath: source,
        destinationPath: destination,
        strategy: "rename",
        state: "pending",
        destinationCreated: false,
        title: null,
        error: null,
        createdAt: "2026-10-08T10:01:00.000Z",
        updatedAt: "2026-10-08T10:01:00.000Z",
      });
      yield* Effect.promise(async () => {
        await rm(source, { recursive: true });
        await mkdir(destination);
        await writeFile(path.join(destination, "plan.md"), "# Plan\n");
      });

      yield* recoverProjectRelocations({ relocations, projects, dispatch: engine.dispatch });

      const project = Option.getOrThrow(yield* projects.getById({ projectId }));
      assert.equal(project.kind, "project");
      assert.equal(project.workspaceRoot, destination);
      const row = Option.getOrThrow(
        yield* relocations.getById({ relocationId: "relocation-chat-recovery" }),
      );
      assert.equal(row.state, "done");
      assert.lengthOf(yield* relocations.listUnresolved(), 0);
    }),
  );
});
