/**
 * OrchestrationReactor - Composite orchestration reactor service interface.
 *
 * Coordinates startup of orchestration runtime reactors that translate domain
 * events into downstream side effects.
 *
 * @module OrchestrationReactor
 */
import { Context } from "effect";
import type { Effect, Scope } from "effect";

import type { ProviderIntentRecoverySummary } from "./ProviderCommandReactor.ts";

/**
 * OrchestrationReactorShape - Service API for orchestration reactor lifecycle.
 */
export interface OrchestrationReactorShape {
  /**
   * Start orchestration-side reactors for provider/runtime/checkpoint flows.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolve the provider intents left open at startup (see
   * `ProviderCommandReactorShape.recoverIntents`). Run after `start` and after
   * orphaned provider sessions were reconciled. Never fails.
   */
  readonly recoverProviderIntents: () => Effect.Effect<ProviderIntentRecoverySummary>;
}

/**
 * OrchestrationReactor - Service tag for orchestration reactor coordination.
 */
export class OrchestrationReactor extends Context.Service<
  OrchestrationReactor,
  OrchestrationReactorShape
>()("ryco/orchestration/Services/OrchestrationReactor") {}
