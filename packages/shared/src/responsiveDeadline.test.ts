import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";

import {
  makeResponsiveIdleDeadline,
  RESPONSIVE_DEADLINE_MAX_TICK_MS,
  responsiveDeadlineTickMs,
  sleepWhileResponsive,
  timeoutWhileResponsive,
  timeoutWhileResponsiveOption,
  timeoutWhileResponsiveOrElse,
} from "./responsiveDeadline.ts";

const NANOS_PER_MILLI = 1_000_000n;

/** Sleeps one deadline may start before a test calls it a spin. */
const MAX_SLEEPS = 1_000;

/**
 * The test clock, with a monotonic offset a test can move to model a stalled
 * or suspended loop (time jumps while no timer runs), a count of sleeps still
 * registered, and a count of every sleep started (a spin dies at MAX_SLEEPS).
 */
const makeObservedClock = Effect.fnUntraced(function* () {
  const testClock = yield* Clock.clockWith(Effect.succeed);
  const state = { offsetNanos: 0n, pendingSleeps: 0, startedSleeps: 0 };
  const monotonicTimeNanosUnsafe = () => testClock.monotonicTimeNanosUnsafe() + state.offsetNanos;
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => testClock.currentTimeMillisUnsafe(),
    currentTimeMillis: testClock.currentTimeMillis,
    currentTimeNanosUnsafe: () => testClock.currentTimeNanosUnsafe(),
    currentTimeNanos: testClock.currentTimeNanos,
    monotonicTimeNanosUnsafe,
    monotonicTimeNanos: Effect.sync(monotonicTimeNanosUnsafe),
    sleep: (duration) =>
      Effect.suspend(() => {
        state.startedSleeps += 1;
        if (state.startedSleeps > MAX_SLEEPS) return Effect.die("the deadline spins");
        state.pendingSleeps += 1;
        return Effect.void;
      }).pipe(
        Effect.andThen(testClock.sleep(duration)),
        Effect.ensuring(
          Effect.sync(() => {
            state.pendingSleeps -= 1;
          }),
        ),
      ),
  };
  return {
    state,
    /** Moves monotonic time without running any timer, as a blocked loop or machine sleep does. */
    jump: (millis: number) => {
      state.offsetNanos += BigInt(millis) * NANOS_PER_MILLI;
    },
    provide: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.provideService(effect, Clock.Clock, clock),
  };
});

const isDone = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Effect.yieldNow.pipe(Effect.as(fiber.pollUnsafe() !== undefined));

describe("responsiveDeadlineTickMs", () => {
  it("charges at most a quarter of short budgets and one second of long ones", () => {
    assert.equal(responsiveDeadlineTickMs(1), 1);
    assert.equal(responsiveDeadlineTickMs(4), 1);
    assert.equal(responsiveDeadlineTickMs(300), 75);
    assert.equal(responsiveDeadlineTickMs(1_001), 251);
    assert.equal(responsiveDeadlineTickMs(2_000), 500);
    assert.equal(responsiveDeadlineTickMs(30_000), RESPONSIVE_DEADLINE_MAX_TICK_MS);
  });
});

describe("sleepWhileResponsive", () => {
  for (const budgetMs of [2_000, 30_000, 1_001, 3]) {
    it.effect(`is pending at ${budgetMs - 1} ms and expires at exactly ${budgetMs} ms`, () =>
      Effect.gen(function* () {
        const fiber = yield* sleepWhileResponsive(budgetMs).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* TestClock.adjust(Duration.millis(budgetMs - 1));
        assert.isFalse(yield* isDone(fiber));
        yield* TestClock.adjust(Duration.millis(1));
        assert.isTrue(yield* isDone(fiber));
      }),
    );
  }

  it.effect("expires on time when the clock is advanced in steps that do not match its ticks", () =>
    Effect.gen(function* () {
      const fiber = yield* sleepWhileResponsive("2 seconds").pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      for (let i = 0; i < 19; i++) yield* TestClock.adjust(Duration.millis(105));
      assert.isFalse(yield* isDone(fiber));
      yield* TestClock.adjust(Duration.millis(5));
      assert.isTrue(yield* isDone(fiber));
    }),
  );

  it.effect("charges a stalled or suspended gap as one tick, not its length", () =>
    Effect.gen(function* () {
      const clock = yield* makeObservedClock();
      // 2 s budget: 500 ms ticks.
      const fiber = yield* clock
        .provide(sleepWhileResponsive("2 seconds"))
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust(Duration.millis(100));
      // The loop is blocked (or the machine asleep) for 10 s inside the first tick.
      clock.jump(10_000);
      yield* TestClock.adjust(Duration.millis(400));
      // That tick is charged 500 ms; 1.5 s of responsive time remain.
      yield* TestClock.adjust(Duration.millis(1_499));
      assert.isFalse(yield* isDone(fiber));
      yield* TestClock.adjust(Duration.millis(1));
      assert.isTrue(yield* isDone(fiber));
    }),
  );

  it.effect("charges a tick that ends early only the time that really passed", () =>
    Effect.gen(function* () {
      const clock = yield* makeObservedClock();
      const fiber = yield* clock
        .provide(sleepWhileResponsive("2 seconds"))
        .pipe(Effect.forkChild({ startImmediately: true }));
      // The first tick fires 30 ms early by the monotonic clock.
      clock.jump(-30);
      yield* TestClock.adjust(Duration.millis(2_000));
      assert.isFalse(yield* isDone(fiber));
      yield* TestClock.adjust(Duration.millis(29));
      assert.isFalse(yield* isDone(fiber));
      yield* TestClock.adjust(Duration.millis(1));
      assert.isTrue(yield* isDone(fiber));
    }),
  );

  it.effect("ends when the test clock cannot represent its last step exactly", () =>
    Effect.gen(function* () {
      // At a large timestamp TestClock's float milliseconds round a nanosecond
      // budget's remainder away; that sleep returns at once without moving the
      // clock, and must still count.
      yield* TestClock.setTime(1_761_000_000_123.456);
      const clock = yield* makeObservedClock();
      const fiber = yield* clock
        .provide(sleepWhileResponsive(Duration.nanos(1_000_000_001n)))
        .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust(Duration.millis(1_001));
      assert.isTrue(yield* isDone(fiber));
      assert.deepStrictEqual(yield* Fiber.join(fiber), Exit.void);
      // Four ticks of 251/251/251/247 ms, plus at most one for the rounding.
      assert.isAtMost(clock.state.startedSleeps, 5);
    }),
  );

  it.effect("completes after a yield for a budget of zero and never for an infinite one", () =>
    Effect.gen(function* () {
      yield* sleepWhileResponsive(Duration.zero);
      const forever = yield* sleepWhileResponsive(Duration.infinity).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust(Duration.days(365));
      assert.isFalse(yield* isDone(forever));
      yield* Fiber.interrupt(forever);
    }),
  );
});

describe("makeResponsiveIdleDeadline", () => {
  it.effect("starts the budget over on every touch and expires a whole budget after the last", () =>
    Effect.gen(function* () {
      // 2 s budget: 500 ms ticks.
      const deadline = yield* makeResponsiveIdleDeadline("2 seconds");
      const fiber = yield* deadline.expired.pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust(Duration.millis(1_900));
      deadline.touch();
      // Touches between ticks, not on them.
      yield* TestClock.adjust(Duration.millis(1_250));
      deadline.touch();
      yield* TestClock.adjust(Duration.millis(1_999));
      assert.isFalse(yield* isDone(fiber));
      yield* TestClock.adjust(Duration.millis(1));
      assert.isTrue(yield* isDone(fiber));
    }),
  );

  it.effect(
    "charges a suspended gap one tick, and output it held back starts the budget over",
    () =>
      Effect.gen(function* () {
        const clock = yield* makeObservedClock();
        const deadline = yield* clock.provide(makeResponsiveIdleDeadline("2 seconds"));
        const fiber = yield* deadline.expired.pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust(Duration.millis(1_400));
        // The machine sleeps for 10 minutes inside the third tick, which fires late on wake.
        clock.jump(600_000);
        yield* TestClock.adjust(Duration.millis(100));
        assert.isFalse(yield* isDone(fiber));
        // Then the output that arrived meanwhile is read.
        deadline.touch();
        yield* TestClock.adjust(Duration.millis(1_999));
        assert.isFalse(yield* isDone(fiber));
        yield* TestClock.adjust(Duration.millis(1));
        assert.isTrue(yield* isDone(fiber));
      }),
  );

  it.effect("charges nothing for a step that ends at the moment of a touch", () =>
    Effect.gen(function* () {
      const clock = yield* makeObservedClock();
      const deadline = yield* clock.provide(makeResponsiveIdleDeadline("2 seconds"));
      const fiber = yield* deadline.expired.pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust(Duration.millis(300));
      deadline.touch();
      // The first tick fires 200 ms early by the monotonic clock: at the touch's own time.
      clock.jump(-200);
      yield* TestClock.adjust(Duration.millis(2_199));
      assert.isFalse(yield* isDone(fiber));
      yield* TestClock.adjust(Duration.millis(1));
      assert.isTrue(yield* isDone(fiber));
    }),
  );
});

describe("timeoutWhileResponsiveOption", () => {
  it.effect("returns the effect's value when it wins and leaves no sleep behind", () =>
    Effect.gen(function* () {
      const clock = yield* makeObservedClock();
      const answer = yield* Deferred.make<string>();
      const fiber = yield* clock
        .provide(timeoutWhileResponsiveOption(Deferred.await(answer), "30 seconds"))
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust(Duration.millis(2_500));
      assert.equal(clock.state.pendingSleeps, 1);
      yield* Deferred.succeed(answer, "done");
      assert.deepStrictEqual(yield* Fiber.join(fiber), Option.some("done"));
      assert.equal(clock.state.pendingSleeps, 0);
    }),
  );

  it.effect("yields None at the deadline and propagates the effect's own failure", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.never.pipe(
        timeoutWhileResponsiveOption(Duration.millis(300)),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust(Duration.millis(300));
      assert.isTrue(Option.isNone(yield* Fiber.join(fiber)));
      const error = yield* timeoutWhileResponsiveOption(Effect.fail("boom" as const), 300).pipe(
        Effect.flip,
      );
      assert.equal(error, "boom");
    }),
  );

  it.effect("interrupting the caller leaves no sleep behind", () =>
    Effect.gen(function* () {
      const clock = yield* makeObservedClock();
      const fiber = yield* clock
        .provide(timeoutWhileResponsiveOption(Effect.never, "30 seconds"))
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust(Duration.millis(1_500));
      assert.equal(clock.state.pendingSleeps, 1);
      yield* Fiber.interrupt(fiber);
      assert.equal(clock.state.pendingSleeps, 0);
    }),
  );

  it.effect("a budget of zero times out a pending effect after a yield", () =>
    Effect.gen(function* () {
      const result = yield* timeoutWhileResponsiveOption(Effect.never, Duration.zero);
      assert.isTrue(Option.isNone(result));
    }),
  );
});

describe("timeoutWhileResponsiveOrElse", () => {
  it.effect("runs orElse at the deadline only", () =>
    Effect.gen(function* () {
      const late = yield* Effect.never.pipe(
        timeoutWhileResponsiveOrElse({
          duration: "2 seconds",
          orElse: () => Effect.fail("deadline" as const),
        }),
        Effect.flip,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust(Duration.millis(1_999));
      assert.isFalse(yield* isDone(late));
      yield* TestClock.adjust(Duration.millis(1));
      assert.equal(yield* Fiber.join(late), "deadline");

      const value = yield* timeoutWhileResponsiveOrElse(Effect.succeed(7), {
        duration: "2 seconds",
        orElse: () => Effect.fail("deadline" as const),
      });
      assert.equal(value, 7);
    }),
  );
});

describe("timeoutWhileResponsive", () => {
  it.effect("fails with Effect's own TimeoutError at the deadline only", () =>
    Effect.gen(function* () {
      const late = yield* Effect.never.pipe(
        timeoutWhileResponsive("2 seconds"),
        Effect.flip,
        Effect.forkChild({ startImmediately: true }),
      );
      const plain = yield* Effect.never.pipe(
        Effect.timeout("2 seconds"),
        Effect.flip,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust(Duration.millis(1_999));
      assert.isFalse(yield* isDone(late));
      yield* TestClock.adjust(Duration.millis(1));
      const error = yield* Fiber.join(late);
      assert.isTrue(Cause.isTimeoutError(error));
      assert.equal(error.message, (yield* Fiber.join(plain)).message);

      assert.equal(yield* timeoutWhileResponsive(Effect.succeed(7), "2 seconds"), 7);
    }),
  );
});
