/**
 * A small keyed stale-while-revalidate cache for slow reads that must never fail their caller
 * (the load returns a fallback itself). A fresh entry is returned as is; a stale one is
 * returned at once while one background read refreshes it; a missing one is read, with
 * concurrent callers sharing that read.
 */
import { Deferred, Effect, Scope } from "effect";

interface Entry<A> {
  value: A | undefined;
  /** When `value` was read; undefined before the first read finished. */
  readAtMs: number | undefined;
  inFlight: Deferred.Deferred<A> | undefined;
}

export interface StaleWhileRevalidateCache<A> {
  readonly get: (key: string, load: Effect.Effect<A>) => Effect.Effect<A>;
}

export function makeStaleWhileRevalidateCache<A>(options: {
  readonly freshMs: number;
  readonly capacity: number;
  /** Where background refreshes run. */
  readonly scope: Scope.Scope;
  readonly nowMs?: () => number;
}): StaleWhileRevalidateCache<A> {
  const nowMs = options.nowMs ?? Date.now;
  const entries = new Map<string, Entry<A>>();

  const refresh = (key: string, entry: Entry<A>, load: Effect.Effect<A>) => {
    const done = Deferred.makeUnsafe<A>();
    entry.inFlight = done;
    return load.pipe(
      Effect.tap((value) =>
        Effect.sync(() => {
          entry.value = value;
          entry.readAtMs = nowMs();
        }),
      ),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          entry.inFlight = undefined;
          // A read that never completed leaves no entry to wait on.
          if (entry.readAtMs === undefined && entries.get(key) === entry) entries.delete(key);
        }).pipe(Effect.andThen(Deferred.done(done, exit))),
      ),
    );
  };

  const get: StaleWhileRevalidateCache<A>["get"] = (key, load) =>
    Effect.suspend(() => {
      let entry = entries.get(key);
      if (entry === undefined) {
        entry = { value: undefined, readAtMs: undefined, inFlight: undefined };
        entries.set(key, entry);
        while (entries.size > options.capacity) {
          const oldest = entries.keys().next().value;
          if (oldest === undefined) break;
          entries.delete(oldest);
        }
      }
      const current = entry;
      if (current.readAtMs === undefined || current.value === undefined) {
        return current.inFlight ? Deferred.await(current.inFlight) : refresh(key, current, load);
      }
      if (nowMs() - current.readAtMs >= options.freshMs && current.inFlight === undefined) {
        return refresh(key, current, load).pipe(
          Effect.forkIn(options.scope),
          Effect.as(current.value),
        );
      }
      return Effect.succeed(current.value);
    });

  return { get };
}
