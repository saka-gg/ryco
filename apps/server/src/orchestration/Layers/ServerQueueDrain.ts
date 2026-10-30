/**
 * ServerQueueDrain - sends each thread's queued follow-ups (port batch 3, design §3.4).
 *
 * The boot path holds only this layer: it notes which queues held entries when the process
 * started (a restart never sends them without a Resume; a task that waits only for a free slot of
 * its delegation request is left to that request, and one its delegating chat gave up already
 * waits for a Resume) and, once commands are admitted, loads
 * the drain itself (`serverQueueDrainRuntime.ts`) with `import()` and runs it. Until a client
 * queues a follow-up the runtime has nothing to send, so it stays off the boot closure
 * (serverBundleBoundaries.test.ts).
 *
 * @module ServerQueueDrain
 */
import type { OrchestrationReadModel, ThreadId } from "@ryco/contracts";
import {
  assessClaudeCacheResume,
  CLAUDE_CACHE_REVIEW_WINDOW_LIMITS,
} from "@ryco/shared/claudeCacheReview";
import { makeKeyedSerialWorker } from "@ryco/shared/KeyedSerialWorker";
import { losslessBackpressureQueuePolicy } from "@ryco/shared/QueuePolicy";
import { Cause, Context, Effect, Layer } from "effect";

import { ServerRuntimeStartup } from "../../serverRuntimeStartup.ts";
import { currentCommandReadModel } from "../currentCommandReadModel.ts";
import { heldOnlyAsGivenUpDelegation, heldOnlyForDelegationSlot } from "../delegationSlotHold.ts";
import { runtimeModePrivilegeRank, serverWakeGuard } from "../serverWake.ts";
import { findThreadInArray } from "../threadIndex.ts";
import { OrchestrationCommandApplication } from "../Services/OrchestrationCommandApplication.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ServerWakeFence } from "../Services/ServerWakeFence.ts";

export interface ServerQueueDrainShape {
  /** Threads whose queue held entries when this process started. */
  readonly queuedAtBoot: ReadonlyArray<ThreadId>;
}

export class ServerQueueDrain extends Context.Service<ServerQueueDrain, ServerQueueDrainShape>()(
  "ryco/orchestration/ServerQueueDrain",
) {}

const loadRuntime = Effect.promise(() => import("../serverQueueDrainRuntime.ts"));

/**
 * The threads whose queue an earlier process left with entries. A task that waits only for a
 * free slot of its delegation request is not among them: the node releases it, not a Resume. Nor
 * is one held only by its given-up pause: it already waits for a Resume, and a restart hold would
 * only change its banner.
 */
export const threadsQueuedAtBoot = (threads: OrchestrationReadModel["threads"]) =>
  threads
    .filter(
      (thread) =>
        (thread.followUpQueue?.entries.length ?? 0) > 0 &&
        !heldOnlyForDelegationSlot(thread.followUpQueue?.hold) &&
        !heldOnlyAsGivenUpDelegation(thread.followUpQueue?.hold),
    )
    .map((thread) => thread.id);

export const ServerQueueDrainLive = Layer.effect(
  ServerQueueDrain,
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const projections = yield* ProjectionSnapshotQuery;
    const application = yield* OrchestrationCommandApplication;
    const fence = yield* ServerWakeFence;
    const startup = yield* ServerRuntimeStartup;
    const readModel = currentCommandReadModel(engine, projections);
    // Read before any client command is admitted: these queues were left by an earlier process.
    const queuedAtBoot = threadsQueuedAtBoot(
      (yield* readModel.pipe(Effect.catch(() => Effect.succeed({ threads: [] })))).threads,
    );
    yield* Effect.forkScoped(
      startup.awaitCommandReady.pipe(
        Effect.andThen(loadRuntime),
        Effect.flatMap((runtime) =>
          // Boot modules go in as values: the runtime imports none (no boot chunk splits).
          runtime.runServerQueueDrain({
            readModel,
            findThread: findThreadInArray,
            subscribeDomainEvents: engine.subscribeDomainEvents,
            getThreadShellById: projections.getThreadShellById,
            fence,
            serverWakeGuard,
            makeKeyedSerialWorker,
            losslessBackpressureQueuePolicy,
            dispatch: application.applyInternal,
            runtimeModePrivilegeRank,
            queuedAtBoot,
            // Unique per process start: the drain's command ids must never repeat a spent one.
            bootId: `${engine.bootSequence}-${crypto.randomUUID().slice(0, 8)}`,
            ...(projections.getThreadWindow === undefined
              ? {}
              : {
                  claudeResumeReview: (threadId, target, nowMs) =>
                    projections.getThreadWindow!({
                      threadId,
                      limits: CLAUDE_CACHE_REVIEW_WINDOW_LIMITS,
                    }).pipe(
                      Effect.map((window) => {
                        const review = assessClaudeCacheResume(window.thread, target, nowMs, {
                          workspaceCwd: window.workspaceCwd,
                        });
                        // One Resume answers for this observation of this runtime's cache.
                        return review === undefined
                          ? null
                          : {
                              reason: review.reason,
                              promptTokens: review.promptTokens,
                              observationKey: `${review.observation.observedAt}:${window.thread.session?.runtimeSessionId ?? ""}`,
                            };
                      }),
                    ),
                }),
          }),
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("follow-up queue drain did not start", {
                cause: Cause.pretty(cause),
              }),
        ),
      ),
    );
    return { queuedAtBoot } satisfies ServerQueueDrainShape;
  }),
);
