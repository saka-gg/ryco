/**
 * KeyedSerialWorker - FIFO lanes keyed by identity, with lanes running concurrently.
 *
 * Items of one key run strictly in enqueue order, one at a time. Items of
 * different keys never wait for each other: every key with work has its own
 * lane fiber, forked into the construction scope when the key goes from idle
 * to active and ending when its lane is empty.
 *
 * Capacity bounds the total number of outstanding items (queued plus running)
 * across all keys. `enqueue` waits only when that bound is reached. The one
 * global head-of-line case is a single blocked key accumulating `capacity`
 * items; callers bound their own per-item work so that state stays transient.
 * A warning is logged (and counted) when one key's queue crosses
 * `laneDepthWarning`.
 *
 * Every failure of `process` is caught, logged and skipped, so one bad item
 * never stops its lane. That includes interrupt-only causes, which can only
 * come from inner fibers: a lane fiber that is itself interrupted (scope
 * close) never reaches the handler.
 *
 * @module KeyedSerialWorker
 */
import type { Scope } from "effect";
import { Cause, Effect, Option, TxRef } from "effect";

import type { LosslessBackpressureQueuePolicy, QueuePolicyMetricsSnapshot } from "./QueuePolicy.ts";

export interface KeyedSerialWorkerMetricsSnapshot extends QueuePolicyMetricsSnapshot {
  /** Keys with a running lane. */
  readonly activeKeys: number;
  /** Times one key's queue crossed `laneDepthWarning`. */
  readonly laneDepthWarningCount: number;
}

export interface KeyedSerialWorker<K, A> {
  /** Never waits behind another key; waits only when `capacity` items are outstanding in total. */
  readonly enqueue: (key: K, item: A) => Effect.Effect<void>;
  /** Resolves when every key is idle and empty. */
  readonly drain: Effect.Effect<void>;
  /** Resolves when `key` is idle and empty, regardless of other keys. */
  readonly drainKey: (key: K) => Effect.Effect<void>;
  /** True when `key` has no queued item and no running item. */
  readonly isIdle: (key: K) => Effect.Effect<boolean>;
  readonly metrics: Effect.Effect<KeyedSerialWorkerMetricsSnapshot>;
}

interface KeyedSerialWorkerState<K, A> {
  /** Items not yet started, per key. */
  readonly pending: ReadonlyMap<K, ReadonlyArray<A>>;
  /** Keys whose lane fiber is running (processing or about to take the next item). */
  readonly active: ReadonlySet<K>;
  /** Queued plus running items across all keys. */
  readonly outstanding: number;
  readonly highWaterMark: number;
  readonly blockedDurationMs: number;
  readonly laneDepthWarningCount: number;
}

type EnqueueResult =
  | { readonly committed: false }
  | { readonly committed: true; readonly startLane: boolean; readonly depth: number };

const DEFAULT_LANE_DEPTH_WARNING = 64;

export const makeKeyedSerialWorker = <K, A, E, R>(options: {
  /** `capacity` is the total number of outstanding items across keys. */
  readonly policy: LosslessBackpressureQueuePolicy;
  readonly process: (key: K, item: A) => Effect.Effect<void, E, R>;
  readonly laneDepthWarning?: number;
}): Effect.Effect<KeyedSerialWorker<K, A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const context = yield* Effect.context<R>();
    const capacity = options.policy.capacity;
    const laneDepthWarning = Math.max(1, options.laneDepthWarning ?? DEFAULT_LANE_DEPTH_WARNING);
    const stateRef = yield* TxRef.make<KeyedSerialWorkerState<K, A>>({
      pending: new Map(),
      active: new Set(),
      outstanding: 0,
      highWaterMark: 0,
      blockedDurationMs: 0,
      laneDepthWarningCount: 0,
    });

    const awaitCapacity = TxRef.get(stateRef).pipe(
      Effect.tap((state) => (state.outstanding >= capacity ? Effect.txRetry : Effect.void)),
      Effect.asVoid,
      Effect.tx,
    );

    const commit = (key: K, item: A) =>
      TxRef.modify(stateRef, (state): [EnqueueResult, KeyedSerialWorkerState<K, A>] => {
        if (state.outstanding >= capacity) {
          return [{ committed: false }, state];
        }
        const queue = state.pending.get(key) ?? [];
        const pending = new Map(state.pending);
        pending.set(key, [...queue, item]);
        const startLane = !state.active.has(key);
        const active = startLane ? new Set(state.active).add(key) : state.active;
        const outstanding = state.outstanding + 1;
        const depth = queue.length + 1;
        const crossedWarning = depth === laneDepthWarning + 1;
        return [
          { committed: true, startLane, depth },
          {
            ...state,
            pending,
            active,
            outstanding,
            highWaterMark: Math.max(state.highWaterMark, outstanding),
            laneDepthWarningCount: state.laneDepthWarningCount + (crossedWarning ? 1 : 0),
          },
        ];
      }).pipe(Effect.tx);

    /** Takes the head of the key's queue, or retires the lane when the queue is empty. */
    const takeNext = (key: K) =>
      TxRef.modify(stateRef, (state): [Option.Option<A>, KeyedSerialWorkerState<K, A>] => {
        const queue = state.pending.get(key) ?? [];
        const pending = new Map(state.pending);
        if (queue.length === 0) {
          pending.delete(key);
          const active = new Set(state.active);
          active.delete(key);
          return [Option.none(), { ...state, pending, active }];
        }
        const [head, ...rest] = queue;
        if (rest.length === 0) {
          pending.delete(key);
        } else {
          pending.set(key, rest);
        }
        return [Option.some(head as A), { ...state, pending }];
      }).pipe(Effect.tx);

    const releaseOne = TxRef.update(stateRef, (state) => ({
      ...state,
      outstanding: Math.max(0, state.outstanding - 1),
    })).pipe(Effect.tx);

    const processItem = (key: K, item: A): Effect.Effect<void> =>
      options.process(key, item).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`${options.policy.component} failed to process an item`, {
            interruptOnly: Cause.hasInterruptsOnly(cause),
            cause: Cause.pretty(cause),
          }),
        ),
        Effect.ensuring(releaseOne),
        Effect.withSpan(`${options.policy.component}.item`, { root: true }),
        Effect.provideContext(context),
      );

    const runLane = (key: K): Effect.Effect<void> =>
      Effect.gen(function* () {
        while (true) {
          const next = yield* takeNext(key);
          if (Option.isNone(next)) return;
          yield* processItem(key, next.value);
        }
      });

    const enqueue: KeyedSerialWorker<K, A>["enqueue"] = (key, item) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const startedAt = Date.now();
          while (true) {
            // Waiting for capacity is the only interruptible step.
            yield* restore(awaitCapacity);
            // Commit and fork are one uninterruptible step, so an interrupt can
            // never leave a key marked active without a lane fiber.
            const result = yield* commit(key, item);
            if (!result.committed) continue;
            if (result.startLane) {
              yield* Effect.forkIn(runLane(key), scope);
            }
            if (result.depth === laneDepthWarning + 1) {
              yield* Effect.logWarning(`${options.policy.component} lane is backing up`, {
                depth: result.depth,
                laneDepthWarning,
              });
            }
            break;
          }
          const blockedMs = Math.max(0, Date.now() - startedAt);
          if (blockedMs > 0) {
            yield* TxRef.update(stateRef, (state) => ({
              ...state,
              blockedDurationMs: state.blockedDurationMs + blockedMs,
            })).pipe(Effect.tx);
          }
        }),
      );

    const drain: KeyedSerialWorker<K, A>["drain"] = TxRef.get(stateRef).pipe(
      Effect.tap((state) => (state.outstanding > 0 ? Effect.txRetry : Effect.void)),
      Effect.asVoid,
      Effect.tx,
    );

    const keyBusy = (state: KeyedSerialWorkerState<K, A>, key: K) =>
      state.active.has(key) || (state.pending.get(key)?.length ?? 0) > 0;

    const drainKey: KeyedSerialWorker<K, A>["drainKey"] = (key) =>
      TxRef.get(stateRef).pipe(
        Effect.tap((state) => (keyBusy(state, key) ? Effect.txRetry : Effect.void)),
        Effect.asVoid,
        Effect.tx,
      );

    const isIdle: KeyedSerialWorker<K, A>["isIdle"] = (key) =>
      TxRef.get(stateRef).pipe(
        Effect.map((state) => !keyBusy(state, key)),
        Effect.tx,
      );

    const metrics: KeyedSerialWorker<K, A>["metrics"] = TxRef.get(stateRef).pipe(
      Effect.map((state) => ({
        component: options.policy.component,
        strategy: options.policy.strategy,
        capacity,
        depth: state.outstanding,
        highWaterMark: state.highWaterMark,
        blockedDurationMs: state.blockedDurationMs,
        coalescedCount: 0,
        overflowCount: 0,
        recoveryCount: 0,
        activeKeys: state.active.size,
        laneDepthWarningCount: state.laneDepthWarningCount,
      })),
      Effect.tx,
    );

    return { enqueue, drain, drainKey, isIdle, metrics } satisfies KeyedSerialWorker<K, A>;
  });
