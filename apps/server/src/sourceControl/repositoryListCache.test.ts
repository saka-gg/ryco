import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { SourceControlProviderError } from "@ryco/contracts";

import { inBackgroundProcessLane } from "../processGovernor.ts";
import { ForgeRequestPausedError } from "./forgeRateLimit.ts";
import { markServedWhilePaused, pausedUntilOf } from "./lastGoodWhilePaused.ts";
import { makeRepositoryListCache, type RepositoryChanges } from "./repositoryListCache.ts";

const rateLimited = (retryAt?: number) =>
  new SourceControlProviderError({
    provider: "github",
    operation: "getChangeRequestDetail",
    detail: "GitHub API rate limit exceeded.",
    reason: "rate-limited",
    ...(retryAt !== undefined ? { retryAt } : {}),
  });

const refused = (retryAt: number) =>
  new SourceControlProviderError({
    provider: "github",
    operation: "getChangeRequestDetail",
    detail: "GitHub requests are paused after a rate limit.",
    reason: "rate-limited",
    retryAt,
    cause: new ForgeRequestPausedError({ provider: "github", host: "github.com", retryAt }),
  });

/** A list read whose outcome the test switches; counts its loads. */
function switchableLoad() {
  const state: {
    loads: number;
    next: Effect.Effect<{ readonly number: number }, SourceControlProviderError>;
  } = { loads: 0, next: Effect.succeed({ number: 1 }) };
  const load = Effect.suspend(() => {
    state.loads += 1;
    return state.next;
  });
  return { state, load };
}

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

  it.effect("lets an entry choose a shorter lifetime", () =>
    Effect.gen(function* () {
      let now = 0;
      let loads = 0;
      const cache = makeRepositoryListCache({ ttlMs: 30_000, nowMs: () => now });
      const read = (key: string, ttlMs?: number) =>
        cache.get({
          repository: "a",
          key,
          load: Effect.sync(() => ++loads),
          ...(ttlMs !== undefined ? { ttlMs } : {}),
        });
      expect(yield* read("detail", 5_000)).toBe(1);
      expect(yield* read("list")).toBe(2);
      now = 4_999;
      expect(yield* read("detail", 5_000)).toBe(1);
      now = 5_000;
      expect(yield* read("detail", 5_000)).toBe(3);
      expect(yield* read("list")).toBe(2);
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

  describe("while the forge is rate limiting", () => {
    it.effect(
      "holds the forge's answer until the pause ends; last good goes to background readers",
      () =>
        Effect.gen(function* () {
          let now = 1_000_000;
          const cache = makeRepositoryListCache({ ttlMs: 1_000, nowMs: () => now });
          const { state, load } = switchableLoad();
          const read = cache.get({ repository: "a", key: "detail", load, lastGood: true });

          expect(yield* read).toEqual({ number: 1 });
          now += 1_000;
          state.next = Effect.fail(rateLimited(now + 60_000));

          // A background row keeps its last good detail, marked with the pause's end.
          const served = yield* inBackgroundProcessLane(read);
          expect(served).toEqual({ number: 1 });
          expect(pausedUntilOf(served)).toBe(now + 60_000);
          // The focused surface gets the typed error, from the held answer.
          const error = yield* Effect.flip(read);
          expect(error.reason).toBe("rate-limited");
          const [first, second] = yield* Effect.all([Effect.flip(read), Effect.flip(read)], {
            concurrency: "unbounded",
          });
          expect([first.retryAt, second.retryAt]).toEqual([now + 60_000, now + 60_000]);
          expect(state.loads).toBe(2);

          now += 59_999;
          yield* inBackgroundProcessLane(read);
          expect(state.loads).toBe(2);
          now += 1;
          state.next = Effect.succeed({ number: 2 });
          const fresh = yield* read;
          expect(fresh).toEqual({ number: 2 });
          expect(pausedUntilOf(fresh)).toBeNull();
          expect(state.loads).toBe(3);
        }),
    );

    it.effect("does not hold a read the pause refused, nor other failures", () =>
      Effect.gen(function* () {
        let now = 1_000_000;
        const cache = makeRepositoryListCache({ ttlMs: 1_000, nowMs: () => now });
        const { state, load } = switchableLoad();
        const read = cache.get({ repository: "a", key: "detail", load, lastGood: true });
        yield* read;
        now += 1_000;

        state.next = Effect.fail(refused(now + 60_000));
        expect(pausedUntilOf(yield* inBackgroundProcessLane(read))).toBe(now + 60_000);
        expect((yield* Effect.flip(read)).detail).toContain("paused");
        expect(state.loads).toBe(3);

        state.next = Effect.fail(
          new SourceControlProviderError({
            provider: "github",
            operation: "getChangeRequestDetail",
            detail: "host unreachable",
          }),
        );
        expect((yield* Effect.flip(inBackgroundProcessLane(read))).detail).toBe("host unreachable");
        yield* Effect.flip(read);
        expect(state.loads).toBe(5);
      }),
    );

    it.effect("keeps held entries through an invalidation while the pause runs", () =>
      Effect.gen(function* () {
        let now = 1_000_000;
        const cache = makeRepositoryListCache({ ttlMs: 1_000, nowMs: () => now });
        const { state, load } = switchableLoad();
        const read = cache.get({ repository: "a", key: "list", load, lastGood: true });
        let pauseChecks = 0;
        const stillPaused = (paused: boolean) =>
          Effect.sync(() => {
            pauseChecks += 1;
            return paused;
          });

        yield* read;
        // Nothing held: dropped as before, without asking about a pause.
        yield* cache.invalidate("a", { keepHeldWhile: stillPaused(true) });
        expect(pauseChecks).toBe(0);
        state.next = Effect.fail(rateLimited(now + 300_000));
        yield* Effect.flip(read);
        expect(state.loads).toBe(2);

        for (let poll = 0; poll < 9; poll += 1) {
          now += 30_000;
          yield* cache.invalidate("a", { keepHeldWhile: stillPaused(true) });
          yield* Effect.flip(read);
          // Last good outlives invalidations.
          expect(yield* inBackgroundProcessLane(read)).toEqual({ number: 1 });
        }
        expect(state.loads).toBe(2);
        expect(pauseChecks).toBe(9);

        yield* cache.invalidate("a", { keepHeldWhile: stillPaused(false) });
        yield* Effect.flip(read);
        expect(state.loads).toBe(3);
        yield* cache.invalidate("a");
        yield* Effect.flip(read);
        expect(state.loads).toBe(4);
      }),
    );

    it.effect("holds a value served while paused, and never keeps it as last good", () =>
      Effect.gen(function* () {
        let now = 1_000_000;
        const cache = makeRepositoryListCache({ ttlMs: 1_000, nowMs: () => now });
        let loads = 0;
        let next: Effect.Effect<ReadonlyArray<number>, SourceControlProviderError> = Effect.sync(
          () => markServedWhilePaused([1, 2], now + 20_000),
        );
        const read = cache.get({
          repository: "a",
          key: "picker",
          load: Effect.suspend(() => (++loads, next)),
          lastGood: true,
        });

        const rows = yield* read;
        expect(pausedUntilOf(rows)).toBe(now + 20_000);
        now += 19_999;
        yield* read;
        expect(loads).toBe(1);
        now += 1;
        next = Effect.fail(rateLimited(now + 20_000));
        yield* Effect.flip(inBackgroundProcessLane(read));
        expect(loads).toBe(2);
      }),
    );

    it.effect("serves no last good to reads that did not opt in", () =>
      Effect.gen(function* () {
        let now = 1_000_000;
        const cache = makeRepositoryListCache({ ttlMs: 1_000, nowMs: () => now });
        const { state, load } = switchableLoad();
        const read = cache.get({ repository: "a", key: "list", load });
        yield* read;
        now += 1_000;
        state.next = Effect.fail(rateLimited(now + 60_000));
        expect((yield* Effect.flip(inBackgroundProcessLane(read))).reason).toBe("rate-limited");
      }),
    );
  });

  it.effect("reads again a finished entry older than maxAgeMs and keeps a younger one", () =>
    Effect.gen(function* () {
      let now = 0;
      let loads = 0;
      const cache = makeRepositoryListCache({ ttlMs: 60_000, nowMs: () => now });
      const read = (maxAgeMs?: number) =>
        cache.get({
          repository: "host",
          key: "involved",
          load: Effect.sync(() => ++loads),
          ...(maxAgeMs !== undefined ? { maxAgeMs } : {}),
        });
      expect(yield* read()).toBe(1);
      now = 9_999;
      expect(yield* read(10_000)).toBe(1);
      now = 10_000;
      expect(yield* read(10_000)).toBe(2);
      // The re-read restarts the entry's age for every reader.
      now = 15_000;
      expect(yield* read(10_000)).toBe(2);
      expect(yield* read()).toBe(2);
    }),
  );

  it.effect("joins an in-flight read even with maxAgeMs 0, and never caches its failure", () =>
    Effect.gen(function* () {
      const cache = makeRepositoryListCache();
      let loads = 0;
      const gate = yield* Deferred.make<void>();
      const leader = yield* Effect.forkChild(
        cache.get({
          repository: "a",
          key: "k",
          load: Deferred.await(gate).pipe(Effect.as(++loads)),
        }),
      );
      yield* Effect.yieldNow;
      const follower = yield* Effect.forkChild(
        cache.get({ repository: "a", key: "k", load: Effect.sync(() => ++loads), maxAgeMs: 0 }),
      );
      yield* Effect.yieldNow;
      yield* Deferred.succeed(gate, undefined);
      expect([yield* Fiber.join(leader), yield* Fiber.join(follower)]).toEqual([1, 1]);

      let failures = 0;
      const failing = cache.get({
        repository: "a",
        key: "failing",
        load: Effect.suspend(() => (++failures, Effect.fail("offline" as const))),
        maxAgeMs: 10_000,
      });
      expect(yield* Effect.flip(failing)).toBe("offline");
      expect(yield* Effect.flip(failing)).toBe("offline");
      expect(failures).toBe(2);
    }),
  );

  it.effect("keeps an entry stored soon after an invalidation only for settleTtlMs", () =>
    Effect.gen(function* () {
      let now = 0;
      let loads = 0;
      const cache = makeRepositoryListCache({ nowMs: () => now });
      const read = (repository: string) =>
        cache.get({
          repository,
          key: "search",
          load: Effect.sync(() => ++loads),
          ttlMs: 240_000,
          settleTtlMs: 15_000,
        });
      // Never invalidated: the normal lifetime.
      expect(yield* read("quiet")).toBe(1);
      now = 200_000;
      expect(yield* read("quiet")).toBe(1);

      yield* cache.invalidate("busy");
      expect(yield* read("busy")).toBe(2);
      now = 214_999;
      expect(yield* read("busy")).toBe(2);
      now = 215_000;
      expect(yield* read("busy")).toBe(3);
      // A full lifetime after the invalidation, entries live their normal TTL again.
      now = 440_000;
      expect(yield* read("busy")).toBe(4);
      now = 600_000;
      expect(yield* read("busy")).toBe(4);
    }),
  );

  it.effect("tells a revalidating read what its repository went through", () =>
    Effect.gen(function* () {
      let now = 0;
      const cache = makeRepositoryListCache({ ttlMs: 1_000, nowMs: () => now });
      const seen: Array<RepositoryChanges> = [];
      let loads = 0;
      const read = (repository = "a") =>
        cache.get({
          repository,
          key: "detail",
          load: Effect.sync(() => ++loads),
          revalidate: (changes) => Effect.sync(() => (seen.push(changes), -1)),
        });

      // Read through `revalidate`, never `load`, and cached like any read.
      expect(yield* read()).toBe(-1);
      expect(yield* read()).toBe(-1);
      expect(loads).toBe(0);
      expect(seen).toEqual([{ changedAtMs: 0, mutations: 0 }]);
      // A git action or an agent turn: a fingerprint must be newer than it.
      now = 100;
      yield* cache.invalidate("a", { revalidate: "fresh" });
      yield* read();
      expect(seen.at(-1)).toEqual({ changedAtMs: 100, mutations: 0 });
      // A poll's refresh drops the entry and says nothing changed.
      now = 200;
      yield* cache.invalidate("a", { revalidate: "reuse" });
      yield* read();
      expect(seen.at(-1)).toEqual({ changedAtMs: 100, mutations: 0 });
      // A mutation through Ryco.
      now = 300;
      yield* cache.invalidate("a");
      yield* read();
      expect(seen.at(-1)).toEqual({ changedAtMs: 300, mutations: 1 });
      // Per repository.
      yield* read("b");
      expect(seen.at(-1)).toEqual({ changedAtMs: 0, mutations: 0 });
    }),
  );
});
