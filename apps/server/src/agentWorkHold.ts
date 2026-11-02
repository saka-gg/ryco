/**
 * agentWorkHold - the consumers of {@link AgentWorkActivity} for this process.
 *
 * A desktop-launched backend reports agent work to Desktop main over the private desktop pipe
 * (an `agent-work` frame per change), and main holds the machine awake from it. A headless
 * server holds the machine awake itself while agents work (`--keep-awake-while-working`), unless
 * `--prevent-sleep` already holds it for the whole run. Every server keeps a busy marker beside
 * the host install lock while its agents work ({@link ProviderBusyMarkerLive}). The process builds
 * one tracker for all of them (`server.ts`).
 *
 * @module agentWorkHold
 */
import { Cause, Effect, Fiber, Layer, Stream } from "effect";

import type { ServerConfigShape } from "./config.ts";
import { writeDesktopAgentWorkFrame } from "./desktopLifecycle.ts";
import { AgentWorkActivity, sameAgentWorkState } from "./orchestration/AgentWorkActivity.ts";
import { ProviderInstallLock } from "./provider/Services/ProviderInstallLock.ts";
import { AgentWorkSleepInhibitorLive } from "./service/sleepInhibitor.ts";

/** Mirrors agent work onto the desktop pipe: one frame per distinct state, the first included. */
export const DesktopAgentWorkFramesLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const activity = yield* AgentWorkActivity;
    yield* activity.changes.pipe(
      Stream.changesWith(sameAgentWorkState),
      Stream.runForEach((state) =>
        Effect.sync(() =>
          writeDesktopAgentWorkFrame({
            type: "agent-work",
            working: state.working,
            keepAwake: state.keepAwake,
          }),
        ),
      ),
      Effect.forkScoped,
    );
  }),
);

/** Which agent-work consumers this process runs. */
export function agentWorkHoldConsumers(
  config: Pick<ServerConfigShape, "mode" | "preventSleep" | "keepAwakeWhileWorking">,
): { readonly desktopFrames: boolean; readonly headlessHold: boolean } {
  const desktop = config.mode === "desktop";
  return {
    desktopFrames: desktop,
    // `--prevent-sleep` already holds the machine awake for the whole run.
    headlessHold: !desktop && config.preventSleep !== true && config.keepAwakeWhileWorking === true,
  };
}

/** The sleep holds this process runs; nothing at all when none applies. */
export function makeAgentWorkHoldLayer(
  config: Pick<ServerConfigShape, "mode" | "preventSleep" | "keepAwakeWhileWorking">,
) {
  const { desktopFrames, headlessHold } = agentWorkHoldConsumers(config);
  if (!desktopFrames && !headlessHold) return Layer.empty;
  return Layer.mergeAll(
    desktopFrames ? DesktopAgentWorkFramesLive : Layer.empty,
    headlessHold ? AgentWorkSleepInhibitorLive : Layer.empty,
  );
}

/**
 * Keeps this process's busy marker beside the host install lock while its agents work, or
 * stopped less than 2 minutes ago (`keepAwake`), so an unattended update in another Ryco process
 * on this machine waits for them: the provider CLIs are the machine's. Every server keeps it,
 * whatever its own settings. The lock module loads with the first busy period; nothing touches
 * the disk before one.
 */
export const ProviderBusyMarkerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const activity = yield* AgentWorkActivity;
    const installLock = yield* ProviderInstallLock;
    const scope = yield* Effect.scope;
    const hold = installLock.lock.pipe(
      Effect.flatMap((lock) => lock.holdBusy),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("Ryco could not mark this machine's provider CLIs as in use", {
              cause: Cause.pretty(cause),
            }),
      ),
    );
    let marker: Fiber.Fiber<unknown, unknown> | undefined;
    yield* activity.changes.pipe(
      Stream.runForEach(({ keepAwake }) => {
        if (keepAwake === (marker !== undefined)) return Effect.void;
        if (keepAwake) {
          return Effect.map(Effect.forkIn(hold, scope), (fiber) => {
            marker = fiber;
          });
        }
        const held = marker!;
        marker = undefined;
        return Fiber.interrupt(held);
      }),
      Effect.forkScoped,
    );
  }),
);
