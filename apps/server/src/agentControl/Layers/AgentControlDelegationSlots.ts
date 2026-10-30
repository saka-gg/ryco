/**
 * AgentControlDelegationSlots - starts the next waiting task of a capped `ryco_create_threads`
 * request (`maxConcurrent`) when an earlier one stops working.
 *
 * The boot path holds only this layer. Once commands are admitted it waits for the first queue
 * held for a delegation slot (one an earlier process left, or the first capped request's), then
 * loads the runtime (`delegationSlotRuntime.ts`) with `import()` and runs it, so a node that never
 * caps a request never loads it (serverBundleBoundaries.test.ts).
 *
 * @module AgentControlDelegationSlots
 */
import type { FollowUpQueueHold, OrchestrationReadModel } from "@ryco/contracts";
import { Cause, Effect, Layer, Option, Stream } from "effect";

import { currentCommandReadModel } from "../../orchestration/currentCommandReadModel.ts";
import {
  DELEGATION_SLOT_CAUSE_PREFIX,
  cancelledTaskEntryIds,
  delegationSlotCancelCommandId,
  noUserMessageSent,
} from "../../orchestration/delegationSlotHold.ts";
import { OrchestrationCommandApplication } from "../../orchestration/Services/OrchestrationCommandApplication.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerWakeFence } from "../../orchestration/Services/ServerWakeFence.ts";
import { findThreadInArray } from "../../orchestration/threadIndex.ts";
import { CompletionReturnRepository } from "../../persistence/Layers/AgentControlCompletionReturns.ts";
import { ServerRuntimeStartup } from "../../serverRuntimeStartup.ts";
import { noLongerAwaited } from "../delegatedTaskControl.ts";
import { AgentControlOperationStore } from "../Services/AgentControlOperationStore.ts";
import { AgentControlProposalEvents } from "../Services/AgentControlProposalEvents.ts";
import { AgentControlProposalStore } from "../Services/AgentControlProposalStore.ts";

const loadRuntime = Effect.promise(() => import("../delegationSlotRuntime.ts"));

const holdsSlot = (hold: FollowUpQueueHold | null | undefined) =>
  hold?.causeKeys.some((key) => key.startsWith(DELEGATION_SLOT_CAUSE_PREFIX)) === true;
/** A live thread (not archived, deleted or in Trash) waits for a slot. */
export const anyLiveTaskWaitsForSlot = (threads: OrchestrationReadModel["threads"]) =>
  threads.some(
    (thread) =>
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      holdsSlot(thread.followUpQueue?.hold),
  );

export const AgentControlDelegationSlotsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const projections = yield* ProjectionSnapshotQuery;
    const application = yield* OrchestrationCommandApplication;
    const fence = yield* ServerWakeFence;
    const startup = yield* ServerRuntimeStartup;
    const proposals = yield* AgentControlProposalStore;
    const operations = yield* AgentControlOperationStore;
    const proposalEvents = yield* AgentControlProposalEvents;
    const completionReturns = yield* Effect.serviceOption(CompletionReturnRepository);
    const readModel = currentCommandReadModel(engine, projections);
    // Subscribed before the read, so a hold recorded in between is still seen.
    const firstSlotHold = Effect.scoped(
      Effect.gen(function* () {
        const events = yield* engine.subscribeDomainEvents;
        const live = readModel.pipe(
          Effect.map((model) => anyLiveTaskWaitsForSlot(model.threads)),
          Effect.catch(() => Effect.succeed(false)),
        );
        if (yield* live) return;
        // A new slot hold, or a waiting task back from the archive or Trash.
        yield* events.pipe(
          Stream.mapEffect((event) =>
            event.type === "thread.queue-held"
              ? Effect.succeed(holdsSlot(event.payload.hold))
              : event.type === "thread.unarchived" || event.type === "thread.untrashed"
                ? live
                : Effect.succeed(false),
          ),
          Stream.filter((waits) => waits),
          Stream.runHead,
        );
      }),
    );
    yield* Effect.forkScoped(
      startup.awaitCommandReady.pipe(
        Effect.andThen(firstSlotHold),
        Effect.andThen(loadRuntime),
        Effect.flatMap((runtime) =>
          // Boot modules go in as values: the runtime imports none (no boot chunk splits).
          runtime.runDelegationSlots({
            readModel,
            findThread: findThreadInArray,
            subscribeDomainEvents: engine.subscribeDomainEvents,
            getThreadShellById: projections.getThreadShellById,
            holdReason: fence.holdReason,
            getProposal: proposals.getById,
            getOperation: operations.getByProposalId,
            dispatch: application.apply,
            causePrefix: DELEGATION_SLOT_CAUSE_PREFIX,
            ...(Option.isSome(completionReturns)
              ? { getCompletionReturn: completionReturns.value.get }
              : {}),
            noLongerAwaited,
            cancelCommandId: delegationSlotCancelCommandId,
            noUserMessageSent,
            cancelledTaskEntryIds,
            proposalChanges: proposalEvents.changes,
          }),
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("delegation slots did not start", { cause: Cause.pretty(cause) }),
        ),
      ),
    );
  }),
);
