import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { Deferred, Effect, Exit, Fiber } from "effect";

import { makeKeyedSingleFlight } from "./KeyedSingleFlight.ts";

describe("makeKeyedSingleFlight", () => {
  it.live("shares one run per key, keeps keys apart, and frees a key once it settles", () =>
    Effect.gen(function* () {
      const flights = makeKeyedSingleFlight<string, number, string>();
      const release = yield* Deferred.make<void>();
      let runs = 0;
      const run = (value: number) =>
        Effect.gen(function* () {
          runs += 1;
          yield* Deferred.await(release);
          return value;
        });

      const first = yield* Effect.forkChild(flights.join("a", run(1)));
      yield* Effect.yieldNow;
      const joined = yield* Effect.forkChild(flights.join("a", run(2)));
      // Another key is not held behind "a".
      expect(yield* flights.join("b", Effect.succeed(3))).toBe(3);
      yield* Effect.yieldNow;
      expect(runs).toBe(1);
      expect(flights.size()).toBe(1);

      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(first)).toBe(1);
      expect(yield* Fiber.join(joined)).toBe(1);
      expect(flights.size()).toBe(0);
      expect(yield* flights.join("a", Effect.succeed(4))).toBe(4);
    }),
  );

  it.live("gives every caller the run's failure, then runs again", () =>
    Effect.gen(function* () {
      const flights = makeKeyedSingleFlight<string, number, string>();
      const release = yield* Deferred.make<void>();
      const first = yield* Effect.forkChild(
        flights.join("a", Deferred.await(release).pipe(Effect.andThen(Effect.fail("boom")))),
      );
      yield* Effect.yieldNow;
      const joined = yield* Effect.forkChild(flights.join("a", Effect.succeed(1)));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(first).pipe(Effect.flip)).toBe("boom");
      expect(yield* Fiber.join(joined).pipe(Effect.flip)).toBe("boom");
      expect(yield* flights.join("a", Effect.succeed(2))).toBe(2);
    }),
  );

  it.live("keeps the run going for the others when its starter is interrupted", () =>
    Effect.gen(function* () {
      const flights = makeKeyedSingleFlight<string, number, never>();
      const release = yield* Deferred.make<void>();
      const starter = yield* Effect.forkChild(
        flights.join("a", Deferred.await(release).pipe(Effect.as(1))),
      );
      yield* Effect.yieldNow;
      const joined = yield* Effect.forkChild(flights.join("a", Effect.succeed(2)));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(starter);
      expect(Exit.hasInterrupts(yield* Fiber.await(starter))).toBe(true);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(joined)).toBe(1);
      expect(flights.size()).toBe(0);
    }),
  );
});
