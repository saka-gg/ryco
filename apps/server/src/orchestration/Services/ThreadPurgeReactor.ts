/**
 * ThreadPurgeReactor - Permanent deletion after the undo grace period.
 *
 * Deleting a conversation moves it to the server's Trash state (hidden everywhere) so the client
 * can offer Undo. This reactor deletes it permanently once `THREAD_DELETE_GRACE_MS` passed, also
 * across restarts, and drops tombstoned workspace records once no conversation references them.
 *
 * @module ThreadPurgeReactor
 */
import { Context } from "effect";
import type { Effect, Scope } from "effect";

export interface ThreadPurgeReactorShape {
  /**
   * Subscribe to domain events, then (in the background) retire the old Trash once and sweep
   * what is due. Must run in a scope that owns every scheduled purge.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves once the Trash retirement and the first sweep after `start` have run. The
   * returned marker is `null` while the retirement could not be recorded (nothing is purged).
   */
  readonly awaitStartupSweep: Effect.Effect<string | null>;
}

export class ThreadPurgeReactor extends Context.Service<
  ThreadPurgeReactor,
  ThreadPurgeReactorShape
>()("ryco/orchestration/Services/ThreadPurgeReactor") {}
