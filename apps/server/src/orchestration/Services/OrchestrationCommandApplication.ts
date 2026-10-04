import type {
  ClientOrchestrationCommand,
  InternalOrchestrationCommand,
  OrchestrationCommand,
  OrchestrationDispatchCommandError,
} from "@ryco/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

export type OrchestrationNormalizedCommandDispatcher = (
  command: OrchestrationCommand,
) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;

export interface OrchestrationCommandApplicationShape {
  /** Normalize and apply a client/domain command through the authoritative engine. */
  readonly apply: (
    command: ClientOrchestrationCommand,
  ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;

  /**
   * Shared application semantics with a caller-supplied normalized dispatcher.
   * The WebSocket boundary uses this only to preserve its bootstrap/startup gate;
   * normalization, archive/session-stop, terminal cleanup, and error mapping stay
   * owned here.
   */
  readonly applyWithDispatcher: (
    command: ClientOrchestrationCommand,
    dispatch: OrchestrationNormalizedCommandDispatcher,
  ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;

  /**
   * Apply a server-originated internal command (no client normalization; same
   * engine dispatcher, archive follow-ups and error mapping as `apply`).
   * Never pass decoded client input here.
   */
  readonly applyInternal: (
    command: InternalOrchestrationCommand,
  ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;
}

export class OrchestrationCommandApplication extends Context.Service<
  OrchestrationCommandApplication,
  OrchestrationCommandApplicationShape
>()("ryco/orchestration/Services/OrchestrationCommandApplication") {}
