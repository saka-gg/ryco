import { EventId, ProviderInstanceId, ThreadId, TurnId } from "@ryco/contracts";
import type { SessionEvent } from "@github/copilot-sdk";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { isCopilotChildEvent } from "./CopilotAdapter.eventScope.ts";
import { mapEvent } from "./CopilotAdapter.mapEvent.ts";
import type { ActiveCopilotSession } from "./CopilotAdapter.types.ts";

const session = {
  threadId: ThreadId.make("parent"),
  activeTurnId: TurnId.make("parent-turn"),
  providerInstanceId: ProviderInstanceId.make("copilot"),
} as ActiveCopilotSession;
const send = (type: string, data: unknown, agentId?: string) =>
  Effect.runPromise(
    mapEvent(
      {
        makeEventStamp: () =>
          Effect.succeed({ eventId: EventId.make("event"), createdAt: "2026-09-07T00:00:00.000Z" }),
        nextEventId: Effect.succeed(EventId.make("next")),
      },
      session,
      {
        type,
        data,
        ...(agentId ? { agentId } : {}),
        timestamp: "2026-09-07T00:00:00.000Z",
      } as SessionEvent,
    ),
  );
const identity = {
  toolCallId: "launch",
  agentName: "reviewer",
  agentDisplayName: "Review",
  model: "test-model",
};

describe("Copilot native subagents", () => {
  it("maps lifecycle identity, model and terminal usage even on child-scoped envelopes", async () => {
    expect(
      await send("subagent.started", { ...identity, agentDescription: "Review retries" }, "child"),
    ).toMatchObject([
      {
        type: "task.started",
        turnId: "parent-turn",
        payload: {
          taskId: "copilot-task:launch",
          taskType: "subagent",
          title: "Review",
          role: "reviewer",
          model: "test-model",
          description: "Review retries",
          toolUseId: "launch",
        },
      },
    ]);
    expect(
      await send("subagent.completed", {
        ...identity,
        totalTokens: 0,
        totalToolCalls: 3,
        durationMs: 42,
      }),
    ).toMatchObject([
      {
        type: "task.completed",
        payload: {
          taskId: "copilot-task:launch",
          status: "completed",
          typedUsage: { totalTokens: 0, toolUses: 3, durationMs: 42 },
        },
      },
    ]);
  });

  it("preserves failure and cancellation and does not invent token counts", async () => {
    expect(
      await send("subagent.failed", { ...identity, error: "Could not read workspace" }),
    ).toMatchObject([
      {
        type: "task.completed",
        payload: { status: "failed", summary: "Could not read workspace" },
      },
    ]);
    const cancelled = await send("subagent.completed", {
      ...identity,
      cancelled: true,
      durationMs: 20,
    });
    expect(cancelled).toMatchObject([
      { type: "task.completed", payload: { status: "stopped", usage: { durationMs: 20 } } },
    ]);
    expect(cancelled[0]?.payload).not.toHaveProperty("typedUsage");
  });

  it.each([
    ["assistant.turn_start", { turnId: "child-turn" }],
    ["abort", { reason: "child cancelled" }],
    ["session.error", { message: "child failed", errorType: "unknown" }],
    [
      "assistant.message_delta",
      { messageId: "child-message", deltaContent: "private child narration" },
    ],
    ["assistant.usage", { inputTokens: 9000, outputTokens: 100 }],
  ])("does not project child %s onto the parent", async (type, data) => {
    expect(await send(type, data, "child")).toEqual([]);
    expect(isCopilotChildEvent({ type, data, agentId: "child" } as SessionEvent)).toBe(true);
  });

  it("recognizes deprecated parent tool attribution without rejecting main events", async () => {
    expect(
      await send("assistant.message_delta", {
        messageId: "child",
        deltaContent: "child text",
        parentToolCallId: "launch",
      }),
    ).toEqual([]);
    expect(await send("assistant.turn_start", { turnId: "next-parent-turn" })).toMatchObject([
      { type: "turn.started", turnId: "next-parent-turn" },
    ]);
  });
});
