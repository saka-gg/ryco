import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";

import { makeStaleWhileRevalidateCache } from "./staleWhileRevalidateCache.ts";

describe("staleWhileRevalidateCache", () => {
  it.effect("serves fresh values, refreshes stale ones behind the reader, shares first reads", () =>
    Effect.gen(function* () {
      let now = 0;
      let loads = 0;
      const scope = yield* Effect.scope;
      const cache = makeStaleWhileRevalidateCache<number>({
        freshMs: 1_000,
        capacity: 8,
        scope,
        nowMs: () => now,
      });
      const gate = yield* Deferred.make<void>();
      const load = Effect.suspend(() => {
        loads += 1;
        const value = loads;
        return Deferred.await(gate).pipe(Effect.as(value));
      });
      const first = yield* Effect.forkChild(cache.get("a", load));
      const second = yield* Effect.forkChild(cache.get("a", load));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(gate, undefined);
      expect([yield* Fiber.join(first), yield* Fiber.join(second)]).toEqual([1, 1]);
      expect(loads).toBe(1);

      now = 500;
      expect(yield* cache.get("a", load)).toBe(1);
      expect(loads).toBe(1);

      // Stale: answered at once with the old value while one refresh runs.
      now = 1_500;
      expect(yield* cache.get("a", load)).toBe(1);
      expect(yield* cache.get("a", load)).toBe(1);
      yield* Effect.yieldNow;
      expect(loads).toBe(2);
      for (let index = 0; index < 5; index++) yield* Effect.yieldNow;
      expect(yield* cache.get("a", load)).toBe(2);
    }).pipe(Effect.scoped),
  );
});
