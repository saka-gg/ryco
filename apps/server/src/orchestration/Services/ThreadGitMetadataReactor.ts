/**
 * ThreadGitMetadataReactor - follows checkout changes an agent makes into its
 * thread.
 *
 * At turn start, after each git or forge command and at turn end it reads the
 * thread's checked-out branch and records it in the thread and its workspace
 * (guarded, so a newer branch change always wins), and refreshes the
 * checkout's published git status. It runs on the node, so every client sees
 * the change whether or not a window is open.
 *
 * @module ThreadGitMetadataReactor
 */
import { Context } from "effect";
import type { Effect, Scope } from "effect";

export interface ThreadGitMetadataReactorShape {
  /**
   * Subscribe to provider runtime events. Run in a scope: the subscription and
   * the per-thread sync lanes end with it.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when every queued sync has run. Intended for tests; a held-back
   * remote refresh still waiting for its spacing is not queued yet.
   */
  readonly drain: Effect.Effect<void>;
}

export class ThreadGitMetadataReactor extends Context.Service<
  ThreadGitMetadataReactor,
  ThreadGitMetadataReactorShape
>()("ryco/orchestration/Services/ThreadGitMetadataReactor") {}
