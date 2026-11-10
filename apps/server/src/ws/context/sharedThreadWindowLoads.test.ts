import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber } from "effect";

import { loadSharedThreadWindow, sharedThreadWindowLoadCount } from "./sharedThreadWindowLoads.ts";

/**
 * A load that finishes when `release` is completed, counting starts and
 * interruptions; `started` completes once a load runs.
 */
const makeGatedLoad = Effect.gen(function* () {
  const release = yield* Deferred.make<string, string>();
  const started = yield* Deferred.make<void>();
  const counts = { started: 0, interrupted: 0 };
  const load = Effect.suspend(() => {
    counts.started += 1;
    Deferred.doneUnsafe(started, Effect.void);
    return Deferred.await(release);
  }).pipe(Effect.onInterrupt(() => Effect.sync(() => void (counts.interrupted += 1))));
  return { release, started, counts, load };
});

/** Starts a requester at once, so it has joined (or started) the load when this returns. */
const request = (owner: object, key: string, load: Effect.Effect<string, string>) =>
  Effect.forkChild(loadSharedThreadWindow(owner, key, load), { startImmediately: true });

describe("loadSharedThreadWindow", () => {
  it.effect("serves concurrent requests for the same window from one load", () =>
    Effect.gen(function* () {
      const owner = {};
      const { release, started, counts, load } = yield* makeGatedLoad;
      const first = yield* request(owner, "thread-1", load);
      const second = yield* request(owner, "thread-1", load);
      // Another window (different limits or thread) is its own load.
      const other = yield* request(owner, "thread-2", load);
      yield* Deferred.await(started);
      yield* Deferred.succeed(release, "window");
      assert.equal(yield* Fiber.join(first), "window");
      assert.equal(yield* Fiber.join(second), "window");
      assert.equal(yield* Fiber.join(other), "window");
      assert.equal(counts.started, 2);
      assert.equal(sharedThreadWindowLoadCount(owner), 2);

      // A finished window is never served again: the next request reads afresh.
      assert.equal(yield* loadSharedThreadWindow(owner, "thread-1", load), "window");
      assert.equal(counts.started, 3);
    }),
  );

  it.effect("keeps loading for the others when the first requester leaves", () =>
    Effect.gen(function* () {
      const owner = {};
      const { release, started, counts, load } = yield* makeGatedLoad;
      const first = yield* request(owner, "thread-1", load);
      const second = yield* request(owner, "thread-1", load);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(first);
      yield* Deferred.succeed(release, "window");
      assert.equal(yield* Fiber.join(second), "window");
      assert.equal(counts.started, 1);
      assert.equal(counts.interrupted, 0);
    }),
  );

  it.effect("stops the load once every requester left", () =>
    Effect.gen(function* () {
      const owner = {};
      const { started, counts, load } = yield* makeGatedLoad;
      const first = yield* request(owner, "thread-1", load);
      const second = yield* request(owner, "thread-1", load);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(first);
      yield* Fiber.interrupt(second);
      assert.equal(counts.interrupted, 1);
      // The next request starts a new load instead of joining the stopped one.
      const third = yield* request(owner, "thread-1", load);
      assert.equal(sharedThreadWindowLoadCount(owner), 2);
      yield* Fiber.interrupt(third);
    }),
  );

  it.effect("shares a failure with the waiters but not with later requests", () =>
    Effect.gen(function* () {
      const owner = {};
      const { release, started, counts, load } = yield* makeGatedLoad;
      const first = yield* request(owner, "thread-1", load);
      const second = yield* request(owner, "thread-1", load);
      yield* Deferred.await(started);
      yield* Deferred.fail(release, "boom");
      assert.deepEqual(yield* Fiber.await(first), Exit.fail("boom"));
      assert.deepEqual(yield* Fiber.await(second), Exit.fail("boom"));
      assert.equal(counts.started, 1);
      // `release` stays failed, so a fresh load fails too, but it did start.
      assert.deepEqual(
        yield* Effect.exit(loadSharedThreadWindow(owner, "thread-1", load)),
        Exit.fail("boom"),
      );
      assert.equal(counts.started, 2);
    }),
  );
});
