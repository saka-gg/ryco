/**
 * A short-lived cache of forge list reads (change requests, issues) per repository.
 *
 * The pull requests page asks for three groups at once, the composer's `#` menu, the overview
 * and the branch picker ask for overlapping lists, and every surface re-asks on open. Each
 * miss is a forge round trip (1-3 s on GitHub). Reads of one repository with the same key
 * within the TTL share one result; concurrent identical reads share one forge call. Entries
 * of a repository are dropped together with its change request index: remote refreshes
 * (after git actions, agent turns and the periodic poll) and change request mutations.
 * Failures are not cached, except a forge's rate-limited answer, which is held until its
 * pause ends (see `lastGoodWhilePaused`). Reads that opt in keep their last good value for
 * background readers while the forge is rate limiting.
 */
import { Cause, Deferred, Effect, Exit, Option } from "effect";

import { heldUntil, makeLastGood, pauseHoldMs, pausedUntilOf } from "./lastGoodWhilePaused.ts";

export const REPOSITORY_LIST_CACHE_TTL_MS = 30_000;
const REPOSITORY_LIST_CACHE_CAPACITY = 256;

interface Entry {
  readonly repository: string;
  /** Infinity while the read is in flight. */
  expiresAtMs: number;
  /** Holds a rate-limited answer, or a value served while paused, until the pause ends. */
  held: boolean;
  /** The read's outcome, typed by the caller that started it. */
  readonly result: Deferred.Deferred<Exit.Exit<unknown, never>>;
}

interface GetInput<A, E, R> {
  readonly repository: string;
  readonly key: string;
  readonly load: Effect.Effect<A, E, R>;
  /** Overrides the cache's TTL for this entry. */
  readonly ttlMs?: number;
  /**
   * Keep the last good value and serve it to background readers when a read fails with a
   * rate limit. For reads background readers make, and not for large values.
   */
  readonly lastGood?: boolean;
}

export interface RepositoryListCache {
  /** `load` once per (repository, key) per TTL; concurrent callers share it. */
  readonly get: <A, E, R>(input: GetInput<A, E, R>) => Effect.Effect<A, E, R>;
  /**
   * Drops the repository's entries. Held ones stay when `keepHeldWhile` (asked only when one
   * is held) says the forge's pause still runs.
   */
  readonly invalidate: (
    repository: string,
    options?: { readonly keepHeldWhile?: Effect.Effect<boolean> },
  ) => Effect.Effect<void>;
}

export function makeRepositoryListCache(options?: {
  readonly ttlMs?: number;
  readonly nowMs?: () => number;
}): RepositoryListCache {
  const ttlMs = options?.ttlMs ?? REPOSITORY_LIST_CACHE_TTL_MS;
  const nowMs = options?.nowMs ?? Date.now;
  const entries = new Map<string, Entry>();
  const lastGood = makeLastGood<object>(REPOSITORY_LIST_CACHE_CAPACITY);

  /** When a finished read is held until: its pause's end, or null to cache it as usual. */
  const holdUntil = (exit: Exit.Exit<unknown, unknown>, now: number) => {
    if (Exit.isFailure(exit))
      return heldUntil(Option.getOrUndefined(Exit.findErrorOption(exit)), now);
    // A value served while paused (a slice of a held listing) is held, never last good.
    const pausedUntil = pausedUntilOf(exit.value);
    return pausedUntil === null ? null : now + pauseHoldMs(pausedUntil, now, 1_000);
  };

  const read = <A, E, R>(id: string, input: GetInput<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const hit = entries.get(id);
      if (hit && hit.expiresAtMs > nowMs()) {
        return Deferred.await(hit.result).pipe(
          Effect.flatMap((exit) => exit as unknown as Exit.Exit<A, E>),
          // The read it joined was cancelled: read again.
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? read(id, input) : Effect.failCause(cause),
          ),
        );
      }
      if (hit) entries.delete(id);
      const entry: Entry = {
        repository: input.repository,
        expiresAtMs: Number.POSITIVE_INFINITY,
        held: false,
        result: Deferred.makeUnsafe<Exit.Exit<unknown, never>>(),
      };
      entries.set(id, entry);
      while (entries.size > REPOSITORY_LIST_CACHE_CAPACITY) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      const settle = (exit: Exit.Exit<A, E>) =>
        Effect.sync(() => {
          const now = nowMs();
          const heldUntilMs = holdUntil(exit, now);
          if (heldUntilMs !== null) {
            entry.held = true;
            entry.expiresAtMs = heldUntilMs;
          } else if (Exit.isSuccess(exit)) {
            entry.expiresAtMs = now + (input.ttlMs ?? ttlMs);
            if (input.lastGood && typeof exit.value === "object" && exit.value !== null) {
              lastGood.remember(id, exit.value, now);
            }
          } else if (entries.get(id) === entry) {
            entries.delete(id);
          }
        }).pipe(
          Effect.andThen(
            Deferred.succeed(entry.result, exit as unknown as Exit.Exit<unknown, never>),
          ),
        );
      return input.load.pipe(Effect.onExit(settle));
    });

  const get = <A, E, R>(input: GetInput<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const id = `${input.repository}\u0000${input.key}`;
      const result = read(id, input);
      if (!input.lastGood) return result;
      return result.pipe(
        Effect.catch(
          (error) => lastGood.serve(id, error, nowMs()) as unknown as Effect.Effect<A, E>,
        ),
      );
    });

  const invalidate: RepositoryListCache["invalidate"] = (repository, invalidateOptions) =>
    Effect.suspend(() => {
      const holding = [...entries.values()].some(
        (entry) => entry.repository === repository && entry.held && entry.expiresAtMs > nowMs(),
      );
      const keepHeld =
        holding && invalidateOptions?.keepHeldWhile !== undefined
          ? invalidateOptions.keepHeldWhile
          : Effect.succeed(false);
      return Effect.map(keepHeld, (keep) => {
        for (const [id, entry] of entries) {
          if (entry.repository !== repository) continue;
          if (keep && entry.held && entry.expiresAtMs > nowMs()) continue;
          entries.delete(id);
        }
      });
    });

  return { get, invalidate };
}
