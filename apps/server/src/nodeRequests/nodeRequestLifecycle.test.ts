import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Ref } from "effect";
import * as TestClock from "effect/testing/TestClock";

import { makeBusyGuard, makeExpiryScheduler, makeKeyedSemaphore } from "./nodeRequestLifecycle.ts";

it.effect("keyed semaphore: one holder per key, and a key is dropped once idle", () =>
  Effect.gen(function* () {
    const locks = makeKeyedSemaphore();
    const release = yield* Deferred.make<void>();
    const order = yield* Ref.make<string[]>([]);
    const first = yield* Effect.forkChild(
      locks.withPermit(
        "thread-1",
        Ref.update(order, (all) => [...all, "first"]).pipe(Effect.andThen(Deferred.await(release))),
      ),
    );
    yield* Effect.yieldNow;
    const second = yield* Effect.forkChild(
      locks.withPermit(
        "thread-1",
        Ref.update(order, (all) => [...all, "second"]),
      ),
    );
    // Another key does not wait.
    yield* locks.withPermit(
      "thread-2",
      Ref.update(order, (all) => [...all, "other"]),
    );
    yield* Effect.yieldNow;
    assert.deepEqual(yield* Ref.get(order), ["first", "other"]);
    assert.strictEqual(locks.size(), 1);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    assert.deepEqual(yield* Ref.get(order), ["first", "other", "second"]);
    // Pruned: a long-running node keeps no semaphore per thread or request.
    assert.strictEqual(locks.size(), 0);
  }),
);

it.effect("busy guard: a second holder of the same key fails at once", () =>
  Effect.gen(function* () {
    const guard = makeBusyGuard(() => "busy" as const);
    const release = yield* Deferred.make<void>();
    const first = yield* Effect.forkChild(guard("request-1", Deferred.await(release)));
    yield* Effect.yieldNow;
    assert.strictEqual(yield* Effect.flip(guard("request-1", Effect.void)), "busy");
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    yield* guard("request-1", Effect.void);
  }),
);

it.effect("expiry scheduler: runs at the expiry and retries a failed record with backoff", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const failures = yield* Ref.make(0);
    const schedule = makeExpiryScheduler<string>({
      retryMs: 1_000,
      maxRetryMs: 4_000,
      onFailure: () => Ref.update(failures, (count) => count + 1),
    });
    const expire = Ref.updateAndGet(attempts, (count) => count + 1).pipe(
      Effect.flatMap((count) => (count < 3 ? Effect.fail("record failed") : Effect.void)),
    );
    yield* schedule("request-1", new Date(10_000).toISOString(), expire);
    // A second schedule of the same key is ignored.
    yield* schedule("request-1", new Date(10_000).toISOString(), expire);
    yield* TestClock.adjust("9 seconds");
    assert.strictEqual(yield* Ref.get(attempts), 0);
    yield* TestClock.adjust("1 second");
    assert.strictEqual(yield* Ref.get(attempts), 1);
    yield* TestClock.adjust("1 second");
    assert.strictEqual(yield* Ref.get(attempts), 2);
    yield* TestClock.adjust("2 seconds");
    assert.strictEqual(yield* Ref.get(attempts), 3);
    assert.strictEqual(yield* Ref.get(failures), 2);
  }),
);
