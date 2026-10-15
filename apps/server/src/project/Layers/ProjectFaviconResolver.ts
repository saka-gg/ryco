import { Deferred, Effect, Layer, Queue } from "effect";

import {
  ProjectFaviconResolver,
  ProjectFaviconUnavailable,
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

/** Interrupting a read aborts `signal`, which kills its child at once. */
export type ReadProjectFavicons = (
  roots: readonly string[],
  signal: AbortSignal,
) => Promise<ReadonlyArray<ProjectFaviconReadResult>>;

/** A read that did not finish: not an answer, never served as "no icon". */
const UNAVAILABLE = Symbol("ProjectFaviconUnavailable");
type IconOutcome = ProjectFavicon | null | typeof UNAVAILABLE;

interface CachedIcon {
  readonly expiresAtMs: number;
  readonly icon: IconOutcome;
}

export const makeProjectFaviconResolverWith = (options: {
  readonly readFavicons: ReadProjectFavicons;
  readonly now?: () => number;
}) =>
  Effect.gen(function* () {
    const now = options.now ?? Date.now;
    const cache = new Map<string, CachedIcon>();
    const pending = new Map<string, Deferred.Deferred<IconOutcome>>();
    const queue = yield* Queue.unbounded<string>();

    const remember = (root: string, icon: IconOutcome, ttlMs: number) => {
      cache.delete(root);
      cache.set(root, { expiresAtMs: now() + ttlMs, icon });
      for (const oldest of cache.keys()) {
        if (cache.size <= ICON_CACHE_CAPACITY) break;
        cache.delete(oldest);
      }
    };
    const settle = (root: string, icon: IconOutcome) =>
      Effect.suspend(() => {
        const deferred = pending.get(root);
        pending.delete(root);
        return deferred ? Deferred.succeed(deferred, icon).pipe(Effect.asVoid) : Effect.void;
      });

    /** Releases a batch's callers still waiting on the deferred they registered (no answer cached). */
    const abandon = (root: string, deferred: Deferred.Deferred<IconOutcome> | undefined) =>
      Effect.suspend(() => {
        if (deferred === undefined || pending.get(root) !== deferred) return Effect.void;
        pending.delete(root);
        return Deferred.succeed(deferred, UNAVAILABLE).pipe(Effect.asVoid);
      });

    const readBatch = (roots: ReadonlyArray<string>, retry: boolean): Effect.Effect<void> =>
      Effect.gen(function* () {
        const results = yield* Effect.tryPromise((signal) =>
          options.readFavicons(roots, signal),
        ).pipe(Effect.orElseSucceed(() => roots.map(() => ({ status: "unavailable" }) as const)));
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
        // stalled. It backs off (still unavailable, not "no icon"); the roots
        // behind it get one more child.
        const [stalled, ...rest] = unresolved;
        remember(stalled!, UNAVAILABLE, STALLED_ROOT_BACKOFF_MS);
        yield* settle(stalled!, UNAVAILABLE);
        if (retry && rest.length > 0) {
          yield* readBatch(rest, false);
        } else {
          yield* Effect.forEach(rest, (root) => settle(root, UNAVAILABLE), { discard: true });
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
      Effect.suspend((): Effect.Effect<IconOutcome> => {
        const cached = cache.get(cwd);
        if (cached && cached.expiresAtMs > now()) return Effect.succeed(cached.icon);
        // Registered and queued synchronously: an interrupted caller can never
        // leave a pending root that no reader will settle.
        let deferred = pending.get(cwd);
        if (!deferred) {
          deferred = Deferred.makeUnsafe<IconOutcome>();
          pending.set(cwd, deferred);
          Queue.offerUnsafe(queue, cwd);
        }
        return Deferred.await(deferred);
      }).pipe(
        Effect.timeoutOrElse({
          duration: READ_ICON_DEADLINE,
          orElse: () => Effect.succeed<IconOutcome>(UNAVAILABLE),
        }),
        Effect.flatMap((icon) =>
          icon === UNAVAILABLE
            ? Effect.fail(new ProjectFaviconUnavailable({ cwd }))
            : Effect.succeed(icon),
        ),
      );

    return { readIcon } satisfies ProjectFaviconResolverShape;
  });

export const makeProjectFaviconResolver = makeProjectFaviconResolverWith({
  readFavicons: (roots, signal) => readProjectFavicons(roots, { signal }),
});

export const ProjectFaviconResolverLive = Layer.effect(
  ProjectFaviconResolver,
  makeProjectFaviconResolver,
);
