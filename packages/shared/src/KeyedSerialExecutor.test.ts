import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { Deferred, Effect, Exit, Fiber } from "effect";

import { makeKeyedSerialExecutor } from "./KeyedSerialExecutor.ts";

describe("makeKeyedSerialExecutor", () => {
  it.live("serializes one key, runs different keys in parallel, and forgets released keys", () =>
    Effect.gen(function* () {
      const executor = yield* makeKeyedSerialExecutor<string>();
      const releaseFirst = yield* Deferred.make<void>();
      const firstEntered = yield* Deferred.make<void>();
      const order: string[] = [];

      const first = yield* Effect.forkChild(
        executor.withLock(
          "a",
          Effect.gen(function* () {
            order.push("a1:start");
            yield* Deferred.succeed(firstEntered, undefined);
            yield* Deferred.await(releaseFirst);
            order.push("a1:end");
          }),
        ),
      );
      yield* Deferred.await(firstEntered);
      const second = yield* Effect.forkChild(
        executor.withLock(
          "a",
          Effect.sync(() => {
            order.push("a2");
          }),
        ),
      );
      // A different key is not held behind "a".
      yield* executor.withLock(
        "b",
        Effect.sync(() => {
          order.push("b1");
        }),
      );
      yield* Effect.yieldNow;
      expect(order).toEqual(["a1:start", "b1"]);
      expect(yield* executor.activeKeyCount).toBe(1);

      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(order).toEqual(["a1:start", "b1", "a1:end", "a2"]);
      expect(yield* executor.activeKeyCount).toBe(0);
    }),
  );

  it.live("releases the key when the guarded effect fails", () =>
    Effect.gen(function* () {
      const executor = yield* makeKeyedSerialExecutor<string>();
      const result = yield* executor.withLock("a", Effect.fail("boom")).pipe(Effect.flip);
      expect(result).toBe("boom");
      expect(yield* executor.activeKeyCount).toBe(0);
      expect(yield* executor.withLock("a", Effect.succeed(1))).toBe(1);
    }),
  );

  it.live("releases the key when the guarded effect dies", () =>
    Effect.gen(function* () {
      const executor = yield* makeKeyedSerialExecutor<string>();
      const exit = yield* Effect.exit(executor.withLock("a", Effect.die("defect")));
      expect(Exit.hasDies(exit)).toBe(true);
      expect(yield* executor.activeKeyCount).toBe(0);
      expect(yield* executor.withLock("a", Effect.succeed(1))).toBe(1);
    }),
  );

  it.live("a waiter queued behind the holder shares its entry and runs in arrival order", () =>
    Effect.gen(function* () {
      const executor = yield* makeKeyedSerialExecutor<string>();
      const release = yield* Deferred.make<void>();
      const entered = yield* Deferred.make<void>();
      const order: string[] = [];
      const holder = yield* Effect.forkChild(
        executor.withLock(
          "a",
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(Effect.sync(() => order.push("holder"))),
          ),
        ),
      );
      yield* Deferred.await(entered);
      const waiters: Array<Fiber.Fiber<number>> = [];
      for (const name of ["w1", "w2", "w3"]) {
        waiters.push(
          yield* Effect.forkChild(
            executor.withLock(
              "a",
              Effect.sync(() => order.push(name)),
            ),
          ),
        );
        yield* Effect.yieldNow;
      }
      // Holder and waiters use one entry.
      expect(yield* executor.activeKeyCount).toBe(1);
      expect(order).toEqual([]);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      for (const waiter of waiters) yield* Fiber.join(waiter);
      expect(order).toEqual(["holder", "w1", "w2", "w3"]);
      expect(yield* executor.activeKeyCount).toBe(0);
    }),
  );

  it.live("interrupting a waiter leaks neither its entry nor a permit", () =>
    Effect.gen(function* () {
      const executor = yield* makeKeyedSerialExecutor<string>();
      const release = yield* Deferred.make<void>();
      const entered = yield* Deferred.make<void>();
      const holder = yield* Effect.forkChild(
        executor.withLock(
          "a",
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ),
      );
      yield* Deferred.await(entered);
      let waiterRan = false;
      const waiter = yield* Effect.forkChild(
        executor.withLock(
          "a",
          Effect.sync(() => {
            waiterRan = true;
          }),
        ),
      );
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(waiter);
      expect(waiterRan).toBe(false);
      // Only the holder is left on the key, and it still excludes others.
      expect(yield* executor.activeKeyCount).toBe(1);
      const entries: string[] = [];
      const next = yield* Effect.forkChild(
        executor.withLock(
          "a",
          Effect.sync(() => {
            entries.push("next");
          }),
        ),
      );
      yield* Effect.yieldNow;
      expect(entries).toEqual([]);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      yield* Fiber.join(next);
      expect(entries).toEqual(["next"]);
      expect(yield* executor.activeKeyCount).toBe(0);
    }),
  );

  it.live("interrupting the holder releases the key to the next waiter", () =>
    Effect.gen(function* () {
      const executor = yield* makeKeyedSerialExecutor<string>();
      const entered = yield* Deferred.make<void>();
      const holder = yield* Effect.forkChild(
        executor.withLock(
          "a",
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        ),
      );
      yield* Deferred.await(entered);
      const waiter = yield* Effect.forkChild(executor.withLock("a", Effect.succeed("ran")));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(holder);
      expect(yield* Fiber.join(waiter)).toBe("ran");
      expect(yield* executor.activeKeyCount).toBe(0);
    }),
  );
});
