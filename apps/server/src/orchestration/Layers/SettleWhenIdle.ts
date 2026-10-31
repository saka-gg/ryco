/**
 * Settle when idle on the boot path is wiring only: the runtime (`settleWhenIdleRuntime.ts`)
 * loads behind `import()` once commands are ready, so it stays off the boot closure
 * (serverBundleBoundaries.test.ts).
 *
 * @module SettleWhenIdle
 */
import type { OrchestrationThreadShell } from "@ryco/contracts";
import { queuedTurnIdleBlocker } from "@ryco/shared/threadSettlement";
import { Cause, Effect, Layer } from "effect";

import { ServerRuntimeStartup } from "../../serverRuntimeStartup.ts";
import { currentCommandReadModel } from "../currentCommandReadModel.ts";
import { queuedTurnIdleInputFromShell } from "../serverWake.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

/**
 * A filed thread's work ended: no turn runs or waits to start, nothing waits on the person, no
 * follow-up is queued, and no background work is still going (a monitor left running does not
 * count, as for a queued turn).
 */
export const settleWhenIdleReady = (shell: OrchestrationThreadShell, nowMs: number): boolean =>
  shell.settleWhenIdleAt != null &&
  shell.followUpQueueSummary === undefined &&
  queuedTurnIdleBlocker(queuedTurnIdleInputFromShell(shell, nowMs)) === null;

export const SettleWhenIdleLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const snapshots = yield* ProjectionSnapshotQuery;
    const startup = yield* ServerRuntimeStartup;
    yield* Effect.forkScoped(
      startup.awaitCommandReady.pipe(
        Effect.andThen(Effect.promise(() => import("../settleWhenIdleRuntime.ts"))),
        Effect.flatMap(({ makeSettleWhenIdle, runSettleWhenIdle }) =>
          runSettleWhenIdle(
            makeSettleWhenIdle({
              readModel: currentCommandReadModel(engine, snapshots),
              readShell: (threadId) => snapshots.getThreadShellById(threadId),
              isIdle: settleWhenIdleReady,
              dispatch: (command) => engine.dispatch(command),
              // Unique per process start: command ids must never repeat a spent one.
              bootId: `${engine.bootSequence}-${crypto.randomUUID().slice(0, 8)}`,
            }),
            engine.streamDomainEvents,
          ),
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("settle when idle stopped", { cause: Cause.pretty(cause) }),
        ),
      ),
    );
  }),
);
