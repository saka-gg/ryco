import { Effect, Option, Ref } from "effect";
import * as Semaphore from "effect/Semaphore";

export interface ProviderMaintenanceCommandCoordinatorShape<E> {
  readonly withCommandLock: <A, R>(input: {
    readonly targetKey: string;
    readonly lockKey: string;
    readonly onQueued?: Effect.Effect<void, E, R>;
    readonly run: Effect.Effect<A, E, R>;
  }) => Effect.Effect<A, E, R>;
  /**
   * `withCommandLock` that never waits: `None` without running when the target is already
   * updating or another command holds the lock key.
   */
  readonly tryWithCommandLock: <A, E, R>(input: {
    readonly targetKey: string;
    readonly lockKey: string;
    readonly run: Effect.Effect<A, E, R>;
  }) => Effect.Effect<Option.Option<A>, E, R>;
}

export const makeProviderMaintenanceCommandCoordinator = Effect.fn(
  "makeProviderMaintenanceCommandCoordinator",
)(function* <E>(input: { readonly makeAlreadyRunningError: (targetKey: string) => E }) {
  const runningTargetsRef = yield* Ref.make<ReadonlySet<string>>(new Set());
  const locksRef = yield* Ref.make<ReadonlyMap<string, Semaphore.Semaphore>>(new Map());

  const acquireTarget = Effect.fn("acquireTarget")(function* (targetKey: string) {
    return yield* Ref.modify(runningTargetsRef, (runningTargets) => {
      if (runningTargets.has(targetKey)) {
        return [false, runningTargets] as const;
      }
      const next = new Set(runningTargets);
      next.add(targetKey);
      return [true, next] as const;
    });
  });

  const releaseTarget = (targetKey: string) =>
    Ref.update(runningTargetsRef, (runningTargets) => {
      const next = new Set(runningTargets);
      next.delete(targetKey);
      return next;
    });

  const getLock = Effect.fn("getProviderMaintenanceCommandLock")(function* (lockKey: string) {
    const existing = (yield* Ref.get(locksRef)).get(lockKey);
    if (existing) {
      return existing;
    }

    const lock = yield* Semaphore.make(1);
    return yield* Ref.modify(locksRef, (locks) => {
      const current = locks.get(lockKey);
      if (current) {
        return [current, locks] as const;
      }
      const next = new Map(locks);
      next.set(lockKey, lock);
      return [lock, next] as const;
    });
  });

  const withCommandLock: ProviderMaintenanceCommandCoordinatorShape<E>["withCommandLock"] = ({
    targetKey,
    lockKey,
    onQueued,
    run,
  }) =>
    Effect.gen(function* () {
      const acquired = yield* acquireTarget(targetKey);
      if (!acquired) {
        return yield* Effect.fail(input.makeAlreadyRunningError(targetKey));
      }

      return yield* Effect.gen(function* () {
        const lock = yield* getLock(lockKey);
        if (onQueued) {
          yield* onQueued;
        }
        return yield* lock.withPermits(1)(run);
      }).pipe(Effect.ensuring(releaseTarget(targetKey)));
    });

  const tryWithCommandLock: ProviderMaintenanceCommandCoordinatorShape<E>["tryWithCommandLock"] = ({
    targetKey,
    lockKey,
    run,
  }) =>
    Effect.gen(function* () {
      if (!(yield* acquireTarget(targetKey))) return Option.none();
      return yield* Effect.flatMap(getLock(lockKey), (lock) =>
        lock.withPermitsIfAvailable(1)(run),
      ).pipe(Effect.ensuring(releaseTarget(targetKey)));
    });

  return {
    withCommandLock,
    tryWithCommandLock,
  } satisfies ProviderMaintenanceCommandCoordinatorShape<E>;
});
