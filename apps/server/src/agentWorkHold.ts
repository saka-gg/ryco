/**
 * agentWorkHold - the consumers of {@link AgentWorkActivity} for this process.
 *
 * A desktop-launched backend reports agent work to Desktop main over the private desktop pipe
 * (an `agent-work` frame per change), and main holds the machine awake from it. The tracker is
 * built only when a consumer needs it.
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

/** The agent-work consumers this process runs; nothing at all when none applies. */
export function makeAgentWorkHoldLayer(config: Pick<ServerConfigShape, "mode">) {
  return config.mode === "desktop"
    ? DesktopAgentWorkFramesLive.pipe(Layer.provide(AgentWorkActivityLive))
    : Layer.empty;
}
