/**
 * Deadlines that count only the time the event loop was free to run.
 *
 * A plain `Effect.timeout`/`timeoutOption` sleeps for its whole budget on one
 * timer. When the loop is blocked (a long synchronous task, a garbage
 * collection pause, a heap snapshot) or the machine sleeps, that timer expires
 * meanwhile. Once the loop runs again, expired timers fire in the timers phase,
 * before the poll phase delivers I/O that finished during the stall, so work
 * that was healthy (a git child that already exited, a provider answer already
 * in the pipe, a child process that was suspended with the machine) fails on a
 * deadline it never really used.
 *
 * Here the budget is spent in ticks of at most
 * `RESPONSIVE_DEADLINE_MAX_TICK_MS`. Each tick charges the time that really
 * passed, capped at the tick length, so a stalled or suspended gap of any
 * length costs at most one tick, while an operation that hangs on a responsive
 * loop still expires on time. On macOS and Windows the monotonic clock (and
 * libuv's timers) keep running across machine sleep, so sleep is one such gap.
 * The trade: a loop that is blocked again and again stretches a deadline by up
 * to one tick per blocked gap (a loop that runs each 1 s tick 2 s late triples
 * a long budget). A wall-clock cap would bring back the failure after machine
 * sleep, so there is none.
 *
 * Use it for deadlines whose expiry fails work or a request: fail a session
 * start or a turn, fail a user's interrupt or stop request, kill a git child.
 * `makeResponsiveIdleDeadline` is the same budget started over by each sign of
 * life, for a watch that fails work gone quiet (a clone that prints nothing).
 * Do not use it where the timer's job is to notice that time passed
 * (heartbeats, liveness probes, retry backoff, debounces), nor for waits whose
 * expiry only escalates cleanup that is already under way (give a closing
 * query a few seconds, then kill it): firing early there costs nothing, and
 * such waits should not grow when the loop is busy.
 *
 * It runs on Effect's `Clock`, so `TestClock` drives it like `Effect.sleep`:
 * the last tick lands exactly on the budget. Effect-only and free of Node
 * imports, so any runtime can use it.
 *
 * @module responsiveDeadline
 */
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { dual } from "effect/Function";
import * as Option from "effect/Option";

/** A stalled or suspended gap costs at most this much of a deadline's budget. */
export const RESPONSIVE_DEADLINE_MAX_TICK_MS = 1_000;

/**
 * Tick length for a budget: a quarter of it, between 1 ms and
 * `RESPONSIVE_DEADLINE_MAX_TICK_MS`, so short deadlines still lose at most a
 * quarter of their budget to a stall.
 */
export const responsiveDeadlineTickMs = (budgetMs: number): number =>
  Math.max(1, Math.min(RESPONSIVE_DEADLINE_MAX_TICK_MS, Math.ceil(budgetMs / 4)));

const NANOS_PER_MILLI = 1_000_000;

/**
 * A deadline for a quiet spell, started over by every sign of life: `expired`
 * completes once the event loop has been free to run for `budget` without a
 * `touch`. Time is charged as by `sleepWhileResponsive`, so a stalled or
 * suspended gap costs at most one tick, and output that a blocked loop or a
 * machine sleep held back still arrives before the deadline rather than after
 * it. `touch` is synchronous and cheap enough to call for every line a child
 * prints. Run `expired` once.
 */
export interface ResponsiveIdleDeadline {
  readonly touch: () => void;
  readonly expired: Effect.Effect<void>;
}

export const makeResponsiveIdleDeadline = (
  budget: Duration.Input,
): Effect.Effect<ResponsiveIdleDeadline> =>
  Clock.clockWith((clock) =>
    Effect.sync(() => {
      const budgetMs = Duration.toMillis(Duration.fromInputUnsafe(budget));
      let spentMs = 0;
      let lastNanos = clock.monotonicTimeNanosUnsafe();
      let touchedDuringStep = false;
      const touch = () => {
        spentMs = 0;
        lastNanos = clock.monotonicTimeNanosUnsafe();
        touchedDuringStep = true;
      };
      if (budgetMs === Number.POSITIVE_INFINITY) return { touch, expired: Effect.never };
      if (!(budgetMs > 0)) return { touch, expired: Effect.yieldNow };
      const tickMs = responsiveDeadlineTickMs(budgetMs);
      const tick = (): Effect.Effect<void> =>
        Effect.suspend(() => {
          touchedDuringStep = false;
          const stepMs = Math.min(tickMs, budgetMs - spentMs);
          return Effect.flatMap(clock.sleep(Duration.millis(stepMs)), () => {
            const nowNanos = clock.monotonicTimeNanosUnsafe();
            const elapsedMs = Number(nowNanos - lastNanos) / NANOS_PER_MILLI;
            lastNanos = nowNanos;
            // A timer can fire early by the loop's cached time, so charge what
            // really passed (since the last touch); a stall or sleep charges one
            // step, not its length. A clock that did not move at all is charged
            // the whole step, or the loop would spin: TestClock keeps float
            // milliseconds, so at a large timestamp a tiny remainder rounds away
            // and its sleep returns at once. Unless a touch just started the
            // budget over: then nothing has passed since.
            spentMs += elapsedMs > 0 ? Math.min(elapsedMs, stepMs) : touchedDuringStep ? 0 : stepMs;
            return spentMs < budgetMs ? tick() : Effect.void;
          });
        });
      return { touch, expired: tick() };
    }),
  );

/**
 * Completes once the event loop has been free to run for `budget`. A budget of
 * zero or less completes after one yield; an infinite one never completes.
 */
export const sleepWhileResponsive = (budget: Duration.Input): Effect.Effect<void> =>
  Effect.flatMap(makeResponsiveIdleDeadline(budget), (deadline) => deadline.expired);

/**
 * `Effect.timeoutOption`, but only time the event loop was free to run counts
 * toward the budget. Same race and interruption semantics: Effect defines
 * `timeoutOption` as this race over `Effect.sleep`.
 */
export const timeoutWhileResponsiveOption: typeof Effect.timeoutOption = dual(
  2,
  <A, E, R>(
    self: Effect.Effect<A, E, R>,
    budget: Duration.Input,
  ): Effect.Effect<Option.Option<A>, E, R> =>
    Effect.raceFirst(
      Effect.asSome(self),
      Effect.as(sleepWhileResponsive(budget), Option.none<A>()),
    ),
);

/** `Effect.timeoutOrElse`, but only time the event loop was free to run counts. */
export const timeoutWhileResponsiveOrElse: typeof Effect.timeoutOrElse = dual(
  2,
  <A, E, R, A2, E2, R2>(
    self: Effect.Effect<A, E, R>,
    options: {
      readonly duration: Duration.Input;
      readonly orElse: () => Effect.Effect<A2, E2, R2>;
    },
  ): Effect.Effect<A | A2, E | E2, R | R2> =>
    Effect.flatMap(
      timeoutWhileResponsiveOption(self, options.duration),
      (option): Effect.Effect<A | A2, E2, R2> =>
        Option.isNone(option) ? options.orElse() : Effect.succeed(option.value),
    ),
);

/**
 * `Effect.timeout`, but only time the event loop was free to run counts. Fails
 * with the same `Cause.TimeoutError` (and message) at the deadline.
 */
export const timeoutWhileResponsive: typeof Effect.timeout = dual(
  2,
  <A, E, R>(
    self: Effect.Effect<A, E, R>,
    budget: Duration.Input,
  ): Effect.Effect<A, E | Cause.TimeoutError, R> => {
    const duration = Duration.fromInputUnsafe(budget);
    return timeoutWhileResponsiveOrElse(self, {
      duration,
      orElse: () =>
        Effect.fail(
          new Cause.TimeoutError(`Operation timed out after '${Duration.format(duration)}'`),
        ),
    });
  },
);
