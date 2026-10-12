/**
 * ProviderRuntimeIngestionService - Provider runtime ingestion service interface.
 *
 * Owns background workers that consume provider runtime streams and emit
 * orchestration commands/events.
 *
 * @module ProviderRuntimeIngestionService
 */
import { Context } from "effect";
import type { Effect, Scope } from "effect";
import type { ThreadId } from "@ryco/contracts";

/**
 * ProviderRuntimeIngestionShape - Service API for runtime ingestion lifecycle.
 */
/**
 * Why a thread's provider history is read: a client opened the thread, or its
 * session settled (a turn ended, the session stopped) while one watched it.
 */
export type HistoryRecoveryTrigger = "subscribe" | "session-settled";

export interface ProviderRuntimeIngestionShape {
  /**
   * Coalesced, read-only provider history recovery; failures leave local
   * history available. Spaced per thread (longer after a failure), so callers
   * may signal freely.
   */
  readonly reconcileThread?: (
    threadId: ThreadId,
    trigger?: HistoryRecoveryTrigger,
  ) => Effect.Effect<void>;
  /**
   * Start ingesting provider runtime events into orchestration commands.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   *
   * Uses an internal queue and continues after non-interrupt failures by
   * logging warnings.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * ProviderRuntimeIngestionService - Service tag for runtime ingestion workers.
 */
export class ProviderRuntimeIngestionService extends Context.Service<
  ProviderRuntimeIngestionService,
  ProviderRuntimeIngestionShape
>()("ryco/orchestration/Services/ProviderRuntimeIngestion/ProviderRuntimeIngestionService") {}
