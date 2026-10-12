import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber } from "effect";

import { makeRepositoryListCache } from "./repositoryListCache.ts";

describe("repositoryListCache", () => {
  it.effect("reuses a result within the TTL, per repository and key", () =>
    Effect.gen(function* () {
      let now = 0;
      let loads = 0;
      const cache = makeRepositoryListCache({ ttlMs: 1_000, nowMs: () => now });
      const read = (repository: string, key: string) =>
        cache.get({ repository, key, load: Effect.sync(() => ++loads) });
      expect(yield* read("a", "open")).toBe(1);
      expect(yield* read("a", "open")).toBe(1);
      expect(yield* read("a", "closed")).toBe(2);
      expect(yield* read("b", "open")).toBe(3);
      now = 1_000;
      expect(yield* read("a", "open")).toBe(4);
      expect(yield* read("b", "open")).toBe(5);
      // Invalidation drops one repository's entries only.
      yield* cache.invalidate("a");
      expect(yield* read("a", "open")).toBe(6);
      expect(yield* read("b", "open")).toBe(5);
    }),
  );

  it.effect("never caches a failure, and shares one in-flight read", () =>
    Effect.gen(function* () {
      const cache = makeRepositoryListCache();
      let loads = 0;
      const failing = cache.get({
        repository: "a",
        key: "k",
        load: Effect.suspend(() => (++loads, Effect.fail("offline" as const))),
      });
      expect(yield* Effect.flip(failing)).toBe("offline");
      expect(yield* Effect.flip(failing)).toBe("offline");
      expect(loads).toBe(2);

      const gate = yield* Deferred.make<void>();
      let gated = 0;
      const slow = cache.get({
        repository: "a",
        key: "slow",
        load: Deferred.await(gate).pipe(Effect.as(++gated)),
      });
      const first = yield* Effect.forkChild(slow);
      const second = yield* Effect.forkChild(slow);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(gate, undefined);
      expect([yield* Fiber.join(first), yield* Fiber.join(second)]).toEqual([1, 1]);
    }),
  );

  it.effect("a reader that joined a cancelled read reads again", () =>
    Effect.gen(function* () {
      const cache = makeRepositoryListCache();
      let loads = 0;
      const never = yield* Deferred.make<number>();
      const leader = yield* Effect.forkChild(
        cache.get({
          repository: "a",
          key: "k",
          load: Effect.suspend(() => (++loads, Deferred.await(never))),
        }),
      );
      yield* Effect.yieldNow;
      const follower = yield* Effect.forkChild(
        cache.get({ repository: "a", key: "k", load: Effect.sync(() => ++loads) }),
      );
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(leader);
      const exit = yield* Fiber.await(follower);
      expect(Exit.isSuccess(exit) && exit.value).toBe(2);
    }),
  );
});
