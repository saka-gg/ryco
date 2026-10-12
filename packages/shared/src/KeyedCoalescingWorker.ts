/**
 * KeyedCoalescingWorker - A keyed worker that keeps only the latest value per key.
 *
 * Enqueues for an active or already-queued key are merged atomically instead of
 * creating duplicate queued items. `drainKey()` resolves only when that key has
 * no queued, pending, or active work left.
 *
 * @module KeyedCoalescingWorker
 */
import type * as Scope from "effect/Scope";
import * as Effect from "effect/Effect";
import * as TxQueue from "effect/TxQueue";
import * as TxRef from "effect/TxRef";

import type { LatestStateQueuePolicy, QueuePolicyMetricsSnapshot } from "./QueuePolicy.ts";

export interface KeyedCoalescingWorker<K, V> {
  readonly enqueue: (key: K, value: V) => Effect.Effect<void>;
  readonly drainKey: (key: K) => Effect.Effect<void>;
  readonly metrics: Effect.Effect<QueuePolicyMetricsSnapshot>;
}

interface KeyedCoalescingWorkerState<K, V> {
  readonly latestByKey: Map<K, V>;
  readonly queuedKeys: Set<K>;
  readonly activeKeys: Set<K>;
  readonly highWaterMark: number;
  readonly blockedDurationMs: number;
  readonly coalescedCount: number;
  readonly recoveryCount: number;
}

export const makeKeyedCoalescingWorker = <K, V, E, R>(options: {
  readonly policy: LatestStateQueuePolicy;
  readonly merge: (current: V, next: V) => V;
  readonly process: (key: K, value: V) => Effect.Effect<void, E, R>;
}): Effect.Effect<KeyedCoalescingWorker<K, V>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const queue = yield* Effect.acquireRelease(
      TxQueue.bounded<K>(options.policy.capacity),
      TxQueue.shutdown,
    );
    const stateRef = yield* TxRef.make<KeyedCoalescingWorkerState<K, V>>({
      latestByKey: new Map(),
      queuedKeys: new Set(),
      activeKeys: new Set(),
      highWaterMark: 0,
      blockedDurationMs: 0,
      coalescedCount: 0,
      recoveryCount: 0,
    });

    const processKey = (key: K, value: V): Effect.Effect<void, E, R> =>
      options.process(key, value).pipe(
        Effect.flatMap(() =>
          TxRef.modify(stateRef, (state) => {
            const nextValue = state.latestByKey.get(key);
            if (nextValue === undefined) {
              const activeKeys = new Set(state.activeKeys);
              activeKeys.delete(key);
              return [null, { ...state, activeKeys }] as const;
            }

            const latestByKey = new Map(state.latestByKey);
            latestByKey.delete(key);
            return [nextValue, { ...state, latestByKey }] as const;
          }).pipe(Effect.tx),
        ),
        Effect.flatMap((nextValue) =>
          nextValue === null ? Effect.void : processKey(key, nextValue),
        ),
      );

    const recoverFailedKey = (key: K): Effect.Effect<V | null> =>
      TxRef.modify(stateRef, (state) => {
        const nextValue = state.latestByKey.get(key);
        if (nextValue !== undefined) {
          const latestByKey = new Map(state.latestByKey);
          latestByKey.delete(key);
          return [
            nextValue,
            { ...state, latestByKey, recoveryCount: state.recoveryCount + 1 },
          ] as const;
        }

        const activeKeys = new Set(state.activeKeys);
        activeKeys.delete(key);
        return [null, { ...state, activeKeys, recoveryCount: state.recoveryCount + 1 }] as const;
      }).pipe(Effect.tx);

    yield* TxQueue.take(queue).pipe(
      Effect.flatMap((key) =>
        TxRef.modify(stateRef, (state) => {
          const queuedKeys = new Set(state.queuedKeys);
          queuedKeys.delete(key);

          const value = state.latestByKey.get(key);
          if (value === undefined) {
            return [null, { ...state, queuedKeys }] as const;
          }

          const latestByKey = new Map(state.latestByKey);
          latestByKey.delete(key);
          const activeKeys = new Set(state.activeKeys);
          activeKeys.add(key);

          return [
            { key, value } as const,
            { ...state, latestByKey, queuedKeys, activeKeys },
          ] as const;
        }).pipe(Effect.tx),
      ),
      Effect.flatMap((item) =>
        item === null
          ? Effect.void
          : processKey(item.key, item.value).pipe(
              Effect.catchCause(() =>
                recoverFailedKey(item.key).pipe(
                  Effect.flatMap((nextValue) =>
                    nextValue === null ? Effect.void : processKey(item.key, nextValue),
                  ),
                ),
              ),
            ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    const enqueue: KeyedCoalescingWorker<K, V>["enqueue"] = (key, value) =>
      Effect.gen(function* () {
        const startedAt = Date.now();
        yield* TxRef.modify(stateRef, (state) => {
          const latestByKey = new Map(state.latestByKey);
          const existing = latestByKey.get(key);
          latestByKey.set(key, existing === undefined ? value : options.merge(existing, value));

          if (state.queuedKeys.has(key) || state.activeKeys.has(key)) {
            return [
              false,
              { ...state, latestByKey, coalescedCount: state.coalescedCount + 1 },
            ] as const;
          }

          const queuedKeys = new Set(state.queuedKeys);
          queuedKeys.add(key);
          const depth = queuedKeys.size + state.activeKeys.size;
          return [
            true,
            {
              ...state,
              latestByKey,
              queuedKeys,
              highWaterMark: Math.max(state.highWaterMark, depth),
            },
          ] as const;
        }).pipe(
          Effect.flatMap((shouldOffer) => (shouldOffer ? TxQueue.offer(queue, key) : Effect.void)),
          Effect.tx,
        );
        const blockedMs = Math.max(0, Date.now() - startedAt);
        if (blockedMs > 0) {
          yield* TxRef.update(stateRef, (state) => ({
            ...state,
            blockedDurationMs: state.blockedDurationMs + blockedMs,
          })).pipe(Effect.tx);
        }
      });

    const drainKey: KeyedCoalescingWorker<K, V>["drainKey"] = (key) =>
      TxRef.get(stateRef).pipe(
        Effect.tap((state) =>
          state.latestByKey.has(key) || state.queuedKeys.has(key) || state.activeKeys.has(key)
            ? Effect.txRetry
            : Effect.void,
        ),
        Effect.asVoid,
        Effect.tx,
      );

    const metrics: KeyedCoalescingWorker<K, V>["metrics"] = TxRef.get(stateRef).pipe(
      Effect.map((state) => ({
        component: options.policy.component,
        strategy: options.policy.strategy,
        capacity: options.policy.capacity,
        depth: state.queuedKeys.size + state.activeKeys.size,
        highWaterMark: state.highWaterMark,
        blockedDurationMs: state.blockedDurationMs,
        coalescedCount: state.coalescedCount,
        overflowCount: 0,
        recoveryCount: state.recoveryCount,
      })),
      Effect.tx,
    );

    return { enqueue, drainKey, metrics } satisfies KeyedCoalescingWorker<K, V>;
  });
