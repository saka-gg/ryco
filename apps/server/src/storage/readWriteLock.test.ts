import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber } from "effect";

import { makeReadWriteLockUnsafe } from "./readWriteLock.ts";

/** Yield until forked fibers have run as far as they can. */
const settle = Effect.gen(function* () {
  for (let index = 0; index < 20; index++) yield* Effect.yieldNow;
});

/** A holder that records when it entered and stays inside until `release` completes. */
const holder = (log: Array<string>, name: string, release: Deferred.Deferred<void>) =>
  Effect.gen(function* () {
    log.push(`${name}:enter`);
    yield* Deferred.await(release);
    log.push(`${name}:exit`);
  });

it.effect("lets shared holders overlap", () =>
  Effect.gen(function* () {
    const lock = makeReadWriteLockUnsafe();
    const log: Array<string> = [];
    const release = yield* Deferred.make<void>();
    const first = yield* lock.withShared(holder(log, "a", release)).pipe(Effect.forkChild);
    const second = yield* lock.withShared(holder(log, "b", release)).pipe(Effect.forkChild);
    yield* settle;
    assert.deepEqual(log, ["a:enter", "b:enter"]);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
  }),
);

it.effect("runs an exclusive holder alone, after the shared holders before it", () =>
  Effect.gen(function* () {
    const lock = makeReadWriteLockUnsafe();
    const log: Array<string> = [];
    const releaseShared = yield* Deferred.make<void>();
    const releaseExclusive = yield* Deferred.make<void>();
    const shared = yield* lock
      .withShared(holder(log, "shared", releaseShared))
      .pipe(Effect.forkChild);
    yield* settle;
    const exclusive = yield* lock
      .withPermit(holder(log, "exclusive", releaseExclusive))
      .pipe(Effect.forkChild);
    yield* settle;
    assert.deepEqual(log, ["shared:enter"]);

    yield* Deferred.succeed(releaseShared, undefined);
    yield* Fiber.join(shared);
    yield* settle;
    assert.deepEqual(log, ["shared:enter", "shared:exit", "exclusive:enter"]);

    const later = yield* lock
      .withShared(Effect.sync(() => log.push("later")))
      .pipe(Effect.forkChild);
    yield* settle;
    assert.notInclude(log, "later");
    yield* Deferred.succeed(releaseExclusive, undefined);
    yield* Fiber.join(exclusive);
    yield* Fiber.join(later);
    assert.deepEqual(log.slice(-2), ["exclusive:exit", "later"]);
  }),
);

it.effect("admits in arrival order, so a stream of shared work cannot starve exclusive work", () =>
  Effect.gen(function* () {
    const lock = makeReadWriteLockUnsafe();
    const log: Array<string> = [];
    const releaseFirst = yield* Deferred.make<void>();
    const first = yield* lock.withShared(holder(log, "first", releaseFirst)).pipe(Effect.forkChild);
    yield* settle;
    const exclusive = yield* lock
      .withPermit(Effect.sync(() => log.push("exclusive")))
      .pipe(Effect.forkChild);
    yield* settle;
    // Arrives while the exclusive request waits: queues behind it instead of joining `first`.
    const second = yield* lock
      .withShared(Effect.sync(() => log.push("second")))
      .pipe(Effect.forkChild);
    yield* settle;
    assert.deepEqual(log, ["first:enter"]);

    yield* Deferred.succeed(releaseFirst, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(exclusive);
    yield* Fiber.join(second);
    assert.deepEqual(log, ["first:enter", "first:exit", "exclusive", "second"]);
  }),
);

it.effect("admits the shared waiters behind an exclusive waiter that is interrupted", () =>
  Effect.gen(function* () {
    const lock = makeReadWriteLockUnsafe();
    const log: Array<string> = [];
    const releaseFirst = yield* Deferred.make<void>();
    const first = yield* lock.withShared(holder(log, "first", releaseFirst)).pipe(Effect.forkChild);
    yield* settle;
    const exclusive = yield* lock
      .withPermit(Effect.sync(() => log.push("exclusive")))
      .pipe(Effect.forkChild);
    yield* settle;
    const second = yield* lock
      .withShared(Effect.sync(() => log.push("second")))
      .pipe(Effect.forkChild);
    yield* settle;
    assert.deepEqual(log, ["first:enter"]);

    yield* Fiber.interrupt(exclusive);
    yield* Fiber.join(second);
    assert.deepEqual(log, ["first:enter", "second"]);

    yield* Deferred.succeed(releaseFirst, undefined);
    yield* Fiber.join(first);
    // Nothing leaked: an exclusive holder is admitted right away.
    yield* lock.withPermit(Effect.sync(() => log.push("after")));
    assert.deepEqual(log.at(-1), "after");
  }),
);

it.effect("releases on failure and on interruption of a holder", () =>
  Effect.gen(function* () {
    const lock = makeReadWriteLockUnsafe();
    const failed = yield* lock.withPermit(Effect.fail("boom")).pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(failed));

    const entered = yield* Deferred.make<void>();
    const held = yield* lock
      .withShared(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(held);

    let ran = false;
    yield* lock.withPermit(
      Effect.sync(() => {
        ran = true;
      }),
    );
    assert.isTrue(ran);
  }),
);
