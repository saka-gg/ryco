/**
 * A fair read/write lock for Effect fibers.
 *
 * Shared holders run concurrently with each other; an exclusive holder runs alone. Waiters are
 * admitted strictly in arrival order, consecutive shared waiters together: a shared request that
 * arrives while an exclusive one waits queues behind it (so exclusive work cannot starve), and an
 * exclusive request waits only for the holders admitted before it (so shared work cannot starve
 * behind a stream of exclusive requests either).
 *
 * Not reentrant, like `Semaphore`: a holder that waits for the lock again, in its own fiber or a
 * child's, deadlocks once anything is queued.
 *
 * Interruption is safe at every point: a waiter interrupted before admission leaves the queue
 * (admitting whoever it blocked), one interrupted right after admission returns its grant, and a
 * holder releases on any exit.
 *
 * @module readWriteLock
 */
import { Effect } from "effect";

export interface ReadWriteLock {
  /** Run `effect` concurrently with other shared holders; excluded only by exclusive ones. */
  readonly withShared: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Run `effect` alone: after every earlier holder released, before any later waiter. */
  readonly withPermit: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

type LockMode = "shared" | "exclusive";

interface Waiter {
  readonly mode: LockMode;
  granted: boolean;
  wake: (() => void) | undefined;
}

export const makeReadWriteLockUnsafe = (): ReadWriteLock => {
  let sharedHolders = 0;
  let exclusiveHeld = false;
  const queue: Array<Waiter> = [];

  const admissible = (mode: LockMode) =>
    mode === "shared" ? !exclusiveHeld : !exclusiveHeld && sharedHolders === 0;

  const take = (mode: LockMode) => {
    if (mode === "shared") sharedHolders += 1;
    else exclusiveHeld = true;
  };

  /** Admit waiters from the head of the queue while they fit; strictly in order. */
  const admit = () => {
    while (queue.length > 0) {
      const head = queue[0]!;
      if (!admissible(head.mode)) return;
      queue.shift();
      take(head.mode);
      head.granted = true;
      head.wake?.();
      if (head.mode === "exclusive") return;
    }
  };

  const release = (mode: LockMode) => {
    if (mode === "shared") sharedHolders -= 1;
    else exclusiveHeld = false;
    admit();
  };

  /** Interrupted while queued, or right after being admitted. */
  const abandon = (waiter: Waiter) => {
    if (waiter.granted) {
      release(waiter.mode);
      return;
    }
    const index = queue.indexOf(waiter);
    if (index >= 0) queue.splice(index, 1);
    // A removed exclusive waiter may have been holding back the shared waiters behind it.
    admit();
  };

  const withMode =
    (mode: LockMode) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          const run = restore(effect).pipe(Effect.ensuring(Effect.sync(() => release(mode))));
          // Fast path only when nobody waits: a newcomer never overtakes a queued waiter.
          if (queue.length === 0 && admissible(mode)) {
            take(mode);
            return run;
          }
          const waiter: Waiter = { mode, granted: false, wake: undefined };
          queue.push(waiter);
          const wait = Effect.callback<void>((resume) => {
            if (waiter.granted) {
              resume(Effect.void);
              return;
            }
            waiter.wake = () => resume(Effect.void);
          });
          return restore(wait).pipe(
            Effect.onInterrupt(() => Effect.sync(() => abandon(waiter))),
            Effect.andThen(run),
          );
        }),
      );

  return { withShared: withMode("shared"), withPermit: withMode("exclusive") };
};
