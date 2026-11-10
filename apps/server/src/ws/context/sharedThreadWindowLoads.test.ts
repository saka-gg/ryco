import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber } from "effect";

import { loadSharedThreadWindow, sharedThreadWindowLoadCount } from "./sharedThreadWindowLoads.ts";

/** Lets forked fibers run (the scheduler may run them after a setImmediate). */
const settle = Effect.sleep("10 millis");

/** A load that finishes when `release` is completed, counting starts and interruptions. */
const makeGatedLoad = Effect.gen(function* () {
  const release = yield* Deferred.make<string, string>();
  const counts = { started: 0, interrupted: 0 };
  const load = Effect.suspend(() => {
    counts.started += 1;
    return Deferred.await(release);
  }).pipe(Effect.onInterrupt(() => Effect.sync(() => void (counts.interrupted += 1))));
  return { release, counts, load };
});

describe("loadSharedThreadWindow", () => {
  it.live("serves concurrent requests for the same window from one load", () =>
    Effect.gen(function* () {
      const owner = {};
      const { release, counts, load } = yield* makeGatedLoad;
      const first = yield* Effect.forkChild(loadSharedThreadWindow(owner, "thread-1", load));
      const second = yield* Effect.forkChild(loadSharedThreadWindow(owner, "thread-1", load));
      // Another window (different limits or thread) is its own load.
      const other = yield* Effect.forkChild(loadSharedThreadWindow(owner, "thread-2", load));
      yield* settle;
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

  it.live("keeps loading for the others when the first requester leaves", () =>
    Effect.gen(function* () {
      const owner = {};
      const { release, counts, load } = yield* makeGatedLoad;
      const first = yield* Effect.forkChild(loadSharedThreadWindow(owner, "thread-1", load));
      const second = yield* Effect.forkChild(loadSharedThreadWindow(owner, "thread-1", load));
      yield* settle;
      yield* Fiber.interrupt(first);
      yield* Deferred.succeed(release, "window");
      assert.equal(yield* Fiber.join(second), "window");
      assert.equal(counts.started, 1);
      assert.equal(counts.interrupted, 0);
    }),
  );

  it.live("stops the load once every requester left", () =>
    Effect.gen(function* () {
      const owner = {};
      const { counts, load } = yield* makeGatedLoad;
      const first = yield* Effect.forkChild(loadSharedThreadWindow(owner, "thread-1", load));
      const second = yield* Effect.forkChild(loadSharedThreadWindow(owner, "thread-1", load));
      yield* settle;
      yield* Fiber.interrupt(first);
      yield* Fiber.interrupt(second);
      yield* settle;
      assert.equal(counts.interrupted, 1);
      // The next request starts a new load instead of joining the stopped one.
      const third = yield* Effect.forkChild(loadSharedThreadWindow(owner, "thread-1", load));
      yield* settle;
      assert.equal(counts.started, 2);
      yield* Fiber.interrupt(third);
    }),
  );

  it.live("shares a failure with the waiters but not with later requests", () =>
    Effect.gen(function* () {
      const owner = {};
      const { release, counts, load } = yield* makeGatedLoad;
      const first = yield* Effect.forkChild(loadSharedThreadWindow(owner, "thread-1", load));
      const second = yield* Effect.forkChild(loadSharedThreadWindow(owner, "thread-1", load));
      yield* settle;
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
