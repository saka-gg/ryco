import { describe, expect, it } from "vite-plus/test";
import {
  EventId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@ryco/contracts";
import type { SessionEvent } from "@github/copilot-sdk";
import { Effect } from "effect";

import { mapEvent } from "./CopilotAdapter.mapEvent.ts";
import type { ActiveCopilotSession } from "./CopilotAdapter.types.ts";

describe("mapEvent", () => {
  it("keeps the active turn id on Copilot idle completion events", async () => {
    const turnId = TurnId.make("turn-1");
    const session = {
      activeTurnId: turnId,
      threadId: ThreadId.make("thread-1"),
      providerInstanceId: ProviderInstanceId.make("copilot"),
      lastUsage: undefined,
    } as ActiveCopilotSession;
    const event = {
      type: "session.idle",
      timestamp: "2026-05-12T00:00:00.000Z",
      data: { aborted: false },
    } as SessionEvent;

    const events = await Effect.runPromise(
      mapEvent(
        {
          makeEventStamp: () =>
            Effect.succeed({
              eventId: EventId.make("event-1"),
              createdAt: "2026-05-12T00:00:00.000Z",
            }),
          nextEventId: Effect.succeed(EventId.make("event-2")),
        },
        session,
        event,
      ),
    );

    const completed = events.find(
      (candidate): candidate is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
        candidate.type === "turn.completed",
    );
    expect(completed?.turnId).toBe(turnId);
  });
  it("keeps authoritative current context through billing events and compaction", async () => {
    const session = {
      threadId: ThreadId.make("thread-usage"),
      activeTurnId: TurnId.make("turn-usage"),
      providerInstanceId: ProviderInstanceId.make("copilot"),
      lastUsage: undefined,
    } as ActiveCopilotSession;
    const send = (type: string, data: unknown) =>
      Effect.runPromise(
        mapEvent(
          {
            makeEventStamp: () =>
              Effect.succeed({
                eventId: EventId.make("usage"),
                createdAt: "2026-09-05T00:00:00.000Z",
              }),
            nextEventId: Effect.succeed(EventId.make("next")),
          },
          session,
          { type, data, timestamp: "2026-09-05T00:00:00.000Z" } as SessionEvent,
        ),
      );

    const usage = await send("session.usage_info", {
      currentTokens: 50_000,
      tokenLimit: 128_000,
      messagesLength: 5,
    });
    expect(usage).toMatchObject([
      {
        type: "thread.token-usage.updated",
        payload: { usage: { usedTokens: 50_000, maxTokens: 128_000 } },
      },
    ]);
    const billed = await send("assistant.usage", {
      inputTokens: 200,
      outputTokens: 100,
      model: "test-model",
    });
    expect(billed).toMatchObject([
      { payload: { usage: { usedTokens: 50_000, maxTokens: 128_000, outputTokens: 100 } } },
    ]);
    expect(
      await send("assistant.usage", {
        inputTokens: 999_000,
        initiator: "sub-agent",
        model: "test-model",
      }),
    ).toEqual([]);
    expect(await send("session.usage_info", { currentTokens: -1, tokenLimit: 128_000 })).toEqual(
      [],
    );
    expect(session.lastUsage?.usedTokens).toBe(50_000);
    await send("session.usage_info", {
      currentTokens: 10_000,
      tokenLimit: 64_000,
      messagesLength: 2,
    });
    expect(session.lastUsage).toMatchObject({ usedTokens: 10_000, maxTokens: 64_000 });
    await send("session.usage_info", { currentTokens: 0, tokenLimit: 64_000, messagesLength: 0 });
    const completed = await send("session.idle", { aborted: false });
    expect(completed).toContainEqual(
      expect.objectContaining({
        type: "turn.completed",
        payload: expect.objectContaining({
          usage: expect.objectContaining({ usedTokens: 0, maxTokens: 64_000 }),
        }),
      }),
    );
  });
});

describe("mapEvent session.error usage limits", () => {
  const session = {
    activeTurnId: TurnId.make("turn-limit"),
    threadId: ThreadId.make("thread-limit"),
    providerInstanceId: ProviderInstanceId.make("copilot"),
    lastUsage: undefined,
  } as ActiveCopilotSession;
  const mapError = (data: Record<string, unknown>) =>
    Effect.runPromise(
      mapEvent(
        {
          makeEventStamp: () =>
            Effect.succeed({
              eventId: EventId.make("event-error"),
              createdAt: "2026-10-04T10:00:00.000Z",
            }),
          nextEventId: Effect.succeed(EventId.make("event-error-2")),
        },
        session,
        {
          type: "session.error",
          timestamp: "2026-10-04T10:00:00.000Z",
          data: { message: "Limited", ...data },
        } as SessionEvent,
      ),
    );

  it("maps quota exhaustion to usage_limit with an unknown reset", async () => {
    const [error] = await mapError({ errorType: "quota", errorCode: "quota_exceeded" });
    expect(error?.type === "runtime.error" && error.payload).toMatchObject({
      class: "usage_limit",
      resetAt: null,
    });
    const [weekly] = await mapError({
      errorType: "rate_limit",
      errorCode: "user_weekly_rate_limited",
    });
    expect(weekly?.type === "runtime.error" && weekly.payload.class).toBe("usage_limit");
  });

  it("keeps a generic rate limit a provider error", async () => {
    const [error] = await mapError({ errorType: "rate_limit", errorCode: "rate_limited" });
    expect(error?.type === "runtime.error" && error.payload.class).toBe("provider_error");
    expect(error?.type === "runtime.error" && "resetAt" in error.payload).toBe(false);
  });

  const sendHtmlToolEvent = (session: ActiveCopilotSession, type: string, data: unknown) =>
    Effect.runPromise(
      mapEvent(
        {
          makeEventStamp: () =>
            Effect.succeed({
              eventId: EventId.make("html"),
              createdAt: "2026-10-07T00:00:00.000Z",
            }),
          nextEventId: Effect.succeed(EventId.make("next")),
        },
        session,
        { type, data, timestamp: "2026-10-07T00:00:00.000Z" } as SessionEvent,
      ),
    );

  it("shows a Ryco HTML tool call by page title, without the page markup", async () => {
    const session = {
      threadId: ThreadId.make("thread-html"),
      activeTurnId: TurnId.make("turn-html"),
      providerInstanceId: ProviderInstanceId.make("copilot"),
      lastUsage: undefined,
      htmlRenderToolCalls: new Map(),
    } as ActiveCopilotSession;
    const send = (type: string, data: unknown) => sendHtmlToolEvent(session, type, data);
    const html = "<!doctype html><script>drawSecretChart()</script>";
    const [started] = await send("tool.execution_start", {
      toolCallId: "call-html",
      toolName: "ryco-ryco_html_render",
      mcpServerName: "ryco",
      mcpToolName: "ryco_html_render",
      arguments: { html, title: "Quarterly revenue", height: 420 },
    });
    expect(started).toMatchObject({
      type: "item.started",
      payload: {
        itemType: "mcp_tool_call",
        title: "Rendered HTML",
        detail: "Quarterly revenue",
        data: { title: "Quarterly revenue", height: 420, htmlChars: html.length },
      },
    });
    expect(JSON.stringify(started?.payload)).not.toContain("drawSecretChart");

    // Copilot's completion names neither the tool nor its input; the row reads as it started.
    const [completed] = await send("tool.execution_complete", {
      toolCallId: "call-html",
      success: true,
      result: { content: "Shown to the reader above your reply." },
    });
    expect(completed).toMatchObject({
      type: "item.completed",
      payload: { title: "Rendered HTML", detail: "Quarterly revenue" },
    });
    expect(session.htmlRenderToolCalls.size).toBe(0);

    await send("tool.execution_start", {
      toolCallId: "call-preview",
      toolName: "ryco-ryco_html_preview",
      mcpServerName: "ryco",
      mcpToolName: "ryco_html_preview",
      arguments: { html, width: 390, appearance: "light" },
    });
    const [previewed] = await send("tool.execution_complete", {
      toolCallId: "call-preview",
      success: true,
    });
    expect(previewed).toMatchObject({
      payload: { title: "Previewed HTML", detail: "390px light" },
    });

    await send("tool.execution_start", {
      toolCallId: "call-failed",
      toolName: "ryco-ryco_html_preview",
      arguments: { html },
    });
    const [failed] = await send("tool.execution_complete", {
      toolCallId: "call-failed",
      success: false,
      error: { message: "An exact active turn is required." },
    });
    expect(failed).toMatchObject({
      payload: { title: "Previewed HTML", detail: "An exact active turn is required." },
    });

    // A completion that names the tool itself still reads as one, without the result text.
    const [named] = await send("tool.execution_complete", {
      toolCallId: "call-unseen",
      mcpServerName: "ryco",
      mcpToolName: "ryco_html_render",
      success: true,
      result: { content: "Shown to the reader above your reply." },
    });
    expect(named).toMatchObject({ payload: { title: "Rendered HTML" } });
    expect((named!.payload as { detail?: string }).detail).toBeUndefined();

    const [other] = await send("tool.execution_start", {
      toolCallId: "call-other",
      toolName: "bash",
      arguments: { command: "ls" },
    });
    expect(other).toMatchObject({ payload: { title: "bash", data: { command: "ls" } } });
    const [otherDone] = await send("tool.execution_complete", {
      toolCallId: "call-other",
      success: true,
      result: { content: "README.md" },
    });
    expect(otherDone).toMatchObject({ payload: { title: "Tool call", detail: "README.md" } });
  });

  it("forgets HTML tool calls that never complete, oldest first", async () => {
    const session = {
      threadId: ThreadId.make("thread-html"),
      activeTurnId: TurnId.make("turn-html"),
      providerInstanceId: ProviderInstanceId.make("copilot"),
      lastUsage: undefined,
      htmlRenderToolCalls: new Map(),
    } as ActiveCopilotSession;
    for (let index = 0; index < 70; index += 1) {
      await sendHtmlToolEvent(session, "tool.execution_start", {
        toolCallId: `call-${index}`,
        toolName: "ryco-ryco_html_render",
        arguments: { html: "<p>x</p>", title: `Page ${index}`, height: 300 },
      });
    }
    expect(session.htmlRenderToolCalls.size).toBe(64);
    expect(session.htmlRenderToolCalls.has("call-5")).toBe(false);
    expect(session.htmlRenderToolCalls.get("call-69")).toEqual({
      title: "Rendered HTML",
      detail: "Page 69",
    });
  });
});
