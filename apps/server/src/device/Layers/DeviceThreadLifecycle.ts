/**
 * DeviceThreadLifecycleLive - the orchestration facts the device manager
 * cannot see for itself.
 *
 * Tells the manager which provider turn each thread is running (an agent's
 * device holds end with that turn) and which threads were removed (their
 * attachments and holds end). It reads the projection's own domain events, so
 * it is provider-neutral, and it only reads: it dispatches nothing.
 *
 * The turn comes from `thread.session-set`, whose `session.activeTurnId` is the
 * projection's authoritative running turn. Events arrive in sequence order, so
 * a stale session-set can never release a newer turn's holds.
 *
 * Adapted from the turn-settled release in Synara commit `d419d5d40` (#1966),
 * which keys the same holds by provider turn generations instead.
 *
 * @module device/Layers/DeviceThreadLifecycle
 */
import type { OrchestrationEvent } from "@ryco/contracts";
import { Cause, Effect, Layer, Stream } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { DeviceManager } from "../DeviceManager.ts";
import { DeviceService } from "../Services/DeviceService.ts";

export type DeviceThreadLifecycleTarget = Pick<
  DeviceManager,
  "observeThreadTurn" | "handleThreadRemoved"
>;

/** Synchronous and O(1) for threads that hold no device, so the event bus never waits on it. */
export function applyDeviceThreadEvent(
  target: DeviceThreadLifecycleTarget,
  event: OrchestrationEvent,
): void {
  try {
    switch (event.type) {
      case "thread.session-set":
        target.observeThreadTurn(event.payload.threadId, event.payload.session.activeTurnId);
        return;
      case "thread.deleted":
      case "thread.trashed":
      case "thread.archived":
        // Not awaited: the detach publishes a snapshot (a simctl listing), and
        // the event stream must keep draining meanwhile.
        void target.handleThreadRemoved(event.payload.threadId).catch(() => undefined);
        return;
    }
  } catch {
    // One bad event must not end the subscription.
  }
}

export const DeviceThreadLifecycleLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const { supported, manager } = yield* DeviceService;
    // No device workspace on this node (no local platform, no SSH hosts): nothing can be held.
    if (!supported) return;
    // The hot stream: a turn already running when this fiber subscribes is
    // learned at its next session-set; until then its device calls hold the
    // device only while they run.
    yield* Effect.forkScoped(
      Stream.runForEach(engine.streamDomainEvents, (event) =>
        Effect.sync(() => applyDeviceThreadEvent(manager, event)),
      ).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("device thread lifecycle stopped", {
                cause: Cause.pretty(cause),
              }),
        ),
      ),
    );
  }),
);
