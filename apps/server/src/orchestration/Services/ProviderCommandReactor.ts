/**
 * ProviderCommandReactor - Provider command reaction service interface.
 *
 * Owns background workers that react to orchestration intent events and
 * dispatch provider-side command execution.
 *
 * @module ProviderCommandReactor
 */
import type { MessageId, ThreadId } from "@ryco/contracts";
import { Context } from "effect";
import type { Effect, Scope } from "effect";

import type { IntentDeliveryState } from "../providerEffectIntents.ts";

/** What startup recovery did with the provider intents it found open. */
export interface ProviderIntentRecoverySummary {
  /** This-process rows (above the boot sequence) re-entered through the live entry. */
  readonly replayed: number;
  /** Turn starts an earlier process never confirmed, now cancelled visibly (never re-sent). */
  readonly cancelledTurnStarts: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly deliveryState: IntentDeliveryState;
  }>;
  readonly rejectedSteers: number;
  readonly retriedSessionStops: number;
  readonly handoffsAbandoned: number;
  /** Rows settled with only a log line: thread gone, unreadable, owned elsewhere, poison. */
  readonly settledWithoutOutcome: number;
}

/**
 * ProviderCommandReactorShape - Service API for provider command reactors.
 */
export interface ProviderCommandReactorShape {
  /**
   * Start reacting to provider-intent orchestration domain events.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   *
   * Filters orchestration domain events to provider-intent types before
   * processing.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;

  /**
   * One turn-liveness pass: settles running turns whose runtime is gone (seen on
   * two consecutive sweeps) and reports once when a live provider goes quiet.
   * Runs periodically after `start`; exposed for tests.
   */
  readonly sweepLiveness: Effect.Effect<void>;

  /**
   * Resolves the provider intents left open at startup. Rows committed by this
   * process before the reactor subscribed are replayed through the live entry;
   * rows of earlier processes are cancelled visibly (turn start, steer, never
   * re-sent) or retried (session stop). Runs after `start` and orphan session
   * reconciliation. Never fails.
   */
  readonly recoverIntents: () => Effect.Effect<ProviderIntentRecoverySummary>;
}

/**
 * ProviderCommandReactor - Service tag for provider command reaction workers.
 */
export class ProviderCommandReactor extends Context.Service<
  ProviderCommandReactor,
  ProviderCommandReactorShape
>()("ryco/orchestration/Services/ProviderCommandReactor") {}
