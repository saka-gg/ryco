/**
 * Micro-benchmarks for per-event server paths of the persistence work; run with Node.
 *
 *   node apps/server/scripts/bench-persistence-micro.ts [--subscriptions 50] [--events 20000]
 *
 * - replayMetrics: one live enqueue plus dequeue on one of N active shell/thread subscriptions
 *   (the replay gauges used to rescan every subscription per event).
 * - sharedThreadShellReads: N subscribers mapping the same thread event through the shared
 *   thread list (shellSnapshotCopy.ts), counting the shell row reads they cause (one per event
 *   when shared, N before).
 * - commandModelThreadUpdate: one thread update in a command read model of T threads (an
 *   index lookup and one array slot instead of find + map over every thread).
 */
import { parseArgs } from "node:util";

import {
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
} from "@ryco/contracts";
import { Effect, Option } from "effect";

import { findThreadInArray, updateThreadInArray } from "../src/orchestration/threadIndex.ts";
import { makeShellSnapshotCopy } from "../src/orchestration/shellSnapshotCopy.ts";
import { makeWsReplayMetrics } from "../src/wsReplayMetrics.ts";

const { values } = parseArgs({
  options: {
    subscriptions: { type: "string", default: "50" },
    events: { type: "string", default: "20000" },
    threads: { type: "string", default: "5000" },
  },
});
const subscriptions = Number(values.subscriptions);
const events = Number(values.events);
const threadCount = Number(values.threads);
const round = (value: number) => Math.round(value * 100) / 100;

async function replayMetrics() {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const metrics = yield* Effect.forEach(
          Array.from({ length: subscriptions }, (_, index) => index),
          (index) =>
            makeWsReplayMetrics({
              stream: "thread",
              subscriptionId: `bench-${index}`,
              snapshotSequence: 0,
            }),
        );
        const startedAt = performance.now();
        for (let sequence = 1; sequence <= events; sequence += 1) {
          const target = metrics[sequence % subscriptions]!;
          yield* target.recordLiveEnqueued(sequence);
          yield* target.recordLiveDequeued(sequence);
        }
        const elapsed = performance.now() - startedAt;
        for (const target of metrics) yield* target.reset;
        return { microsecondsPerRecord: round((elapsed * 1000) / (2 * events)) };
      }),
    ),
  );
}

async function sharedReads() {
  const threadId = ThreadId.make("bench-thread");
  const shell = {
    id: threadId,
    createdAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T00:00:00.000Z",
    latestTurn: null,
    session: null,
  } as unknown as OrchestrationThreadShell;
  let reads = 0;
  const copy = makeShellSnapshotCopy({
    buildShell: () =>
      Effect.succeed({
        snapshotSequence: 0,
        updatedAt: shell.updatedAt,
        projects: [],
        threads: [shell],
      } as unknown as OrchestrationShellSnapshot),
    getThreadShellById: () =>
      Effect.sync(() => {
        reads += 1;
      }).pipe(Effect.andThen(Effect.as(Effect.yieldNow, Option.some(shell)))),
    getProjectShellById: () => Effect.succeed(Option.none()),
  });
  await Effect.runPromise(copy.read());
  const threadEvents = Math.min(events, 2_000);
  for (let sequence = 1; sequence <= threadEvents; sequence += 1) {
    copy.record([
      {
        type: "thread.activity-appended",
        aggregateKind: "thread",
        aggregateId: threadId,
        sequence,
      },
    ] as unknown as ReadonlyArray<OrchestrationEvent>);
    await Effect.runPromise(
      Effect.all(
        Array.from({ length: subscriptions }, () => copy.readThread(threadId)),
        { concurrency: "unbounded" },
      ),
    );
  }
  return {
    subscribers: subscriptions,
    threadEvents,
    reads,
    readsWithoutSharing: threadEvents * subscriptions,
  };
}

function commandModelThreadUpdate() {
  const threads = Array.from({ length: threadCount }, (_, index) => ({
    id: `thread-${index}`,
    updatedAt: "2026-10-12T00:00:00.000Z",
  }));
  const measure = (update: (model: typeof threads, id: string) => typeof threads) => {
    let model = threads;
    const startedAt = performance.now();
    for (let index = 0; index < events; index += 1) {
      model = update(model, `thread-${(index * 7919) % threadCount}`);
    }
    return round(((performance.now() - startedAt) * 1000) / events);
  };
  const touched = (thread: (typeof threads)[number]) => ({ ...thread, updatedAt: "now" });
  return {
    threads: threadCount,
    findAndMapMicroseconds: measure((model, id) => {
      model.find((thread) => thread.id === id);
      return model.map((thread) => (thread.id === id ? touched(thread) : thread));
    }),
    indexedMicroseconds: measure((model, id) => {
      findThreadInArray(model, id);
      return updateThreadInArray(model, id, touched) as typeof threads;
    }),
  };
}

console.log(
  JSON.stringify(
    {
      replayMetrics: await replayMetrics(),
      sharedThreadShellReads: await sharedReads(),
      commandModelThreadUpdate: commandModelThreadUpdate(),
    },
    null,
    2,
  ),
);
