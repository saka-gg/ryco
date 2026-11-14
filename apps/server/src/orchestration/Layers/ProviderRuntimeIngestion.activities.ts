/**
 * Provider runtime events to thread activities: the pure mapping `ProviderRuntimeIngestion`
 * appends for each event.
 */
import {
  ApprovalRequestId,
  isToolLifecycleItemType,
  type ThreadTokenUsageSnapshot,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
  type RuntimeTaskUsage,
  type TaskAgentLinkage,
} from "@ryco/contracts";
import {
  FAST_MODE_STATE_ACTIVITY_KIND,
  parseClaudeFastModeReport,
} from "@ryco/shared/claudeFastMode";
import {
  claudeContextUsageActivityId,
  claudeFastModeActivityId,
  promptSuggestionActivityId,
  taskProgressActivityId,
  taskUsageActivityId,
  toolProgressActivityId,
} from "@ryco/shared/latestStateActivities";
import { classifyTaskAgentKind } from "@ryco/shared/taskClassification";
import type {
  ContextWindowActivityPayload,
  ApprovalActivityPayload,
  RuntimeErrorActivityPayload,
  SubagentActivityPayload,
  TaskActivityPayload,
  ToolActivityPayload,
  TurnPlanActivityPayload,
  UserInputActivityPayload,
} from "@ryco/shared/threadActivityPayloads";
import { redactToolParameterCredentials } from "@ryco/shared/toolParameterRedaction";
import {
  projectActivityPayload,
  withoutHtmlRenderToolMarkup,
} from "../ActivityPayloadProjection.ts";
import { capActivityData } from "../activityDataCap.ts";
import { toTurnId, truncateActivityText } from "./ProviderRuntimeIngestion.helpers.ts";

export function toApprovalRequestId(value: string | undefined): ApprovalRequestId | undefined {
  return value === undefined ? undefined : ApprovalRequestId.make(value);
}

export function truncateDetail(value: string, limit = 180): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

/**
 * The detail of an approval or tool activity. A detail that is a whole JSON object loses its
 * credential-named parameters before truncation would leave it unparseable.
 */
export function toolActivityDetail(detail: string): string {
  return truncateDetail(redactToolParameterCredentials(detail));
}

/**
 * Tool data as persisted: no HTML tool page, no credential-named parameter, and no oversized
 * string. Redaction runs before the cap so a structured parameter string is still whole. The
 * provider keeps its own input: redaction returns new values and never mutates `data`.
 */
export function toolActivityData(itemType: string, data: unknown): unknown {
  return capActivityData(
    itemType,
    redactToolParameterCredentials(withoutHtmlRenderToolMarkup(data)),
  );
}

/** A notice's body (for example a local command's output) is display text, not a log. */
export const RUNTIME_NOTICE_DETAIL_LIMIT = 4_000;

export function buildContextWindowActivityPayload(
  event: ProviderRuntimeEvent,
): ThreadTokenUsageSnapshot | undefined {
  if (event.type !== "thread.token-usage.updated" || event.payload.usage.usedTokens < 0) {
    return undefined;
  }
  return event.payload.usage;
}

export function requestKindFromCanonicalRequestType(
  requestType: string | undefined,
): "command" | "file-read" | "file-change" | undefined {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    default:
      return undefined;
  }
}

/** The task runtime payload fields every task activity repeats. */
export type TaskLinkageSource = TaskAgentLinkage & {
  readonly typedUsage?: RuntimeTaskUsage | undefined;
  readonly status?: string | undefined;
  readonly error?: string | undefined;
};

export type CopiedTaskLinkageField = Exclude<keyof TaskLinkageSource, "agentKind">;

/**
 * The fields `taskLinkageActivityFields` copies. Typed by the contract, so a field renamed there
 * fails to compile here, and one added there fails `everyTaskLinkageFieldCopied` until it is
 * listed. `agentKind` is the server's own stamp, never copied.
 */
export const COPIED_TASK_LINKAGE_FIELDS = [
  "isBackgrounded",
  "canStop",
  "canMessage",
  "taskType",
  "agentId",
  "title",
  "role",
  "model",
  "effort",
  "toolUseId",
  "parentAgentId",
  "workflowName",
  "agentIndex",
  "phaseIndex",
  "phaseTitle",
  "phases",
  "attempt",
  "runHandles",
  "outputFile",
  "agentPath",
  "timelineBypass",
  "typedUsage",
  "status",
  "error",
] as const satisfies ReadonlyArray<CopiedTaskLinkageField>;

export const everyTaskLinkageFieldCopied: [
  Exclude<CopiedTaskLinkageField, (typeof COPIED_TASK_LINKAGE_FIELDS)[number]>,
] extends [never]
  ? true
  : never = true;
void everyTaskLinkageFieldCopied;

/**
 * Copies the optional TaskAgentLinkage bundle from a task.* runtime payload
 * into the persisted activity payload. Identity fields ride on every row so
 * client folds survive activity retention; absent fields stay absent.
 */
export function taskLinkageActivityFields(payload: TaskLinkageSource): TaskActivityPayload {
  const fields: Record<string, unknown> = {
    // Server-stamped classification: persisted rows are self-describing, so
    // clients trust the stamp instead of re-deriving agent-vs-background
    // from taskType denylists and marker heuristics (legacy rows without a
    // stamp keep the client fallback).
    agentKind: classifyTaskAgentKind({ taskType: payload.taskType, agentId: payload.agentId }),
  };
  for (const key of COPIED_TASK_LINKAGE_FIELDS) {
    if (payload[key] !== undefined) {
      fields[key] = payload[key];
    }
  }
  return fields as TaskActivityPayload;
}

export function runtimeEventToActivities(
  event: ProviderRuntimeEvent,
  taskTitle?: string,
): ReadonlyArray<OrchestrationThreadActivity> {
  switch (event.type) {
    case "session.started":
    case "session.exited":
    case "session.state.changed": {
      if (
        event.type === "session.state.changed" &&
        event.payload.state !== "stopped" &&
        event.payload.state !== "error"
      )
        return [];
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "background-work.session-boundary",
          summary: "Background work session changed",
          payload: {
            runtimeSessionId: event.runtimeSessionId,
            state: event.type === "session.started" ? "started" : "stopped",
          },
          turnId: null,
        },
      ];
    }
    case "request.opened": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.requested",
          summary:
            requestKind === "command"
              ? "Command approval requested"
              : requestKind === "file-read"
                ? "File-read approval requested"
                : requestKind === "file-change"
                  ? "File-change approval requested"
                  : "Approval requested",
          payload: {
            ...(event.runtimeSessionId ? { runtimeSessionId: event.runtimeSessionId } : {}),
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.detail ? { detail: toolActivityDetail(event.payload.detail) } : {}),
            ...(event.payload.reason
              ? { reason: truncateDetail(event.payload.reason, 1_000) }
              : {}),
            ...(event.payload.acceptForSessionOffered === false
              ? { acceptForSessionOffered: false }
              : {}),
          } satisfies ApprovalActivityPayload,
          turnId: toTurnId(event.turnId) ?? null,
        },
      ];
    }

    case "request.resolved": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.resolved",
          summary: "Approval resolved",
          payload: {
            ...(event.runtimeSessionId ? { runtimeSessionId: event.runtimeSessionId } : {}),
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.decision ? { decision: event.payload.decision } : {}),
          } satisfies ApprovalActivityPayload,
          turnId: toTurnId(event.turnId) ?? null,
        },
      ];
    }

    case "runtime.error": {
      const usageLimit = event.payload.class === "usage_limit";
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "runtime.error",
          summary: usageLimit ? "Usage limit reached" : "Runtime error",
          payload: (usageLimit
            ? {
                message: truncateDetail(event.payload.message),
                class: "usage_limit",
                resetAt: event.payload.resetAt ?? null,
              }
            : {
                message: truncateDetail(event.payload.message),
              }) satisfies RuntimeErrorActivityPayload,
          turnId: toTurnId(event.turnId) ?? null,
        },
      ];
    }

    case "tool.denied": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "tool.denied",
          summary: `Tool denied: ${event.payload.toolName}`,
          payload: {
            toolName: event.payload.toolName,
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
            ...(event.payload.reason ? { detail: truncateDetail(event.payload.reason) } : {}),
            ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}),
          } satisfies ToolActivityPayload,
          turnId: toTurnId(event.turnId) ?? null,
        },
      ];
    }

    case "runtime.notice": {
      // Labelled by its own message, so a retry or a provider banner never reads as a warning.
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "runtime.notice",
          summary: truncateDetail(event.payload.message),
          payload:
            event.payload.detail !== undefined
              ? { detail: truncateActivityText(event.payload.detail, RUNTIME_NOTICE_DETAIL_LIMIT) }
              : {},
          turnId: toTurnId(event.turnId) ?? null,
        },
      ];
    }

    case "runtime.warning": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "runtime.warning",
          summary: "Runtime warning",
          payload: {
            message: truncateDetail(event.payload.message),
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
        },
      ];
    }

    case "turn.plan.updated": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "turn.plan.updated",
          summary: "Plan updated",
          payload: {
            plan: event.payload.plan,
            ...(event.payload.explanation !== undefined
              ? { explanation: event.payload.explanation }
              : {}),
          } satisfies TurnPlanActivityPayload,
          turnId: toTurnId(event.turnId) ?? null,
        },
      ];
    }

    case "user-input.requested": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.requested",
          summary: event.payload.nonBlocking
            ? "Optional question — agent continues working"
            : "User input requested",
          payload: {
            ...(event.runtimeSessionId ? { runtimeSessionId: event.runtimeSessionId } : {}),
            ...(event.requestId ? { requestId: event.requestId } : {}),
            questions: event.payload.questions,
            ...(event.payload.nonBlocking
              ? { nonBlocking: true, itemId: event.itemId, providerRefs: event.providerRefs }
              : {}),
          } satisfies UserInputActivityPayload,
          turnId: toTurnId(event.turnId) ?? null,
        },
      ];
    }

    case "user-input.resolved": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.resolved",
          summary: event.payload.cancelled ? "Question cancelled" : "User input submitted",
          payload: {
            ...(event.runtimeSessionId ? { runtimeSessionId: event.runtimeSessionId } : {}),
            ...(event.requestId ? { requestId: event.requestId } : {}),
            answers: event.payload.answers,
            ...(event.payload.cancelled !== undefined
              ? { cancelled: event.payload.cancelled }
              : {}),
            ...(event.payload.userInputIdentity
              ? { userInputIdentity: event.payload.userInputIdentity }
              : {}),
          } satisfies UserInputActivityPayload,
          turnId: toTurnId(event.turnId) ?? null,
        },
      ];
    }

    case "task.started": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.started",
          summary:
            event.payload.taskType === "plan"
              ? "Plan task started"
              : event.payload.taskType
                ? `${event.payload.taskType} task started`
                : "Task started",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.description
              ? { detail: truncateDetail(event.payload.description) }
              : {}),
            ...taskLinkageActivityFields(event.payload),
            ...(event.runtimeSessionId ? { runtimeSessionId: event.runtimeSessionId } : {}),
          } satisfies TaskActivityPayload,
          turnId: toTurnId(event.turnId) ?? null,
        },
      ];
    }

    case "task.progress": {
      const description = event.payload.description.trim();
      const linkage = {
        ...taskLinkageActivityFields(event.payload),
        ...(event.runtimeSessionId ? { runtimeSessionId: event.runtimeSessionId } : {}),
      };
      // Usage and activity are independent latest-state streams. Separate
      // stable ids keep a command/reasoning update from replacing token usage
      // and keep a pure usage tick from blanking meaningful activity.
      const identityLinkage: {
        -readonly [Key in keyof TaskActivityPayload]: TaskActivityPayload[Key];
      } = {
        ...linkage,
      };
      delete identityLinkage.typedUsage;
      delete identityLinkage.status;
      delete identityLinkage.error;
      const title = description.length > 0 ? { title: truncateDetail(description, 120) } : {};
      const hasProgressState =
        event.payload.typedUsage === undefined ||
        event.payload.summary !== undefined ||
        event.payload.lastToolName !== undefined ||
        event.payload.status !== undefined ||
        event.payload.error !== undefined;
      return [
        ...(hasProgressState
          ? [
              {
                // Activity is latest state, not history, so each meaningful
                // tick replaces the last and a large fleet stays bounded.
                id: taskProgressActivityId(event.threadId, event.payload.taskId),
                createdAt: event.createdAt,
                tone: "info" as const,
                kind: "task.progress" as const,
                summary:
                  description.length > 0 ? truncateDetail(description, 120) : "Reasoning update",
                payload: {
                  taskId: event.payload.taskId,
                  ...title,
                  detail: truncateDetail(event.payload.summary ?? event.payload.description),
                  ...(event.payload.summary
                    ? { summary: truncateDetail(event.payload.summary) }
                    : {}),
                  ...(event.payload.lastToolName
                    ? { lastToolName: event.payload.lastToolName }
                    : {}),
                  ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
                  ...(event.payload.status ? { status: event.payload.status } : {}),
                  ...(event.payload.error ? { error: event.payload.error } : {}),
                  ...identityLinkage,
                } satisfies TaskActivityPayload,
                turnId: toTurnId(event.turnId) ?? null,
              },
            ]
          : []),
        ...(event.payload.typedUsage !== undefined
          ? [
              {
                id: taskUsageActivityId(event.threadId, event.payload.taskId),
                createdAt: event.createdAt,
                tone: "info" as const,
                kind: "task.progress" as const,
                summary: "Task usage updated",
                payload: {
                  taskId: event.payload.taskId,
                  ...title,
                  ...identityLinkage,
                  usageSnapshot: true,
                  typedUsage: event.payload.typedUsage,
                } satisfies TaskActivityPayload,
                turnId: toTurnId(event.turnId) ?? null,
              },
            ]
          : []),
      ];
    }

    case "task.updated": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.status === "failed" ? "error" : "info",
          kind: "task.updated",
          summary:
            event.payload.status === "failed"
              ? "Task failed"
              : event.payload.status
                ? `Task ${event.payload.status}`
                : "Task updated",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.description
              ? { detail: truncateDetail(event.payload.description) }
              : {}),
            ...(event.payload.endedAt ? { endedAt: event.payload.endedAt } : {}),
            ...(event.payload.isBackgrounded !== undefined
              ? { isBackgrounded: event.payload.isBackgrounded }
              : {}),
            ...taskLinkageActivityFields(event.payload),
            ...(event.runtimeSessionId ? { runtimeSessionId: event.runtimeSessionId } : {}),
          } satisfies TaskActivityPayload,
          turnId: toTurnId(event.turnId) ?? null,
        },
      ];
    }

    case "tool.progress": {
      // Only agent-owned heartbeats are persisted: they feed the owning
      // agent's activity line. Parent-conversation tool progress stays
      // ephemeral (item lifecycle already covers it).
      if (event.payload.taskId === undefined) {
        return [];
      }
      return [
        {
          // Same stable-id treatment as task.progress: a heartbeat is
          // "what is this agent doing right now", so one row per task
          // (thread-scoped for the same global-PK collision reason).
          id: toolProgressActivityId(event.threadId, event.payload.taskId),
          createdAt: event.createdAt,
          tone: "info",
          kind: "tool.progress",
          summary: event.payload.toolName ?? "Tool progress",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.toolName ? { toolName: event.payload.toolName } : {}),
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
            ...(event.payload.elapsedSeconds !== undefined
              ? { elapsedSeconds: event.payload.elapsedSeconds }
              : {}),
            ...(event.payload.parentToolUseId
              ? { parentToolUseId: event.payload.parentToolUseId }
              : {}),
          } satisfies ToolActivityPayload,
          turnId: toTurnId(event.turnId) ?? null,
        },
      ];
    }

    case "task.completed": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.status === "failed" ? "error" : "info",
          kind: "task.completed",
          summary:
            event.payload.status === "failed"
              ? "Task failed"
              : event.payload.status === "stopped"
                ? "Task stopped"
                : "Task completed",
          payload: {
            taskId: event.payload.taskId,
            status: event.payload.status,
            ...(taskTitle ? { title: truncateDetail(taskTitle, 120) } : {}),
            // Mirrors task.progress: clients label from summary and keep
            // detail for the expanded body.
            ...(event.payload.summary
              ? {
                  summary: truncateDetail(event.payload.summary),
                  detail: truncateDetail(event.payload.summary),
                }
              : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
            ...taskLinkageActivityFields(event.payload),
            ...(event.runtimeSessionId ? { runtimeSessionId: event.runtimeSessionId } : {}),
          } satisfies TaskActivityPayload,
          turnId: toTurnId(event.turnId) ?? null,
        },
      ];
    }

    case "subagent.started": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "subagent.started",
          summary: `${event.payload.subagent.label ?? "Subagent"} started`,
          payload: {
            itemType: "collab_agent_tool_call",
            status: "running",
            subagent: event.payload.subagent,
          } satisfies SubagentActivityPayload,
          turnId: toTurnId(event.turnId) ?? null,
        },
      ];
    }

    case "subagent.updated": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "subagent.updated",
          summary: event.payload.summary ?? `${event.payload.subagent.label ?? "Subagent"} updated`,
          payload: {
            itemType: "collab_agent_tool_call",
            ...(event.payload.status ? { status: event.payload.status } : {}),
            subagent: event.payload.subagent,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.summary ? { summary: truncateDetail(event.payload.summary) } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
          } satisfies SubagentActivityPayload,
          turnId: toTurnId(event.turnId) ?? null,
        },
      ];
    }

    case "subagent.completed": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.status === "failed" ? "error" : "tool",
          kind: "subagent.completed",
          summary:
            event.payload.status === "failed"
              ? `${event.payload.subagent.label ?? "Subagent"} failed`
              : event.payload.status === "stopped"
                ? `${event.payload.subagent.label ?? "Subagent"} stopped`
                : `${event.payload.subagent.label ?? "Subagent"} completed`,
          payload: {
            itemType: "collab_agent_tool_call",
            status: event.payload.status,
            subagent: event.payload.subagent,
            ...(event.payload.summary ? { detail: truncateDetail(event.payload.summary) } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
          } satisfies SubagentActivityPayload,
          turnId: toTurnId(event.turnId) ?? null,
        },
      ];
    }

    case "thread.state.changed": {
      if (event.payload.state !== "compacted") {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-compaction",
          summary: "Context compacted",
          payload: {
            state: event.payload.state,
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
        },
      ];
    }

    case "session.configured": {
      // Only Claude's Fast mode report; the raw init config carries snake_case keys.
      const report = parseClaudeFastModeReport(event.payload.config.fastModeState);
      if (report === undefined) return [];
      return [
        {
          id: claudeFastModeActivityId(event.threadId),
          createdAt: event.createdAt,
          tone: "info",
          kind: FAST_MODE_STATE_ACTIVITY_KIND,
          summary: "Fast mode state",
          payload: {
            ...report,
            ...(event.providerInstanceId !== undefined
              ? { instanceId: event.providerInstanceId }
              : {}),
          },
          turnId: null,
        },
      ];
    }

    case "turn.prompt-suggestion": {
      // One per thread: each completed turn's suggestion replaces the last. Clients offer it only
      // while its turn is still the thread's latest.
      const turnId = toTurnId(event.turnId);
      if (turnId === undefined) return [];
      return [
        {
          id: promptSuggestionActivityId(event.threadId),
          createdAt: event.createdAt,
          tone: "info",
          // `PROMPT_SUGGESTION_ACTIVITY_KIND` (`@ryco/shared/promptSuggestion`), spelled out:
          // importing that module here put it on the server boot path.
          kind: "prompt.suggestion",
          summary: "Suggested next prompt",
          payload: { suggestion: event.payload.suggestion },
          turnId,
        },
      ];
    }

    case "thread.token-usage.updated": {
      const payload = buildContextWindowActivityPayload(event);
      if (!payload) {
        return [];
      }

      return [
        {
          id:
            event.provider === "claudeAgent"
              ? claudeContextUsageActivityId(event.threadId)
              : event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-window.updated",
          summary: "Context window updated",
          payload: {
            ...payload,
            statisticsProvider: event.provider,
          } satisfies ContextWindowActivityPayload,
          turnId: toTurnId(event.turnId) ?? null,
        },
      ];
    }

    case "item.updated": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        projectActivityPayload({
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.updated",
          summary: event.payload.title ?? "Tool updated",
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.itemId ? { providerItemId: event.itemId } : {}),
            ...(event.providerRefs ? { providerRefs: event.providerRefs } : {}),
            ...(event.payload.detail ? { detail: toolActivityDetail(event.payload.detail) } : {}),
            ...(event.payload.data !== undefined
              ? { data: toolActivityData(event.payload.itemType, event.payload.data) }
              : {}),
            ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}),
            ...(event.payload.parentToolUseId
              ? { parentToolUseId: event.payload.parentToolUseId }
              : {}),
          } satisfies ToolActivityPayload,
          turnId: toTurnId(event.turnId) ?? null,
        }),
      ];
    }

    case "item.completed": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.completed",
          summary: event.payload.title ?? "Tool",
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.itemId ? { providerItemId: event.itemId } : {}),
            ...(event.providerRefs ? { providerRefs: event.providerRefs } : {}),
            ...(event.payload.detail ? { detail: toolActivityDetail(event.payload.detail) } : {}),
            ...(event.payload.data !== undefined
              ? { data: toolActivityData(event.payload.itemType, event.payload.data) }
              : {}),
            ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}),
            ...(event.payload.parentToolUseId
              ? { parentToolUseId: event.payload.parentToolUseId }
              : {}),
          } satisfies ToolActivityPayload,
          turnId: toTurnId(event.turnId) ?? null,
        },
      ];
    }

    case "item.started": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.started",
          summary: `${event.payload.title ?? "Tool"} started`,
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.itemId ? { providerItemId: event.itemId } : {}),
            ...(event.providerRefs ? { providerRefs: event.providerRefs } : {}),
            ...(event.payload.detail ? { detail: toolActivityDetail(event.payload.detail) } : {}),
            ...(event.payload.data !== undefined
              ? { data: toolActivityData(event.payload.itemType, event.payload.data) }
              : {}),
            ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}),
            ...(event.payload.parentToolUseId
              ? { parentToolUseId: event.payload.parentToolUseId }
              : {}),
          } satisfies ToolActivityPayload,
          turnId: toTurnId(event.turnId) ?? null,
        },
      ];
    }

    default:
      break;
  }

  return [];
}
