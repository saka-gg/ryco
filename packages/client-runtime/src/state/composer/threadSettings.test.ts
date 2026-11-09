import { CommandId, ThreadId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadSettingsForNextTurnCommands } from "./threadSettings.ts";

const input = {
  threadId: ThreadId.make("thread-1"),
  createdAt: "2026-11-09T10:00:00.000Z",
  runtimeMode: "approval-required",
  interactionMode: "plan",
  tokenMode: "off",
} as const;
const commandId = (kind: string) => CommandId.make(`command-${kind}`);

describe("threadSettingsForNextTurnCommands", () => {
  it("writes only the modes that differ from the thread's", () => {
    expect(
      threadSettingsForNextTurnCommands(
        { runtimeMode: "approval-required", interactionMode: "default" },
        input,
        commandId,
      ),
    ).toEqual([
      {
        type: "thread.interaction-mode.set",
        commandId: "command-interaction-mode",
        threadId: "thread-1",
        interactionMode: "plan",
        createdAt: input.createdAt,
      },
    ]);
  });

  it("writes nothing when the thread already runs in the chosen modes", () => {
    expect(
      threadSettingsForNextTurnCommands(
        { runtimeMode: "approval-required", interactionMode: "plan", tokenMode: "off" },
        input,
        commandId,
      ),
    ).toEqual([]);
  });

  it("writes all three when the thread's modes are unknown (a thread the node created)", () => {
    expect(
      threadSettingsForNextTurnCommands(null, input, commandId).map((command) => command.type),
    ).toEqual(["thread.runtime-mode.set", "thread.interaction-mode.set", "thread.token-mode.set"]);
  });
});
