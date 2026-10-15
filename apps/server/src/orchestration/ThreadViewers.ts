/**
 * ThreadViewersService - in-memory count of the clients viewing each thread.
 *
 * A thread subscription whose history recovery is active has a view attached
 * (a client shows the thread, or an older client or the CLI follows it); a
 * passive one (a sidebar prewarm, a retained idle thread) does not. Every
 * active subscription, on any connection, holds one lease here while it is
 * active. The provider session reaper keeps an idle session alive while its
 * thread is viewed, so returning to the open thread does not pay a cold start.
 *
 * Process-local and unpersisted: after a restart no thread is viewed until its
 * clients subscribe again.
 *
 * @module ThreadViewersService
 */
import type { ThreadId } from "@ryco/contracts";
import { Context, Effect, Layer } from "effect";

export class ThreadViewersService extends Context.Service<
  ThreadViewersService,
  {
    /** Counts one viewer of the thread until the returned release runs (idempotent). */
    readonly retain: (threadId: ThreadId) => Effect.Effect<Effect.Effect<void>>;
    readonly isViewed: (threadId: ThreadId) => boolean;
  }
>()("ryco/orchestration/ThreadViewersService") {}

export function make(): ThreadViewersService["Service"] {
  // Only viewed threads have an entry, so the map is bounded by open subscriptions.
  const viewers = new Map<ThreadId, number>();
  return {
    retain: (threadId) =>
      Effect.sync(() => {
        viewers.set(threadId, (viewers.get(threadId) ?? 0) + 1);
        let released = false;
        return Effect.sync(() => {
          if (released) return;
          released = true;
          const remaining = (viewers.get(threadId) ?? 1) - 1;
          if (remaining > 0) viewers.set(threadId, remaining);
          else viewers.delete(threadId);
        });
      }),
    isViewed: (threadId) => viewers.has(threadId),
  };
}

export const layer = Layer.effect(ThreadViewersService, Effect.sync(make));
