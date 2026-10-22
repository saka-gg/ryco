/**
 * KeyedSingleFlight - one run per key at a time, shared by every caller.
 *
 * The first caller for a key starts the run; a caller that arrives while it is
 * running waits for that run's outcome instead of starting its own. Once the
 * run settles the key is free again, and the next caller starts a new one.
 *
 * The run is detached from the caller that started it: a caller that is
 * interrupted only stops waiting, and never cuts the run off for the others.
 *
 * @module KeyedSingleFlight
 */
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

export interface KeyedSingleFlight<Key, A, E> {
  /** Runs `run` under `key`, or waits for the run already in flight for it. */
  readonly join: <R>(key: Key, run: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Keys with a run in flight. For tests and diagnostics. */
  readonly size: () => number;
}

export const makeKeyedSingleFlight = <Key, A, E>(): KeyedSingleFlight<Key, A, E> => {
  const running = new Map<Key, Deferred.Deferred<A, E>>();
  return {
    join: (key, run) =>
      // A run is registered together with the fiber that settles it, or not at
      // all: an interruption between the two would leave every later caller for
      // the key waiting on an outcome nothing ever completes. Only the wait is
      // interruptible; the forked run is interruptible on its own.
      Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          const existing = running.get(key);
          if (existing) return restore(Deferred.await(existing));
          const outcome = Deferred.makeUnsafe<A, E>();
          running.set(key, outcome);
          return run.pipe(
            Effect.onExit((exit) =>
              Effect.suspend(() => {
                if (running.get(key) === outcome) running.delete(key);
                return Deferred.done(outcome, exit);
              }),
            ),
            Effect.forkDetach,
            Effect.andThen(restore(Deferred.await(outcome))),
          );
        }),
      ),
    size: () => running.size,
  };
};
