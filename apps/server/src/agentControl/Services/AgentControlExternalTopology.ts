/**
 * AgentControlExternalTopology - Whether external Agent Control integrations
 * may run in this process, and the hand-off to the Hub connector.
 *
 * External integrations need a provably local runtime, so they never run
 * beside a Hub relay connection. A connector that starts with an identity is
 * Hub-connected from the start. A Desktop standby connector is not: it holds
 * no identity and opens no socket until the user signs in or enrolls in this
 * process. Before it opens its first relay connection it yields the process,
 * which closes every external listener first. The topology only ever narrows.
 *
 * @module AgentControlExternalTopology
 */
import type { AgentControlExternalTopology } from "@ryco/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

export interface AgentControlExternalTopologyShape {
  /** Where external integrations stand right now. */
  readonly current: () => AgentControlExternalTopology;
  /**
   * Hand this process to the Hub connector. External integrations become
   * unavailable for the rest of the process, and every registered listener
   * has closed (with its accepted connections) when this completes.
   * Idempotent.
   */
  readonly yieldToHub: Effect.Effect<void>;
  /**
   * Register the procedure `yieldToHub` runs to close an external listener.
   * It must tolerate running when nothing is listening.
   */
  readonly onYieldToHub: (close: Effect.Effect<void>) => Effect.Effect<void>;
}

export class AgentControlExternalTopologyService extends Context.Service<
  AgentControlExternalTopologyService,
  AgentControlExternalTopologyShape
>()("ryco/agentControl/Services/AgentControlExternalTopology") {}
