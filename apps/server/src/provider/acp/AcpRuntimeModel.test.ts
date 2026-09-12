import { describe, expect, it } from "vite-plus/test";

import type * as EffectAcpSchema from "effect-acp/schema";

import {
  extractModelConfigId,
  mergeToolCallState,
  parsePermissionRequest,
  parseSessionModeState,
  parseSessionUpdateEvent,
} from "./AcpRuntimeModel.ts";

describe("AcpRuntimeModel", () => {
  it("preserves native slash command metadata and explicit empty updates", () => {
    const commands = [{ name: "review", description: "Review changes", input: { hint: "files" } }];
    expect(
      parseSessionUpdateEvent({
        sessionId: "s",
        update: { sessionUpdate: "available_commands_update", availableCommands: commands },
      }).events,
    ).toEqual([{ _tag: "CommandsUpdated", commands }]);
    expect(
      parseSessionUpdateEvent({
        sessionId: "s",
        update: { sessionUpdate: "available_commands_update", availableCommands: [] },
      }).events,
    ).toEqual([{ _tag: "CommandsUpdated", commands: [] }]);
  });
  it("parses session mode state from typed ACP session setup responses", () => {
    const modeState = parseSessionModeState({
      sessionId: "session-1",
      modes: {
        currentModeId: " code ",
        availableModes: [
          { id: " ask ", name: " Ask ", description: " Request approval " },
          { id: " code ", name: " Code " },
        ],
      },
      configOptions: [],
    } satisfies EffectAcpSchema.NewSessionResponse);

    expect(modeState).toEqual({
      currentModeId: "code",
      availableModes: [
        { id: "ask", name: "Ask", description: "Request approval" },
        { id: "code", name: "Code" },
      ],
    });
  });

  it("extracts the model config id from typed ACP config options", () => {
    const modelConfigId = extractModelConfigId({
      sessionId: "session-1",
      configOptions: [
        {
          id: "approval",
          name: "Approval Mode",
          category: "permission",
          type: "select",
          currentValue: "ask",
          options: [{ value: "ask", name: "Ask" }],
        },
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "default",
          options: [{ value: "default", name: "Auto" }],
        },
      ],
    } satisfies EffectAcpSchema.NewSessionResponse);

    expect(modelConfigId).toBe("model");
  });

  it("projects typed ACP tool call updates into runtime events", () => {
    const created = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Terminal",
        kind: "execute",
        status: "pending",
        rawInput: {
          executable: "bun",
          args: ["run", "typecheck"],
        },
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Running checks",
            },
          },
        ],
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(created.events).toEqual([
      {
        _tag: "ToolCallUpdated",
        toolCall: {
          toolCallId: "tool-1",
          kind: "execute",
          title: "Ran command",
          status: "pending",
          command: "bun run typecheck",
          detail: "bun run typecheck",
          data: {
            toolCallId: "tool-1",
            kind: "execute",
            command: "bun run typecheck",
            rawInput: {
              executable: "bun",
              args: ["run", "typecheck"],
            },
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: "Running checks",
                },
              },
            ],
          },
        },
        rawPayload: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-1",
            title: "Terminal",
            kind: "execute",
            status: "pending",
            rawInput: {
              executable: "bun",
              args: ["run", "typecheck"],
            },
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: "Running checks",
                },
              },
            ],
          },
        },
      },
    ]);

    const updated = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        rawOutput: { exitCode: 0 },
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(updated.events).toHaveLength(1);
    expect(updated.events[0]?._tag).toBe("ToolCallUpdated");
    const createdEvent = created.events[0];
    const updatedEvent = updated.events[0];
    if (createdEvent?._tag === "ToolCallUpdated" && updatedEvent?._tag === "ToolCallUpdated") {
      expect(mergeToolCallState(createdEvent.toolCall, updatedEvent.toolCall)).toMatchObject({
        toolCallId: "tool-1",
        status: "completed",
        title: "Ran command",
        detail: "bun run typecheck",
        command: "bun run typecheck",
      });
    }
  });

  it("trims padded current mode updates before emitting a mode change", () => {
    const result = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: " code ",
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(result.modeId).toBe("code");
    expect(result.events).toEqual([
      {
        _tag: "ModeChanged",
        modeId: "code",
      },
    ]);
  });

  it("annotates ACP tool calls with explicit subagent summaries", () => {
    const created = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-agent-1",
        title: "Task",
        kind: "other",
        status: "pending",
        rawInput: {
          description: "Review the retry flow",
          prompt: "Inspect retries and report back",
          subagent_type: "code-reviewer",
        },
      },
    } satisfies EffectAcpSchema.SessionNotification);

    const updated = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-agent-1",
        status: "completed",
        rawOutput: {
          summary: "Retry flow reviewed",
        },
      },
    } satisfies EffectAcpSchema.SessionNotification);

    const createdEvent = created.events[0];
    const updatedEvent = updated.events[0];
    expect(createdEvent?._tag).toBe("ToolCallUpdated");
    expect(updatedEvent?._tag).toBe("ToolCallUpdated");

    if (createdEvent?._tag === "ToolCallUpdated" && updatedEvent?._tag === "ToolCallUpdated") {
      expect(createdEvent.toolCall.subagent).toMatchObject({
        status: "starting",
        summary: "Task",
        detail: "Review the retry flow",
        subagent: {
          subagentId: "tool-agent-1",
          origin: "inferred",
          capability: "summary",
          label: "Task",
          description: "Review the retry flow",
        },
      });

      expect(
        mergeToolCallState(createdEvent.toolCall, updatedEvent.toolCall).subagent,
      ).toMatchObject({
        status: "completed",
        summary: "Retry flow reviewed",
        subagent: {
          subagentId: "tool-agent-1",
          origin: "inferred",
          capability: "summary",
        },
      });
    }
  });

  it.each([
    { kind: "execute" as const, title: "Run command", rawInput: { command: "rg subagent src" } },
    { kind: "read" as const, title: "Read subagent documentation" },
    { kind: "search" as const, title: "Search delegation code" },
    { kind: "other" as const, title: "Read subagent status" },
  ])("does not turn ordinary tool data into agents: $title", (fields) => {
    const { events } = parseSessionUpdateEvent({
      sessionId: "session",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "ordinary-tool",
        status: "completed",
        ...fields,
      },
    });
    const event = events[0];
    expect(event?._tag).toBe("ToolCallUpdated");
    if (event?._tag === "ToolCallUpdated") expect(event.toolCall.subagent).toBeUndefined();
  });

  it("does not infer subagents from generic task wording", () => {
    const result = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-task-1",
        title: "Run a task",
        kind: "other",
        status: "pending",
        rawInput: {
          description: "Agent status check",
          prompt: "Check the pending task queue",
        },
      },
    } satisfies EffectAcpSchema.SessionNotification);

    const event = result.events[0];
    expect(event?._tag).toBe("ToolCallUpdated");
    if (event?._tag === "ToolCallUpdated") {
      expect(event.toolCall.subagent).toBeUndefined();
    }
  });

  it("projects typed ACP plan and content updates", () => {
    const planResult = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "plan",
        entries: [
          { content: " Inspect state ", priority: "high", status: "completed" },
          { content: "", priority: "medium", status: "in_progress" },
        ],
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(planResult.events).toEqual([
      {
        _tag: "PlanUpdated",
        payload: {
          plan: [
            { step: "Inspect state", status: "completed" },
            { step: "Step 2", status: "inProgress" },
          ],
        },
        rawPayload: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "plan",
            entries: [
              { content: " Inspect state ", priority: "high", status: "completed" },
              { content: "", priority: "medium", status: "in_progress" },
            ],
          },
        },
      },
    ]);

    const contentResult = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "hello from acp",
        },
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(contentResult.events).toEqual([
      {
        _tag: "ContentDelta",
        text: "hello from acp",
        rawPayload: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "hello from acp",
            },
          },
        },
      },
    ]);
  });

  it("projects ACP thought chunks into reasoning stream deltas", () => {
    const result = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: {
          type: "text",
          text: "Considering edge cases",
        },
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(result.events).toEqual([
      {
        _tag: "ThoughtDelta",
        text: "Considering edge cases",
        rawPayload: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: {
              type: "text",
              text: "Considering edge cases",
            },
          },
        },
      },
    ]);
  });

  it("drops non-text thought chunks", () => {
    const result = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: {
          type: "image",
          data: "aGVsbG8=",
          mimeType: "image/png",
        },
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(result.events).toEqual([]);
  });

  it("normalizes ACP diff tool content into shared change payloads", () => {
    const result = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-edit-1",
        title: "Edit file",
        kind: "edit",
        status: "completed",
        content: [
          {
            type: "diff",
            path: "src/app.ts",
            oldText: "const a = 1;\nconst b = 2;\nconst c = 3;\n",
            newText: "const a = 1;\nconst b = 42;\nconst c = 3;\nconst d = 4;\n",
          },
        ],
      },
    } satisfies EffectAcpSchema.SessionNotification);

    const event = result.events[0];
    expect(event?._tag).toBe("ToolCallUpdated");
    if (event?._tag === "ToolCallUpdated") {
      expect(event.toolCall.data.changes).toEqual([
        {
          path: "src/app.ts",
          additions: 2,
          deletions: 1,
          diff: `--- a/src/app.ts
+++ b/src/app.ts
@@ -2,2 +2,3 @@
-const b = 2;
+const b = 42;
 const c = 3;
+const d = 4;`,
        },
      ]);
      expect(event.toolCall.data.path).toBe("src/app.ts");
    }
  });

  it("falls back to the first tool-call location when no diff content exists", () => {
    const result = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-read-1",
        title: "Read file",
        kind: "read",
        status: "completed",
        locations: [{ path: "src/index.ts", line: 10 }],
      },
    } satisfies EffectAcpSchema.SessionNotification);

    const event = result.events[0];
    expect(event?._tag).toBe("ToolCallUpdated");
    if (event?._tag === "ToolCallUpdated") {
      expect(event.toolCall.data.path).toBe("src/index.ts");
      expect(event.toolCall.data.changes).toBeUndefined();
    }
  });

  it("projects ACP usage updates into cumulative token usage snapshots", () => {
    const result = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "usage_update",
        used: 12_345,
        size: 200_000,
        cost: { amount: 0.42, currency: "USD" },
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(result.events).toEqual([
      {
        _tag: "UsageUpdated",
        usage: {
          usedTokens: 12_345,
          lastUsedTokens: 12_345,
          maxTokens: 200_000,
        },
        rawPayload: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "usage_update",
            used: 12_345,
            size: 200_000,
            cost: { amount: 0.42, currency: "USD" },
          },
        },
      },
    ]);
  });

  it("propagates zero context usage for Cursor and Grok", () => {
    const result = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: { sessionUpdate: "usage_update", used: 0, size: 128_000 },
    } satisfies EffectAcpSchema.SessionNotification);
    expect(result.events).toMatchObject([
      { _tag: "UsageUpdated", usage: { usedTokens: 0, maxTokens: 128_000 } },
    ]);
  });

  it("keeps permission request parsing compatible with loose extension payloads", () => {
    const request = parsePermissionRequest({
      sessionId: "session-1",
      options: [
        {
          optionId: "allow-once",
          name: "Allow once",
          kind: "allow_once",
        },
      ],
      toolCall: {
        toolCallId: "tool-1",
        title: "`cat package.json`",
        kind: "execute",
        status: "pending",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Not in allowlist",
            },
          },
        ],
      },
    });

    expect(request).toMatchObject({
      kind: "execute",
      detail: "cat package.json",
      toolCall: {
        toolCallId: "tool-1",
        kind: "execute",
        status: "pending",
        command: "cat package.json",
      },
    });
  });
});
