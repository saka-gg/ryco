import { EventId, type OrchestrationThreadActivity } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";
import { projectActivityPayload } from "./ActivityPayloadProjection.ts";

describe("provider output projection", () => {
  it.each([
    { result: { content: [{ type: "text", text: "first line\nsecond line" }] } },
    { result: { detailedContent: "first line\nsecond line" } },
    { state: { output: "first line\nsecond line" } },
    { rawOutput: "first line\nsecond line" },
    {
      content: [
        {
          type: "content",
          content: { type: "resource", resource: { text: "first line\nsecond line" } },
        },
      ],
    },
  ])("retains compact progress without persisting repeated full outputs", (data) => {
    const activity: OrchestrationThreadActivity = {
      id: EventId.make("event"),
      createdAt: "2026-09-07T00:00:00.000Z",
      tone: "tool",
      kind: "tool.updated",
      summary: "Tool",
      turnId: null,
      payload: { itemType: "dynamic_tool_call", data, agentId: "owner", parentToolUseId: "launch" },
    };
    expect(projectActivityPayload(activity).payload).toEqual({
      itemType: "dynamic_tool_call",
      agentId: "owner",
      parentToolUseId: "launch",
      data: { rawOutput: { content: "first line" } },
    });
  });
});
