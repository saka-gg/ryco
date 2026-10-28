/**
 * One implementation of "strictly increasing by sequence" for streams of sequenced items: the
 * WebSocket feeds use it to drop what a snapshot already covered, and the orchestration engine
 * uses it to give each domain-event subscription a gap-free view of the event log.
 *
 * @module sequenceOrderedStream
 */
import { Channel, Effect, Exit, Pull, Scope, Stream } from "effect";
import type { Array as Arr } from "effect";

export interface OrderBySequenceOptions<A, E2, R2> {
  readonly getSequence: (item: A) => number;
  /** Items at or below this sequence are dropped. */
  readonly initialSequence: number;
  /**
   * Reads every persisted item in `(fromExclusive, throughInclusive]`, ascending. Without it,
   * gaps pass through: filtered streams (one thread's events) are gappy by design.
   */
  readonly fillGap?: (fromExclusive: number, throughInclusive: number) => Stream.Stream<A, E2, R2>;
}

/**
 * Emits items in strictly increasing sequence, once each. Items at or below the last emitted
 * sequence are dropped. With `fillGap`, a jump past the next sequence first emits
 * `fillGap(last, next - 1)`, then the item that jumped. After a gap is read, the cursor moves to
 * its upper bound: what the reader did not return there is a hole, and is not read again.
 *
 * Each run keeps its own cursor. Works on the source's arrays: an array with nothing to drop
 * and no jump is passed on as is, so the common path allocates nothing per item.
 */
export const orderBySequence =
  <A, E2 = never, R2 = never>(options: OrderBySequenceOptions<A, E2, R2>) =>
  <E, R>(self: Stream.Stream<A, E, R>): Stream.Stream<A, E | E2, R | R2> =>
    Stream.transformPull(self, (upstream, scope) =>
      Effect.sync(() => {
        const { getSequence, fillGap } = options;
        let cursor = options.initialSequence;
        // The source array that jumped, and the index of the item that jumped.
        let held: { readonly items: ReadonlyArray<A>; readonly index: number } | undefined;
        let gap:
          | {
              readonly pull: Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E2, void, R2>;
              readonly scope: Scope.Closeable;
              readonly throughInclusive: number;
            }
          | undefined;

        /**
         * The items of `items[from..]` above the cursor, up to the first jump (which is left in
         * `held`). Returns `items` itself when it keeps all of them.
         */
        const keep = (
          items: ReadonlyArray<A>,
          from: number,
          detectJumps: boolean,
        ): ReadonlyArray<A> => {
          let kept: Array<A> | undefined;
          for (let index = from; index < items.length; index++) {
            const item = items[index]!;
            const sequence = getSequence(item);
            if (sequence <= cursor) {
              kept ??= items.slice(from, index);
              continue;
            }
            if (detectJumps && sequence > cursor + 1) {
              held = { items, index };
              return kept ?? items.slice(from, index);
            }
            cursor = sequence;
            kept?.push(item);
          }
          return kept ?? (from === 0 ? items : items.slice(from));
        };

        const emit = (
          items: ReadonlyArray<A>,
        ): Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E | E2, void, R2> =>
          items.length > 0 ? Effect.succeed(items as Arr.NonEmptyReadonlyArray<A>) : pull;

        const pullGap = (
          open: NonNullable<typeof gap>,
        ): Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E | E2, void, R2> =>
          // Only the gap's own end is caught here, never the source's.
          open.pull.pipe(
            Pull.catchDone(() => {
              gap = undefined;
              cursor = Math.max(cursor, open.throughInclusive);
              return Effect.as(Scope.close(open.scope, Exit.void), undefined);
            }),
            Effect.flatMap((items) => (items === undefined ? pull : emit(keep(items, 0, false)))),
          );

        const openGap = (
          fillGap: NonNullable<OrderBySequenceOptions<A, E2, R2>["fillGap"]>,
          throughInclusive: number,
        ): Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E | E2, void, R2> => {
          const gapScope = Scope.forkUnsafe(scope);
          return Channel.toPullScoped(
            Stream.toChannel(fillGap(cursor, throughInclusive)),
            gapScope,
          ).pipe(
            Effect.flatMap((gapPull) => {
              const open = { pull: gapPull, scope: gapScope, throughInclusive };
              gap = open;
              return pullGap(open);
            }),
          );
        };

        const pull: Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E | E2, void, R2> = Effect.suspend(
          () => {
            if (gap !== undefined) return pullGap(gap);
            if (held !== undefined) {
              const { items, index } = held;
              const sequence = getSequence(items[index]!);
              if (fillGap !== undefined && sequence > cursor + 1) {
                return openGap(fillGap, sequence - 1);
              }
              held = undefined;
              return emit(keep(items, index, true));
            }
            return Effect.flatMap(upstream, (items) => emit(keep(items, 0, fillGap !== undefined)));
          },
        );
        return pull;
      }),
    );

/** Drops items at or below the last emitted sequence; gaps pass through. */
export const dedupeBySequence = <A>(
  getSequence: (item: A) => number,
  initialSequence: number,
): (<E, R>(self: Stream.Stream<A, E, R>) => Stream.Stream<A, E, R>) =>
  orderBySequence<A>({ getSequence, initialSequence });
