/**
 * A small keyed stale-while-revalidate cache for slow reads. A fresh entry is returned as is;
 * a stale one is returned at once while one background read refreshes it; a missing one is
 * read, with concurrent callers sharing that read.
 *
 * Only successful reads are cached as values. A failed first read fails its callers, and its
 * failure is replayed to later callers for `retryAfterFailureMs` before the source is read
 * again. A failed background refresh keeps the last good value and is not retried for
 * `retryAfterFailureMs` either, so a broken source is never re-read on every call. An
 * interrupted first read leaves no entry, so the next caller reads at once.
 */
import { Cause, Deferred, Effect, Exit, Scope } from "effect";

interface Entry<A, E> {
  value: A | undefined;
  /** When `value` was read; undefined before the first read finished. */
  readAtMs: number | undefined;
  /** When the last read failed; cleared by a successful read. */
  failedAtMs: number | undefined;
  /** Why a first read failed, replayed until `failedAtMs + retryAfterFailureMs`. */
  coldFailure: Cause.Cause<E> | undefined;
  inFlight: Deferred.Deferred<A, E> | undefined;
}

export interface StaleWhileRevalidateCache<A, E = never> {
  readonly get: (key: string, load: Effect.Effect<A, E>) => Effect.Effect<A, E>;
}

/** How long a failed read is not retried: the last good value, or the cold failure, is served. */
const DEFAULT_RETRY_AFTER_FAILURE_MS = 30_000;

export function makeStaleWhileRevalidateCache<A, E = never>(options: {
  readonly freshMs: number;
  readonly capacity: number;
  /** Where background refreshes run. */
  readonly scope: Scope.Scope;
  readonly retryAfterFailureMs?: number;
  readonly nowMs?: () => number;
}): StaleWhileRevalidateCache<A, E> {
  const nowMs = options.nowMs ?? Date.now;
  const retryAfterFailureMs = options.retryAfterFailureMs ?? DEFAULT_RETRY_AFTER_FAILURE_MS;
  const entries = new Map<string, Entry<A, E>>();

  const refresh = (key: string, entry: Entry<A, E>, load: Effect.Effect<A, E>) => {
    const done = Deferred.makeUnsafe<A, E>();
    entry.inFlight = done;
    return load.pipe(
      Effect.tap((value) =>
        Effect.sync(() => {
          entry.value = value;
          entry.readAtMs = nowMs();
          entry.failedAtMs = undefined;
          entry.coldFailure = undefined;
        }),
      ),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          entry.inFlight = undefined;
          if (Exit.isSuccess(exit)) return;
          if (entry.readAtMs !== undefined) {
            entry.failedAtMs = nowMs();
          } else if (Cause.hasInterruptsOnly(exit.cause)) {
            // An interrupted first read leaves no entry to wait on.
            if (entries.get(key) === entry) entries.delete(key);
          } else {
            entry.failedAtMs = nowMs();
            entry.coldFailure = exit.cause;
          }
        }).pipe(Effect.andThen(Deferred.done(done, exit))),
      ),
    );
  };

  const get: StaleWhileRevalidateCache<A, E>["get"] = (key, load) =>
    Effect.suspend(() => {
      let entry = entries.get(key);
      if (entry === undefined) {
        entry = {
          value: undefined,
          readAtMs: undefined,
          failedAtMs: undefined,
          coldFailure: undefined,
          inFlight: undefined,
        };
        entries.set(key, entry);
        while (entries.size > options.capacity) {
          const oldest = entries.keys().next().value;
          if (oldest === undefined) break;
          entries.delete(oldest);
        }
      }
      const current = entry;
      const now = nowMs();
      if (current.readAtMs === undefined || current.value === undefined) {
        if (current.inFlight) return Deferred.await(current.inFlight);
        if (
          current.coldFailure !== undefined &&
          current.failedAtMs !== undefined &&
          now - current.failedAtMs < retryAfterFailureMs
        ) {
          return Effect.failCause(current.coldFailure);
        }
        return refresh(key, current, load);
      }
      if (
        now - current.readAtMs >= options.freshMs &&
        current.inFlight === undefined &&
        (current.failedAtMs === undefined || now - current.failedAtMs >= retryAfterFailureMs)
      ) {
        return refresh(key, current, load).pipe(
          // The reader already has the last good value; a failure only marks the entry.
          Effect.ignore,
          Effect.forkIn(options.scope),
          Effect.as(current.value),
        );
      }
      return Effect.succeed(current.value);
    });

  return { get };
}
