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
 * background readers while the forge is rate limiting, and reads that opt in to `revalidate`
 * learn what their repository went through, so a host fingerprint can stand in for a full read.
 */
import { Cause, Deferred, Effect, Exit, Option } from "effect";

import { heldUntil, makeLastGood, pauseHoldMs, pausedUntilOf } from "./lastGoodWhilePaused.ts";

export const REPOSITORY_LIST_CACHE_TTL_MS = 30_000;
const REPOSITORY_LIST_CACHE_CAPACITY = 256;

interface Entry {
  readonly repository: string;
  /** Infinity while the read is in flight. */
  expiresAtMs: number;
  /** When the read finished; Infinity while it is in flight. */
  storedAtMs: number;
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
  /** A finished read older than this is read again; an in-flight one is still joined. */
  readonly maxAgeMs?: number;
  /**
   * Lifetime of an entry stored within one TTL of `invalidate` dropping the repository: for
   * reads that lag behind writes (host searches), so a read made right after a change
   * request mutation is not kept for the whole TTL.
   */
  readonly settleTtlMs?: number;
  /**
   * Keep the last good value and serve it to background readers when a read fails with a
   * rate limit. For reads background readers make, and not for large values.
   */
  readonly lastGood?: boolean;
  /**
   * Read through this instead of `load` (`changeRequestRowRevalidation`), told what the
   * repository went through, so a cheap host fingerprint can stand in for a full read.
   */
  readonly revalidate?: (changes: RepositoryChanges) => Effect.Effect<A, E, R>;
}

/** What a revalidating read learns of its repository. */
export interface RepositoryChanges {
  /** The last `invalidate` that may have changed something: all but `revalidate: "reuse"`. */
  readonly changedAtMs: number;
  /** The `invalidate`s without `revalidate` (mutations through Ryco) so far. */
  readonly mutations: number;
}

const NO_CHANGES: RepositoryChanges = { changedAtMs: 0, mutations: 0 };

export interface RepositoryListCache {
  /** `load` once per (repository, key) per TTL; concurrent callers share it. */
  readonly get: <A, E, R>(input: GetInput<A, E, R>) => Effect.Effect<A, E, R>;
  /**
   * Drops the repository's entries. Held ones stay when `keepHeldWhile` (asked only when one
   * is held) says the forge's pause still runs. `revalidate` says what may have changed, for
   * reads that revalidate: `"fresh"` (a git action or an agent turn) something on the host,
   * `"reuse"` (a periodic poll) nothing known; without it (a mutation through Ryco) anything.
   */
  readonly invalidate: (
    repository: string,
    options?: {
      readonly keepHeldWhile?: Effect.Effect<boolean>;
      readonly revalidate?: "fresh" | "reuse";
    },
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
  /** When `invalidate` last dropped each repository (for `settleTtlMs`). */
  const droppedAtMs = new Map<string, number>();
  const changes = new Map<string, RepositoryChanges>();

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
      const now = nowMs();
      if (
        hit &&
        hit.expiresAtMs > now &&
        (input.maxAgeMs === undefined || now - hit.storedAtMs < input.maxAgeMs)
      ) {
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
        storedAtMs: Number.POSITIVE_INFINITY,
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
            entry.storedAtMs = now;
            entry.expiresAtMs = heldUntilMs;
          } else if (Exit.isSuccess(exit)) {
            const lifetime = input.ttlMs ?? ttlMs;
            const dropped = droppedAtMs.get(input.repository);
            const settling =
              input.settleTtlMs !== undefined && dropped !== undefined && now - dropped < lifetime;
            entry.storedAtMs = now;
            entry.expiresAtMs =
              now + (settling ? Math.min(lifetime, input.settleTtlMs ?? lifetime) : lifetime);
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
      const load = input.revalidate
        ? input.revalidate(changes.get(input.repository) ?? NO_CHANGES)
        : input.load;
      return load.pipe(Effect.onExit(settle));
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
        droppedAtMs.delete(repository);
        droppedAtMs.set(repository, nowMs());
        for (const oldest of droppedAtMs.keys()) {
          if (droppedAtMs.size <= REPOSITORY_LIST_CACHE_CAPACITY) break;
          droppedAtMs.delete(oldest);
        }
        if (invalidateOptions?.revalidate !== "reuse") {
          const mutations = changes.get(repository)?.mutations ?? 0;
          changes.delete(repository);
          changes.set(repository, {
            changedAtMs: nowMs(),
            mutations: mutations + (invalidateOptions?.revalidate === undefined ? 1 : 0),
          });
          for (const oldest of changes.keys()) {
            if (changes.size <= REPOSITORY_LIST_CACHE_CAPACITY) break;
            changes.delete(oldest);
          }
        }
      });
    });

  return { get, invalidate };
}
