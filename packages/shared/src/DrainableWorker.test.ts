import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { Deferred, Effect } from "effect";

import { makeDrainableWorker } from "./DrainableWorker.ts";
import { losslessBackpressureQueuePolicy } from "./QueuePolicy.ts";

describe("makeDrainableWorker", () => {
  it.live("waits for work enqueued during active processing before draining", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const releaseSecond = yield* Deferred.make<void>();

        const worker = yield* makeDrainableWorker({
          policy: losslessBackpressureQueuePolicy({
            component: "drainable-worker-test",
            capacity: 2,
          }),
          process: (item: string) =>
            Effect.gen(function* () {
              if (item === "first") {
                yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseFirst);
              }

              if (item === "second") {
                yield* Deferred.succeed(secondStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseSecond);
              }

              processed.push(item);
            }),
        });

        yield* worker.enqueue("first");
        yield* Deferred.await(firstStarted);

        const drained = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          worker.drain.pipe(
            Effect.tap(() => Deferred.succeed(drained, undefined).pipe(Effect.orDie)),
          ),
        );

        yield* worker.enqueue("second");
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(secondStarted);

        expect(yield* Deferred.isDone(drained)).toBe(false);

        yield* Deferred.succeed(releaseSecond, undefined);
        yield* Deferred.await(drained);

        expect(processed).toEqual(["first", "second"]);
        expect(yield* worker.metrics).toMatchObject({
          component: "drainable-worker-test",
          capacity: 2,
          depth: 0,
          highWaterMark: 2,
        });
      }),
    ),
  );

  it.live("backpressures admission when capacity is exhausted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const thirdAdmitted = yield* Deferred.make<void>();
        const worker = yield* makeDrainableWorker({
          policy: losslessBackpressureQueuePolicy({
            component: "bounded-test",
            capacity: 1,
          }),
          process: (item: number) =>
            item === 1
              ? Deferred.succeed(firstStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseFirst)),
                )
              : Effect.void,
        });

        yield* worker.enqueue(1);
        yield* Deferred.await(firstStarted);
        yield* worker.enqueue(2);
        yield* Effect.forkChild(
          worker
            .enqueue(3)
            .pipe(Effect.andThen(Deferred.succeed(thirdAdmitted, undefined)), Effect.asVoid),
        );
        yield* Effect.yieldNow;
        expect(yield* Deferred.isDone(thirdAdmitted)).toBe(false);

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(thirdAdmitted);
        yield* worker.drain;
        expect((yield* worker.metrics).highWaterMark).toBe(2);
      }),
    ),
  );

  it.live("keeps processing and draining after an item fails or dies", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const worker = yield* makeDrainableWorker({
          policy: losslessBackpressureQueuePolicy({
            component: "drainable-worker-failure-test",
            capacity: 4,
          }),
          process: (item: string): Effect.Effect<void, string> =>
            item === "fail"
              ? Effect.fail("boom")
              : item === "die"
                ? Effect.die(new Error("defect"))
                : Effect.sync(() => void processed.push(item)),
        });

        yield* worker.enqueue("fail");
        yield* worker.enqueue("die");
        yield* worker.enqueue("ok");
        yield* worker.drain.pipe(Effect.timeout("2 seconds"));

        expect(processed).toEqual(["ok"]);
        expect((yield* worker.metrics).depth).toBe(0);
      }),
    ),
  );
});
