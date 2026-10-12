import { Array as Arr, Effect, Stream } from "effect";
import type { OrchestrationEvent } from "@ryco/contracts";

import { approximateJsonBytes } from "../../observability/PerfInstrumentation.ts";

/**
 * Chunk-preserving helpers for orchestration RPC streams.
 *
 * Effect RPC writes one `Chunk` frame per emitted array and, on acknowledging
 * transports (WebSocket, relay), waits for the client's `Ack` before pulling
 * the next array. Per-element combinators (`Stream.tap`, `Stream.mapEffect`,
 * `Stream.flatMap`) re-emit single-element arrays, which turns a replay page
 * or a backlog of queued live events into one round trip per event. These
 * helpers keep whatever batch the source produced and only split it to stay
 * under a per-chunk budget.
 */

const eventBytesCache = new WeakMap<OrchestrationEvent, number>();

/**
 * Approximate encoded size of one orchestration event, measured once. Every
 * live subscriber receives the same event object from the engine's PubSub, so
 * the live-queue byte ledger, the progress coalescer and the chunk splitter of
 * every subscription share one measurement.
 */
export const orchestrationEventBytes = (event: OrchestrationEvent): number => {
  const cached = eventBytesCache.get(event);
  if (cached !== undefined) return cached;
  const bytes = approximateJsonBytes(event);
  eventBytesCache.set(event, bytes);
  return bytes;
};

export interface StreamChunkBudget<A> {
  readonly maxItems: number;
  readonly maxBytes?: number;
  readonly sizeOf?: (item: A) => number;
}

/**
 * Splits one batch into consecutive groups within the budget. An item larger
 * than `maxBytes` travels alone; the order of items is preserved.
 */
export const splitByChunkBudget = <A>(
  items: Arr.NonEmptyReadonlyArray<A>,
  budget: StreamChunkBudget<A>,
): ReadonlyArray<Arr.NonEmptyReadonlyArray<A>> => {
  const maxItems = Math.max(1, Math.floor(budget.maxItems));
  const maxBytes = budget.maxBytes;
  const sizeOf = budget.sizeOf;
  if (items.length === 1) return [items];
  if (maxBytes === undefined || sizeOf === undefined) {
    return items.length <= maxItems ? [items] : Arr.chunksOf(items, maxItems);
  }

  const byteLimit = Math.max(1, maxBytes);
  const groups: Array<Arr.NonEmptyReadonlyArray<A>> = [];
  let current: Array<A> = [];
  let currentBytes = 0;
  for (const item of items) {
    const itemBytes = sizeOf(item);
    if (
      current.length > 0 &&
      (current.length >= maxItems || currentBytes + itemBytes > byteLimit)
    ) {
      groups.push(current as Arr.NonEmptyArray<A>);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += itemBytes;
  }
  if (current.length > 0) groups.push(current as Arr.NonEmptyArray<A>);
  return groups.length === 1 ? [items] : groups;
};

/** Re-chunks a stream so no emitted array exceeds the budget; never merges arrays. */
export const rechunkByBudget =
  <A>(budget: StreamChunkBudget<A>) =>
  <E, R>(stream: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> =>
    stream.pipe(
      Stream.chunks,
      Stream.flatMap((items) => {
        const groups = splitByChunkBudget(items, budget);
        return groups.length === 1 ? Stream.fromArray(items) : Stream.fromArrays(...groups);
      }),
    );

/** Runs one effect per emitted array (not per element), passing the array through. */
export const tapArray =
  <A, X, E2, R2>(f: (items: Arr.NonEmptyReadonlyArray<A>) => Effect.Effect<X, E2, R2>) =>
  <E, R>(stream: Stream.Stream<A, E, R>): Stream.Stream<A, E | E2, R | R2> =>
    stream.pipe(Stream.mapArrayEffect((items) => Effect.as(f(items), items)));

/** Synchronous per-array observer; returns the stream unchanged when disabled. */
export const observeArrays =
  <A>(enabled: boolean, observe: (items: Arr.NonEmptyReadonlyArray<A>) => void) =>
  <E, R>(stream: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> =>
    enabled ? stream.pipe(tapArray((items) => Effect.sync(() => observe(items)))) : stream;
