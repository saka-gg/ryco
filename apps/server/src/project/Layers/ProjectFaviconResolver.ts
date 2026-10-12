import { Deferred, Effect, Layer, Queue } from "effect";

import {
  ProjectFaviconResolver,
  type ProjectFavicon,
  type ProjectFaviconResolverShape,
} from "../Services/ProjectFaviconResolver.ts";
import { readProjectFavicons, type ProjectFaviconReadResult } from "../readProjectFavicon.ts";

/** Found and definitely-absent icons are reused this long, across connections and tabs. */
const RESOLVED_ICON_TTL_MS = 10 * 60_000;
/** A root whose read stalled is not retried (nor allowed to stall other roots) for this long. */
const STALLED_ROOT_BACKOFF_MS = 60_000;
const ICON_CACHE_CAPACITY = 1_024;
/** Concurrent isolated children. */
const READER_CHILDREN = 2;
/** Roots one child resolves; requests arriving together share a child. */
const ROOTS_PER_CHILD = 16;
/** Bounds a caller's wait (queueing included); icons never gate a usable node. */
const READ_ICON_DEADLINE = "30 seconds";

export type ReadProjectFavicons = (
  roots: readonly string[],
) => Promise<ReadonlyArray<ProjectFaviconReadResult>>;

interface CachedIcon {
  readonly expiresAtMs: number;
  readonly icon: ProjectFavicon | null;
}

export const makeProjectFaviconResolverWith = (options: {
  readonly readFavicons: ReadProjectFavicons;
  readonly now?: () => number;
}) =>
  Effect.gen(function* () {
    const now = options.now ?? Date.now;
    const cache = new Map<string, CachedIcon>();
    const pending = new Map<string, Deferred.Deferred<ProjectFavicon | null>>();
    const queue = yield* Queue.unbounded<string>();

    const remember = (root: string, icon: ProjectFavicon | null, ttlMs: number) => {
      cache.delete(root);
      cache.set(root, { expiresAtMs: now() + ttlMs, icon });
      for (const oldest of cache.keys()) {
        if (cache.size <= ICON_CACHE_CAPACITY) break;
        cache.delete(oldest);
      }
    };
    const settle = (root: string, icon: ProjectFavicon | null) =>
      Effect.suspend(() => {
        const deferred = pending.get(root);
        pending.delete(root);
        return deferred ? Deferred.succeed(deferred, icon).pipe(Effect.asVoid) : Effect.void;
      });

    /** Releases a batch's callers still waiting on the deferred they registered (no answer cached). */
    const abandon = (
      root: string,
      deferred: Deferred.Deferred<ProjectFavicon | null> | undefined,
    ) =>
      Effect.suspend(() => {
        if (deferred === undefined || pending.get(root) !== deferred) return Effect.void;
        pending.delete(root);
        return Deferred.succeed(deferred, null).pipe(Effect.asVoid);
      });

    const readBatch = (roots: ReadonlyArray<string>, retry: boolean): Effect.Effect<void> =>
      Effect.gen(function* () {
        const results = yield* Effect.tryPromise(() => options.readFavicons(roots)).pipe(
          Effect.orElseSucceed(() => roots.map(() => ({ status: "unavailable" }) as const)),
        );
        const unresolved: string[] = [];
        for (const [index, root] of roots.entries()) {
          const result = results[index] ?? { status: "unavailable" as const };
          if (result.status === "unavailable") {
            unresolved.push(root);
            continue;
          }
          const icon = result.status === "found" ? result.icon : null;
          remember(root, icon, RESOLVED_ICON_TTL_MS);
          yield* settle(root, icon);
        }
        if (unresolved.length === 0) return;
        // Roots are read in order: the first unfinished one is where the child
        // stalled. It backs off; the roots behind it get one more child.
        const [stalled, ...rest] = unresolved;
        remember(stalled!, null, STALLED_ROOT_BACKOFF_MS);
        yield* settle(stalled!, null);
        if (retry && rest.length > 0) {
          yield* readBatch(rest, false);
        } else {
          yield* Effect.forEach(rest, (root) => settle(root, null), { discard: true });
        }
      });

    const reader = Effect.gen(function* () {
      const roots = Array.from(yield* Queue.takeBetween(queue, 1, ROOTS_PER_CHILD));
      const claimed = roots.map((root) => [root, pending.get(root)] as const);
      yield* readBatch(roots, true).pipe(
        // A broken batch must neither stop this reader nor strand its callers.
        Effect.catchCause((cause) => Effect.logDebug("Project icon batch failed", { cause })),
        Effect.ensuring(
          Effect.forEach(claimed, ([root, deferred]) => abandon(root, deferred), {
            discard: true,
          }),
        ),
      );
    }).pipe(Effect.forever);
    for (let index = 0; index < READER_CHILDREN; index++) {
      yield* Effect.forkScoped(reader);
    }

    const readIcon: ProjectFaviconResolverShape["readIcon"] = (cwd) =>
      Effect.suspend(() => {
        const cached = cache.get(cwd);
        if (cached && cached.expiresAtMs > now()) return Effect.succeed(cached.icon);
        // Registered and queued synchronously: an interrupted caller can never
        // leave a pending root that no reader will settle.
        let deferred = pending.get(cwd);
        if (!deferred) {
          deferred = Deferred.makeUnsafe<ProjectFavicon | null>();
          pending.set(cwd, deferred);
          Queue.offerUnsafe(queue, cwd);
        }
        return Deferred.await(deferred);
      }).pipe(
        Effect.timeout(READ_ICON_DEADLINE),
        Effect.catch(() => Effect.succeed(null)),
      );

    return { readIcon } satisfies ProjectFaviconResolverShape;
  });

export const makeProjectFaviconResolver = makeProjectFaviconResolverWith({
  readFavicons: (roots) => readProjectFavicons(roots),
});

export const ProjectFaviconResolverLive = Layer.effect(
  ProjectFaviconResolver,
  makeProjectFaviconResolver,
);
