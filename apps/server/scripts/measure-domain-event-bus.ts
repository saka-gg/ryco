/** Dispatch throughput of the real orchestration engine (in-memory SQLite) with domain-event
 * subscribers; run with Node (server runtime).
 * node apps/server/scripts/measure-domain-event-bus.ts [count=5000] [stalled=1] [draining=0]
 * `stalled` holds one subscription without reading it while `count` project updates are
 * dispatched (the shape of a reactor blocked on a full lane); `draining` subscribers read every
 * event as it is published. With a stalled subscriber, the stalled stream is then read to the
 * end and timed (catch-up). Prints one JSON line.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ProjectId, type OrchestrationEvent } from "@ryco/contracts";
import { Effect, Layer, ManagedRuntime, Metric, Option, PubSub, Stream } from "effect";

import { ServerConfig } from "../src/config.ts";
import { metricNames } from "../src/observability/Metrics.ts";
import { OrchestrationEngineLive } from "../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../src/orchestration/Services/OrchestrationEngine.ts";
import * as ThreadBackgroundLiveness from "../src/orchestration/ThreadBackgroundLiveness.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../src/persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../src/project/Layers/RepositoryIdentityResolver.ts";
import { ProjectAvatarStore } from "../src/project/Services/ProjectAvatarStore.ts";

const count = Number(process.argv[2] ?? 5000);
const stalled = (process.argv[3] ?? "1") === "1";
const draining = Number(process.argv[4] ?? 0);
if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(draining) || draining < 0)
  throw new Error("Use a positive count and a non-negative number of draining subscribers");
const STALL_TIMEOUT = "20 seconds";

/**
 * The subscription as a stream. Before the gap-replay bus, `subscribeDomainEvents` returned a
 * PubSub subscription; accepting both lets the same script measure the code before the change.
 */
const asStream = (subscription: unknown): Stream.Stream<OrchestrationEvent> =>
  Stream.isStream(subscription)
    ? (subscription as Stream.Stream<OrchestrationEvent>)
    : Stream.fromSubscription(subscription as PubSub.Subscription<OrchestrationEvent>);

const directory = mkdtempSync(join(tmpdir(), "ryco-domain-event-bus-measure-"));
const layer = OrchestrationEngineLive.pipe(
  Layer.provide(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(OrchestrationProjectionPipelineLive),
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(
    Layer.succeed(ProjectAvatarStore, {
      write: () => Effect.die("unused"),
      read: () => Effect.succeed(null),
      remove: () => Effect.void,
    }),
  ),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolverLive),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(directory, { prefix: "ryco-domain-event-bus-" })),
  Layer.provideMerge(NodeServices.layer),
);

const runtime = ManagedRuntime.make(layer);
const counterValue = (id: string) =>
  Effect.map(Metric.snapshot, (snapshots) => {
    let total = 0;
    for (const snapshot of snapshots) {
      if (
        snapshot.id === id &&
        snapshot.type === "Counter" &&
        snapshot.attributes?.queue === "orchestration.domain-events"
      ) {
        total += Number(snapshot.state.count);
      }
    }
    return total;
  });

try {
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const projectId = ProjectId.make("project-measure");
  await runtime.runPromise(
    engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("cmd-measure-create"),
      projectId,
      title: "Measure",
      workspaceRoot: join(directory, "workspace"),
      defaultModelSelection: null,
      createdAt: new Date().toISOString(),
    }),
  );

  let completed = 0;
  const result = await runtime.runPromise(
    Effect.gen(function* () {
      const stalledStream = stalled ? asStream(yield* engine.subscribeDomainEvents) : undefined;
      for (let index = 0; index < draining; index++) {
        yield* Effect.forkScoped(Stream.runDrain(asStream(yield* engine.subscribeDomainEvents)));
      }
      const startedAt = performance.now();
      const flood = yield* Effect.gen(function* () {
        for (let index = 0; index < count; index++) {
          yield* engine.dispatch({
            type: "project.meta.update",
            commandId: CommandId.make(`cmd-measure-${index}`),
            projectId,
            title: `Update ${index}`,
          });
          completed = index + 1;
        }
      }).pipe(Effect.timeoutOption(STALL_TIMEOUT));
      const dispatchMs = performance.now() - startedAt;

      let catchUpMs: number | null = null;
      let caughtUp: number | null = null;
      if (stalledStream !== undefined && Option.isSome(flood)) {
        const catchUpStartedAt = performance.now();
        caughtUp = yield* Stream.runCount(Stream.take(stalledStream, count));
        catchUpMs = performance.now() - catchUpStartedAt;
      }
      return {
        finished: Option.isSome(flood),
        dispatchMs,
        catchUpMs,
        caughtUp,
        gaps: yield* counterValue(metricNames.runtimeQueueOverflowsTotal),
        replayedEvents: yield* counterValue(metricNames.runtimeQueueRecoveriesTotal),
      };
    }).pipe(Effect.scoped),
  );

  console.log(
    JSON.stringify({
      count,
      stalled,
      draining,
      finished: result.finished,
      completed,
      dispatchMs: Math.round(result.dispatchMs),
      perDispatchUs: Math.round((result.dispatchMs * 1000) / Math.max(1, completed)),
      catchUpMs: result.catchUpMs === null ? null : Math.round(result.catchUpMs),
      caughtUp: result.caughtUp,
      gaps: result.gaps,
      replayedEvents: result.replayedEvents,
    }),
  );
} finally {
  // A wedged engine's worker never finishes; do not wait for it on exit.
  await Promise.race([
    runtime.dispose(),
    new Promise((resolve) => setTimeout(resolve, 2_000).unref()),
  ]);
  rmSync(directory, { recursive: true, force: true });
}
process.exit(0);
