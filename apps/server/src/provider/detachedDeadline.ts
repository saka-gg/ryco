/**
 * Deadlines for provider operations that hold even when the operation cannot
 * be interrupted.
 *
 * `Effect.timeout`, `timeoutOption` and `race` resume only after the loser has
 * been interrupted *and has exited*. A deadline wrapped directly around an
 * adapter call that sits in an uninterruptible region, or that has slow scope
 * finalizers (an ACP session scope kills a child process), therefore returns
 * only when that region ends.
 *
 * `runDetachedWithDeadline` forks the operation into a long-lived scope (the
 * ProviderService layer scope) and races a `Fiber.await` *observer* against
 * the deadline. Interrupting an observer is instant, so the caller stops
 * waiting promptly whichever way it ends:
 *
 * - deadline: the caller fails with `onTimeout()`; the operation is
 *   interrupted in the background.
 * - caller interrupted (for example a Stop cancel): the caller returns at once
 *   and the operation is abandoned the same way.
 * - in both cases `onAbandon(exit)` runs once the operation fiber has really
 *   exited, so a late success can be undone (stop the new runtime, interrupt
 *   the late turn). With `abandonGraceMs`, the operation first gets that long to
 *   finish on its own, so a late success is observable at all.
 *
 * Locks and permits taken *inside* the operation are released only when its
 * fiber exits, so "one adapter start per thread at a time" still holds.
 *
 * @module detachedDeadline
 */
import { Cause, Duration, Effect, Exit, Fiber, Option } from "effect";
import type { Scope } from "effect";

export interface DetachedDeadlineOptions<A, E, E2> {
  /** Outlives callers; the operation and its cleanup run here. */
  readonly scope: Scope.Scope;
  readonly timeoutMs: number;
  /** Evaluated at the deadline. */
  readonly onTimeout: () => E2;
  /** Runs in the background once an abandoned operation has really exited. */
  readonly onAbandon?: (exit: Exit.Exit<A, E>) => Effect.Effect<void>;
  /**
   * Lets an abandoned operation run this much longer before it is interrupted.
   * An interrupted fiber exits Interrupted, never Success, so without a grace a
   * request that already reached the provider can never be seen succeeding late
   * (and undone by `onAbandon`).
   */
  readonly abandonGraceMs?: number;
}

const abandonIn = <A, E>(
  fiber: Fiber.Fiber<A, E>,
  options: Pick<DetachedDeadlineOptions<A, E, unknown>, "scope" | "onAbandon" | "abandonGraceMs">,
): Effect.Effect<void> =>
  Effect.forkIn(
    (options.abandonGraceMs === undefined
      ? Effect.succeed(Option.none<Exit.Exit<A, E>>())
      : Fiber.await(fiber).pipe(Effect.timeoutOption(Duration.millis(options.abandonGraceMs)))
    ).pipe(
      Effect.flatMap((settled) =>
        Option.isSome(settled)
          ? Effect.succeed(settled.value)
          : Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber))),
      ),
      Effect.flatMap((exit) => options.onAbandon?.(exit) ?? Effect.void),
      Effect.catchCause((cause) =>
        Effect.logWarning("provider.detached-abandon-failed", { cause: Cause.pretty(cause) }),
      ),
    ),
    options.scope,
  ).pipe(Effect.asVoid);

/**
 * Waits for the detached operation at most `timeoutMs`. `None` means the
 * deadline fired and the operation was abandoned.
 */
const awaitDetached = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: DetachedDeadlineOptions<A, E, unknown>,
): Effect.Effect<Option.Option<A>, E, R> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkIn(effect, options.scope, { startImmediately: true });
      const abandon = abandonIn(fiber, options);
      const waited = yield* restore(
        Fiber.await(fiber).pipe(Effect.timeoutOption(Duration.millis(options.timeoutMs))),
      ).pipe(Effect.onInterrupt(() => abandon));
      if (Option.isNone(waited)) {
        yield* abandon;
        return Option.none<A>();
      }
      return Option.some(yield* waited.value);
    }),
  );

/** Runs `effect` detached and fails with `onTimeout()` at the deadline. */
export const runDetachedWithDeadline = <A, E, R, E2>(
  effect: Effect.Effect<A, E, R>,
  options: DetachedDeadlineOptions<A, E, E2>,
): Effect.Effect<A, E | E2, R> =>
  awaitDetached(effect, options).pipe(
    Effect.flatMap((result) =>
      Option.isSome(result) ? Effect.succeed(result.value) : Effect.fail(options.onTimeout()),
    ),
  );

/** Like `runDetachedWithDeadline`, but a deadline yields `None` instead of failing. */
export const runDetachedWithDeadlineOption = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: Omit<DetachedDeadlineOptions<A, E, never>, "onTimeout">,
): Effect.Effect<Option.Option<A>, E, R> =>
  awaitDetached(effect, { ...options, onTimeout: () => undefined as never });
