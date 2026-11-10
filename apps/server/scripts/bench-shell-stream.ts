/**
 * Measures what the thread list ("shell") costs the server while an agent streams; run with Node.
 *
 *   node apps/server/scripts/bench-shell-stream.ts --home /path/to/fixture-home \
 *     [--subscribers 5] [--stream-seconds 10] [--reconnects 20]
 *
 * The home comes from `generate-fixture-home.ts` (the report's numbers use 4,500 threads, 60%
 * archived). The database is copied first, so runs repeat. It reports, as JSON:
 * - reconnect: the time a shell snapshot takes when one event arrived since the previous one (an
 *   agent is streaming), for both forms, the main thread's busy time during those reads, and the
 *   bytes one paged, stubbed snapshot sends;
 * - streaming: with `--subscribers` shell subscriptions open, one thread streams an assistant
 *   message (20 deltas a second) and a tool activity (2 a second) for `--stream-seconds`; the
 *   shell bytes and items every subscriber received per second.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  OrchestrationGetSnapshotError,
  ProviderInstanceId,
  RuntimeSessionId,
  type OrchestrationCommand,
  type OrchestrationShellStreamItem,
  type ThreadId,
  TurnId,
} from "@ryco/contracts";
import { Effect, Fiber, Layer, ManagedRuntime, Stream } from "effect";

import { ServerConfig } from "../src/config.ts";
import { OrchestrationEngineLive } from "../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../src/orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  readStubbedShellSnapshot,
} from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../src/orchestration/ThreadBackgroundLiveness.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../src/persistence/Services/OrchestrationEventStore.ts";
import { RepositoryIdentityResolverLive } from "../src/project/Layers/RepositoryIdentityResolver.ts";
import { ProjectAvatarStore } from "../src/project/Services/ProjectAvatarStore.ts";
import { makeOrchestrationStreamHelpers } from "../src/ws/context/orchestrationStreams.ts";
import { pageShellSnapshot } from "../src/ws/context/shellSnapshotPages.ts";

const { values } = parseArgs({
  options: {
    home: { type: "string" },
    subscribers: { type: "string", default: "5" },
    "stream-seconds": { type: "string", default: "10" },
    reconnects: { type: "string", default: "20" },
  },
});
if (values.home === undefined) throw new Error("--home is required");
const sourceDb = join(resolve(values.home), "userdata", "state.sqlite");
if (!existsSync(sourceDb)) throw new Error(`No database at ${sourceDb}`);
const subscriberCount = Number(values.subscribers);
const streamSeconds = Number(values["stream-seconds"]);
const reconnects = Number(values.reconnects);

const workDir = mkdtempSync(join(tmpdir(), "ryco-bench-shell-"));
const dbPath = join(workDir, "state.sqlite");
copyFileSync(sourceDb, dbPath);

const MockProjectAvatarStoreLive = Layer.succeed(ProjectAvatarStore, {
  write: () => Effect.die("unused"),
  read: () => Effect.succeed(null),
  remove: () => Effect.void,
});
const layer = OrchestrationEngineLive.pipe(
  Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(OrchestrationProjectionPipelineLive),
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(MockProjectAvatarStoreLive),
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolverLive),
  Layer.provideMerge(makeSqlitePersistenceLive(dbPath, { checkpointWorker: false })),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), workDir)),
  Layer.provideMerge(NodeServices.layer),
);
const runtime = ManagedRuntime.make(layer);

type Services = Layer.Success<typeof layer>;
const run = <A, E>(effect: Effect.Effect<A, E, Services>) => runtime.runPromise(effect);
const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const median = (values: ReadonlyArray<number>) => {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};
const round = (value: number) => Math.round(value * 100) / 100;

async function main() {
  const { engine, query, eventStore } = await run(
    Effect.all({
      engine: Effect.service(OrchestrationEngineService),
      query: Effect.service(ProjectionSnapshotQuery),
      eventStore: Effect.service(OrchestrationEventStore),
    }),
  );
  let serial = 0;
  const dispatch = (command: Record<string, unknown>) =>
    run(
      engine.dispatch({
        ...command,
        commandId: CommandId.make(`bench-${(serial += 1)}`),
      } as unknown as OrchestrationCommand),
    );

  const first = await run(query.getShellSnapshot());
  const live = first.threads.filter((thread) => thread.archivedAt === null);
  const threadId = live.at(-1)!.id as ThreadId;
  const turnId = TurnId.make("bench-turn");
  const messageId = MessageId.make("bench-assistant");
  const now = () => new Date().toISOString();
  await dispatch({
    type: "thread.turn.start",
    threadId,
    message: { messageId: MessageId.make("bench-user"), role: "user", text: "go", attachments: [] },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: now(),
  });
  await dispatch({
    type: "thread.session.set",
    threadId,
    session: {
      threadId,
      status: "running",
      providerName: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeSessionId: RuntimeSessionId.make("bench-runtime"),
      runtimeMode: "full-access",
      activeTurnId: turnId,
      lastError: null,
      updatedAt: now(),
    },
    createdAt: now(),
  });
  const delta = () =>
    dispatch({
      type: "thread.message.assistant.delta",
      threadId,
      messageId,
      delta: "streamed words ",
      turnId,
      createdAt: now(),
    });
  let activitySerial = 0;
  const activity = () => {
    activitySerial += 1;
    return dispatch({
      type: "thread.activity.append",
      threadId,
      activity: {
        id: EventId.make(`bench-activity-${activitySerial}`),
        tone: "tool",
        kind: activitySerial % 2 === 0 ? "tool.completed" : "tool.started",
        summary: "Read",
        payload: { toolName: "Read" },
        turnId,
        createdAt: now(),
      },
      createdAt: now(),
    });
  };

  // Reconnects while an agent streams: one event between consecutive snapshots.
  const measureReconnects = async (read: () => Promise<unknown>) => {
    const times: number[] = [];
    const elu = performance.eventLoopUtilization();
    for (let index = 0; index < reconnects; index += 1) {
      await delta();
      const startedAt = performance.now();
      await read();
      times.push(performance.now() - startedAt);
    }
    const busy = performance.eventLoopUtilization(elu);
    return { medianMs: round(median(times)), maxMs: round(Math.max(...times)), busy };
  };
  // Warm both forms once.
  await run(readStubbedShellSnapshot(query));
  const stubbedReconnect = await measureReconnects(() => run(readStubbedShellSnapshot(query)));
  const fullReconnect = await measureReconnects(() => run(query.getShellSnapshot()));
  const stubbed = await run(readStubbedShellSnapshot(query));
  const full = await run(query.getShellSnapshot());
  const pagedBytes = pageShellSnapshot(stubbed).reduce(
    (total, page) => total + page.reduce((sum, item) => sum + bytesOf(item), 0),
    0,
  );

  const asSnapshotError = Effect.mapError(
    (cause: unknown) => new OrchestrationGetSnapshotError({ message: "bench", cause }),
  );
  // N shell subscriptions while one thread streams.
  const helpers = makeOrchestrationStreamHelpers({
    orchestrationEngine: engine,
    projectionSnapshotQuery: query,
    repositoryIdentityResolver: {
      resolve: () => Effect.succeed(null),
    } as never,
    ...(eventStore.probeResume ? { probeResume: eventStore.probeResume } : {}),
    ...(eventStore.readReplayFloor ? { readReplayFloor: eventStore.readReplayFloor } : {}),
    readStreamEventsPage: eventStore.readStreamEventsPage,
    ...(eventStore.readEventHeadersPage
      ? { readEventHeadersPage: eventStore.readEventHeadersPage }
      : {}),
  });
  interface Counter {
    snapshotDone: boolean;
    bytes: number;
    items: number;
    upserts: number;
  }
  const counters: Counter[] = [];
  const fibers: Array<Fiber.Fiber<void, unknown>> = [];
  const ready: Array<Promise<void>> = [];
  for (let index = 0; index < subscriberCount; index += 1) {
    const counter: Counter = { snapshotDone: false, bytes: 0, items: 0, upserts: 0 };
    counters.push(counter);
    let markReady!: () => void;
    ready.push(new Promise((done) => (markReady = done)));
    const stream = helpers.makeReplayableShellStream(asSnapshotError(query.getShellSnapshot()), {
      snapshotDelivery: "paged",
      stubbedSnapshot: asSnapshotError(readStubbedShellSnapshot(query)),
    }) as Stream.Stream<OrchestrationShellStreamItem, OrchestrationGetSnapshotError>;
    fibers.push(
      runtime.runFork(
        Stream.runForEach(stream, (item) =>
          Effect.sync(() => {
            if (!counter.snapshotDone) {
              if (item.kind === "snapshot-end" || item.kind === "snapshot") {
                counter.snapshotDone = true;
                markReady();
              }
              return;
            }
            counter.items += 1;
            counter.bytes += bytesOf(item);
            if (item.kind === "thread-upserted") counter.upserts += 1;
          }),
        ),
      ),
    );
  }
  await Promise.all(ready);
  const streamStartedAt = performance.now();
  const elu = performance.eventLoopUtilization();
  let ticks = 0;
  while (performance.now() - streamStartedAt < streamSeconds * 1000) {
    ticks += 1;
    await delta();
    if (ticks % 10 === 0) await activity();
    await new Promise((done) => setTimeout(done, 50));
  }
  const streamedMs = performance.now() - streamStartedAt;
  const busy = performance.eventLoopUtilization(elu);
  await new Promise((done) => setTimeout(done, 1_000));
  for (const fiber of fibers) await run(Fiber.interrupt(fiber));
  const seconds = streamedMs / 1000;
  const totalBytes = counters.reduce((sum, counter) => sum + counter.bytes, 0);
  const totalUpserts = counters.reduce((sum, counter) => sum + counter.upserts, 0);

  /** Resumes the shell from `from` and waits until it goes quiet (median of 5). */
  const measureResume = async (from: number) => {
    const times: number[] = [];
    let bytes = 0;
    let items = 0;
    let snapshot = false;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const stream = helpers.makeReplayableShellStream(asSnapshotError(query.getShellSnapshot()), {
        resumeFromSequence: from,
        snapshotDelivery: "paged",
        stubbedSnapshot: asSnapshotError(readStubbedShellSnapshot(query)),
      }) as Stream.Stream<OrchestrationShellStreamItem, OrchestrationGetSnapshotError>;
      let lastItemAt = performance.now();
      bytes = 0;
      items = 0;
      const startedAt = performance.now();
      const fiber = runtime.runFork(
        Stream.runForEach(stream, (item) =>
          Effect.sync(() => {
            lastItemAt = performance.now();
            bytes += bytesOf(item);
            items += 1;
            if (item.kind === "snapshot-begin" || item.kind === "snapshot") snapshot = true;
          }),
        ),
      );
      while (performance.now() - lastItemAt < 200) {
        await new Promise((done) => setTimeout(done, 20));
      }
      times.push(lastItemAt - startedAt);
      await run(Fiber.interrupt(fiber));
    }
    return { medianMs: round(median(times)), bytes, items, snapshot };
  };
  const resumeWithinWindow = await measureResume(
    Math.max(1, (await run(eventStore.latestSequence)) - 1_000),
  );
  // 3,000 events on 20 threads: beyond the 1,000 events the event log replays.
  const gapStart = await run(eventStore.latestSequence);
  for (let index = 0; index < 3_000; index += 1) {
    activitySerial += 1;
    await dispatch({
      type: "thread.activity.append",
      threadId: live[index % 20]!.id,
      activity: {
        id: EventId.make(`bench-gap-activity-${activitySerial}`),
        tone: "tool",
        kind: "tool.started",
        summary: "Read",
        payload: { toolName: "Read" },
        turnId: null,
        createdAt: now(),
      },
      createdAt: now(),
    });
  }
  const resumeAfterGap = await measureResume(gapStart);

  // A client that missed the last ~1,000 events resumes the shell (median of 5).
  const latest = await run(eventStore.latestSequence);
  const resumeTimes: number[] = [];
  let resumeBytes = 0;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const stream = helpers.makeReplayableShellStream(
      Effect.die("a resumed shell loads no snapshot"),
      { resumeFromSequence: Math.max(1, latest - 1_000) },
    ) as Stream.Stream<OrchestrationShellStreamItem, OrchestrationGetSnapshotError>;
    let lastItemAt = performance.now();
    let bytes = 0;
    const startedAt = performance.now();
    const fiber = runtime.runFork(
      Stream.runForEach(stream, (item) =>
        Effect.sync(() => {
          lastItemAt = performance.now();
          bytes += bytesOf(item);
        }),
      ),
    );
    while (performance.now() - lastItemAt < 200) {
      await new Promise((done) => setTimeout(done, 20));
    }
    resumeTimes.push(lastItemAt - startedAt);
    resumeBytes = bytes;
    await run(Fiber.interrupt(fiber));
  }

  const result = {
    threads: full.threads.length,
    liveThreads: live.length,
    reconnect: {
      stubbed: { ...stubbedReconnect, busy: round(stubbedReconnect.busy.utilization) },
      full: { ...fullReconnect, busy: round(fullReconnect.busy.utilization) },
      pagedStubbedBytes: pagedBytes,
      fullSnapshotItemBytes: bytesOf({ kind: "snapshot", snapshot: full }),
    },
    streaming: {
      subscribers: subscriberCount,
      seconds: round(seconds),
      deltasPerSecond: round(ticks / seconds),
      shellBytesPerSecondAllSubscribers: Math.round(totalBytes / seconds),
      shellBytesPerSecondPerSubscriber: Math.round(totalBytes / seconds / subscriberCount),
      threadUpsertsPerSecondPerSubscriber: round(totalUpserts / seconds / subscriberCount),
      eventLoopUtilization: round(busy.utilization),
    },
    resume1000Events: { medianMs: round(median(resumeTimes)), bytes: resumeBytes },
    resumeWithinWindow,
    resumeAfter3000EventsOn20Threads: resumeAfterGap,
  };
  console.log(JSON.stringify(result, null, 2));
  await runtime.dispose();
  rmSync(workDir, { recursive: true, force: true });
}

main().catch(async (error) => {
  console.error(error);
  rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
});
