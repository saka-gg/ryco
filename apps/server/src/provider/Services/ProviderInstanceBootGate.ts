/**
 * ProviderInstanceBootGate — releases deferred provider driver construction.
 *
 * Building a provider instance imports its SDK, may start helper processes and allocates the
 * adapter, so the hydration layer starts the registry empty and builds every configured instance
 * only once the HTTP listener serves (`ServerRuntimeStartup.markHttpServing` releases the gate).
 * A consumer that needs a configured instance earlier (`ProviderInstanceRegistry.getInstance`)
 * releases it on demand, so nothing can wait on the gate indefinitely.
 *
 * @module provider/Services/ProviderInstanceBootGate
 */
import { Context } from "effect";
import type { Effect } from "effect";

export interface ProviderInstanceBootGateShape {
  /** Start building the configured instances. Idempotent; does not wait for the build. */
  readonly release: Effect.Effect<void>;
  /** Release the gate and wait until the initial instance build has settled. */
  readonly awaitInitialReconcile: Effect.Effect<void>;
}

export class ProviderInstanceBootGate extends Context.Service<
  ProviderInstanceBootGate,
  ProviderInstanceBootGateShape
>()("ryco/provider/Services/ProviderInstanceBootGate") {}
