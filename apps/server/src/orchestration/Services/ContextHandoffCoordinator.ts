import type { OrchestrationEvent } from "@ryco/contracts";
import { Context, Effect } from "effect";

import type { ProviderSessionStartCancelledError } from "../threadLaneControl.ts";

export type ContextHandoffTurnStartEvent = Extract<
  OrchestrationEvent,
  { readonly type: "thread.turn-start-requested" }
>;

/**
 * The reactor's per-thread lane hooks for one handoff turn start.
 *
 * - `guardStart` wraps the target session start, so a Stop cancels it.
 * - `onDispatchStarted` runs right after `dispatching` is persisted and before
 *   the turn is sent. From then on the lane item owns a running turn and Stop
 *   reaches the provider out of band. It fails Cancelled when a user stop or
 *   interrupt was already noted, closing the gap between start and ownership.
 * - `stopRequested` tells the failure path that the user stopped the thread, so
 *   the source is put back as `stopped`, never `ready`.
 */
export interface ContextHandoffLaneControl {
  readonly guardStart: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ProviderSessionStartCancelledError, R>;
  readonly onDispatchStarted: Effect.Effect<void, ProviderSessionStartCancelledError>;
  readonly stopRequested: Effect.Effect<boolean>;
}

/** No lane: startup recovery and direct callers. */
export const NO_LANE_CONTROL: ContextHandoffLaneControl = {
  guardStart: (effect) => effect,
  onDispatchStarted: Effect.void,
  stopRequested: Effect.succeed(false),
};

export interface ContextHandoffCoordinatorShape {
  /**
   * Prepare and dispatch the first turn for one durable handoff operation.
   * The implementation owns terminal failure projection and never throws an
   * operational failure back into the generic provider-turn path.
   */
  readonly processTurnStart: (
    event: ContextHandoffTurnStartEvent,
    control?: ContextHandoffLaneControl,
  ) => Effect.Effect<void>;

  /** Reconcile durable operations left in preparing/dispatching at startup. */
  readonly recover: () => Effect.Effect<void>;
}

export class ContextHandoffCoordinator extends Context.Service<
  ContextHandoffCoordinator,
  ContextHandoffCoordinatorShape
>()("ryco/orchestration/Services/ContextHandoffCoordinator") {}
