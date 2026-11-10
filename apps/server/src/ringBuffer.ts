/**
 * A fixed-capacity buffer that keeps the most recent `capacity` values. A push is O(1) and never
 * copies: once full, it overwrites the oldest slot.
 */
export interface RingBuffer<A> {
  readonly push: (value: A) => void;
  readonly size: () => number;
  /** Oldest first, as a new array. */
  readonly values: () => Array<A>;
  /** Newest first, lazily, so a reader that stops early reads only what it needs. */
  readonly newestFirst: () => IterableIterator<A>;
}

export const makeRingBuffer = <A>(capacity: number): RingBuffer<A> => {
  const limit = Math.max(1, Math.floor(capacity));
  const slots: Array<A> = [];
  // The slot the next push writes once the buffer is full; it holds the oldest value.
  let next = 0;
  const at = (offsetFromOldest: number) =>
    slots[slots.length < limit ? offsetFromOldest : (next + offsetFromOldest) % limit]!;
  return {
    push(value) {
      if (slots.length < limit) {
        slots.push(value);
        return;
      }
      slots[next] = value;
      next = (next + 1) % limit;
    },
    size: () => slots.length,
    values: () => Array.from({ length: slots.length }, (_, index) => at(index)),
    *newestFirst() {
      for (let index = slots.length - 1; index >= 0; index -= 1) yield at(index);
    },
  };
};
