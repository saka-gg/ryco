import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { Deferred, Effect, Fiber } from "effect";

import { makeKeyedSerialWorker } from "./KeyedSerialWorker.ts";
import { losslessBackpressureQueuePolicy } from "./QueuePolicy.ts";

const policy = (capacity: number) =>
  losslessBackpressureQueuePolicy({ component: "keyed-serial-worker-test", capacity });

describe("makeKeyedSerialWorker", () => {
  it.live("runs the items of one key in FIFO order", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const worker = yield* makeKeyedSerialWorker({
          policy: policy(16),
          process: (_key: string, item: string) =>
            Effect.gen(function* () {
              yield* Effect.yieldNow;
              processed.push(item);
            }),
        });
        for (const item of ["a1", "a2", "a3", "a4"]) yield* worker.enqueue("a", item);
        yield* worker.drain;
        expect(processed).toEqual(["a1", "a2", "a3", "a4"]);
      }),
    ),
  );

  it.live("a blocked key does not block another key", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const releaseA = yield* Deferred.make<void>();
        const bDone = yield* Deferred.make<void>();
        const processed: string[] = [];
        const worker = yield* makeKeyedSerialWorker({
          policy: policy(16),
          process: (key: string, item: string) =>
            Effect.gen(function* () {
              if (key === "a") yield* Deferred.await(releaseA);
              processed.push(item);
              if (key === "b") yield* Deferred.succeed(bDone, undefined);
            }),
        });
        yield* worker.enqueue("a", "a1");
        yield* worker.enqueue("b", "b1");
        yield* Deferred.await(bDone);
        expect(processed).toEqual(["b1"]);
        yield* Deferred.succeed(releaseA, undefined);
        yield* worker.drain;
        expect(processed).toEqual(["b1", "a1"]);
      }),
    ),
  );

  it.live("drain waits for every key; drainKey resolves while another key is blocked", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const releaseB = yield* Deferred.make<void>();
        const bStarted = yield* Deferred.make<void>();
        const worker = yield* makeKeyedSerialWorker({
          policy: policy(16),
          process: (key: string, _item: number) =>
            key === "b"
              ? Deferred.succeed(bStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseB)))
              : Effect.yieldNow,
        });
        yield* worker.enqueue("a", 1);
        yield* worker.enqueue("b", 1);
        yield* Deferred.await(bStarted);
        yield* worker.drainKey("a");
        expect(yield* worker.isIdle("a")).toBe(true);
        expect(yield* worker.isIdle("b")).toBe(false);

        const drained = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          worker.drain.pipe(Effect.andThen(Deferred.succeed(drained, undefined))),
        );
        yield* Effect.yieldNow;
        expect(yield* Deferred.isDone(drained)).toBe(false);
        yield* Deferred.succeed(releaseB, undefined);
        yield* Deferred.await(drained);
        expect(yield* worker.isIdle("b")).toBe(true);
      }),
    ),
  );

  it.live("processes an item enqueued while its lane is exiting", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let processed = 0;
        const worker = yield* makeKeyedSerialWorker({
          policy: policy(4),
          process: (_key: string, _item: number) =>
            Effect.gen(function* () {
              yield* Effect.yieldNow;
              processed += 1;
            }),
        });
        for (let iteration = 0; iteration < 200; iteration += 1) {
          yield* worker.enqueue("a", iteration);
          // Let the lane reach (or pass) its empty-queue exit before the next enqueue.
          if (iteration % 2 === 0) yield* Effect.yieldNow;
          yield* worker.enqueue("a", iteration);
          yield* worker.drainKey("a");
        }
        yield* worker.drain;
        expect(processed).toBe(400);
        expect(yield* worker.isIdle("a")).toBe(true);
      }),
    ),
  );

  it.live("keeps a lane running after a failure, a defect and an inner interrupt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const worker = yield* makeKeyedSerialWorker({
          policy: policy(16),
          process: (_key: string, item: string) => {
            switch (item) {
              case "fail":
                return Effect.fail("boom");
              case "die":
                return Effect.die(new Error("defect"));
              case "inner-interrupt":
                return Effect.gen(function* () {
                  const child = yield* Effect.forkChild(Effect.never);
                  yield* Fiber.interrupt(child);
                  yield* Fiber.join(child);
                });
              default:
                return Effect.sync(() => {
                  processed.push(item);
                });
            }
          },
        });
        for (const item of ["fail", "after-fail", "die", "after-die", "inner-interrupt", "last"]) {
          yield* worker.enqueue("a", item);
        }
        yield* worker.drain;
        expect(processed).toEqual(["after-fail", "after-die", "last"]);
      }),
    ),
  );

  it.live("blocks at capacity, lets a blocked enqueuer be interrupted, and still drains", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>();
        const processed: number[] = [];
        const worker = yield* makeKeyedSerialWorker({
          policy: policy(2),
          process: (_key: string, item: number) =>
            Deferred.await(release).pipe(Effect.andThen(Effect.sync(() => processed.push(item)))),
        });
        yield* worker.enqueue("a", 1);
        yield* worker.enqueue("b", 2);
        const blocked = yield* Effect.forkChild(worker.enqueue("c", 3));
        yield* Effect.yieldNow;
        expect(blocked.pollUnsafe()).toBeUndefined();
        yield* Fiber.interrupt(blocked);
        // Nothing was committed for the interrupted enqueue: no key without a lane.
        expect(yield* worker.isIdle("c")).toBe(true);
        yield* Deferred.succeed(release, undefined);
        yield* worker.drain;
        expect(processed.toSorted()).toEqual([1, 2]);
        expect(yield* worker.isIdle("a")).toBe(true);
      }),
    ),
  );

  it.live("reports idleness and metrics", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>();
        const worker = yield* makeKeyedSerialWorker({
          policy: policy(8),
          laneDepthWarning: 1,
          process: (_key: string, _item: number) => Deferred.await(release),
        });
        expect(yield* worker.isIdle("a")).toBe(true);
        yield* worker.enqueue("a", 1);
        yield* worker.enqueue("a", 2);
        yield* worker.enqueue("a", 3);
        yield* worker.enqueue("b", 1);
        expect(yield* worker.isIdle("a")).toBe(false);
        const busy = yield* worker.metrics;
        expect(busy).toMatchObject({
          component: "keyed-serial-worker-test",
          capacity: 8,
          depth: 4,
          highWaterMark: 4,
          activeKeys: 2,
        });
        expect(busy.laneDepthWarningCount).toBeGreaterThanOrEqual(1);
        yield* Deferred.succeed(release, undefined);
        yield* worker.drain;
        expect(yield* worker.metrics).toMatchObject({ depth: 0, highWaterMark: 4, activeKeys: 0 });
      }),
    ),
  );
});
