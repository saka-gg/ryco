/**
 * DrainableWorker - A queue-based worker that exposes a `drain()` effect.
 *
 * Wraps a bounded, backpressured queue and adds
 * a signal that resolves when the queue is empty **and** the current item
 * has finished processing. This lets tests replace timing-sensitive
 * `Effect.sleep` calls with deterministic `drain()`.
 *
 * @module DrainableWorker
 */
import type * as Scope from "effect/Scope";
import * as Effect from "effect/Effect";
import * as TxQueue from "effect/TxQueue";
import * as TxRef from "effect/TxRef";

import type { LosslessBackpressureQueuePolicy, QueuePolicyMetricsSnapshot } from "./QueuePolicy.ts";

export interface DrainableWorker<A> {
  /**
   * Enqueue a work item and track it for `drain()`.
   *
   * This wraps `Queue.offer` so drain state is updated atomically with the
   * enqueue path instead of inferring it from queue internals.
   */
  readonly enqueue: (item: A) => Effect.Effect<void>;

  /**
   * Resolves when the queue is empty and the worker is idle (not processing).
   */
  readonly drain: Effect.Effect<void>;

  /** A consistent snapshot of queue pressure and admission behavior. */
  readonly metrics: Effect.Effect<QueuePolicyMetricsSnapshot>;
}

/**
 * Create a drainable worker that processes items from a bounded queue.
 *
 * The worker is forked into the current scope and will be interrupted when
 * the scope closes. A finalizer shuts down the queue.
 *
 * @param process - The effect to run for each queued item.
 * @returns A `DrainableWorker` with `queue` and `drain`.
 */
export const makeDrainableWorker = <A, E, R>(options: {
  readonly policy: LosslessBackpressureQueuePolicy;
  readonly process: (item: A) => Effect.Effect<void, E, R>;
}): Effect.Effect<DrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const queue = yield* Effect.acquireRelease(
      TxQueue.bounded<A>(options.policy.capacity),
      TxQueue.shutdown,
    );
    const outstanding = yield* TxRef.make(0);
    const highWaterMark = yield* TxRef.make(0);
    const blockedDurationMs = yield* TxRef.make(0);

    yield* TxQueue.take(queue).pipe(
      Effect.tap((a) =>
        Effect.ensuring(
          options.process(a),
          TxRef.update(outstanding, (n) => n - 1),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    const drain: DrainableWorker<A>["drain"] = TxRef.get(outstanding).pipe(
      Effect.tap((n) => (n > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
    );

    const enqueue: DrainableWorker<A>["enqueue"] = (element) =>
      Effect.gen(function* () {
        const startedAt = Date.now();
        yield* TxQueue.offer(queue, element).pipe(
          Effect.tap(() =>
            TxRef.modify(outstanding, (current) => {
              const depth = current + 1;
              return [depth, depth] as const;
            }).pipe(
              Effect.tap((depth) =>
                TxRef.update(highWaterMark, (current) => Math.max(current, depth)),
              ),
            ),
          ),
          Effect.tx,
        );
        const blockedMs = Math.max(0, Date.now() - startedAt);
        if (blockedMs > 0) {
          yield* TxRef.update(blockedDurationMs, (total) => total + blockedMs).pipe(Effect.tx);
        }
      });

    const metrics: DrainableWorker<A>["metrics"] = Effect.gen(function* () {
      const [depth, highWater, blocked] = yield* Effect.all([
        TxRef.get(outstanding),
        TxRef.get(highWaterMark),
        TxRef.get(blockedDurationMs),
      ]).pipe(Effect.tx);
      return {
        component: options.policy.component,
        strategy: options.policy.strategy,
        capacity: options.policy.capacity,
        depth,
        highWaterMark: highWater,
        blockedDurationMs: blocked,
        coalescedCount: 0,
        overflowCount: 0,
        recoveryCount: 0,
      };
    });

    return { enqueue, drain, metrics } satisfies DrainableWorker<A>;
  });
