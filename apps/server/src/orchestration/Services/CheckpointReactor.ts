/**
 * CheckpointReactor - Checkpoint reaction service interface.
 *
 * Owns background workers that react to orchestration checkpoint lifecycle
 * events and apply checkpoint side effects.
 *
 * @module CheckpointReactor
 */
import type { ThreadId } from "@ryco/contracts";
import { Context } from "effect";
import type { Effect, Scope } from "effect";

/**
 * CheckpointReactorShape - Service API for checkpoint reactor lifecycle.
 */
export interface CheckpointReactorShape {
  /**
   * Start the checkpoint reactor.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   *
   * Consumes both orchestration-domain and provider-runtime events via an
   * internal queue.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Finish or terminalize checkpoint reverts a previous process left pending.
   * Runs once at startup, before the reactors start; never fails.
   */
  readonly recover: () => Effect.Effect<void>;

  /**
   * Resolves once the thread's pre-turn baseline exists (captured now if it
   * was missing), after every checkpoint item queued for the thread before it,
   * such as the previous turn's completion capture. A turn start awaits this
   * before the provider can touch files, so the baseline never contains the
   * turn's own edits. Never fails: a capture failure is logged.
   */
  readonly ensurePreTurnBaseline: (threadId: ThreadId) => Effect.Effect<void>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * CheckpointReactor - Service tag for checkpoint reactor workers.
 */
export class CheckpointReactor extends Context.Service<CheckpointReactor, CheckpointReactorShape>()(
  "ryco/orchestration/Services/CheckpointReactor",
) {}
