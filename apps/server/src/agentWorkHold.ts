/**
 * agentWorkHold - the consumers of {@link AgentWorkActivity} for this process.
 *
 * A desktop-launched backend reports agent work to Desktop main over the private desktop pipe
 * (an `agent-work` frame per change), and main holds the machine awake from it. A headless
 * server holds the machine awake itself while agents work (`--keep-awake-while-working`), unless
 * `--prevent-sleep` already holds it for the whole run. The tracker is built only when a consumer
 * needs it.
 *
 * @module agentWorkHold
 */
import { Effect, Layer, Stream } from "effect";

import type { ServerConfigShape } from "./config.ts";
import { writeDesktopAgentWorkFrame } from "./desktopLifecycle.ts";
import {
  AgentWorkActivity,
  AgentWorkActivityLive,
  sameAgentWorkState,
} from "./orchestration/AgentWorkActivity.ts";
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

/** The agent-work consumers this process runs; nothing at all when none applies. */
export function makeAgentWorkHoldLayer(
  config: Pick<ServerConfigShape, "mode" | "preventSleep" | "keepAwakeWhileWorking">,
) {
  const { desktopFrames, headlessHold } = agentWorkHoldConsumers(config);
  if (!desktopFrames && !headlessHold) return Layer.empty;
  return Layer.mergeAll(
    desktopFrames ? DesktopAgentWorkFramesLive : Layer.empty,
    headlessHold ? AgentWorkSleepInhibitorLive : Layer.empty,
  ).pipe(Layer.provide(AgentWorkActivityLive));
}
