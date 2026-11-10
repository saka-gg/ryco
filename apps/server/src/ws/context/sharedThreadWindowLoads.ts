/**
 * One thread-window load for every subscriber asking for the same window at
 * the same time.
 *
 * Two clients (a Mac and a phone, or two tabs) opening the same thread, or a
 * reconnect that re-subscribes every retained window on several connections
 * at once, each ran the same window read: a few hundred rows, decoded and
 * measured, on the main database connection. Loads are keyed by everything
 * that shapes the window (thread, limits, payload mode, budgets); a request
 * that arrives while an equal load runs waits for it instead of reading again.
 * A window read before a subscriber arrived is still correct for it: the
 * subscription replays every event after the window's `snapshotSequence`.
 *
 * Only in-flight loads are shared; a finished window is never served again.
 * The load runs on its own fiber, so one subscriber leaving does not cancel it
 * for the others; it is interrupted once every waiter has left.
 *
 * @module sharedThreadWindowLoads
 */
import { Deferred, Effect, Exit, Fiber } from "effect";

interface Entry<A, E> {
  readonly result: Deferred.Deferred<A, E>;
  waiters: number;
  fiber: Fiber.Fiber<void> | undefined;
}

const tables = new WeakMap<object, Map<string, Entry<unknown, unknown>>>();

/** Loads started per owner (tests and diagnostics). */
const loadCounts = new WeakMap<object, number>();
export const sharedThreadWindowLoadCount = (owner: object): number => loadCounts.get(owner) ?? 0;

/**
 * Runs `load`, or joins the in-flight load of `owner` (the projection query
 * the windows are read from) under the same `key`.
 */
export const loadSharedThreadWindow = <A, E>(
  owner: object,
  key: string,
  load: Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.suspend(() => {
    let table = tables.get(owner);
    if (table === undefined) {
      table = new Map();
      tables.set(owner, table);
    }
    const owningTable = table;
    let entry = table.get(key) as Entry<A, E> | undefined;
    const startsLoad = entry === undefined;
    if (entry === undefined) {
      entry = { result: Deferred.makeUnsafe<A, E>(), waiters: 0, fiber: undefined };
      table.set(key, entry as Entry<unknown, unknown>);
      loadCounts.set(owner, (loadCounts.get(owner) ?? 0) + 1);
    }
    const current = entry;
    current.waiters += 1;
    const settle = (exit: Exit.Exit<A, E>) =>
      Effect.sync(() => {
        if (owningTable.get(key) === current) owningTable.delete(key);
        Deferred.doneUnsafe(current.result, exit);
      });
    const leave = Effect.suspend(() => {
      current.waiters -= 1;
      if (current.waiters > 0 || Deferred.isDoneUnsafe(current.result)) return Effect.void;
      // Nobody waits for this load any more: stop it, so the next request starts afresh.
      if (owningTable.get(key) === current) owningTable.delete(key);
      const fiber = current.fiber;
      current.fiber = undefined;
      return fiber === undefined ? Effect.void : Fiber.interrupt(fiber);
    });
    const start = startsLoad
      ? load.pipe(
          Effect.exit,
          Effect.flatMap(settle),
          Effect.forkDetach,
          Effect.map((fiber) => {
            current.fiber = fiber;
          }),
        )
      : Effect.void;
    return start.pipe(
      Effect.andThen(Deferred.await(current.result)),
      Effect.onExit(() => leave),
    );
  });
