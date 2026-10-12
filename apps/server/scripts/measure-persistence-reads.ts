/**
 * Measures the persistence read paths on a copy of a Ryco home; run with Node (server runtime).
 *
 *   node apps/server/scripts/measure-persistence-reads.ts --home /tmp/ryco-fixture-home [--runs 3]
 *
 * Generate a home with `bun run perf:fixture-home --out <dir>`. Each run copies the home's
 * database, so the source stays untouched, and reports:
 * - migrationsMs: opening the copy (pending migrations and repairs included);
 * - engineHydrationMs: building the orchestration engine (projector catch-up + command model);
 * - commandModelBytes: JSON size of the engine's in-memory command read model;
 * - shellSnapshotMs: median of 5 full shell snapshot builds;
 * - statistics: cold (first open), after one unrelated write, cached, and first open after a
 *   restart of the runtime, each with its duration, the longest event-loop stall observed while
 *   it ran (5 ms sampler) and the slowest main-connection `SELECT 1` issued every 5 ms meanwhile.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, EventId, ThreadId, type OrchestrationCommand } from "@ryco/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../src/config.ts";
import { OrchestrationEngineLive } from "../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../src/orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../src/orchestration/ThreadBackgroundLiveness.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../src/project/Layers/RepositoryIdentityResolver.ts";
import { ProjectAvatarStore } from "../src/project/Services/ProjectAvatarStore.ts";
import { StatisticsQuery, StatisticsQueryLive } from "../src/statistics/StatisticsQuery.ts";

const MockProjectAvatarStoreLive = Layer.succeed(ProjectAvatarStore, {
  write: () => Effect.die("unused"),
  read: () => Effect.succeed(null),
  remove: () => Effect.void,
});

const median = (values: ReadonlyArray<number>) =>
  values.toSorted((left, right) => left - right)[Math.floor(values.length / 2)]!;
const round = (value: number) => Math.round(value * 10) / 10;

function makeRuntime(dbPath: string, baseDir: string) {
  const persistence = makeSqlitePersistenceLive(dbPath);
  const layer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
    StatisticsQueryLive,
  ).pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(MockProjectAvatarStoreLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provideMerge(persistence),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );
  return ManagedRuntime.make(layer);
}

/** Runs `task` while sampling the event loop and the main connection's latency. */
async function observe<A>(
  runtime: ReturnType<typeof makeRuntime>,
  sql: SqlClient.SqlClient,
  task: () => Promise<A>,
) {
  let lastTick = performance.now();
  let maxLoopGapMs = 0;
  const sampler = setInterval(() => {
    const now = performance.now();
    maxLoopGapMs = Math.max(maxLoopGapMs, now - lastTick);
    lastTick = now;
  }, 5);
  const probing = { active: true };
  let maxMainQueryMs = 0;
  const probe = (async () => {
    while (probing.active) {
      const startedAt = performance.now();
      await runtime.runPromise(sql`SELECT 1`);
      maxMainQueryMs = Math.max(maxMainQueryMs, performance.now() - startedAt);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();
  const startedAt = performance.now();
  const result = await task();
  const durationMs = performance.now() - startedAt;
  probing.active = false;
  await probe;
  clearInterval(sampler);
  return {
    result,
    stats: {
      durationMs: round(durationMs),
      maxLoopGapMs: round(maxLoopGapMs),
      maxMainQueryMs: round(maxMainQueryMs),
    },
  };
}

async function measureOnce(home: string) {
  const work = mkdtempSync(join(tmpdir(), "ryco-measure-persistence-"));
  try {
    const source = join(home, "userdata", "state.sqlite");
    const dbPath = join(work, "state.sqlite");
    copyFileSync(source, dbPath);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(`${source}${suffix}`))
        copyFileSync(`${source}${suffix}`, `${dbPath}${suffix}`);
    }

    const migrationsStartedAt = performance.now();
    const migrations = ManagedRuntime.make(
      makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer)),
    );
    await migrations.runPromise(Effect.void);
    const migrationsMs = performance.now() - migrationsStartedAt;
    await migrations.dispose();

    let runtime = makeRuntime(dbPath, work);
    const hydrationStartedAt = performance.now();
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const engineHydrationMs = performance.now() - hydrationStartedAt;
    const commandModel = await runtime.runPromise(engine.getReadModel!());
    const commandModelBytes = JSON.stringify(commandModel).length;
    const threadId = commandModel.threads.find((thread) => thread.deletedAt === null)!.id;

    const snapshots = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const shellTimes: number[] = [];
    for (let run = 0; run < 5; run += 1) {
      const startedAt = performance.now();
      await runtime.runPromise(snapshots.getShellSnapshot());
      shellTimes.push(performance.now() - startedAt);
    }

    let sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
    let statistics = await runtime.runPromise(Effect.service(StatisticsQuery));
    const cold = await observe(runtime, sql, () => runtime.runPromise(statistics.getStatistics()));
    let serial = 0;
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`measure-${(serial += 1)}`),
        threadId: ThreadId.make(threadId),
        activity: {
          id: EventId.make(`measure-activity-${serial}`),
          tone: "info",
          kind: "measure.note",
          summary: "Measurement note",
          payload: {},
          turnId: null,
          createdAt: new Date().toISOString(),
        },
        createdAt: new Date().toISOString(),
      } as unknown as OrchestrationCommand),
    );
    const afterWrite = await observe(runtime, sql, () =>
      runtime.runPromise(statistics.getStatistics()),
    );
    const cached = await observe(runtime, sql, () =>
      runtime.runPromise(statistics.getStatistics()),
    );
    await runtime.dispose();

    runtime = makeRuntime(dbPath, work);
    await runtime.runPromise(Effect.service(OrchestrationEngineService));
    sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
    statistics = await runtime.runPromise(Effect.service(StatisticsQuery));
    const afterRestart = await observe(runtime, sql, () =>
      runtime.runPromise(statistics.getStatistics()),
    );
    await runtime.dispose();

    return {
      migrationsMs: round(migrationsMs),
      engineHydrationMs: round(engineHydrationMs),
      commandModelBytes,
      shellSnapshotMs: round(median(shellTimes)),
      statistics: {
        cold: cold.stats,
        afterWrite: afterWrite.stats,
        cached: cached.stats,
        afterRestart: afterRestart.stats,
      },
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const { values } = parseArgs({
  options: {
    home: { type: "string" },
    runs: { type: "string", default: "3" },
  },
});
if (!values.home) {
  console.error("Usage: node apps/server/scripts/measure-persistence-reads.ts --home <dir>");
  process.exit(2);
}
const runs = [];
for (let run = 0; run < Number(values.runs); run += 1) {
  runs.push(await measureOnce(resolve(values.home)));
}
console.log(JSON.stringify(runs, null, 2));
