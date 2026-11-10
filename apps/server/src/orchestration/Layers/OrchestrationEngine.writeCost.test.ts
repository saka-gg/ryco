import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, EventId, ProjectId, ProviderInstanceId, ThreadId } from "@ryco/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectAvatarStore } from "../../project/Services/ProjectAvatarStore.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadSessionModelSelections from "../ThreadSessionModelSelections.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

/**
 * Counts the SQLite statements `node:sqlite` executes, by their first keyword, through the
 * prototype every prepared statement shares.
 */
const installStatementCounter = () => {
  const probe = new DatabaseSync(":memory:");
  const prototype = Object.getPrototypeOf(probe.prepare("SELECT 1")) as Record<
    string,
    (...args: Array<unknown>) => unknown
  >;
  probe.close();
  const counts = new Map<string, number>();
  const statements = new Map<string, number>();
  const originals = new Map<string, (...args: Array<unknown>) => unknown>();
  for (const method of ["all", "get", "run", "iterate"]) {
    const original = prototype[method]!;
    originals.set(method, original);
    prototype[method] = function (this: { readonly sourceSQL: string }, ...args: Array<unknown>) {
      const source = this.sourceSQL.trim();
      const keyword = source.split(/\s+/, 1)[0]!.toUpperCase();
      counts.set(keyword, (counts.get(keyword) ?? 0) + 1);
      const key = source.replace(/\s+/g, " ");
      statements.set(key, (statements.get(key) ?? 0) + 1);
      return original.apply(this, args);
    };
  }
  return {
    reset: () => {
      counts.clear();
      statements.clear();
    },
    total: () => [...counts.values()].reduce((sum, count) => sum + count, 0),
    counts: () => Object.fromEntries(counts),
    statements: () => Object.fromEntries(statements),
    restore: () => {
      for (const [method, original] of originals) prototype[method] = original;
    },
  };
};

const MockProjectAvatarStoreLive = Layer.succeed(ProjectAvatarStore, {
  write: () => Effect.die("ProjectAvatarStore.write not implemented in test"),
  read: () => Effect.succeed(null),
  remove: () => Effect.void,
});

/**
 * Statements per streamed provider event, end to end through the engine. Set
 * RYCO_WRITE_COST_EVENTS (default 200) and RYCO_WRITE_COST_OUT=<file> to write the counts and the
 * wall time per event for a before/after comparison.
 */
describe("orchestration write cost per streamed event", () => {
  it("runs no command receipt statements for a provider activity", async () => {
    const layer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadSessionModelSelections.layer),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(MockProjectAvatarStoreLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolverLive),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "ryco-write-cost-" })),
      Layer.provideMerge(NodeServices.layer),
    );
    const runtime = ManagedRuntime.make(layer);
    const counter = installStatementCounter();
    try {
      const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
      const projectId = ProjectId.make("write-cost-project");
      const threadId = ThreadId.make("write-cost-thread");
      const createdAt = new Date().toISOString();
      const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "fixture" };
      await runtime.runPromise(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("write-cost-project-create"),
          projectId,
          title: "Write cost",
          workspaceRoot: process.cwd(),
          defaultModelSelection: modelSelection,
          createdAt,
        }),
      );
      await runtime.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("write-cost-thread-create"),
          threadId,
          projectId,
          title: "Write cost",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      );

      const events = Number(process.env.RYCO_WRITE_COST_EVENTS ?? 200);
      counter.reset();
      const startedAt = performance.now();
      for (let index = 0; index < events; index += 1) {
        const eventId = randomUUID();
        await runtime.runPromise(
          engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make(`provider:${eventId}:thread-activity-append:${index}`),
            threadId,
            activity: {
              id: EventId.make(eventId),
              tone: "tool",
              kind: "tool.updated",
              summary: "Running a command",
              turnId: null,
              payload: { itemType: "command_execution", detail: `line ${index}` },
              createdAt,
            },
            createdAt,
          }),
        );
      }
      const elapsedMs = performance.now() - startedAt;
      const perEvent = counter.total() / events;
      const report = JSON.stringify(
        {
          events,
          statementsPerEvent: perEvent,
          msPerEvent: Number((elapsedMs / events).toFixed(3)),
          byKeyword: counter.counts(),
          byStatement: Object.fromEntries(
            Object.entries(counter.statements()).map(([statement, count]) => [
              statement.slice(0, 70),
              count,
            ]),
          ),
        },
        null,
        2,
      );
      if (process.env.RYCO_WRITE_COST_OUT) writeFileSync(process.env.RYCO_WRITE_COST_OUT, report);
      expect(perEvent).toBeGreaterThan(0);
      // The event, its projection rows and the projector cursors; no receipt lookup or write.
      expect(
        Object.keys(counter.statements()).filter((statement) =>
          statement.includes("orchestration_command_receipts"),
        ),
      ).toEqual([]);
    } finally {
      counter.restore();
      await runtime.dispose();
    }
  }, 120_000);
});
