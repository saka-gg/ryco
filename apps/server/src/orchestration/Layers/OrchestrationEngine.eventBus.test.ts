/**
 * The domain-event bus never holds back the command worker: a subscriber that falls behind its
 * live window replays what it missed from the event store, exactly once and in order.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@ryco/contracts";
import { losslessBackpressureQueuePolicy } from "@ryco/shared/QueuePolicy";
import { makeKeyedSerialWorker } from "@ryco/shared/KeyedSerialWorker";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Metric,
  Option,
  Stream,
} from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { metricNames } from "../../observability/Metrics.ts";
import { PersistenceDecodeError, PersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import {
  SqlitePersistenceMemory,
  makeSqlitePersistenceLive,
} from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../../persistence/Services/OrchestrationEventStore.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { ProjectAvatarStore } from "../../project/Services/ProjectAvatarStore.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ORCHESTRATION_DOMAIN_EVENT_BUS_CAPACITY,
  makeOrchestrationEngineLive,
} from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const projectId = ProjectId.make("project-bus");
const BUS_ATTRIBUTES = { queue: "orchestration.domain-events" } as const;

const MockProjectAvatarStoreLive = Layer.succeed(ProjectAvatarStore, {
  write: () => Effect.die("ProjectAvatarStore.write not implemented in test"),
  read: () => Effect.succeed(null),
  remove: () => Effect.void,
});

interface SystemOptions {
  readonly databasePath?: string;
  readonly domainEventBusCapacity?: number;
  readonly decorateEventStore?: (
    live: OrchestrationEventStoreShape,
  ) => OrchestrationEventStoreShape;
  /** Boots the engine on a command read model that reports this snapshot sequence. */
  readonly commandReadModelSequence?: number;
}

const systems: Array<{ readonly dispose: () => Promise<void> }> = [];
const tempDirs: Array<string> = [];

afterEach(async () => {
  for (const system of systems.splice(0)) await system.dispose();
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

const makeDatabasePath = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ryco-event-bus-test-"));
  tempDirs.push(dir);
  return path.join(dir, "state.sqlite");
};

async function createSystem(options: SystemOptions = {}) {
  const eventStoreLayer =
    options.decorateEventStore === undefined
      ? OrchestrationEventStoreLive
      : Layer.effect(
          OrchestrationEventStore,
          Effect.map(Effect.service(OrchestrationEventStore), options.decorateEventStore),
        ).pipe(Layer.provide(OrchestrationEventStoreLive));
  const snapshotQueryLayer =
    options.commandReadModelSequence === undefined
      ? OrchestrationProjectionSnapshotQueryLive
      : Layer.effect(
          ProjectionSnapshotQuery,
          Effect.map(Effect.service(ProjectionSnapshotQuery), (live) => ({
            ...live,
            getCommandReadModel: () =>
              live.getCommandReadModel().pipe(
                Effect.map((model) => ({
                  ...model,
                  snapshotSequence: options.commandReadModelSequence!,
                })),
              ),
          })),
        ).pipe(Layer.provide(OrchestrationProjectionSnapshotQueryLive));
  const layer = makeOrchestrationEngineLive(
    options.domainEventBusCapacity === undefined
      ? {}
      : { domainEventBusCapacity: options.domainEventBusCapacity },
  ).pipe(
    Layer.provide(snapshotQueryLayer),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(MockProjectAvatarStoreLive),
    Layer.provide(eventStoreLayer),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provideMerge(
      options.databasePath
        ? makeSqlitePersistenceLive(options.databasePath)
        : SqlitePersistenceMemory,
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "ryco-event-bus-test-" })),
    Layer.provideMerge(NodeServices.layer),
    // Each system counts into its own registry, so one test's gaps never show up in another's.
    Layer.provideMerge(Layer.succeed(Metric.MetricRegistry, new Map())),
  );
  const runtime = ManagedRuntime.make(layer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  let disposed = false;
  const system = {
    engine,
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    counter: (id: string) =>
      runtime.runPromise(
        Effect.map(Metric.snapshot, (snapshots) => {
          let total = 0;
          for (const snapshot of snapshots) {
            if (
              snapshot.id === id &&
              snapshot.type === "Counter" &&
              Object.entries(BUS_ATTRIBUTES).every(
                ([key, value]) => snapshot.attributes?.[key] === value,
              )
            ) {
              total += Number(snapshot.state.count);
            }
          }
          return total;
        }),
      ),
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await runtime.dispose();
    },
  };
  systems.push(system);
  return system;
}

type System = Awaited<ReturnType<typeof createSystem>>;

const createProject = (): OrchestrationCommand => ({
  type: "project.create",
  commandId: CommandId.make("cmd-bus-project-create"),
  projectId,
  title: "Bus Project",
  workspaceRoot: "/tmp/project-bus",
  defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
  createdAt: new Date().toISOString(),
});

let commandCounter = 0;
const updateTitle = (title: string): OrchestrationCommand => ({
  type: "project.meta.update",
  commandId: CommandId.make(`cmd-bus-update-${++commandCounter}`),
  projectId,
  title,
});

const dispatchUpdates = (system: System, count: number, prefix = "Update") =>
  Effect.forEach(
    Array.from({ length: count }, (_, index) => index),
    (index) => system.engine.dispatch(updateTitle(`${prefix} ${index}`)),
    { discard: true },
  );

const sequencesOf = (events: Iterable<OrchestrationEvent>) =>
  Array.from(events, (event) => event.sequence);

const range = (fromInclusive: number, throughInclusive: number) =>
  Array.from({ length: throughInclusive - fromInclusive + 1 }, (_, index) => fromInclusive + index);

/** Collects a subscription until (and including) `finalSequence`. */
const collectThrough = (events: Stream.Stream<OrchestrationEvent>, finalSequence: number) =>
  events.pipe(
    Stream.takeUntil((event) => event.sequence >= finalSequence),
    Stream.runCollect,
    Effect.map(sequencesOf),
  );

const titleOf = (event: OrchestrationEvent) =>
  event.type === "project.meta-updated" ? event.payload.title : undefined;

describe("OrchestrationEngine domain-event bus", () => {
  it("keeps dispatch responsive and replays every event to a subscriber that falls behind", async () => {
    const system = await createSystem();
    const { sequence: createdSequence } = await system.run(system.engine.dispatch(createProject()));
    const count = ORCHESTRATION_DOMAIN_EVENT_BUS_CAPACITY + 510;

    const delivered = await system.run(
      Effect.gen(function* () {
        const live = yield* system.engine.subscribeDomainEvents;
        // Nothing drains `live` here: the old bus stopped the command worker at its capacity.
        const flood = yield* dispatchUpdates(system, count).pipe(
          Effect.timeoutOption("10 seconds"),
        );
        expect(Option.isSome(flood)).toBe(true);
        return Array.from(yield* Stream.runCollect(Stream.take(live, count)));
      }).pipe(Effect.scoped),
    );

    expect(sequencesOf(delivered)).toEqual(range(createdSequence + 1, createdSequence + count));
    expect(titleOf(delivered.at(-1)!)).toBe(`Update ${count - 1}`);
    expect(await system.counter(metricNames.runtimeQueueOverflowsTotal)).toBe(1);
    expect(await system.counter(metricNames.runtimeQueueRecoveriesTotal)).toBe(
      count - ORCHESTRATION_DOMAIN_EVENT_BUS_CAPACITY,
    );
  });

  it("never wedges when a reactor's lane items wait on dispatch while the bus overflows", async () => {
    const system = await createSystem();
    await system.run(system.engine.dispatch(createProject()));
    const count = ORCHESTRATION_DOMAIN_EVENT_BUS_CAPACITY + 510;

    await system.run(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const sawSecondTrigger = yield* Deferred.make<void>();
        const seen: Array<number> = [];
        const followUps: Array<number> = [];
        // The shape of ProviderCommandReactor: a lossless lane whose items dispatch commands.
        const lanes = yield* makeKeyedSerialWorker({
          policy: losslessBackpressureQueuePolicy({ component: "test.reactor", capacity: 1 }),
          process: (_key: string, index: number) =>
            Deferred.await(gate).pipe(
              Effect.andThen(system.engine.dispatch(updateTitle(`Follow-up ${index}`))),
              Effect.map(({ sequence }) => {
                followUps[index] = sequence;
              }),
            ),
        });
        const events = yield* system.engine.subscribeDomainEvents;
        yield* Effect.forkScoped(
          Stream.runForEach(events, (event) =>
            Effect.gen(function* () {
              seen.push(event.sequence);
              const title = titleOf(event);
              if (title?.startsWith("Trigger ") !== true) return;
              const index = Number(title.slice("Trigger ".length));
              if (index === 1) yield* Deferred.succeed(sawSecondTrigger, undefined);
              // The second trigger waits here until the first lane item finishes.
              yield* lanes.enqueue("project", index);
            }),
          ),
        );

        yield* system.engine.dispatch(updateTitle("Trigger 0"));
        yield* system.engine.dispatch(updateTitle("Trigger 1"));
        yield* Deferred.await(sawSecondTrigger);

        const flood = yield* dispatchUpdates(system, count).pipe(
          Effect.timeoutOption("10 seconds"),
        );
        expect(Option.isSome(flood)).toBe(true);

        yield* Deferred.succeed(gate, undefined);
        const settled = yield* Effect.gen(function* () {
          while (followUps[1] === undefined || seen.at(-1)! < followUps[1]) {
            yield* Effect.sleep("5 millis");
          }
        }).pipe(Effect.timeoutOption("10 seconds"));
        expect(Option.isSome(settled)).toBe(true);

        expect(followUps[0]).toBeLessThan(followUps[1]!);
        expect(seen).toEqual(range(seen[0]!, followUps[1]!));
      }).pipe(Effect.scoped),
    );
  });

  it("starts each subscription exactly after the last published event, even while publishing", async () => {
    const system = await createSystem({ domainEventBusCapacity: 16 });
    const { sequence: createdSequence } = await system.run(system.engine.dispatch(createProject()));
    const count = 300;
    const finalSequence = createdSequence + count;

    const results = await system.run(
      Effect.gen(function* () {
        // Advanced by the flood fiber.
        const progress = { dispatched: 0 };
        const flood = yield* Effect.forEach(
          range(1, count),
          (index) =>
            system.engine
              .dispatch(updateTitle(`Concurrent ${index}`))
              .pipe(Effect.tap(() => Effect.sync(() => (progress.dispatched = index)))),
          { discard: true },
        ).pipe(Effect.forkScoped);

        const eager: Array<Fiber.Fiber<ReadonlyArray<number>>> = [];
        const lagging: Array<Stream.Stream<OrchestrationEvent>> = [];
        for (let index = 0; index < 20; index++) {
          while (progress.dispatched < index * 14) yield* Effect.sleep("1 millis");
          const events = yield* system.engine.subscribeDomainEvents;
          if (index % 2 === 0) {
            eager.push(yield* Effect.forkScoped(collectThrough(events, finalSequence)));
          } else {
            lagging.push(events);
          }
        }
        yield* Fiber.join(flood);
        const late = yield* Effect.forEach(lagging, (events) =>
          collectThrough(events, finalSequence),
        );
        const early = yield* Effect.forEach(eager, Fiber.join);
        return [...early, ...late];
      }).pipe(Effect.scoped),
    );

    expect(results).toHaveLength(20);
    for (const sequences of results) {
      expect(sequences.length).toBeGreaterThan(0);
      expect(sequences).toEqual(range(sequences[0]!, finalSequence));
    }
    expect(await system.counter(metricNames.runtimeQueueOverflowsTotal)).toBeGreaterThan(0);
  });

  it("retries a failed gap read and never skips or repeats", async () => {
    let armed = false;
    let attempts = 0;
    const system = await createSystem({
      domainEventBusCapacity: 16,
      decorateEventStore: (live) => ({
        ...live,
        readThroughSequence: (fromExclusive, throughInclusive, options) =>
          Stream.suspend(() => {
            if (!armed) return live.readThroughSequence(fromExclusive, throughInclusive, options);
            attempts += 1;
            return attempts <= 2
              ? Stream.fail(
                  new PersistenceSqlError({ operation: "test.gap", detail: "database is locked" }),
                )
              : live.readThroughSequence(fromExclusive, throughInclusive, options);
          }),
      }),
    });
    const { sequence: createdSequence } = await system.run(system.engine.dispatch(createProject()));
    // Projector bootstrap also reads ranges; fail only the subscriber's reads.
    armed = true;

    const delivered = await system.run(
      Effect.gen(function* () {
        const events = yield* system.engine.subscribeDomainEvents;
        yield* dispatchUpdates(system, 100);
        return yield* collectThrough(events, createdSequence + 100);
      }).pipe(Effect.scoped),
    );

    expect(delivered).toEqual(range(createdSequence + 1, createdSequence + 100));
    expect(attempts).toBe(3);
  });

  it("resumes a gap read that failed midway after the last event it delivered", async () => {
    let armed = false;
    const reads: Array<readonly [number, number]> = [];
    const system = await createSystem({
      domainEventBusCapacity: 16,
      decorateEventStore: (live) => ({
        ...live,
        readThroughSequence: (fromExclusive, throughInclusive, options) => {
          if (!armed) return live.readThroughSequence(fromExclusive, throughInclusive, options);
          reads.push([fromExclusive, throughInclusive]);
          // The first read hands on 10 events, then fails.
          return reads.length === 1
            ? live
                .readThroughSequence(fromExclusive, fromExclusive + 10, options)
                .pipe(
                  Stream.concat(
                    Stream.fail(
                      new PersistenceSqlError({ operation: "test.gap", detail: "disk I/O error" }),
                    ),
                  ),
                )
            : live.readThroughSequence(fromExclusive, throughInclusive, options);
        },
      }),
    });
    const { sequence: createdSequence } = await system.run(system.engine.dispatch(createProject()));
    armed = true;

    const delivered = await system.run(
      Effect.gen(function* () {
        const events = yield* system.engine.subscribeDomainEvents;
        yield* dispatchUpdates(system, 100);
        return yield* collectThrough(events, createdSequence + 100);
      }).pipe(Effect.scoped),
    );

    expect(delivered).toEqual(range(createdSequence + 1, createdSequence + 100));
    expect(reads).toHaveLength(2);
    const [[firstFrom, through], [resumedFrom, resumedThrough]] = reads as [
      readonly [number, number],
      readonly [number, number],
    ];
    expect(firstFrom).toBe(createdSequence);
    expect(resumedFrom).toBe(firstFrom + 10);
    expect(resumedThrough).toBe(through);
    // Each missed event is counted once, even though the read was retried.
    expect(await system.counter(metricNames.runtimeQueueRecoveriesTotal)).toBe(through - firstFrom);
  });

  it("ends a subscription it cannot decode a missed event for instead of retrying forever", async () => {
    let armed = false;
    let attempts = 0;
    const system = await createSystem({
      domainEventBusCapacity: 16,
      decorateEventStore: (live) => ({
        ...live,
        readThroughSequence: (fromExclusive, throughInclusive, options) =>
          Stream.suspend(() => {
            if (!armed) return live.readThroughSequence(fromExclusive, throughInclusive, options);
            attempts += 1;
            return Stream.fail(
              new PersistenceDecodeError({ operation: "test.gap", issue: "unknown event type" }),
            );
          }),
      }),
    });
    const { sequence: createdSequence } = await system.run(system.engine.dispatch(createProject()));
    armed = true;

    const exit = await system.run(
      Effect.gen(function* () {
        const events = yield* system.engine.subscribeDomainEvents;
        yield* dispatchUpdates(system, 100);
        return yield* Effect.exit(collectThrough(events, createdSequence + 100));
      }).pipe(Effect.scoped),
    );

    expect(Exit.isFailure(exit) && Exit.hasDies(exit)).toBe(true);
    expect(attempts).toBe(1);
  });

  it("publishes each event once through the failure-reconcile path", async () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;
    const after = (sequenceExclusive: number) =>
      events.filter((event) => event.sequence > sequenceExclusive);
    const nonTransactionalStore: OrchestrationEventStoreShape = {
      append: (event) => {
        const saved = { ...event, sequence: nextSequence++ } as StoredEvent;
        events.push(saved);
        return Effect.succeed(saved);
      },
      readFromSequence: (sequenceExclusive) => Stream.fromIterable(after(sequenceExclusive)),
      readThroughSequence: (sequenceExclusive, sequenceInclusive) =>
        Stream.fromIterable(
          after(sequenceExclusive).filter((event) => event.sequence <= sequenceInclusive),
        ),
      latestSequence: Effect.sync(() => events.at(-1)?.sequence ?? 0),
      readPage: (sequenceExclusive, limit) => {
        const page = after(sequenceExclusive).slice(0, limit);
        return Effect.succeed({
          events: page,
          nextSequence: page.at(-1)?.sequence ?? sequenceExclusive,
          hasMore: after(page.at(-1)?.sequence ?? sequenceExclusive).length > 0,
        });
      },
      readAll: () => Stream.fromIterable(events),
      hasEventAfter: () => Effect.succeed(false),
      readStreamEventsPage: (input) =>
        Effect.succeed({ events: [], nextSequence: input.fromSequenceExclusive, hasMore: false }),
    };
    let failProjection = true;
    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectEvent: () => Effect.void,
      projectEventInTransaction: (event) => {
        if (failProjection && event.commandId === CommandId.make("cmd-bus-archive-fail")) {
          failProjection = false;
          return Effect.fail(
            new PersistenceSqlError({ operation: "test.projection", detail: "projection failed" }),
          );
        }
        return Effect.succeed(Effect.void);
      },
    };
    const runtime = ManagedRuntime.make(
      makeOrchestrationEngineLive().pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(ThreadBackgroundLiveness.layer),
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(Layer.succeed(OrchestrationEventStore, nonTransactionalStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(SqlitePersistenceMemory),
      ),
    );
    systems.push({ dispose: () => runtime.dispose() });
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const threadId = ThreadId.make("thread-bus-reconcile");
    const createdAt = new Date().toISOString();

    const delivered = await runtime.runPromise(
      Effect.gen(function* () {
        const live = yield* engine.subscribeDomainEvents;
        yield* engine.dispatch(createProject());
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-bus-thread-create"),
          threadId,
          projectId,
          title: "Reconcile",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-bus-turn-start"),
          threadId,
          message: {
            messageId: MessageId.make("message-bus-reconcile"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
        });
        // Appended, but its projection fails: the reconcile path publishes it.
        const failed = yield* Effect.exit(
          engine.dispatch({
            type: "thread.archive",
            commandId: CommandId.make("cmd-bus-archive-fail"),
            threadId,
          }),
        );
        expect(Exit.isFailure(failed)).toBe(true);
        // Rejected by the decider: the reconcile path runs again and finds nothing new.
        const rejected = yield* Effect.exit(
          engine.dispatch({
            type: "thread.archive",
            commandId: CommandId.make("cmd-bus-archive-retry"),
            threadId,
          }),
        );
        expect(Exit.isFailure(rejected)).toBe(true);
        const { sequence: finalSequence } = yield* engine.dispatch({
          type: "thread.unarchive",
          commandId: CommandId.make("cmd-bus-unarchive"),
          threadId,
        });
        return yield* collectThrough(live, finalSequence);
      }).pipe(Effect.scoped),
    );

    expect(delivered).toEqual(sequencesOf(events));
    expect(events.map((event) => event.type)).toContain("thread.archived");
  });

  it("keeps streamDomainEvents hot: a run receives only events committed after it starts", async () => {
    const system = await createSystem();
    const { sequence: createdSequence } = await system.run(system.engine.dispatch(createProject()));

    const head = await system.run(
      Effect.gen(function* () {
        const first = yield* Effect.forkScoped(Stream.runHead(system.engine.streamDomainEvents));
        // The run subscribes when it starts; keep committing until it has seen one event.
        let index = 0;
        while (first.pollUnsafe() === undefined) {
          yield* system.engine.dispatch(updateTitle(`Hot ${index++}`));
          yield* Effect.sleep("1 millis");
        }
        return yield* Fiber.join(first);
      }).pipe(Effect.scoped),
    );

    expect(Option.isSome(head)).toBe(true);
    expect(Option.getOrThrow(head).sequence).toBeGreaterThan(createdSequence);
    expect(await system.counter(metricNames.runtimeQueueOverflowsTotal)).toBe(0);
  });

  it("delivers nothing committed before a restart", async () => {
    const databasePath = await makeDatabasePath();
    const first = await createSystem({ databasePath });
    await first.run(first.engine.dispatch(createProject()));
    await first.run(dispatchUpdates(first, 20, "Before restart"));
    await first.dispose();

    let gapReads = 0;
    let armed = false;
    const second = await createSystem({
      databasePath,
      domainEventBusCapacity: 16,
      decorateEventStore: (live) => ({
        ...live,
        readThroughSequence: (fromExclusive, throughInclusive, options) => {
          if (armed) gapReads += 1;
          return live.readThroughSequence(fromExclusive, throughInclusive, options);
        },
      }),
    });
    armed = true;
    const bootSequence = second.engine.bootSequence;
    expect(bootSequence).toBe(21);

    const delivered = await second.run(
      Effect.gen(function* () {
        const subscribed = yield* second.engine.subscribeDomainEvents;
        const streamed = yield* Effect.forkScoped(Stream.runHead(second.engine.streamDomainEvents));
        yield* Effect.sleep("10 millis");
        const { sequence } = yield* second.engine.dispatch(updateTitle("After restart"));
        const head = yield* Stream.runHead(subscribed);
        return { sequence, head, streamed: yield* Fiber.join(streamed) };
      }).pipe(Effect.scoped),
    );

    expect(delivered.sequence).toBe(bootSequence + 1);
    expect(Option.map(delivered.head, (event) => event.sequence)).toEqual(
      Option.some(bootSequence + 1),
    );
    expect(Option.map(delivered.streamed, (event) => event.sequence)).toEqual(
      Option.some(bootSequence + 1),
    );
    expect(gapReads).toBe(0);
    expect(await second.counter(metricNames.runtimeQueueOverflowsTotal)).toBe(0);
    expect(await second.counter(metricNames.runtimeQueueRecoveriesTotal)).toBe(0);
  });

  it("never republishes events committed before boot through the failure-reconcile path", async () => {
    const databasePath = await makeDatabasePath();
    const first = await createSystem({ databasePath });
    const { sequence: createdSequence } = await first.run(first.engine.dispatch(createProject()));
    await first.run(dispatchUpdates(first, 20, "Before restart"));
    await first.dispose();

    // A command read model that lags the store head: the reconcile path re-reads from it.
    const second = await createSystem({
      databasePath,
      domainEventBusCapacity: 16,
      commandReadModelSequence: createdSequence,
    });
    const bootSequence = second.engine.bootSequence;

    const delivered = await second.run(
      Effect.gen(function* () {
        const live = yield* second.engine.subscribeDomainEvents;
        // The first command after boot fails: the reconcile path re-reads every event above the
        // lagging read model's sequence, all of them committed before boot.
        const rejected = yield* Effect.exit(
          second.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("cmd-bus-thread-missing-project"),
            threadId: ThreadId.make("thread-bus-missing-project"),
            projectId: ProjectId.make("project-bus-missing"),
            title: "Missing project",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            branch: null,
            worktreePath: null,
            createdAt: new Date().toISOString(),
          }),
        );
        expect(Exit.isFailure(rejected)).toBe(true);
        yield* dispatchUpdates(second, 4, "After restart");
        return yield* collectThrough(live, bootSequence + 4);
      }).pipe(Effect.scoped),
    );

    expect(delivered).toEqual(range(bootSequence + 1, bootSequence + 4));
    expect(await second.counter(metricNames.runtimeQueueOverflowsTotal)).toBe(0);
  });

  it("delivers an event another process appended, once and in order", async () => {
    const databasePath = await makeDatabasePath();
    const local = await createSystem({ databasePath });
    const { sequence: createdSequence } = await local.run(local.engine.dispatch(createProject()));
    // A second engine on the same database, like an offline `ryco project` command.
    const foreign = await createSystem({ databasePath });

    const delivered = await local.run(
      Effect.gen(function* () {
        const live = yield* local.engine.subscribeDomainEvents;
        yield* local.engine.dispatch(updateTitle("Local 1"));
        yield* Effect.promise(() => foreign.run(foreign.engine.dispatch(updateTitle("Foreign"))));
        const { sequence: finalSequence } = yield* local.engine.dispatch(updateTitle("Local 2"));
        return yield* live.pipe(
          Stream.takeUntil((event) => event.sequence >= finalSequence),
          Stream.runCollect,
        );
      }).pipe(Effect.scoped),
    );

    expect(sequencesOf(delivered)).toEqual(range(createdSequence + 1, createdSequence + 3));
    expect(Array.from(delivered, titleOf)).toEqual(["Local 1", "Foreign", "Local 2"]);
  });
});
