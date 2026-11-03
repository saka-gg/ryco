/**
 * Goal continuation on the boot path is wiring only: the runtime
 * (`goalContinuationRuntime.ts`) loads behind `import()` once commands are ready, and shares the
 * server wake fence with delegated results and pull request updates.
 *
 * @module GoalContinuation
 */
import { Cause, Clock, Effect, Layer } from "effect";

import { AgentControlPolicy } from "../../agentControl/Services/AgentControlPolicy.ts";
import { ServerRuntimeStartup } from "../../serverRuntimeStartup.ts";
import { OrchestrationCommandApplication } from "../Services/OrchestrationCommandApplication.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ServerWakeFence } from "../Services/ServerWakeFence.ts";

export const GoalContinuationLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const application = yield* OrchestrationCommandApplication;
    const snapshots = yield* ProjectionSnapshotQuery;
    const fence = yield* ServerWakeFence;
    const policy = yield* AgentControlPolicy;
    const startup = yield* ServerRuntimeStartup;
    // Turns that ended before this process started never continue on their own.
    const observedSinceMs = yield* Clock.currentTimeMillis;
    yield* Effect.forkScoped(
      startup.awaitCommandReady.pipe(
        Effect.andThen(Effect.promise(() => import("../goalContinuationRuntime.ts"))),
        Effect.flatMap(({ makeGoalContinuation, runGoalContinuation }) =>
          runGoalContinuation(
            makeGoalContinuation({
              readShell: (threadId) => snapshots.getThreadShellById(threadId),
              fence,
              apply: (command) => application.apply(command),
              dispatch: (command) => engine.dispatch(command),
              agentControlEnabled: policy.isEnabled,
              observedSinceMs,
            }),
            engine.streamDomainEvents,
          ),
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("goal continuation stopped", { cause: Cause.pretty(cause) }),
        ),
      ),
    );
  }),
);
