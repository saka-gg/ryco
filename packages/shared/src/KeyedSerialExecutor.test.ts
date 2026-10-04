import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { Deferred, Effect, Fiber } from "effect";

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
});
