/**
 * O(1) thread lookups and updates over the command read model's thread array.
 *
 * The model keeps `threads` as an array (its contract type), and the projector replaces the
 * array on every thread event. Looking a thread up with `find` and updating it with `map` made
 * every event O(threads). The index (id -> position) is built once per array shape and carried
 * over to the next array when an update keeps every position, which is every update but thread
 * creation and removal; those rebuild it lazily on the next lookup.
 *
 * @module threadIndex
 */
interface Identified {
  readonly id: string;
}

const indexes = new WeakMap<ReadonlyArray<Identified>, ReadonlyMap<string, number>>();

function indexOf(threads: ReadonlyArray<Identified>): ReadonlyMap<string, number> {
  let index = indexes.get(threads);
  if (index === undefined) {
    const built = new Map<string, number>();
    for (let position = 0; position < threads.length; position += 1) {
      // First occurrence wins, like Array.prototype.find.
      const id = threads[position]!.id;
      if (!built.has(id)) built.set(id, position);
    }
    index = built;
    indexes.set(threads, index);
  }
  return index;
}

export function findThreadInArray<T extends Identified>(
  threads: ReadonlyArray<T>,
  threadId: string,
): T | undefined {
  const position = indexOf(threads).get(threadId);
  return position === undefined ? undefined : threads[position];
}

/**
 * Returns a new array with the thread replaced by `update(thread)`, or the same array when the
 * thread does not exist. Positions are unchanged, so the index carries over.
 */
export function updateThreadInArray<T extends Identified>(
  threads: ReadonlyArray<T>,
  threadId: string,
  update: (thread: T) => T,
): ReadonlyArray<T> {
  const index = indexOf(threads);
  const position = index.get(threadId);
  if (position === undefined) return threads;
  const next = threads.slice();
  next[position] = update(threads[position]!);
  indexes.set(next, index);
  return next;
}
