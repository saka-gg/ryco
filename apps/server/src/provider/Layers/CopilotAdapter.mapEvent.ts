import { isCopilotChildEvent } from "./CopilotAdapter.eventScope.ts";
import {
  EventId,
  RuntimeTaskId,
  TurnId,
  type ProviderRuntimeEvent,
  type UserInputQuestion,
} from "@ryco/contracts";
import type { SessionEvent } from "@github/copilot-sdk";
import {
  type HtmlRenderToolPresentation,
  resolveHtmlRenderToolPresentation,
  withoutHtmlRenderMarkup,
} from "@ryco/shared/htmlRenderToolPresentation";
import { Effect } from "effect";

import {
  USER_INPUT_QUESTION_ID,
  type ActiveCopilotSession,
  eventBase,
  normalizeUsage,
} from "./CopilotAdapter.types.ts";

/** Ryco's HTML tools, named by Copilot's MCP server/tool pair or its joined tool name. */
function htmlRenderToolPresentation(data: object, input: unknown) {
  const field = (key: string) => {
    const value = (data as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
  };
  const mcpToolName = field("mcpToolName");
  return mcpToolName !== undefined
    ? resolveHtmlRenderToolPresentation({
        toolName: mcpToolName,
        serverName: field("mcpServerName"),
        input,
      })
    : resolveHtmlRenderToolPresentation({ toolName: field("toolName"), input });
}

// Calls that never complete (an interrupted turn) are forgotten oldest first.
const MAX_REMEMBERED_HTML_RENDER_CALLS = 64;

/** Remembers how a started HTML tool call shows, for its completion to show the same. */
function rememberHtmlRenderToolCall(
  session: ActiveCopilotSession,
  toolCallId: string,
  presentation: HtmlRenderToolPresentation,
) {
  const calls = session.htmlRenderToolCalls;
  calls.delete(toolCallId);
  calls.set(toolCallId, presentation);
  for (const oldest of calls.keys()) {
    if (calls.size <= MAX_REMEMBERED_HTML_RENDER_CALLS) break;
    calls.delete(oldest);
  }
}

/** How a completed call showed when it started, forgotten once it is done. */
function takeHtmlRenderToolCall(session: ActiveCopilotSession, toolCallId: string) {
  const presentation = session.htmlRenderToolCalls.get(toolCallId);
  session.htmlRenderToolCalls.delete(toolCallId);
  return presentation;
}

function nonNegativeCount(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Copilot quota and weekly-limit stops are durable usage limits. Its reset time is not
 * reported, and a generic `rate_limited` stays a transient provider error.
 */
function isCopilotUsageLimitError(data: {
  readonly errorType: string;
  readonly errorCode?: string | undefined;
}): boolean {
  if (data.errorType === "quota") {
    return data.errorCode === "quota_exceeded" || data.errorCode === "session_quota_exceeded";
  }
  return data.errorType === "rate_limit" && data.errorCode === "user_weekly_rate_limited";
}

export interface MapEventDeps {
  readonly makeEventStamp: () => Effect.Effect<{ eventId: EventId; createdAt: string }>;
  readonly nextEventId: Effect.Effect<EventId>;
}

export const mapEvent = (
  deps: MapEventDeps,
  session: ActiveCopilotSession,
  event: SessionEvent,
): Effect.Effect<ReadonlyArray<ProviderRuntimeEvent>> =>
  Effect.gen(function* () {
    const turnId = session.activeTurnId;
    const stamp = yield* deps.makeEventStamp();
    const raw = {
      source: "copilot.sdk.session-event" as const,
      method: event.type,
      payload: event,
    };

    // Lifecycle carries explicit parent tool identity and is useful even when
    // the SDK marks the envelope as child-owned. Handle it before scope filtering.
    if (
      event.type === "subagent.started" ||
      event.type === "subagent.completed" ||
      event.type === "subagent.failed"
    ) {
      const data = event.data;
      const linkage = {
        taskId: RuntimeTaskId.make(`copilot-task:${data.toolCallId}`),
        taskType: "subagent",
        title: data.agentDisplayName.trim() || data.agentName.trim() || "Copilot agent",
        ...(data.agentName.trim() ? { role: data.agentName.trim() } : {}),
        ...(data.model?.trim() ? { model: data.model.trim() } : {}),
        toolUseId: data.toolCallId,
      };
      const base = eventBase({
        eventId: stamp.eventId,
        createdAt: event.timestamp,
        threadId: session.threadId,
        providerInstanceId: session.providerInstanceId,
        ...(turnId ? { turnId } : {}),
        raw,
      });
      if (event.type === "subagent.started") {
        return [
          {
            ...base,
            type: "task.started",
            payload: {
              ...linkage,
              ...(event.data.agentDescription.trim()
                ? { description: event.data.agentDescription.trim() }
                : {}),
            },
          },
        ];
      }
      const terminal = event.data;
      const totalTokens = nonNegativeCount(terminal.totalTokens);
      const toolUses = nonNegativeCount(terminal.totalToolCalls);
      const durationMs = nonNegativeCount(terminal.durationMs);
      const usage = {
        ...(totalTokens !== undefined ? { totalTokens } : {}),
        ...(toolUses !== undefined ? { toolUses } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      };
      return [
        {
          ...base,
          type: "task.completed",
          payload: {
            ...linkage,
            status:
              event.type === "subagent.failed"
                ? "failed"
                : event.data.cancelled
                  ? "stopped"
                  : "completed",
            ...(event.type === "subagent.failed" && event.data.error.trim()
              ? { summary: event.data.error.trim() }
              : {}),
            ...(Object.keys(usage).length > 0 ? { usage } : {}),
            ...(totalTokens !== undefined ? { typedUsage: { ...usage, totalTokens } } : {}),
          },
        },
      ];
    }
    // Child narration/lifecycle must never mutate the root turn or leak into
    // its answer. Native lifecycle above supplies the summary-only roster.
    if (isCopilotChildEvent(event)) return [];

    switch (event.type) {
      case "assistant.turn_start": {
        const eventTurnId = TurnId.make(event.data.turnId);
        return [
          {
            ...eventBase({
              eventId: stamp.eventId,
              createdAt: event.timestamp,
              threadId: session.threadId,
              providerInstanceId: session.providerInstanceId,
              turnId: eventTurnId,
              raw,
            }),
            type: "turn.started",
            payload: session.model ? { model: session.model } : {},
          },
        ];
      }
      case "assistant.message_delta":
        return [
          {
            ...eventBase({
              eventId: stamp.eventId,
              createdAt: event.timestamp,
              threadId: session.threadId,
              providerInstanceId: session.providerInstanceId,
              ...(turnId ? { turnId } : {}),
              itemId: event.data.messageId,
              raw,
            }),
            type: "content.delta",
            payload: {
              streamKind: "assistant_text",
              delta: event.data.deltaContent,
            },
          },
        ];
      case "assistant.reasoning_delta":
        return [
          {
            ...eventBase({
              eventId: stamp.eventId,
              createdAt: event.timestamp,
              threadId: session.threadId,
              providerInstanceId: session.providerInstanceId,
              ...(turnId ? { turnId } : {}),
              itemId: event.data.reasoningId,
              raw,
            }),
            type: "content.delta",
            payload: {
              streamKind: "reasoning_text",
              delta: event.data.deltaContent,
            },
          },
        ];
      case "assistant.reasoning":
        return [
          {
            ...eventBase({
              eventId: stamp.eventId,
              createdAt: event.timestamp,
              threadId: session.threadId,
              providerInstanceId: session.providerInstanceId,
              ...(turnId ? { turnId } : {}),
              itemId: event.data.reasoningId,
              raw,
            }),
            type: "item.completed",
            payload: {
              itemType: "reasoning",
              status: "completed",
              title: "Reasoning",
              detail: event.data.content,
              data: event.data,
            },
          },
        ];
      case "assistant.message":
        return [
          {
            ...eventBase({
              eventId: stamp.eventId,
              createdAt: event.timestamp,
              threadId: session.threadId,
              providerInstanceId: session.providerInstanceId,
              ...(turnId ? { turnId } : {}),
              itemId: event.data.messageId,
              raw,
            }),
            type: "item.completed",
            payload: {
              itemType: "assistant_message",
              status: "completed",
              title: "Assistant message",
              detail: event.data.content,
              data: event.data,
            },
          },
        ];
      case "session.usage_info":
      case "assistant.usage": {
        if (event.type === "session.usage_info") {
          const { currentTokens, tokenLimit } = event.data;
          if (
            !Number.isSafeInteger(currentTokens) ||
            currentTokens < 0 ||
            !Number.isSafeInteger(tokenLimit) ||
            tokenLimit <= 0
          ) {
            return [];
          }
          session.contextUsage = { usedTokens: currentTokens, maxTokens: tokenLimit };
          session.lastUsage = {
            ...session.lastUsage,
            ...session.contextUsage,
            lastUsedTokens: currentTokens,
          };
        } else {
          // Child/background API calls are not the main conversation's context.
          if (
            event.data.parentToolCallId ||
            event.data.initiator ||
            (event.data.interactionType &&
              !["conversation-agent", "conversation-user"].includes(event.data.interactionType))
          ) {
            return [];
          }
          session.lastUsage = {
            ...normalizeUsage(event),
            ...session.contextUsage,
            ...(session.contextUsage ? { lastUsedTokens: session.contextUsage.usedTokens } : {}),
          };
        }
        return [
          {
            ...eventBase({
              eventId: stamp.eventId,
              createdAt: event.timestamp,
              threadId: session.threadId,
              providerInstanceId: session.providerInstanceId,
              ...(turnId ? { turnId } : {}),
              raw,
            }),
            type: "thread.token-usage.updated",
            payload: { usage: session.lastUsage },
          },
        ];
      }
      case "session.idle": {
        const readyEventId = yield* deps.nextEventId;
        return [
          {
            ...eventBase({
              eventId: stamp.eventId,
              createdAt: event.timestamp,
              threadId: session.threadId,
              providerInstanceId: session.providerInstanceId,
              ...(turnId ? { turnId } : {}),
              raw,
            }),
            type: "turn.completed",
            payload: {
              state: event.data.aborted ? "interrupted" : "completed",
              ...(session.lastUsage ? { usage: session.lastUsage } : {}),
            },
          },
          {
            ...eventBase({
              eventId: readyEventId,
              createdAt: event.timestamp,
              threadId: session.threadId,
              providerInstanceId: session.providerInstanceId,
              raw,
            }),
            type: "session.state.changed",
            payload: { state: "ready", reason: "session.idle" },
          },
        ];
      }
      case "abort":
        return [
          {
            ...eventBase({
              eventId: stamp.eventId,
              createdAt: event.timestamp,
              threadId: session.threadId,
              providerInstanceId: session.providerInstanceId,
              ...(turnId ? { turnId } : {}),
              raw,
            }),
            type: "turn.aborted",
            payload: { reason: event.data.reason },
          },
        ];
      case "session.error":
        return [
          {
            ...eventBase({
              eventId: stamp.eventId,
              createdAt: event.timestamp,
              threadId: session.threadId,
              providerInstanceId: session.providerInstanceId,
              ...(turnId ? { turnId } : {}),
              raw,
            }),
            type: "runtime.error",
            payload: {
              message: event.data.message,
              ...(isCopilotUsageLimitError(event.data)
                ? { class: "usage_limit" as const, resetAt: null }
                : { class: "provider_error" as const }),
              detail: event.data,
            },
          },
        ];
      case "tool.execution_start": {
        const toolName = event.data.toolName ?? "";
        const isMcpTool = event.data.mcpToolName !== undefined;
        // A Ryco HTML tool shows a short label and is never carried with its page.
        const htmlRender = htmlRenderToolPresentation(event.data, event.data.arguments);
        if (htmlRender) rememberHtmlRenderToolCall(session, event.data.toolCallId, htmlRender);
        return [
          {
            ...eventBase({
              eventId: stamp.eventId,
              createdAt: event.timestamp,
              threadId: session.threadId,
              providerInstanceId: session.providerInstanceId,
              ...(turnId ? { turnId } : {}),
              itemId: event.data.toolCallId,
              raw,
            }),
            type: "item.started",
            payload: {
              itemType: isMcpTool ? "mcp_tool_call" : "dynamic_tool_call",
              status: "inProgress",
              title: htmlRender?.title ?? toolName,
              ...(htmlRender?.detail ? { detail: htmlRender.detail } : {}),
              ...(event.data.arguments
                ? {
                    data: htmlRender
                      ? withoutHtmlRenderMarkup(event.data.arguments)
                      : event.data.arguments,
                  }
                : {}),
            },
          },
        ];
      }
      case "tool.execution_complete": {
        const isMcpTool = "mcpToolName" in event.data && event.data.mcpToolName !== undefined;
        // Copilot names neither the tool nor its input here, so an HTML tool
        // shows as it started. A success keeps its page title as the detail
        // rather than the agent-facing result; a failure shows why.
        const htmlRender =
          takeHtmlRenderToolCall(session, event.data.toolCallId) ??
          htmlRenderToolPresentation(event.data, undefined);
        const resultDetail =
          htmlRender && event.data.success
            ? htmlRender.detail
            : (event.data.result?.detailedContent ??
              event.data.result?.content ??
              event.data.error?.message);
        return [
          {
            ...eventBase({
              eventId: stamp.eventId,
              createdAt: event.timestamp,
              threadId: session.threadId,
              providerInstanceId: session.providerInstanceId,
              ...(turnId ? { turnId } : {}),
              itemId: event.data.toolCallId,
              raw,
            }),
            type: "item.completed",
            payload: {
              itemType: isMcpTool ? "mcp_tool_call" : "dynamic_tool_call",
              status: event.data.success ? "completed" : "failed",
              title: htmlRender?.title ?? "Tool call",
              ...(resultDetail ? { detail: resultDetail } : {}),
              data: event.data,
            },
          },
        ];
      }
      case "user_input.requested": {
        const question: UserInputQuestion = {
          id: USER_INPUT_QUESTION_ID,
          header: "Question",
          question: event.data.question,
          options: (event.data.choices ?? []).map((choice: string) => ({
            label: choice,
            description: choice,
          })),
        };
        return [
          {
            ...eventBase({
              eventId: stamp.eventId,
              createdAt: event.timestamp,
              threadId: session.threadId,
              providerInstanceId: session.providerInstanceId,
              ...(turnId ? { turnId } : {}),
              requestId: event.data.requestId,
              raw,
            }),
            type: "user-input.requested",
            payload: { questions: [question] },
          },
        ];
      }
      case "user_input.completed":
        return [
          {
            ...eventBase({
              eventId: stamp.eventId,
              createdAt: event.timestamp,
              threadId: session.threadId,
              providerInstanceId: session.providerInstanceId,
              ...(turnId ? { turnId } : {}),
              requestId: event.data.requestId,
              raw,
            }),
            type: "user-input.resolved",
            payload: { answers: { [USER_INPUT_QUESTION_ID]: event.data.answer ?? "" } },
          },
        ];
      default:
        return [];
    }
  });
