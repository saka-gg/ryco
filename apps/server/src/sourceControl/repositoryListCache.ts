/**
 * A short-lived cache of forge list reads (change requests, issues) per repository.
 *
 * The pull requests page asks for three groups at once, the composer's `#` menu, the overview
 * and the branch picker ask for overlapping lists, and every surface re-asks on open. Each
 * miss is a forge round trip (1-3 s on GitHub). Reads of one repository with the same key
 * within the TTL share one result; concurrent identical reads share one forge call. Entries
 * of a repository are dropped together with its change request index: remote refreshes
 * (after git actions, agent turns and the periodic poll) and change request mutations.
 * Failures are never cached.
 */
import { Cause, Deferred, Effect, Exit } from "effect";

export const REPOSITORY_LIST_CACHE_TTL_MS = 30_000;
const REPOSITORY_LIST_CACHE_CAPACITY = 256;

interface Entry {
  readonly repository: string;
  /** Infinity while the read is in flight. */
  expiresAtMs: number;
  /** The read's outcome, typed by the caller that started it. */
  readonly result: Deferred.Deferred<Exit.Exit<unknown, never>>;
}

export interface RepositoryListCache {
  /** `load` once per (repository, key) per TTL; concurrent callers share it. */
  readonly get: <A, E, R>(input: {
    readonly repository: string;
    readonly key: string;
    readonly load: Effect.Effect<A, E, R>;
    /** Overrides the cache's TTL for this entry. */
    readonly ttlMs?: number;
  }) => Effect.Effect<A, E, R>;
  readonly invalidate: (repository: string) => Effect.Effect<void>;
}

export function makeRepositoryListCache(options?: {
  readonly ttlMs?: number;
  readonly nowMs?: () => number;
}): RepositoryListCache {
  const ttlMs = options?.ttlMs ?? REPOSITORY_LIST_CACHE_TTL_MS;
  const nowMs = options?.nowMs ?? Date.now;
  const entries = new Map<string, Entry>();

  const get: RepositoryListCache["get"] = <A, E, R>(input: {
    readonly repository: string;
    readonly key: string;
    readonly load: Effect.Effect<A, E, R>;
    readonly ttlMs?: number;
  }): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const id = `${input.repository}\u0000${input.key}`;
      const hit = entries.get(id);
      if (hit && hit.expiresAtMs > nowMs()) {
        return Deferred.await(hit.result).pipe(
          Effect.flatMap((exit) => exit as unknown as Exit.Exit<A, E>),
          // The read it joined was cancelled: read again.
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? get(input) : Effect.failCause(cause),
          ),
        );
      }
      if (hit) entries.delete(id);
      const entry: Entry = {
        repository: input.repository,
        expiresAtMs: Number.POSITIVE_INFINITY,
        result: Deferred.makeUnsafe<Exit.Exit<unknown, never>>(),
      };
      entries.set(id, entry);
      while (entries.size > REPOSITORY_LIST_CACHE_CAPACITY) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      const forget = Effect.sync(() => {
        if (entries.get(id) === entry) entries.delete(id);
      });
      const publish = (exit: Exit.Exit<A, E>) =>
        Deferred.succeed(entry.result, exit as unknown as Exit.Exit<unknown, never>);
      return input.load.pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.sync(() => {
                entry.expiresAtMs = nowMs() + (input.ttlMs ?? ttlMs);
              }).pipe(Effect.andThen(publish(exit)))
            : forget.pipe(Effect.andThen(publish(exit))),
        ),
      );
    });

  const invalidate: RepositoryListCache["invalidate"] = (repository) =>
    Effect.sync(() => {
      for (const [id, entry] of entries) {
        if (entry.repository === repository) entries.delete(id);
      }
    });

  return { get, invalidate };
}
