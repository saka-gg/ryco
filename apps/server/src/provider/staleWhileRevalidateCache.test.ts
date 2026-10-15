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

  it.effect("replays a failed first read until its retry, then reads again", () =>
    Effect.gen(function* () {
      let now = 0;
      let loads = 0;
      const scope = yield* Effect.scope;
      const cache = makeStaleWhileRevalidateCache<number, string>({
        freshMs: 1_000,
        capacity: 8,
        scope,
        retryAfterFailureMs: 30_000,
        nowMs: () => now,
      });
      const load = Effect.suspend(() => {
        loads += 1;
        return loads === 1 ? Effect.fail("cold start") : Effect.succeed(loads);
      });
      expect(yield* cache.get("a", load).pipe(Effect.flip)).toBe("cold start");
      // A broken source is not re-read by every caller.
      now = 29_999;
      expect(yield* cache.get("a", load).pipe(Effect.flip)).toBe("cold start");
      expect(loads).toBe(1);

      now = 30_000;
      expect(yield* cache.get("a", load)).toBe(2);
      expect(yield* cache.get("a", load)).toBe(2);
      expect(loads).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("reads again at once after an interrupted first read", () =>
    Effect.gen(function* () {
      let loads = 0;
      const scope = yield* Effect.scope;
      const cache = makeStaleWhileRevalidateCache<number, string>({
        freshMs: 1_000,
        capacity: 8,
        scope,
        nowMs: () => 0,
      });
      const load = Effect.suspend(() => {
        loads += 1;
        return loads === 1 ? Effect.interrupt : Effect.succeed(loads);
      });
      yield* cache.get("a", load).pipe(Effect.exit);
      expect(yield* cache.get("a", load)).toBe(2);
      expect(loads).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the last good value when a refresh fails, and backs off its retry", () =>
    Effect.gen(function* () {
      let now = 0;
      let loads = 0;
      let failing = false;
      const scope = yield* Effect.scope;
      const cache = makeStaleWhileRevalidateCache<number, string>({
        freshMs: 1_000,
        capacity: 8,
        scope,
        retryAfterFailureMs: 30_000,
        nowMs: () => now,
      });
      const load = Effect.suspend(() => {
        loads += 1;
        return failing ? Effect.fail("timed out") : Effect.succeed(loads);
      });
      const settle = Effect.gen(function* () {
        for (let index = 0; index < 5; index++) yield* Effect.yieldNow;
      });
      expect(yield* cache.get("a", load)).toBe(1);

      failing = true;
      now = 1_500;
      expect(yield* cache.get("a", load)).toBe(1);
      yield* settle;
      expect(loads).toBe(2);
      // The failed refresh neither replaced the value nor is retried at once.
      expect(yield* cache.get("a", load)).toBe(1);
      yield* settle;
      expect(loads).toBe(2);

      failing = false;
      now = 1_500 + 30_000;
      expect(yield* cache.get("a", load)).toBe(1);
      yield* settle;
      expect(loads).toBe(3);
      expect(yield* cache.get("a", load)).toBe(3);
    }).pipe(Effect.scoped),
  );
});
