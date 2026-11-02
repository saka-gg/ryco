/**
 * The server's command watches (`ryco_watch_command`, see `docs/command-watch.md`): a shell
 * command the node runs on an interval for a chat's agent, waking it only when the output
 * changes. No model runs in between.
 *
 * This module is the thin, always-on part on the boot path: the service tag and a layer that
 * captures the services the watch runs on. The runner, the scheduler, the run rules and the
 * output fencing load through `import()` once commands are admitted (or with the first call),
 * so none of them costs boot time.
 *
 * Trust boundaries (each enforced where noted):
 * - Who creates: only an agent, for its own chat, through Agent Control's private session tools
 *   (`agentControl/Mcp/commandWatchTools.ts`: exact active-turn authority, the
 *   `commands.watch` grant, Full access and default mode, not an awaited delegated chat). The
 *   decider re-checks scope, lifecycle and limits atomically (`commandWatchUpdates.ts`). There is
 *   no client RPC that creates one.
 * - Who stops: the agent (`ryco_unwatch_command`), an operator (the client command
 *   `thread.command-watch.stop`), and the chat's own lifecycle (Stop, settle, archive, Trash,
 *   leaving Full access or default mode).
 * - Who reads the command text: the agent, through `ryco_list_command_watches`, and anyone who
 *   may replay the chat's events (viewers included): the watch events carry the whole watch,
 *   just as the agent's own `ryco_watch_command` call is kept as a thread activity. Thread
 *   shells carry only how many watches run.
 * - What runs: the stored command, in the cwd the node resolved when the watch started (never
 *   from the agent's input), with the terminal's environment (no `RYCO_*`), no stdin, in its own
 *   process group that a timeout kills; see `commandWatchRuntime.ts`.
 *
 * @module CommandWatchService
 */
import { isThreadSnoozed } from "@ryco/shared/threadSnooze";
import { Context, Deferred, Duration, Effect, Layer, Option, Scope } from "effect";
import { ChildProcessSpawner } from "effect/process";
import * as SqlClient from "effect/sql/SqlClient";

import { AgentControlPolicy } from "../agentControl/Services/AgentControlPolicy.ts";
import { logOnceEvery } from "../logOnceEvery.ts";
import { serverWakeGuard } from "../orchestration/serverWake.ts";
import { OrchestrationCommandApplication } from "../orchestration/Services/OrchestrationCommandApplication.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerWakeFence } from "../orchestration/Services/ServerWakeFence.ts";
import { isThreadWaitWakeEvent } from "../orchestration/threadWaitWakeEvents.ts";
import { ServerRuntimeStartup } from "../serverRuntimeStartup.ts";
import { createTerminalSpawnEnv } from "../terminal/terminalSpawnEnv.ts";
import type { CommandWatchRuntime, CommandWatchRuntimeDeps } from "./commandWatchRuntime.ts";

/** The first look waits this long after commands are admitted, off the shell-load path. */
export const COMMAND_WATCH_FIRST_SCAN_DELAY_MS = 30_000;

export interface CommandWatchServiceShape {
  /**
   * The runtime (start, stop, list), loaded once commands are admitted. Callers check who may
   * start a watch (see the module note); the decider checks the rest.
   */
  readonly runtime: Effect.Effect<CommandWatchRuntime>;
}

export class CommandWatchService extends Context.Service<
  CommandWatchService,
  CommandWatchServiceShape
>()("ryco/commandWatch/CommandWatchService") {}

/**
 * What the lazy runtime runs on: service instances and the boot-path helpers it calls. Handed
 * over instead of imported, so the runtime's chunk imports no boot module.
 */
export const commandWatchRuntimeDeps = Effect.gen(function* () {
  return {
    commands: yield* OrchestrationCommandApplication,
    engine: yield* OrchestrationEngineService,
    projections: yield* ProjectionSnapshotQuery,
    fence: yield* ServerWakeFence,
    spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
    sql: yield* SqlClient.SqlClient,
    // Wakes hold, and runs pause, while Agent Control is off; absent in tests and CLI layers.
    policy: Option.getOrUndefined(yield* Effect.serviceOption(AgentControlPolicy)),
    helpers: {
      serverWakeGuard,
      isThreadWaitWakeEvent,
      isThreadSnoozed,
      logOnceEvery,
      // The terminal's environment: the node's own without Ryco's variables (`RYCO_*`).
      spawnEnv: () => createTerminalSpawnEnv(process.env),
    },
  } satisfies CommandWatchRuntimeDeps;
});

/**
 * The watch's runtime, loaded once, and only on a node with a command watch: one that survived
 * a restart (its looks start `COMMAND_WATCH_FIRST_SCAN_DELAY_MS` after commands are admitted),
 * or the first call (an agent's start). Tests build the runtime with `makeCommandWatchRuntime`.
 */
export const CommandWatchServiceLive = Layer.effect(
  CommandWatchService,
  Effect.gen(function* () {
    const deps = yield* commandWatchRuntimeDeps;
    const startup = yield* ServerRuntimeStartup;
    // Runs belong to the layer: releasing it interrupts them, which ends their process groups.
    const scope = yield* Effect.scope;
    const wanted = yield* Deferred.make<void>();

    const runtime: Effect.Effect<CommandWatchRuntime> = yield* Effect.cached(
      Effect.promise(() => import("./commandWatchRuntime.ts")).pipe(
        Effect.flatMap(({ makeCommandWatchRuntime }) => makeCommandWatchRuntime(deps)),
        Effect.provideService(Scope.Scope, scope),
      ),
    );

    yield* Effect.forkScoped(
      startup.awaitCommandReady.pipe(
        Effect.andThen(Effect.sleep(Duration.millis(COMMAND_WATCH_FIRST_SCAN_DELAY_MS))),
        Effect.andThen(
          deps.engine.getReadModel === undefined
            ? Effect.void
            : deps.engine
                .getReadModel()
                .pipe(
                  Effect.flatMap((model) =>
                    model.threads.some(
                      (thread) => (thread.commandWatchState?.active.length ?? 0) > 0,
                    )
                      ? Effect.void
                      : Deferred.await(wanted),
                  ),
                ),
        ),
        Effect.andThen(runtime),
        Effect.flatMap((loaded) => loaded.run),
        Effect.catchCause((cause) => Effect.logWarning("Command watches stopped", { cause })),
      ),
    );

    // A watch change is a command like any other: it waits for startup to admit commands.
    return {
      runtime: startup.awaitCommandReady.pipe(
        Effect.orDie,
        Effect.andThen(Deferred.succeed(wanted, undefined)),
        Effect.andThen(runtime),
      ),
    } satisfies CommandWatchServiceShape;
  }),
);
