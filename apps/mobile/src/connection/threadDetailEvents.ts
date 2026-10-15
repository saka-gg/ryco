import type { EnvironmentId, OrchestrationEvent } from "@ryco/contracts";
import type {
  EnvironmentConnectionSupervisor,
  EnvironmentStateSink,
} from "@ryco/client-runtime/connection";
import { deriveOrchestrationBatchEffects } from "@ryco/client-runtime/state/orchestration";
import {
  createEnvironmentEventBatcher,
  type EnvironmentEventBatcherDeps,
} from "@ryco/client-runtime/state/threads";
import { scopeProjectRef, scopeThreadRef } from "@ryco/client-runtime/scoped";

import { markPromotedDraftThreadByRef } from "../state/composerDraftStore";

export interface ThreadDetailEventApplier {
  /** Buffers one detail event; it lands with the rest of its frame. */
  readonly enqueue: (environmentId: EnvironmentId, event: OrchestrationEvent) => void;
  /** Applies every buffered event now. */
  readonly flush: () => void;
  /** Applies every buffered event and unregisters the store mutation barrier. */
  readonly dispose: () => void;
}

/** Test seams; the default is the threads runtime's frame scheduler. */
export type ThreadDetailEventScheduling = Pick<
  EnvironmentEventBatcherDeps<OrchestrationEvent>,
  "scheduleFrame" | "scheduleFallback"
>;

// §4 stub closure for the driver's applyThreadDetailEvent. Mirrors web's
// applyRecoveredEventBatch: derive the batch effects, apply the orchestration
// events through the sink, then run the same promotion / draft-and-terminal
// cleanup / detail-subscription eviction as the shell path.
//
// Detail events arrive one WebSocket message each (a streaming delta every
// ~32 ms per active thread, bursts on replay), so they are batched per frame
// with the shared batcher: N messages become one store commit and one
// snapshot-cache dirty mark. The batcher is a store mutation barrier, so any
// other store write applies the buffered events first and their order against
// snapshots, shell events and removals is unchanged.
//
// The raw events are applied as they arrived, with no UI coalescing: the
// store's applyOrchestrationEvents already shares one message map across a
// batch, and merging a streaming delta with the empty-text completion of the
// same message would turn it into a replacement that drops earlier text.
// syncProjects/syncThreads are mobile no-ops (no UI store, §3-5). This is a
// mobile-local mirror (a hoist candidate to client-runtime), not a fork of the
// effects derivation, which stays in the runtime package.
export function createThreadDetailEventApplier(
  input: {
    readonly stateSink: EnvironmentStateSink;
    readonly getSupervisor: () => Pick<
      EnvironmentConnectionSupervisor,
      "reconcileThreadDetailSubscriptionEvictionForEnvironment"
    >;
  } & ThreadDetailEventScheduling,
): ThreadDetailEventApplier {
  const applyRecoveredEventBatch = (
    events: ReadonlyArray<OrchestrationEvent>,
    environmentId: EnvironmentId,
  ): void => {
    if (events.length === 0) return;

    const batchEffects = deriveOrchestrationBatchEffects(events);

    if (batchEffects.needsProviderInvalidation) {
      input.stateSink.markProviderInvalidationNeeded();
    }

    input.stateSink.applyOrchestrationEvents(environmentId, events);

    for (const threadId of batchEffects.promoteDraftThreadIds) {
      markPromotedDraftThreadByRef(scopeThreadRef(environmentId, threadId));
    }
    for (const threadId of batchEffects.clearDeletedThreadIds) {
      input.stateSink.clearThreadDraft(scopeThreadRef(environmentId, threadId));
    }
    for (const event of events) {
      if (event.type === "project.deleted") {
        input.stateSink.clearProjectDraftThread(
          scopeProjectRef(environmentId, event.payload.projectId),
        );
      }
    }
    for (const threadId of batchEffects.removeTerminalStateThreadIds) {
      input.stateSink.clearTerminalState(scopeThreadRef(environmentId, threadId));
    }

    input.getSupervisor().reconcileThreadDetailSubscriptionEvictionForEnvironment(environmentId);
  };

  // The batcher registers a store mutation barrier; the owner (the driver,
  // while it runs) releases it with `dispose`.
  const batcher = createEnvironmentEventBatcher<OrchestrationEvent>({
    apply: (environmentId, events) => applyRecoveredEventBatch(events, environmentId),
    ...(input.scheduleFrame === undefined ? {} : { scheduleFrame: input.scheduleFrame }),
    ...(input.scheduleFallback === undefined ? {} : { scheduleFallback: input.scheduleFallback }),
  });

  return { enqueue: batcher.enqueue, flush: batcher.flush, dispose: batcher.dispose };
}
