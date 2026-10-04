import { assert, it } from "@effect/vitest";
import { Deferred, Duration, Effect, Exit, Fiber, Option, Scope } from "effect";
import { TestClock } from "effect/testing";

import { runDetachedWithDeadline, runDetachedWithDeadlineOption } from "./detachedDeadline.ts";

class DeadlineError {
  readonly _tag = "DeadlineError";
}

it.effect("returns a value that arrives before the deadline and never abandons", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const abandoned: Array<Exit.Exit<number, never>> = [];
    const value = yield* runDetachedWithDeadline(Effect.succeed(42), {
      scope,
      timeoutMs: 1_000,
      onTimeout: () => new DeadlineError(),
      onAbandon: (exit) => Effect.sync(() => void abandoned.push(exit)),
    });
    assert.equal(value, 42);
    yield* Effect.yieldNow;
    assert.equal(abandoned.length, 0);
  }),
);

it.effect("propagates the operation's own failure", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const error = yield* runDetachedWithDeadline(Effect.fail("adapter failed" as const), {
      scope,
      timeoutMs: 1_000,
      onTimeout: () => new DeadlineError(),
    }).pipe(Effect.flip);
    assert.equal(error, "adapter failed");
  }),
);

it.effect("fails at the deadline even when the operation cannot be interrupted", () =>
  Effect.gen(function* () {
    // Never closed: the zombie fiber below keeps running after the test.
    const scope = yield* Scope.make();
    const caller = yield* runDetachedWithDeadline(Effect.uninterruptible(Effect.never), {
      scope,
      timeoutMs: 100,
      onTimeout: () => new DeadlineError(),
    }).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.millis(100));
    const exit = yield* Fiber.await(caller);
    assert.isTrue(Exit.isFailure(exit));
    const error = yield* Fiber.join(caller).pipe(Effect.flip);
    assert.instanceOf(error, DeadlineError);
  }),
);

it.effect(
  "returns at once when the caller is interrupted and abandons after the operation exits",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const abandoned = yield* Deferred.make<Exit.Exit<string, never>>();
      const caller = yield* runDetachedWithDeadline(
        Effect.uninterruptible(
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(finish)),
            Effect.as("late"),
          ),
        ),
        {
          scope,
          timeoutMs: 10_000,
          onTimeout: () => new DeadlineError(),
          onAbandon: (exit) => Deferred.succeed(abandoned, exit).pipe(Effect.asVoid),
        },
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(entered);
      // The operation is still inside its uninterruptible region, yet the caller returns.
      yield* Fiber.interrupt(caller);
      assert.isFalse(yield* Deferred.isDone(abandoned));
      yield* Deferred.succeed(finish, undefined);
      const exit = yield* Deferred.await(abandoned);
      assert.isTrue(Exit.isSuccess(exit));
    }),
);

it.effect("undoes work that completes after the deadline inside an uninterruptible region", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const finish = yield* Deferred.make<void>();
    const undone = yield* Deferred.make<void>();
    const abandoned = yield* Deferred.make<Exit.Exit<string, never>>();
    const caller = yield* runDetachedWithDeadline(
      // The late result is produced, then the pending interrupt is delivered on
      // leaving the region: the operation's own onInterrupt undoes it (this is
      // how ProviderService stops a runtime whose start finished too late).
      Effect.uninterruptible(Deferred.await(finish).pipe(Effect.as("late-runtime"))).pipe(
        Effect.onInterrupt(() => Deferred.succeed(undone, undefined)),
      ),
      {
        scope,
        timeoutMs: 50,
        onTimeout: () => new DeadlineError(),
        onAbandon: (exit) => Deferred.succeed(abandoned, exit).pipe(Effect.asVoid),
      },
    ).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.millis(50));
    const error = yield* Fiber.join(caller).pipe(Effect.flip);
    assert.instanceOf(error, DeadlineError);
    assert.isFalse(yield* Deferred.isDone(abandoned));
    yield* Deferred.succeed(finish, undefined);
    const exit = yield* Deferred.await(abandoned);
    assert.isTrue(Exit.hasInterrupts(exit));
    assert.isTrue(yield* Deferred.isDone(undone));
  }),
);

it.effect("with an abandon grace, an interruptible late success still reaches onAbandon", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const finish = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    const abandoned = yield* Deferred.make<Exit.Exit<string, never>>();
    const caller = yield* runDetachedWithDeadline(
      Deferred.await(finish).pipe(
        Effect.as("late-turn"),
        Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
      ),
      {
        scope,
        timeoutMs: 50,
        abandonGraceMs: 50,
        onTimeout: () => new DeadlineError(),
        onAbandon: (exit) => Deferred.succeed(abandoned, exit).pipe(Effect.asVoid),
      },
    ).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.millis(50));
    assert.instanceOf(yield* Fiber.join(caller).pipe(Effect.flip), DeadlineError);
    // Within the grace the operation is left running, so its late answer is seen.
    assert.isFalse(yield* Deferred.isDone(interrupted));
    yield* Deferred.succeed(finish, undefined);
    const exit = yield* Deferred.await(abandoned);
    assert.isTrue(Exit.isSuccess(exit) && exit.value === "late-turn");
    assert.isFalse(yield* Deferred.isDone(interrupted));
  }),
);

it.effect("an operation still running after the abandon grace is interrupted", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const interrupted = yield* Deferred.make<void>();
    const abandoned = yield* Deferred.make<Exit.Exit<never, never>>();
    const caller = yield* runDetachedWithDeadline(
      Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
      {
        scope,
        timeoutMs: 50,
        abandonGraceMs: 100,
        onTimeout: () => new DeadlineError(),
        onAbandon: (exit) => Deferred.succeed(abandoned, exit).pipe(Effect.asVoid),
      },
    ).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.millis(50));
    assert.instanceOf(yield* Fiber.join(caller).pipe(Effect.flip), DeadlineError);
    yield* TestClock.adjust(Duration.millis(99));
    assert.isFalse(yield* Deferred.isDone(interrupted));
    yield* TestClock.adjust(Duration.millis(1));
    assert.isTrue(Exit.hasInterrupts(yield* Deferred.await(abandoned)));
    assert.isTrue(yield* Deferred.isDone(interrupted));
  }),
);

it.effect("the option variant yields None at the deadline", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const caller = yield* runDetachedWithDeadlineOption(Effect.uninterruptible(Effect.never), {
      scope,
      timeoutMs: 20,
    }).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.millis(20));
    assert.isTrue(Option.isNone(yield* Fiber.join(caller)));
    assert.deepStrictEqual(
      yield* runDetachedWithDeadlineOption(Effect.succeed(1), { scope, timeoutMs: 20 }),
      Option.some(1),
    );
  }),
);
