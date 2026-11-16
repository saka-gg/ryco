import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ProjectId, ProviderInstanceId } from "@ryco/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

const { projectedCommandIds } = vi.hoisted(() => ({ projectedCommandIds: [] as string[] }));

vi.mock("../projector.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../projector.ts")>();
  return {
    ...actual,
    projectEvent: (model: any, event: any) => {
      projectedCommandIds.push(String(event.commandId));
      return actual.projectEvent(model, event);
    },
  };
});

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { ProjectAvatarStore } from "../../project/Services/ProjectAvatarStore.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const MockProjectAvatarStoreLive = Layer.succeed(ProjectAvatarStore, {
  write: () => Effect.die("ProjectAvatarStore.write not implemented in test"),
  read: () => Effect.succeed(null),
  remove: () => Effect.void,
});

const DEFECT_COMMAND_ID = CommandId.make("cmd-post-commit-defect");

const createProject = (commandId: string, projectId: string) => ({
  type: "project.create" as const,
  commandId: CommandId.make(commandId),
  projectId: ProjectId.make(projectId),
  title: projectId,
  workspaceRoot: `/tmp/${projectId}`,
  defaultModelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5-codex",
  },
  createdAt: new Date().toISOString(),
});

describe("OrchestrationEngine dispatch-failure reconcile", () => {
  it("does not project events the command read model already applied", async () => {
    const pipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectEvent: () => Effect.void,
      // The commit succeeds; the post-commit effect then dies after the model advanced.
      projectEventInTransaction: (event) =>
        Effect.succeed(
          event.commandId === DEFECT_COMMAND_ID ? Effect.die("post-commit defect") : Effect.void,
        ),
    };
    const layer = OrchestrationEngineLive.pipe(
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, pipeline)),
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(MockProjectAvatarStoreLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolverLive),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "ryco-orchestration-reconcile-test-" }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );
    const runtime = ManagedRuntime.make(layer);
    try {
      const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
      projectedCommandIds.length = 0;

      await expect(
        runtime.runPromise(engine.dispatch(createProject(DEFECT_COMMAND_ID, "project-defect"))),
      ).rejects.toBeDefined();

      expect(projectedCommandIds.filter((id) => id === DEFECT_COMMAND_ID)).toHaveLength(1);

      await expect(
        runtime.runPromise(engine.dispatch(createProject("cmd-after-defect", "project-after"))),
      ).resolves.toBeDefined();
    } finally {
      await runtime.dispose();
    }
  });
});
