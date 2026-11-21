/**
 * What every node-owned request kind shares (secret requests, user action requests): reading the
 * thread the request lives in, one-at-a-time locks per key, the expiry timer that retries a failed
 * record with backoff, and the restart pass that schedules those timers again.
 *
 * Loaded only with the request modules that use it, never at boot.
 *
 * @module nodeRequests/nodeRequestLifecycle
 */
import type { OrchestrationThread, ThreadId } from "@ryco/contracts";
import { Clock, Duration, Effect } from "effect";
import * as Semaphore from "effect/Semaphore";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { findThreadInArray } from "../orchestration/threadIndex.ts";

export interface NodeRequestThreadDeps {
  readonly engine: Pick<OrchestrationEngineShape, "getReadModel">;
  /** Passed in from the boot path, so lazily loaded modules do not split it out. */
  readonly findThreadInArray: typeof findThreadInArray;
}

/** The thread as the engine holds it now, deleted ones included; undefined when it is gone. */
export const readThreadRecord = (deps: NodeRequestThreadDeps, threadId: ThreadId) =>
  Effect.gen(function* () {
    if (deps.engine.getReadModel === undefined) return undefined;
    const model = yield* deps.engine.getReadModel();
    const thread: OrchestrationThread | undefined = deps.findThreadInArray(model.threads, threadId);
    return thread;
  });

/** The thread as the engine holds it now; undefined when it is gone or deleted. */
export const readLiveThread = (deps: NodeRequestThreadDeps, threadId: ThreadId) =>
  readThreadRecord(deps, threadId).pipe(
    Effect.map((thread) =>
      thread === undefined || thread.deletedAt !== null ? undefined : thread,
    ),
  );

/**
 * One holder per key at a time; later callers wait their turn. A key's semaphore is dropped once
 * nobody holds or waits on it, so a long-running node does not keep one per request or thread.
 */
export interface KeyedSemaphore {
  readonly withPermit: <A, E, R>(
    key: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /** Keys with a holder or a waiter (tests). */
  readonly size: () => number;
}

export function makeKeyedSemaphore(): KeyedSemaphore {
  const locks = new Map<string, { readonly lock: Semaphore.Semaphore; users: number }>();
  return {
    withPermit: (key, effect) =>
      Effect.suspend(() => {
        let entry = locks.get(key);
        if (entry === undefined) {
          entry = { lock: Semaphore.makeUnsafe(1), users: 0 };
          locks.set(key, entry);
        }
        const held = entry;
        held.users += 1;
        return held.lock
          .withPermits(1)(effect)
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                held.users -= 1;
                if (held.users === 0 && locks.get(key) === held) locks.delete(key);
              }),
            ),
          );
      }),
    size: () => locks.size,
  };
}

/**
 * One holder per key at a time; a second caller fails at once with `busy()` instead of waiting
 * (an answer from a second device while the first is still being written).
 */
export function makeBusyGuard<B>(busy: () => B) {
  const held = new Set<string>();
  return <A, E, R>(key: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | B, R> =>
    Effect.suspend((): Effect.Effect<A, E | B, R> => {
      if (held.has(key)) return Effect.fail(busy());
      held.add(key);
      return effect.pipe(Effect.ensuring(Effect.sync(() => held.delete(key))));
    });
}

/**
 * Expiry timers that live in this process: at `expiresAt` the request's `expire` runs, and while
 * it fails it is tried again after `retryMs`, doubling up to `maxRetryMs`, so a request never
 * stays pending past its time because one record failed. One timer per key.
 */
export function makeExpiryScheduler<E>(options: {
  readonly retryMs: number;
  readonly maxRetryMs: number;
  readonly onFailure: (error: E) => Effect.Effect<void>;
}) {
  const scheduled = new Set<string>();
  return (key: string, expiresAt: string, expire: Effect.Effect<void, E>) =>
    Effect.gen(function* () {
      if (scheduled.has(key)) return;
      scheduled.add(key);
      const expiresAtMs = Date.parse(expiresAt);
      const delayMs = Number.isFinite(expiresAtMs)
        ? Math.max(0, expiresAtMs - (yield* Clock.currentTimeMillis))
        : 0;
      const attempt = (retryMs: number): Effect.Effect<void> =>
        expire.pipe(
          Effect.catch((error) =>
            options
              .onFailure(error)
              .pipe(
                Effect.andThen(Effect.sleep(Duration.millis(retryMs))),
                Effect.andThen(
                  Effect.suspend(() => attempt(Math.min(retryMs * 2, options.maxRetryMs))),
                ),
              ),
          ),
        );
      yield* Effect.sleep(Duration.millis(delayMs)).pipe(
        Effect.andThen(attempt(options.retryMs)),
        Effect.ensuring(Effect.sync(() => scheduled.delete(key))),
        Effect.forkDetach,
      );
    });
}

type RestartedThread = Pick<OrchestrationThread, "id" | "deletedAt" | "activities">;

/** After a restart: `schedule` for every pending request of every thread that is not deleted. */
export const forEachPendingRequestAfterRestart = <Request>(
  threads: ReadonlyArray<RestartedThread>,
  pending: (activities: RestartedThread["activities"]) => ReadonlyArray<Request>,
  schedule: (threadId: ThreadId, request: Request) => Effect.Effect<void>,
) =>
  Effect.forEach(
    threads.filter((thread) => thread.deletedAt === null),
    (thread) =>
      Effect.forEach(pending(thread.activities), (request) => schedule(thread.id, request), {
        discard: true,
      }),
    { discard: true },
  );
