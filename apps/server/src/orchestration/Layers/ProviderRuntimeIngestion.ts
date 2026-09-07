import { derivePendingThreadRequests } from "@ryco/shared/threadActivity";
import {
  ApprovalRequestId,
  type AssistantDeliveryMode,
  CommandId,
  DEFAULT_AGENT_TOKEN_MODE,
  EventId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationMessage,
  type OrchestrationProposedPlanId,
  CheckpointRef,
  isToolLifecycleItemType,
  ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
  type OrchestrationCheckpointSummary,
  type OrchestrationProposedPlan,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
} from "@ryco/contracts";
import { Cache, Cause, Deferred, Duration, Effect, Layer, Option, Semaphore, Stream } from "effect";
import type { ProviderRuntimeBinding } from "../../provider/Services/ProviderSessionDirectory.ts";
import type { ProviderThreadHistory } from "../../provider/Services/ProviderAdapter.ts";
import { historyMessagesToRestore, missingHistoryActivities } from "../providerHistoryRecovery.ts";
import { makeDrainableWorker } from "@ryco/shared/DrainableWorker";
import { losslessBackpressureQueuePolicy } from "@ryco/shared/QueuePolicy";
import { readEnv } from "@ryco/shared/runtimeEnv";
import { classifyTaskAgentKind } from "@ryco/shared/taskClassification";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { isGitRepository } from "../../git/Utils.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ThreadBackgroundLivenessService } from "../ThreadBackgroundLiveness.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderRuntimeIngestionService,
  type ProviderRuntimeIngestionShape,
} from "../Services/ProviderRuntimeIngestion.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { increment, providerRuntimeStaleEventsTotal } from "../../observability/Metrics.ts";
import { projectActivityPayload } from "../ActivityPayloadProjection.ts";
import { capActivityData } from "../activityDataCap.ts";

const providerTurnKey = (threadId: ThreadId, turnId: TurnId) => `${threadId}:${turnId}`;
const providerTaskKey = (threadId: ThreadId, taskId: string) => `${threadId}:${taskId}`;

// Fallback when the in-memory description cache no longer has the task name
// (server restart, session-exit sweep, TTL/capacity eviction): earlier
// task.started/task.progress activities for the task are persisted with it.
function findTaskTitleInActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity> | undefined,
  taskId: string,
): string | undefined {
  if (!activities) {
    return undefined;
  }
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (
      !activity ||
      (activity.kind !== "task.started" &&
        activity.kind !== "task.progress" &&
        activity.kind !== "task.updated")
    ) {
      continue;
    }
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as { taskId?: unknown; title?: unknown; detail?: unknown })
        : undefined;
    if (payload?.taskId !== taskId) {
      continue;
    }
    // task.started and task.updated both persist their description as
    // `detail` — a task whose first description arrives via an update must
    // not complete untitled.
    const title =
      typeof payload.title === "string"
        ? payload.title
        : activity.kind !== "task.progress" && typeof payload.detail === "string"
          ? payload.detail
          : undefined;
    if (title && title.trim().length > 0) {
      return title;
    }
  }
  return undefined;
}

const TASK_DESCRIPTION_BY_TASK_CACHE_CAPACITY = 10_000;
const TASK_DESCRIPTION_BY_TASK_TTL = Duration.minutes(120);

const providerCommandId = (
  event: ProviderRuntimeEvent,
  tag: string,
  discriminator?: string,
): CommandId =>
  CommandId.make(
    discriminator === undefined
      ? `provider:${event.eventId}:${tag}`
      : `provider:${event.eventId}:${tag}:${discriminator}`,
  );
const liveAssistantDeltaBufferKey = (threadId: ThreadId, messageId: MessageId) =>
  `${threadId}:${messageId}`;

interface AssistantSegmentState {
  baseKey: string;
  nextSegmentIndex: number;
  activeMessageId: MessageId | null;
}

interface LiveAssistantDeltaBuffer {
  threadId: ThreadId;
  messageId: MessageId;
  turnId?: TurnId;
  event: ProviderRuntimeEvent;
  text: string;
  createdAt: string;
  generation: number;
}

const TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY = 10_000;
const TURN_MESSAGE_IDS_BY_TURN_TTL = Duration.minutes(120);
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY = 20_000;
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL = Duration.minutes(120);
const BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY = 10_000;
const BUFFERED_PROPOSED_PLAN_BY_ID_TTL = Duration.minutes(120);
const MAX_BUFFERED_ASSISTANT_CHARS = 24_000;
const LIVE_ASSISTANT_DELTA_FLUSH_INTERVAL = Duration.millis(32);
const LIVE_ASSISTANT_DELTA_FLUSH_THRESHOLD_CHARS = 4_096;
const STRICT_PROVIDER_LIFECYCLE_GUARD = readEnv("RYCO_STRICT_PROVIDER_LIFECYCLE_GUARD") !== "0";

type TurnStartRequestedDomainEvent = Extract<
  OrchestrationEvent,
  { type: "thread.turn-start-requested" }
>;

type RuntimeIngestionInput =
  | {
      source: "history";
      threadId: ThreadId;
      expectedUpdatedAt: string;
      binding: ProviderRuntimeBinding;
      history: ProviderThreadHistory;
      done: Deferred.Deferred<void>;
    }
  | {
      source: "runtime";
      event: ProviderRuntimeEvent;
    }
  | {
      source: "domain";
      event: TurnStartRequestedDomainEvent;
    }
  | {
      source: "liveAssistantFlush";
      key: string;
      generation: number;
    };

function toTurnId(value: TurnId | string | undefined): TurnId | undefined {
  return value === undefined ? undefined : TurnId.make(String(value));
}

function toApprovalRequestId(value: string | undefined): ApprovalRequestId | undefined {
  return value === undefined ? undefined : ApprovalRequestId.make(value);
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function hasAssistantMessageForTurn(
  messages: ReadonlyArray<OrchestrationMessage>,
  turnId: TurnId,
  options?: { readonly streamingOnly?: boolean },
): boolean {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    if (message.role !== "assistant" || message.turnId !== turnId) {
      continue;
    }
    if (options?.streamingOnly === true && !message.streaming) {
      continue;
    }
    return true;
  }
  return false;
}

function findMessageById(
  messages: ReadonlyArray<OrchestrationMessage>,
  messageId: MessageId,
): OrchestrationMessage | undefined {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.id === messageId) {
      return message;
    }
  }
  return undefined;
}

function findProposedPlanById(
  proposedPlans: ReadonlyArray<
    Pick<OrchestrationProposedPlan, "id" | "createdAt" | "implementedAt" | "implementationThreadId">
  >,
  planId: string,
):
  | Pick<OrchestrationProposedPlan, "id" | "createdAt" | "implementedAt" | "implementationThreadId">
  | undefined {
  for (let index = 0; index < proposedPlans.length; index += 1) {
    const proposedPlan = proposedPlans[index];
    if (proposedPlan?.id === planId) {
      return proposedPlan;
    }
  }
  return undefined;
}

function hasCheckpointForTurn(
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
  turnId: TurnId,
): boolean {
  for (let index = 0; index < checkpoints.length; index += 1) {
    if (checkpoints[index]?.turnId === turnId) {
      return true;
    }
  }
  return false;
}

function maxCheckpointTurnCount(
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
): number {
  let maxTurnCount = 0;
  for (let index = 0; index < checkpoints.length; index += 1) {
    const checkpoint = checkpoints[index];
    if (checkpoint && checkpoint.checkpointTurnCount > maxTurnCount) {
      maxTurnCount = checkpoint.checkpointTurnCount;
    }
  }
  return maxTurnCount;
}

function truncateDetail(value: string, limit = 180): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

function truncateActivityText(value: string, limit = 24_000): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function rawPayloadThreadId(event: ProviderRuntimeEvent): string | undefined {
  return asTrimmedString(asRecord(event.raw?.payload)?.threadId);
}

function collabReceiverThreadIdsFromRuntimeEvent(event: ProviderRuntimeEvent): string[] {
  if (
    event.type === "subagent.started" ||
    event.type === "subagent.updated" ||
    event.type === "subagent.completed"
  ) {
    return event.payload.subagent.providerThreadId ? [event.payload.subagent.providerThreadId] : [];
  }

  if (
    event.type !== "item.started" &&
    event.type !== "item.updated" &&
    event.type !== "item.completed"
  ) {
    return [];
  }
  if (event.payload.itemType !== "collab_agent_tool_call") {
    return [];
  }

  const data = asRecord(event.payload.data);
  const item = asRecord(data?.item);
  const receiverThreadIds = item?.type === "collabAgentToolCall" ? item.receiverThreadIds : [];
  return Array.isArray(receiverThreadIds)
    ? receiverThreadIds.flatMap((entry) => {
        const threadId = asTrimmedString(entry);
        return threadId ? [threadId] : [];
      })
    : [];
}

function subagentMessageActivityId(input: {
  threadId: ThreadId;
  providerThreadId: string;
  providerItemId: string;
}): EventId {
  return EventId.make(
    `agent-message:${input.threadId}:${input.providerThreadId}:${input.providerItemId}`,
  );
}

function subagentMessageBufferKey(input: {
  threadId: ThreadId;
  providerThreadId: string;
  providerItemId: string;
}): string {
  return `${input.threadId}:${input.providerThreadId}:${input.providerItemId}`;
}

function cappedSubagentMessageText(value: string): string {
  return truncateActivityText(value, MAX_BUFFERED_ASSISTANT_CHARS);
}

function normalizeProposedPlanMarkdown(planMarkdown: string | undefined): string | undefined {
  const trimmed = planMarkdown?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

function hasRenderableAssistantText(text: string | undefined): boolean {
  return (text?.trim().length ?? 0) > 0;
}

function isAssistantTextDeltaEvent(
  event: ProviderRuntimeEvent,
): event is Extract<ProviderRuntimeEvent, { type: "content.delta" }> {
  return event.type === "content.delta" && event.payload.streamKind === "assistant_text";
}

function proposedPlanIdForTurn(threadId: ThreadId, turnId: TurnId): string {
  return `plan:${threadId}:turn:${turnId}`;
}

function proposedPlanIdFromEvent(event: ProviderRuntimeEvent, threadId: ThreadId): string {
  const turnId = toTurnId(event.turnId);
  if (turnId) {
    return proposedPlanIdForTurn(threadId, turnId);
  }
  if (event.itemId) {
    return `plan:${threadId}:item:${event.itemId}`;
  }
  return `plan:${threadId}:event:${event.eventId}`;
}

function assistantSegmentBaseKeyFromEvent(event: ProviderRuntimeEvent): string {
  return String(event.itemId ?? event.turnId ?? event.eventId);
}

function assistantSegmentMessageId(baseKey: string, segmentIndex: number): MessageId {
  return MessageId.make(
    segmentIndex === 0 ? `assistant:${baseKey}` : `assistant:${baseKey}:segment:${segmentIndex}`,
  );
}
function buildContextWindowActivityPayload(
  event: ProviderRuntimeEvent,
): ThreadTokenUsageSnapshot | undefined {
  if (event.type !== "thread.token-usage.updated" || event.payload.usage.usedTokens < 0) {
    return undefined;
  }
  return event.payload.usage;
}

function normalizeRuntimeTurnState(
  value: string | undefined,
): "completed" | "failed" | "interrupted" | "cancelled" {
  switch (value) {
    case "failed":
    case "interrupted":
    case "cancelled":
    case "completed":
      return value;
    default:
      return "completed";
  }
}

function isTerminalProjectionTurnState(state: string): boolean {
  return state === "completed" || state === "error" || state === "interrupted";
}

function orchestrationSessionStatusFromRuntimeState(
  state: "starting" | "running" | "waiting" | "ready" | "interrupted" | "stopped" | "error",
): "starting" | "running" | "ready" | "interrupted" | "stopped" | "error" {
  switch (state) {
    case "starting":
      return "starting";
    case "running":
    case "waiting":
      return "running";
    case "ready":
      return "ready";
    case "interrupted":
      return "interrupted";
    case "stopped":
      return "stopped";
    case "error":
      return "error";
  }
}

function requestKindFromCanonicalRequestType(
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

/**
 * Copies the optional TaskAgentLinkage bundle from a task.* runtime payload
 * into the persisted activity payload. Identity fields ride on every row so
 * client folds survive activity retention; absent fields stay absent.
 */
function taskLinkageActivityFields(payload: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    // Server-stamped classification: persisted rows are self-describing, so
    // clients trust the stamp instead of re-deriving agent-vs-background
    // from taskType denylists and marker heuristics (legacy rows without a
    // stamp keep the client fallback).
    agentKind: classifyTaskAgentKind({
      taskType: typeof payload.taskType === "string" ? payload.taskType : undefined,
      agentId: typeof payload.agentId === "string" ? payload.agentId : undefined,
    }),
  };
  for (const key of [
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
  ] as const) {
    if (payload[key] !== undefined) {
      fields[key] = payload[key];
    }
  }
  return fields;
}

export function runtimeEventToActivities(
  event: ProviderRuntimeEvent,
  taskTitle?: string,
): ReadonlyArray<OrchestrationThreadActivity> {
  const maybeSequence = (() => {
    const eventWithSequence = event as ProviderRuntimeEvent & { sessionSequence?: number };
    return eventWithSequence.sessionSequence !== undefined
      ? { sequence: eventWithSequence.sessionSequence }
      : {};
  })();
  switch (event.type) {
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
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
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
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.decision ? { decision: event.payload.decision } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.error": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "runtime.error",
          summary: "Runtime error",
          payload: {
            message: truncateDetail(event.payload.message),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
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
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
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
          ...maybeSequence,
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
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
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
          summary: "User input requested",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            questions: event.payload.questions,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
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
          summary: "User input submitted",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            answers: event.payload.answers,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
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
            ...taskLinkageActivityFields(event.payload as Record<string, unknown>),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.progress": {
      const description = event.payload.description.trim();
      const linkage = taskLinkageActivityFields(event.payload as Record<string, unknown>);
      // Usage and activity are independent latest-state streams. Separate
      // stable ids keep a command/reasoning update from replacing token usage
      // and keep a pure usage tick from blanking meaningful activity.
      const identityLinkage = { ...linkage };
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
                id: EventId.make(`task-progress:${event.threadId}:${event.payload.taskId}`),
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
                },
                turnId: toTurnId(event.turnId) ?? null,
                ...maybeSequence,
              },
            ]
          : []),
        ...(event.payload.typedUsage !== undefined
          ? [
              {
                id: EventId.make(`task-usage:${event.threadId}:${event.payload.taskId}`),
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
                },
                turnId: toTurnId(event.turnId) ?? null,
                ...maybeSequence,
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
            ...taskLinkageActivityFields(event.payload as Record<string, unknown>),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
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
          id: EventId.make(`tool-progress:${event.threadId}:${event.payload.taskId}`),
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
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
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
            ...taskLinkageActivityFields(event.payload as Record<string, unknown>),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
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
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
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
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
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
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
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
          ...maybeSequence,
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
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-window.updated",
          summary: "Context window updated",
          payload,
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
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
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.data !== undefined
              ? { data: capActivityData(event.payload.itemType, event.payload.data) }
              : {}),
            ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}),
            ...(event.payload.parentToolUseId
              ? { parentToolUseId: event.payload.parentToolUseId }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
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
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.data !== undefined
              ? { data: capActivityData(event.payload.itemType, event.payload.data) }
              : {}),
            ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}),
            ...(event.payload.parentToolUseId
              ? { parentToolUseId: event.payload.parentToolUseId }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
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
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.data !== undefined
              ? { data: capActivityData(event.payload.itemType, event.payload.data) }
              : {}),
            ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}),
            ...(event.payload.parentToolUseId
              ? { parentToolUseId: event.payload.parentToolUseId }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    default:
      break;
  }

  return [];
}

const make = Effect.gen(function* () {
  const threadBackgroundLiveness = yield* ThreadBackgroundLivenessService;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const serverSettingsService = yield* ServerSettingsService;
  const liveAssistantDeltaBuffers = new Map<string, LiveAssistantDeltaBuffer>();
  const subagentProviderThreadIdsByThread = new Map<string, Set<string>>();
  const subagentMessageTextByKey = new Map<string, string>();
  let nextLiveAssistantDeltaBufferGeneration = 1;
  let enqueueRuntimeInput: ((input: RuntimeIngestionInput) => Effect.Effect<void>) | null = null;

  const turnMessageIdsByTurnKey = yield* Cache.make<string, Set<MessageId>>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () => Effect.succeed(new Set<MessageId>()),
  });

  const bufferedAssistantTextByMessageId = yield* Cache.make<MessageId, string>({
    capacity: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL,
    lookup: () => Effect.succeed(""),
  });

  const assistantSegmentStateByTurnKey = yield* Cache.make<string, AssistantSegmentState>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () =>
      Effect.die(
        new Error("assistant segment state should be read through getOption before initialization"),
      ),
  });

  const bufferedProposedPlanById = yield* Cache.make<string, { text: string; createdAt: string }>({
    capacity: BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_PROPOSED_PLAN_BY_ID_TTL,
    lookup: () => Effect.succeed({ text: "", createdAt: "" }),
  });

  const taskDescriptionByTaskKey = yield* Cache.make<string, string>({
    capacity: TASK_DESCRIPTION_BY_TASK_CACHE_CAPACITY,
    timeToLive: TASK_DESCRIPTION_BY_TASK_TTL,
    lookup: () => Effect.succeed(""),
  });

  const rememberTaskDescription = (threadId: ThreadId, taskId: string, description: string) =>
    Cache.set(taskDescriptionByTaskKey, providerTaskKey(threadId, taskId), description);

  // Entries are left in place after completion so replayed or duplicate
  // terminal events stay titled; TTL, capacity, and the session-exit sweep
  // bound the cache.
  const lookupTaskDescription = (threadId: ThreadId, taskId: string) =>
    Cache.getOption(taskDescriptionByTaskKey, providerTaskKey(threadId, taskId)).pipe(
      Effect.map((description) =>
        Option.filter(description, (value) => value.length > 0).pipe(Option.getOrUndefined),
      ),
    );

  const resolveThreadDetail = Effect.fn("resolveThreadDetail")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThreadShell = Effect.fn("resolveThreadShell")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadShellById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const rememberAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Cache.set(
          turnMessageIdsByTurnKey,
          providerTurnKey(threadId, turnId),
          Option.match(existingIds, {
            onNone: () => new Set([messageId]),
            onSome: (ids) => {
              const nextIds = new Set(ids);
              nextIds.add(messageId);
              return nextIds;
            },
          }),
        ),
      ),
    );

  const forgetAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Option.match(existingIds, {
          onNone: () => Effect.void,
          onSome: (ids) => {
            const nextIds = new Set(ids);
            nextIds.delete(messageId);
            if (nextIds.size === 0) {
              return Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));
            }
            return Cache.set(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId), nextIds);
          },
        }),
      ),
    );

  const getAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.map((existingIds) =>
        Option.getOrElse(existingIds, (): Set<MessageId> => new Set<MessageId>()),
      ),
    );

  const clearAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));

  const getAssistantSegmentStateForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.getOption(assistantSegmentStateByTurnKey, providerTurnKey(threadId, turnId));

  const setAssistantSegmentStateForTurn = (
    threadId: ThreadId,
    turnId: TurnId,
    state: AssistantSegmentState,
  ) => Cache.set(assistantSegmentStateByTurnKey, providerTurnKey(threadId, turnId), state);

  const clearAssistantSegmentStateForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.invalidate(assistantSegmentStateByTurnKey, providerTurnKey(threadId, turnId));

  const getActiveAssistantMessageIdForTurn = (threadId: ThreadId, turnId: TurnId) =>
    getAssistantSegmentStateForTurn(threadId, turnId).pipe(
      Effect.map((state) =>
        Option.flatMap(state, (entry) =>
          entry.activeMessageId ? Option.some(entry.activeMessageId) : Option.none(),
        ),
      ),
    );

  const startAssistantSegmentForTurn = (input: {
    threadId: ThreadId;
    turnId: TurnId;
    baseKey: string;
  }) =>
    getAssistantSegmentStateForTurn(input.threadId, input.turnId).pipe(
      Effect.flatMap((existingState) =>
        Effect.gen(function* () {
          const nextState = Option.match(existingState, {
            onNone: () => ({
              baseKey: input.baseKey,
              nextSegmentIndex: 1,
              activeMessageId: assistantSegmentMessageId(input.baseKey, 0),
            }),
            onSome: (state) => {
              const segmentIndex = state.baseKey === input.baseKey ? state.nextSegmentIndex : 0;
              const messageId = assistantSegmentMessageId(input.baseKey, segmentIndex);
              return {
                baseKey: input.baseKey,
                nextSegmentIndex: state.baseKey === input.baseKey ? state.nextSegmentIndex + 1 : 1,
                activeMessageId: messageId,
              } satisfies AssistantSegmentState;
            },
          });
          yield* setAssistantSegmentStateForTurn(input.threadId, input.turnId, nextState);
          return nextState.activeMessageId!;
        }),
      ),
    );

  const getOrCreateAssistantMessageId = (input: {
    threadId: ThreadId;
    event: ProviderRuntimeEvent;
    turnId?: TurnId;
  }) =>
    Effect.gen(function* () {
      if (!input.turnId) {
        return assistantSegmentMessageId(assistantSegmentBaseKeyFromEvent(input.event), 0);
      }

      const activeMessageId = yield* getActiveAssistantMessageIdForTurn(
        input.threadId,
        input.turnId,
      );
      if (Option.isSome(activeMessageId)) {
        return activeMessageId.value;
      }

      return yield* startAssistantSegmentForTurn({
        threadId: input.threadId,
        turnId: input.turnId,
        baseKey: assistantSegmentBaseKeyFromEvent(input.event),
      });
    });

  const flushLiveAssistantDeltaBuffer = (input: {
    key: string;
    commandTag: string;
    generation?: number;
  }) =>
    Effect.gen(function* () {
      const buffer = liveAssistantDeltaBuffers.get(input.key);
      if (!buffer || (input.generation !== undefined && buffer.generation !== input.generation)) {
        return false;
      }

      if (buffer.text.length === 0) {
        liveAssistantDeltaBuffers.delete(input.key);
        return false;
      }

      yield* orchestrationEngine
        .dispatch({
          type: "thread.message.assistant.delta",
          commandId: providerCommandId(buffer.event, input.commandTag, String(buffer.messageId)),
          threadId: buffer.threadId,
          messageId: buffer.messageId,
          delta: buffer.text,
          ...(buffer.turnId ? { turnId: buffer.turnId } : {}),
          createdAt: buffer.createdAt,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              const current = liveAssistantDeltaBuffers.get(input.key);
              if (!current || current.generation === buffer.generation) {
                liveAssistantDeltaBuffers.set(input.key, buffer);
              }
            }).pipe(Effect.andThen(Effect.failCause(cause))),
          ),
        );
      if (liveAssistantDeltaBuffers.get(input.key) === buffer) {
        liveAssistantDeltaBuffers.delete(input.key);
      }
      return true;
    });

  const flushLiveAssistantDeltaBuffers = (input: { commandTag: string; exceptKey?: string }) =>
    Effect.forEach(
      Array.from(liveAssistantDeltaBuffers.keys()).filter((key) => key !== input.exceptKey),
      (key) => flushLiveAssistantDeltaBuffer({ key, commandTag: input.commandTag }),
      { concurrency: 1 },
    ).pipe(Effect.asVoid);

  const flushLiveAssistantDeltaBuffersSafely = (input: {
    commandTag: string;
    exceptKey?: string;
  }) =>
    flushLiveAssistantDeltaBuffers(input).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider runtime ingestion failed to flush live assistant deltas", {
          commandTag: input.commandTag,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const clearLiveAssistantDeltaBuffersForThread = (threadId: ThreadId) =>
    Effect.sync(() => {
      for (const [key, buffer] of liveAssistantDeltaBuffers) {
        if (buffer.threadId === threadId) {
          liveAssistantDeltaBuffers.delete(key);
        }
      }
    });

  const scheduleLiveAssistantDeltaFlush = (key: string, generation: number) =>
    Effect.gen(function* () {
      const enqueue = enqueueRuntimeInput;
      if (!enqueue) {
        return;
      }
      yield* Effect.forkScoped(
        Effect.sleep(LIVE_ASSISTANT_DELTA_FLUSH_INTERVAL).pipe(
          Effect.andThen(
            enqueue({
              source: "liveAssistantFlush",
              key,
              generation,
            }),
          ),
        ),
      );
    }).pipe(Effect.asVoid);

  const appendLiveAssistantDelta = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    delta: string;
    createdAt: string;
  }) =>
    Effect.gen(function* () {
      const key = liveAssistantDeltaBufferKey(input.threadId, input.messageId);
      yield* flushLiveAssistantDeltaBuffersSafely({
        commandTag: "assistant-delta-flush-before-interleaved-assistant-delta",
        exceptKey: key,
      });

      const existingBuffer = liveAssistantDeltaBuffers.get(key);
      if (existingBuffer) {
        liveAssistantDeltaBuffers.set(key, {
          ...existingBuffer,
          event: input.event,
          text: `${existingBuffer.text}${input.delta}`,
        });
      } else {
        const generation = nextLiveAssistantDeltaBufferGeneration;
        nextLiveAssistantDeltaBufferGeneration += 1;
        liveAssistantDeltaBuffers.set(key, {
          event: input.event,
          threadId: input.threadId,
          messageId: input.messageId,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          text: input.delta,
          createdAt: input.createdAt,
          generation,
        });
        yield* scheduleLiveAssistantDeltaFlush(key, generation);
      }

      const buffer = liveAssistantDeltaBuffers.get(key);
      if (buffer && buffer.text.length >= LIVE_ASSISTANT_DELTA_FLUSH_THRESHOLD_CHARS) {
        yield* flushLiveAssistantDeltaBuffer({
          key,
          commandTag: "assistant-delta-coalesced-threshold",
        });
      }
    });

  const rememberSubagentProviderThreadIds = (threadId: ThreadId, event: ProviderRuntimeEvent) =>
    Effect.sync(() => {
      const receiverThreadIds = collabReceiverThreadIdsFromRuntimeEvent(event);
      if (receiverThreadIds.length === 0) {
        return;
      }
      const key = String(threadId);
      const existing = subagentProviderThreadIdsByThread.get(key) ?? new Set<string>();
      for (const receiverThreadId of receiverThreadIds) {
        existing.add(receiverThreadId);
      }
      subagentProviderThreadIdsByThread.set(key, existing);
    });

  const isKnownSubagentProviderThread = (
    threadId: ThreadId,
    providerThreadId: string | undefined,
  ) => {
    if (!providerThreadId) {
      return false;
    }
    return subagentProviderThreadIdsByThread.get(String(threadId))?.has(providerThreadId) ?? false;
  };

  const upsertSubagentMessageActivity = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    subagentId?: string | undefined;
    providerThreadId: string;
    providerItemId: string;
    text: string;
    streaming: boolean;
    createdAt: string;
  }) =>
    Effect.gen(function* () {
      const sessionSequence = (input.event as ProviderRuntimeEvent & { sessionSequence?: number })
        .sessionSequence;
      const commandKey = `${input.providerThreadId}:${input.providerItemId}`;
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: providerCommandId(input.event, "subagent-message-upsert", commandKey),
        threadId: input.threadId,
        activity: {
          id: subagentMessageActivityId({
            threadId: input.threadId,
            providerThreadId: input.providerThreadId,
            providerItemId: input.providerItemId,
          }),
          createdAt: input.createdAt,
          tone: "info",
          kind: "agent.message",
          summary: input.streaming ? "Agent message streaming" : "Agent message",
          payload: {
            itemType: "assistant_message",
            text: truncateActivityText(input.text),
            streaming: input.streaming,
            providerThreadId: input.providerThreadId,
            providerItemId: input.providerItemId,
            ...(input.subagentId ? { subagentId: input.subagentId } : {}),
            ...(input.event.providerRefs ? { providerRefs: input.event.providerRefs } : {}),
          },
          turnId: toTurnId(input.event.turnId) ?? null,
          ...(sessionSequence !== undefined ? { sequence: sessionSequence } : {}),
        },
        createdAt: input.createdAt,
      });
    });

  const appendSubagentMessageDelta = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    subagentId?: string | undefined;
    providerThreadId: string;
    providerItemId: string;
    delta: string;
    createdAt: string;
  }) =>
    Effect.gen(function* () {
      const key = subagentMessageBufferKey({
        threadId: input.threadId,
        providerThreadId: input.providerThreadId,
        providerItemId: input.providerItemId,
      });
      const text = cappedSubagentMessageText(
        `${subagentMessageTextByKey.get(key) ?? ""}${input.delta}`,
      );
      subagentMessageTextByKey.set(key, text);
      yield* upsertSubagentMessageActivity({
        ...input,
        text,
        streaming: true,
      });
    });

  const completeSubagentMessage = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    subagentId?: string | undefined;
    providerThreadId: string;
    providerItemId: string;
    fallbackText?: string | undefined;
    createdAt: string;
  }) =>
    Effect.gen(function* () {
      const key = subagentMessageBufferKey({
        threadId: input.threadId,
        providerThreadId: input.providerThreadId,
        providerItemId: input.providerItemId,
      });
      const bufferedText = subagentMessageTextByKey.get(key) ?? "";
      subagentMessageTextByKey.delete(key);
      const fallbackText = input.fallbackText ?? "";
      const text =
        hasRenderableAssistantText(fallbackText) && fallbackText.length >= bufferedText.length
          ? fallbackText
          : bufferedText;
      if (!hasRenderableAssistantText(text)) {
        return;
      }
      yield* upsertSubagentMessageActivity({
        ...input,
        text,
        streaming: false,
      });
    });

  const bufferedSubagentProviderItemIds = (input: {
    threadId: ThreadId;
    providerThreadId: string;
  }): ReadonlyArray<string> => {
    const prefix = subagentMessageBufferKey({
      threadId: input.threadId,
      providerThreadId: input.providerThreadId,
      providerItemId: "",
    });
    const providerItemIds = new Set<string>();
    for (const key of subagentMessageTextByKey.keys()) {
      if (key.startsWith(prefix)) {
        providerItemIds.add(key.slice(prefix.length));
      }
    }
    return [...providerItemIds];
  };

  const clearSubagentMessageBuffersForThread = (threadId: ThreadId) =>
    Effect.sync(() => {
      const prefix = `${threadId}:`;
      for (const key of subagentMessageTextByKey.keys()) {
        if (key.startsWith(prefix)) {
          subagentMessageTextByKey.delete(key);
        }
      }
    });

  const appendBufferedAssistantText = (messageId: MessageId, delta: string) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existingText) =>
        Effect.gen(function* () {
          const nextText = Option.match(existingText, {
            onNone: () => delta,
            onSome: (text) => `${text}${delta}`,
          });
          if (nextText.length <= MAX_BUFFERED_ASSISTANT_CHARS) {
            yield* Cache.set(bufferedAssistantTextByMessageId, messageId, nextText);
            return "";
          }

          // Safety valve: flush full buffered text as an assistant delta to cap memory.
          yield* Cache.invalidate(bufferedAssistantTextByMessageId, messageId);
          return nextText;
        }),
      ),
    );

  const takeBufferedAssistantText = (messageId: MessageId) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existingText) =>
        Cache.invalidate(bufferedAssistantTextByMessageId, messageId).pipe(
          Effect.as(Option.getOrElse(existingText, () => "")),
        ),
      ),
    );

  const clearBufferedAssistantText = (messageId: MessageId) =>
    Cache.invalidate(bufferedAssistantTextByMessageId, messageId);

  const appendBufferedProposedPlan = (planId: string, delta: string, createdAt: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) => {
        const existing = Option.getOrUndefined(existingEntry);
        return Cache.set(bufferedProposedPlanById, planId, {
          text: `${existing?.text ?? ""}${delta}`,
          createdAt:
            existing?.createdAt && existing.createdAt.length > 0 ? existing.createdAt : createdAt,
        });
      }),
    );

  const takeBufferedProposedPlan = (planId: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) =>
        Cache.invalidate(bufferedProposedPlanById, planId).pipe(
          Effect.as(Option.getOrUndefined(existingEntry)),
        ),
      ),
    );

  const clearBufferedProposedPlan = (planId: string) =>
    Cache.invalidate(bufferedProposedPlanById, planId);

  const clearAssistantMessageState = (messageId: MessageId) =>
    clearBufferedAssistantText(messageId);

  const flushBufferedAssistantMessage = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
  }) =>
    Effect.gen(function* () {
      const bufferedText = yield* takeBufferedAssistantText(input.messageId);
      if (!hasRenderableAssistantText(bufferedText)) {
        return false;
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: providerCommandId(input.event, input.commandTag, String(input.messageId)),
        threadId: input.threadId,
        messageId: input.messageId,
        delta: bufferedText,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt: input.createdAt,
      });
      return true;
    });

  const flushBufferedAssistantMessagesForTurn = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    turnId: TurnId;
    createdAt: string;
    commandTag: string;
  }) =>
    Effect.gen(function* () {
      const assistantMessageIds = yield* getAssistantMessageIdsForTurn(
        input.threadId,
        input.turnId,
      );
      const flushedMessageIds = new Set<MessageId>();
      yield* Effect.forEach(
        assistantMessageIds,
        (messageId) =>
          flushBufferedAssistantMessage({
            event: input.event,
            threadId: input.threadId,
            messageId,
            turnId: input.turnId,
            createdAt: input.createdAt,
            commandTag: input.commandTag,
          }).pipe(
            Effect.tap((flushed) =>
              flushed ? Effect.sync(() => flushedMessageIds.add(messageId)) : Effect.void,
            ),
          ),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      return flushedMessageIds;
    });

  const finalizeAssistantMessage = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
    fallbackText?: string;
    hasProjectedMessage?: boolean;
  }) =>
    Effect.gen(function* () {
      const bufferedText = yield* takeBufferedAssistantText(input.messageId);
      const text =
        bufferedText.length > 0
          ? bufferedText
          : (input.fallbackText?.trim().length ?? 0) > 0
            ? input.fallbackText!
            : "";
      const hasRenderableText = hasRenderableAssistantText(text);

      if (hasRenderableText) {
        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: providerCommandId(
            input.event,
            input.finalDeltaCommandTag,
            String(input.messageId),
          ),
          threadId: input.threadId,
          messageId: input.messageId,
          delta: text,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: input.createdAt,
        });
      }

      if (input.hasProjectedMessage || hasRenderableText) {
        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: providerCommandId(input.event, input.commandTag, String(input.messageId)),
          threadId: input.threadId,
          messageId: input.messageId,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: input.createdAt,
        });
      }
      yield* clearAssistantMessageState(input.messageId);
    });

  const finalizeActiveAssistantSegmentForTurn = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    turnId: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
    hasProjectedMessage: boolean;
    flushedMessageIds?: ReadonlySet<MessageId>;
  }) =>
    Effect.gen(function* () {
      const activeMessageId = yield* getActiveAssistantMessageIdForTurn(
        input.threadId,
        input.turnId,
      );
      if (Option.isNone(activeMessageId)) {
        return;
      }

      yield* finalizeAssistantMessage({
        event: input.event,
        threadId: input.threadId,
        messageId: activeMessageId.value,
        turnId: input.turnId,
        createdAt: input.createdAt,
        commandTag: input.commandTag,
        finalDeltaCommandTag: input.finalDeltaCommandTag,
        hasProjectedMessage:
          input.hasProjectedMessage ||
          (input.flushedMessageIds?.has(activeMessageId.value) ?? false),
      });
      yield* forgetAssistantMessageId(input.threadId, input.turnId, activeMessageId.value);

      const state = yield* getAssistantSegmentStateForTurn(input.threadId, input.turnId);
      if (Option.isSome(state)) {
        yield* setAssistantSegmentStateForTurn(input.threadId, input.turnId, {
          ...state.value,
          activeMessageId: null,
        });
      }
    });

  const upsertProposedPlan = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    threadProposedPlans: ReadonlyArray<{
      id: string;
      createdAt: string;
      implementedAt: string | null;
      implementationThreadId: ThreadId | null;
    }>;
    planId: string;
    turnId?: TurnId;
    planMarkdown: string | undefined;
    createdAt: string;
    updatedAt: string;
  }) =>
    Effect.gen(function* () {
      const planMarkdown = normalizeProposedPlanMarkdown(input.planMarkdown);
      if (!planMarkdown) {
        return;
      }

      const existingPlan = findProposedPlanById(input.threadProposedPlans, input.planId);
      yield* orchestrationEngine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: providerCommandId(input.event, "proposed-plan-upsert", input.planId),
        threadId: input.threadId,
        proposedPlan: {
          id: input.planId,
          turnId: input.turnId ?? null,
          planMarkdown,
          implementedAt: existingPlan?.implementedAt ?? null,
          implementationThreadId: existingPlan?.implementationThreadId ?? null,
          createdAt: existingPlan?.createdAt ?? input.createdAt,
          updatedAt: input.updatedAt,
        },
        createdAt: input.updatedAt,
      });
    });

  const finalizeBufferedProposedPlan = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    threadProposedPlans: ReadonlyArray<{
      id: string;
      createdAt: string;
      implementedAt: string | null;
      implementationThreadId: ThreadId | null;
    }>;
    planId: string;
    turnId?: TurnId;
    fallbackMarkdown?: string;
    updatedAt: string;
  }) =>
    Effect.gen(function* () {
      const bufferedPlan = yield* takeBufferedProposedPlan(input.planId);
      const bufferedMarkdown = normalizeProposedPlanMarkdown(bufferedPlan?.text);
      const fallbackMarkdown = normalizeProposedPlanMarkdown(input.fallbackMarkdown);
      const planMarkdown = bufferedMarkdown ?? fallbackMarkdown;
      if (!planMarkdown) {
        return;
      }

      yield* upsertProposedPlan({
        event: input.event,
        threadId: input.threadId,
        threadProposedPlans: input.threadProposedPlans,
        planId: input.planId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        planMarkdown,
        createdAt:
          bufferedPlan?.createdAt && bufferedPlan.createdAt.length > 0
            ? bufferedPlan.createdAt
            : input.updatedAt,
        updatedAt: input.updatedAt,
      });
      yield* clearBufferedProposedPlan(input.planId);
    });

  const clearTurnStateForSession = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const prefix = `${threadId}:`;
      const proposedPlanPrefix = `plan:${threadId}:`;
      const turnKeys = Array.from(yield* Cache.keys(turnMessageIdsByTurnKey));
      const assistantSegmentKeys = Array.from(yield* Cache.keys(assistantSegmentStateByTurnKey));
      const proposedPlanKeys = Array.from(yield* Cache.keys(bufferedProposedPlanById));
      yield* Effect.forEach(
        turnKeys,
        (key) =>
          Effect.gen(function* () {
            if (!key.startsWith(prefix)) {
              return;
            }

            const messageIds = yield* Cache.getOption(turnMessageIdsByTurnKey, key);
            if (Option.isSome(messageIds)) {
              yield* Effect.forEach(messageIds.value, clearAssistantMessageState, {
                concurrency: 1,
              }).pipe(Effect.asVoid);
            }

            yield* Cache.invalidate(turnMessageIdsByTurnKey, key);
          }),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        assistantSegmentKeys,
        (key) =>
          key.startsWith(prefix)
            ? Cache.invalidate(assistantSegmentStateByTurnKey, key)
            : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        proposedPlanKeys,
        (key) =>
          key.startsWith(proposedPlanPrefix)
            ? Cache.invalidate(bufferedProposedPlanById, key)
            : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      const taskDescriptionKeys = Array.from(yield* Cache.keys(taskDescriptionByTaskKey));
      yield* Effect.forEach(
        taskDescriptionKeys,
        (key) =>
          key.startsWith(prefix) ? Cache.invalidate(taskDescriptionByTaskKey, key) : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* clearLiveAssistantDeltaBuffersForThread(threadId);
    });

  const getSourceProposedPlanReferenceForPendingTurnStart = Effect.fn(
    "getSourceProposedPlanReferenceForPendingTurnStart",
  )(function* (threadId: ThreadId) {
    const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
      threadId,
    });
    if (Option.isNone(pendingTurnStart)) {
      return null;
    }

    const sourceThreadId = pendingTurnStart.value.sourceProposedPlanThreadId;
    const sourcePlanId = pendingTurnStart.value.sourceProposedPlanId;
    if (sourceThreadId === null || sourcePlanId === null) {
      return null;
    }

    return {
      sourceThreadId,
      sourcePlanId,
    } as const;
  });

  const getExpectedProviderTurnIdForThread = Effect.fn("getExpectedProviderTurnIdForThread")(
    function* (threadId: ThreadId) {
      const sessions = yield* providerService.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      return session?.activeTurnId;
    },
  );

  const getSourceProposedPlanReferenceForAcceptedTurnStart = Effect.fn(
    "getSourceProposedPlanReferenceForAcceptedTurnStart",
  )(function* (threadId: ThreadId, eventTurnId: TurnId | undefined) {
    if (eventTurnId === undefined) {
      return null;
    }

    const expectedTurnId = yield* getExpectedProviderTurnIdForThread(threadId);
    if (!sameId(expectedTurnId, eventTurnId)) {
      return null;
    }

    return yield* getSourceProposedPlanReferenceForPendingTurnStart(threadId);
  });

  const markSourceProposedPlanImplemented = Effect.fn("markSourceProposedPlanImplemented")(
    function* (
      event: ProviderRuntimeEvent,
      sourceThreadId: ThreadId,
      sourcePlanId: OrchestrationProposedPlanId,
      implementationThreadId: ThreadId,
      implementedAt: string,
    ) {
      const sourceThread = yield* resolveThreadDetail(sourceThreadId);
      const sourcePlan = sourceThread?.proposedPlans.find((entry) => entry.id === sourcePlanId);
      if (!sourceThread || !sourcePlan || sourcePlan.implementedAt !== null) {
        return;
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: providerCommandId(
          event,
          "source-proposed-plan-implemented",
          `${sourceThreadId}:${sourcePlanId}:${implementationThreadId}`,
        ),
        threadId: sourceThread.id,
        proposedPlan: {
          ...sourcePlan,
          implementedAt,
          implementationThreadId,
          updatedAt: implementedAt,
        },
        createdAt: implementedAt,
      });
    },
  );

  const processRuntimeEvent = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      if (
        event.turnId &&
        ((event.type === "content.delta" && event.payload.streamKind === "assistant_text") ||
          ((event.type === "item.started" ||
            event.type === "item.completed" ||
            event.type === "item.updated") &&
            event.payload.itemType === "assistant_message")) &&
        Option.isSome(
          yield* Cache.getOption(
            restoredTurns,
            `${event.threadId}:${event.runtimeSessionId}:${event.turnId}`,
          ),
        )
      )
        return;
      const thread = yield* resolveThreadShell(event.threadId);
      if (!thread) return;

      const activeSession = thread.session;
      const instanceMatches =
        activeSession?.providerInstanceId === undefined
          ? event.providerInstanceId === undefined
          : event.providerInstanceId === activeSession.providerInstanceId;
      const runtimeMatches =
        activeSession?.runtimeSessionId === undefined
          ? event.runtimeSessionId === undefined
          : event.runtimeSessionId === activeSession.runtimeSessionId;
      if (!activeSession || !instanceMatches || !runtimeMatches) {
        const reason = !activeSession
          ? "missing-active-session"
          : !instanceMatches
            ? "provider-instance-mismatch"
            : "runtime-session-mismatch";
        yield* increment(providerRuntimeStaleEventsTotal, {
          provider: event.provider,
          eventType: event.type,
          reason,
        });
        yield* Effect.logDebug("provider.runtime-event.stale-dropped", {
          provider: event.provider,
          eventType: event.type,
          reason,
        });
        return;
      }

      let loadedThreadDetail: OrchestrationThread | null | undefined;
      const getLoadedThreadDetail = () =>
        Effect.gen(function* () {
          if (loadedThreadDetail !== undefined) {
            return loadedThreadDetail;
          }
          loadedThreadDetail = (yield* resolveThreadDetail(thread.id)) ?? null;
          return loadedThreadDetail;
        });

      const now = event.createdAt;
      const eventTurnId = toTurnId(event.turnId);
      const activeTurnId = thread.session?.activeTurnId ?? null;

      if (event.type === "thread.goal.updated" || event.type === "thread.goal.cleared") {
        // The mutation response confirms pending requests. Uncorrelated notifications
        // must not acknowledge or undo them, even when ingestion trails the RPC reply.
        if (thread.goal?.synchronization && thread.goal.synchronization.state !== "unsupported")
          return;
        let goal = event.type === "thread.goal.updated" ? event.payload.goal : null;
        const structuralChange =
          goal === null ||
          thread.goal == null ||
          goal.objective !== thread.goal.objective ||
          goal.status !== thread.goal.status ||
          goal.tokenBudget !== thread.goal.tokenBudget;
        if (structuralChange && providerService.getThreadGoal) {
          const current = yield* providerService.getThreadGoal(thread.id);
          if (current !== false) goal = current;
          const latest = yield* resolveThreadShell(thread.id);
          if (
            latest?.session?.runtimeSessionId !== activeSession.runtimeSessionId ||
            latest?.session?.providerInstanceId !== activeSession.providerInstanceId
          )
            return;
        }
        if (goal !== null) {
          yield* orchestrationEngine.dispatch({
            type: "thread.goal.sync",
            commandId: providerCommandId(event, "thread-goal-sync"),
            threadId: thread.id,
            goal,
            createdAt: now,
          });
        } else if (thread.goal != null) {
          yield* orchestrationEngine.dispatch({
            type: "thread.goal.provider-clear",
            commandId: providerCommandId(event, "thread-goal-provider-clear"),
            threadId: thread.id,
            createdAt: now,
          });
        }
      }

      // A recovered provider can become ready after the process that owned the
      // projected turn disappeared. In that case no turn.aborted notification
      // can ever arrive, so the provider's own idle session state is the
      // authoritative recovery signal. Do not apply this to incidental ready
      // notifications (for example sandbox setup) while the provider still
      // reports an active turn.
      const providerActiveTurnId =
        event.type === "session.state.changed" &&
        event.payload.state === "ready" &&
        activeTurnId !== null
          ? yield* getExpectedProviderTurnIdForThread(thread.id)
          : undefined;
      const reconciledInterruptedTurnId =
        activeTurnId !== null &&
        (event.type === "session.exited" ||
          (event.type === "session.state.changed" &&
            (event.payload.state === "stopped" ||
              (event.payload.state === "ready" && providerActiveTurnId === undefined))))
          ? activeTurnId
          : undefined;

      const conflictsWithActiveTurn =
        activeTurnId !== null && eventTurnId !== undefined && !sameId(activeTurnId, eventTurnId);
      const missingTurnForActiveTurn = activeTurnId !== null && eventTurnId === undefined;
      const existingEventTurn =
        event.type === "turn.started" && eventTurnId !== undefined
          ? yield* projectionTurnRepository.getByTurnId({
              threadId: thread.id,
              turnId: eventTurnId,
            })
          : Option.none();
      const eventTurnAlreadyTerminal =
        Option.isSome(existingEventTurn) &&
        isTerminalProjectionTurnState(existingEventTurn.value.state);
      const eventTurnAlreadyProjectedWithoutActiveSession =
        activeTurnId === null && Option.isSome(existingEventTurn);

      if (!isAssistantTextDeltaEvent(event)) {
        yield* flushLiveAssistantDeltaBuffersSafely({
          commandTag: "assistant-delta-flush-before-runtime-event",
        });
      }

      yield* rememberSubagentProviderThreadIds(thread.id, event);
      const eventProviderThreadId = rawPayloadThreadId(event);
      const isSubagentProviderThread = isKnownSubagentProviderThread(
        thread.id,
        eventProviderThreadId,
      );

      const shouldApplyThreadLifecycle = (() => {
        if (!STRICT_PROVIDER_LIFECYCLE_GUARD) {
          return true;
        }
        switch (event.type) {
          case "session.exited":
            return true;
          case "session.started":
          case "thread.started":
            return true;
          case "turn.started":
            return (
              !conflictsWithActiveTurn &&
              !eventTurnAlreadyTerminal &&
              !eventTurnAlreadyProjectedWithoutActiveSession
            );
          case "turn.completed":
          case "turn.aborted":
            if (conflictsWithActiveTurn || missingTurnForActiveTurn) {
              return false;
            }
            // Only the active turn may close the lifecycle state.
            if (activeTurnId !== null && eventTurnId !== undefined) {
              return sameId(activeTurnId, eventTurnId);
            }
            // Without an active turn, only a named completion proves that a
            // real turn existed. Claude's resume handshake is untargeted and
            // must not settle a pending turn that never started.
            return eventTurnId !== undefined;
          default:
            return true;
        }
      })();
      const acceptedTurnStartedSourcePlan =
        event.type === "turn.started" && shouldApplyThreadLifecycle
          ? yield* getSourceProposedPlanReferenceForAcceptedTurnStart(thread.id, eventTurnId)
          : null;

      if (
        event.type === "session.started" ||
        event.type === "session.state.changed" ||
        event.type === "session.exited" ||
        event.type === "thread.started" ||
        event.type === "turn.started" ||
        event.type === "turn.completed" ||
        event.type === "turn.aborted"
      ) {
        const nextActiveTurnId =
          event.type === "turn.started"
            ? (eventTurnId ?? null)
            : event.type === "turn.completed" ||
                event.type === "turn.aborted" ||
                event.type === "session.exited" ||
                reconciledInterruptedTurnId !== undefined
              ? null
              : activeTurnId;
        const status = (() => {
          switch (event.type) {
            case "session.state.changed":
              return event.payload.state === "ready" && nextActiveTurnId !== null
                ? "running"
                : orchestrationSessionStatusFromRuntimeState(event.payload.state);
            case "turn.started":
              return "running";
            case "session.exited":
              return "stopped";
            case "turn.completed":
              return normalizeRuntimeTurnState(event.payload.state) === "failed"
                ? "error"
                : "ready";
            case "turn.aborted":
              return "ready";
            case "session.started":
            case "thread.started":
              // Provider thread/session start notifications can arrive during an
              // active turn; preserve turn-running state in that case.
              return activeTurnId !== null ? "running" : "ready";
          }
        })();
        const lastError =
          event.type === "session.state.changed" && event.payload.state === "error"
            ? (event.payload.reason ?? thread.session?.lastError ?? "Provider session error")
            : event.type === "turn.completed" &&
                normalizeRuntimeTurnState(event.payload.state) === "failed"
              ? (event.payload.errorMessage ?? thread.session?.lastError ?? "Turn failed")
              : status === "ready"
                ? null
                : (thread.session?.lastError ?? null);

        if (shouldApplyThreadLifecycle) {
          if (event.type === "turn.started" && acceptedTurnStartedSourcePlan !== null) {
            yield* markSourceProposedPlanImplemented(
              event,
              acceptedTurnStartedSourcePlan.sourceThreadId,
              acceptedTurnStartedSourcePlan.sourcePlanId,
              thread.id,
              now,
            ).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  "provider runtime ingestion failed to mark source proposed plan",
                  {
                    eventId: event.eventId,
                    eventType: event.type,
                    cause: Cause.pretty(cause),
                  },
                ),
              ),
            );
          }

          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: providerCommandId(event, "thread-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status,
              providerName: event.provider,
              ...(event.providerInstanceId !== undefined
                ? { providerInstanceId: event.providerInstanceId }
                : {}),
              ...(event.runtimeSessionId !== undefined
                ? { runtimeSessionId: event.runtimeSessionId }
                : {}),
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              tokenMode: thread.session?.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
              activeTurnId: nextActiveTurnId,
              lastError,
              updatedAt: now,
            },
            createdAt: now,
          });

          const interruptedTurnId =
            event.type === "turn.aborted" ? eventTurnId : reconciledInterruptedTurnId;
          if (interruptedTurnId !== undefined) {
            yield* orchestrationEngine.dispatch({
              type: "thread.turn.interrupt",
              commandId: providerCommandId(
                event,
                "thread-turn-interrupt",
                String(interruptedTurnId),
              ),
              threadId: thread.id,
              turnId: interruptedTurnId,
              createdAt: now,
            });
          }
        }
      }

      const assistantDelta = isAssistantTextDeltaEvent(event) ? event.payload.delta : undefined;
      const subagentDelta =
        event.type === "subagent.message.delta" ? event.payload.delta : undefined;
      const proposedPlanDelta =
        event.type === "turn.proposed.delta" ? event.payload.delta : undefined;

      if (event.type === "subagent.message.delta" && subagentDelta && subagentDelta.length > 0) {
        const subagentPayload = event.payload;
        yield* appendSubagentMessageDelta({
          event,
          threadId: thread.id,
          subagentId: String(subagentPayload.subagentId),
          providerThreadId: subagentPayload.providerThreadId ?? String(subagentPayload.subagentId),
          providerItemId: subagentPayload.providerMessageId ?? String(subagentPayload.subagentId),
          delta: subagentDelta,
          createdAt: now,
        });
      } else if (
        assistantDelta &&
        assistantDelta.length > 0 &&
        isSubagentProviderThread &&
        eventProviderThreadId
      ) {
        yield* appendSubagentMessageDelta({
          event,
          threadId: thread.id,
          providerThreadId: eventProviderThreadId,
          providerItemId: String(event.itemId ?? event.eventId),
          delta: assistantDelta,
          createdAt: now,
        });
      } else if (assistantDelta && assistantDelta.length > 0) {
        const turnId = toTurnId(event.turnId);
        const assistantMessageId = yield* getOrCreateAssistantMessageId({
          threadId: thread.id,
          event,
          ...(turnId ? { turnId } : {}),
        });
        if (turnId) {
          yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
        }

        const assistantDeliveryMode: AssistantDeliveryMode = yield* Effect.map(
          serverSettingsService.getSettings,
          (settings) => (settings.enableLegacyTokenStreaming ? "streaming" : "buffered"),
        );
        if (assistantDeliveryMode === "buffered") {
          const spillChunk = yield* appendBufferedAssistantText(assistantMessageId, assistantDelta);
          if (spillChunk.length > 0) {
            yield* orchestrationEngine.dispatch({
              type: "thread.message.assistant.delta",
              commandId: providerCommandId(
                event,
                "assistant-delta-buffer-spill",
                String(assistantMessageId),
              ),
              threadId: thread.id,
              messageId: assistantMessageId,
              delta: spillChunk,
              ...(turnId ? { turnId } : {}),
              createdAt: now,
            });
          }
        } else {
          yield* appendLiveAssistantDelta({
            event,
            threadId: thread.id,
            messageId: assistantMessageId,
            delta: assistantDelta,
            ...(turnId ? { turnId } : {}),
            createdAt: now,
          });
        }
      }

      const pauseForUserTurnId =
        event.type === "request.opened" || event.type === "user-input.requested"
          ? toTurnId(event.turnId)
          : undefined;
      if (pauseForUserTurnId) {
        const detailedThread = yield* getLoadedThreadDetail();
        const assistantDeliveryMode: AssistantDeliveryMode = yield* Effect.map(
          serverSettingsService.getSettings,
          (settings) => (settings.enableLegacyTokenStreaming ? "streaming" : "buffered"),
        );
        const flushedMessageIds =
          assistantDeliveryMode === "buffered"
            ? yield* flushBufferedAssistantMessagesForTurn({
                event,
                threadId: thread.id,
                turnId: pauseForUserTurnId,
                createdAt: now,
                commandTag:
                  event.type === "request.opened"
                    ? "assistant-delta-flush-on-request-opened"
                    : "assistant-delta-flush-on-user-input-requested",
              })
            : new Set<MessageId>();
        yield* finalizeActiveAssistantSegmentForTurn({
          event,
          threadId: thread.id,
          turnId: pauseForUserTurnId,
          createdAt: now,
          commandTag:
            event.type === "request.opened"
              ? "assistant-complete-on-request-opened"
              : "assistant-complete-on-user-input-requested",
          finalDeltaCommandTag:
            event.type === "request.opened"
              ? "assistant-delta-finalize-on-request-opened"
              : "assistant-delta-finalize-on-user-input-requested",
          hasProjectedMessage:
            detailedThread !== null &&
            hasAssistantMessageForTurn(detailedThread.messages, pauseForUserTurnId, {
              streamingOnly: true,
            }),
          flushedMessageIds,
        });
      }

      if (proposedPlanDelta && proposedPlanDelta.length > 0) {
        const planId = proposedPlanIdFromEvent(event, thread.id);
        yield* appendBufferedProposedPlan(planId, proposedPlanDelta, now);
      }

      const assistantCompletion =
        event.type === "item.completed" &&
        event.payload.itemType === "assistant_message" &&
        !isSubagentProviderThread
          ? {
              messageId: MessageId.make(
                `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
              ),
              fallbackText: event.payload.detail,
            }
          : undefined;
      const subagentMessageCompletion =
        event.type === "item.completed" &&
        event.payload.itemType === "assistant_message" &&
        isSubagentProviderThread &&
        eventProviderThreadId
          ? {
              providerThreadId: eventProviderThreadId,
              providerItemId: String(event.itemId ?? event.eventId),
              fallbackText: event.payload.detail,
            }
          : undefined;
      const proposedPlanCompletion =
        event.type === "turn.proposed.completed"
          ? {
              planId: proposedPlanIdFromEvent(event, thread.id),
              turnId: toTurnId(event.turnId),
              planMarkdown: event.payload.planMarkdown,
            }
          : undefined;

      if (assistantCompletion) {
        const detailedThread = yield* getLoadedThreadDetail();
        const messages = detailedThread?.messages ?? [];
        const turnId = toTurnId(event.turnId);
        const activeAssistantMessageId = turnId
          ? yield* getActiveAssistantMessageIdForTurn(thread.id, turnId)
          : Option.none<MessageId>();
        const hasAssistantMessagesForTurn =
          turnId !== undefined ? hasAssistantMessageForTurn(messages, turnId) : false;
        const assistantMessageId = Option.getOrElse(
          activeAssistantMessageId,
          () => assistantCompletion.messageId,
        );
        const existingAssistantMessage = findMessageById(messages, assistantMessageId);
        const shouldApplyFallbackCompletionText =
          !existingAssistantMessage || existingAssistantMessage.text.length === 0;

        const shouldSkipRedundantCompletion =
          Option.isNone(activeAssistantMessageId) &&
          turnId !== undefined &&
          hasAssistantMessagesForTurn &&
          (assistantCompletion.fallbackText?.trim().length ?? 0) === 0;

        if (!shouldSkipRedundantCompletion) {
          if (turnId && Option.isNone(activeAssistantMessageId)) {
            yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
          }

          yield* finalizeAssistantMessage({
            event,
            threadId: thread.id,
            messageId: assistantMessageId,
            ...(turnId ? { turnId } : {}),
            createdAt: now,
            commandTag: "assistant-complete",
            finalDeltaCommandTag: "assistant-delta-finalize",
            hasProjectedMessage: existingAssistantMessage !== undefined,
            ...(assistantCompletion.fallbackText !== undefined && shouldApplyFallbackCompletionText
              ? { fallbackText: assistantCompletion.fallbackText }
              : {}),
          });

          if (turnId) {
            yield* forgetAssistantMessageId(thread.id, turnId, assistantMessageId);
          }
        }

        if (turnId) {
          yield* clearAssistantSegmentStateForTurn(thread.id, turnId);
        }
      }

      if (subagentMessageCompletion) {
        yield* completeSubagentMessage({
          event,
          threadId: thread.id,
          providerThreadId: subagentMessageCompletion.providerThreadId,
          providerItemId: subagentMessageCompletion.providerItemId,
          ...(subagentMessageCompletion.fallbackText !== undefined
            ? { fallbackText: subagentMessageCompletion.fallbackText }
            : {}),
          createdAt: now,
        });
      }

      if (event.type === "subagent.completed") {
        const subagentId = String(event.payload.subagent.subagentId);
        const providerThreadId = event.payload.subagent.providerThreadId ?? subagentId;
        const providerItemIds = bufferedSubagentProviderItemIds({
          threadId: thread.id,
          providerThreadId,
        });
        yield* Effect.forEach(
          providerItemIds.length > 0 ? providerItemIds : [subagentId],
          (providerItemId) =>
            completeSubagentMessage({
              event,
              threadId: thread.id,
              subagentId,
              providerThreadId,
              providerItemId,
              ...(event.payload.summary !== undefined
                ? { fallbackText: event.payload.summary }
                : {}),
              createdAt: now,
            }),
          { concurrency: 1, discard: true },
        );
      }

      if (proposedPlanCompletion) {
        const detailedThread = yield* getLoadedThreadDetail();
        yield* finalizeBufferedProposedPlan({
          event,
          threadId: thread.id,
          threadProposedPlans: detailedThread?.proposedPlans ?? [],
          planId: proposedPlanCompletion.planId,
          ...(proposedPlanCompletion.turnId ? { turnId: proposedPlanCompletion.turnId } : {}),
          fallbackMarkdown: proposedPlanCompletion.planMarkdown,
          updatedAt: now,
        });
      }

      if (
        event.type === "turn.completed" ||
        event.type === "turn.aborted" ||
        reconciledInterruptedTurnId !== undefined
      ) {
        const detailedThread = yield* getLoadedThreadDetail();
        const messages = detailedThread?.messages ?? [];
        const proposedPlans = detailedThread?.proposedPlans ?? [];
        const turnId = toTurnId(event.turnId) ?? reconciledInterruptedTurnId;
        if (turnId) {
          const assistantMessageIds = yield* getAssistantMessageIdsForTurn(thread.id, turnId);
          yield* Effect.forEach(
            assistantMessageIds,
            (assistantMessageId) =>
              finalizeAssistantMessage({
                event,
                threadId: thread.id,
                messageId: assistantMessageId,
                turnId,
                createdAt: now,
                commandTag: "assistant-complete-finalize",
                finalDeltaCommandTag: "assistant-delta-finalize-fallback",
                hasProjectedMessage: findMessageById(messages, assistantMessageId) !== undefined,
              }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          yield* clearAssistantMessageIdsForTurn(thread.id, turnId);
          yield* clearAssistantSegmentStateForTurn(thread.id, turnId);

          yield* finalizeBufferedProposedPlan({
            event,
            threadId: thread.id,
            threadProposedPlans: proposedPlans,
            planId: proposedPlanIdForTurn(thread.id, turnId),
            turnId,
            updatedAt: now,
          });
        }
        yield* clearSubagentMessageBuffersForThread(thread.id);
      }

      if (
        (event.type === "turn.started" && shouldApplyThreadLifecycle) ||
        event.type === "turn.completed" ||
        event.type === "turn.aborted" ||
        event.type === "session.exited"
      ) {
        const detailedThread = yield* getLoadedThreadDetail();
        const finishedTurnId = toTurnId(event.turnId);
        for (const request of derivePendingThreadRequests(detailedThread?.activities ?? [])) {
          // New turns supersede requests owned by previous turns. Requests for
          // the new turn (or with unknown ownership) remain actionable.
          if (event.type === "turn.started") {
            if (
              finishedTurnId === undefined ||
              request.turnId === null ||
              request.turnId === finishedTurnId
            )
              continue;
          } else if (
            event.type !== "session.exited" &&
            (finishedTurnId === undefined || request.turnId !== finishedTurnId)
          )
            continue;
          yield* orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId: providerCommandId(
              event,
              `request-resolved:${request.kind}:${request.requestId}`,
            ),
            threadId: thread.id,
            activity: {
              id: EventId.make(
                `${event.eventId}:request-resolved:${request.kind}:${request.requestId}`,
              ),
              kind: `${request.kind}.resolved`,
              tone: "info",
              summary: "Pending request cleared because its provider turn ended or was superseded",
              payload: { requestId: request.requestId },
              turnId: request.turnId === null ? null : TurnId.make(request.turnId),
              createdAt: now,
            },
            createdAt: now,
          });
        }
      }

      if (event.type === "session.exited") {
        yield* clearTurnStateForSession(thread.id);
        yield* clearSubagentMessageBuffersForThread(thread.id);
      }

      if (event.type === "runtime.error") {
        const runtimeErrorMessage = event.payload.message;

        const shouldApplyRuntimeError = !STRICT_PROVIDER_LIFECYCLE_GUARD
          ? true
          : activeTurnId === null || eventTurnId === undefined || sameId(activeTurnId, eventTurnId);

        if (shouldApplyRuntimeError) {
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: providerCommandId(event, "runtime-error-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: "error",
              providerName: event.provider,
              ...(event.providerInstanceId !== undefined
                ? { providerInstanceId: event.providerInstanceId }
                : {}),
              ...(event.runtimeSessionId !== undefined
                ? { runtimeSessionId: event.runtimeSessionId }
                : {}),
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              tokenMode: thread.session?.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
              activeTurnId: eventTurnId ?? null,
              lastError: runtimeErrorMessage,
              updatedAt: now,
            },
            createdAt: now,
          });
        }
        yield* clearSubagentMessageBuffersForThread(thread.id);
      }

      if (event.type === "session.state.changed" && event.payload.state === "error") {
        yield* clearSubagentMessageBuffersForThread(thread.id);
      }

      if (event.type === "thread.metadata.updated" && event.payload.name) {
        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: providerCommandId(event, "thread-meta-update"),
          threadId: thread.id,
          title: event.payload.name,
        });
      }

      if (event.type === "turn.diff.updated") {
        const turnId = toTurnId(event.turnId);
        const checkpointContext = turnId
          ? yield* projectionSnapshotQuery
              .getThreadCheckpointContext(thread.id)
              .pipe(Effect.map(Option.getOrUndefined))
          : undefined;
        const workspaceCwd =
          checkpointContext?.worktreePath ?? checkpointContext?.workspaceRoot ?? undefined;
        if (turnId && checkpointContext && workspaceCwd && isGitRepository(workspaceCwd)) {
          // Skip if a checkpoint already exists for this turn. A real
          // (non-placeholder) capture from CheckpointReactor should not
          // be clobbered, and dispatching a duplicate placeholder for the
          // same turnId would produce an unstable checkpointTurnCount.
          if (hasCheckpointForTurn(checkpointContext.checkpoints, turnId)) {
            // Already tracked; no-op.
          } else {
            const assistantMessageId = MessageId.make(
              `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
            );
            yield* orchestrationEngine.dispatch({
              type: "thread.turn.diff.complete",
              commandId: providerCommandId(event, "thread-turn-diff-complete", String(turnId)),
              threadId: thread.id,
              turnId,
              completedAt: now,
              checkpointRef: CheckpointRef.make(`provider-diff:${event.eventId}`),
              status: "missing",
              files: [],
              assistantMessageId,
              checkpointTurnCount: maxCheckpointTurnCount(checkpointContext.checkpoints) + 1,
              createdAt: now,
            });
          }
        }
      }

      if (
        event.type === "task.started" ||
        event.type === "task.progress" ||
        event.type === "task.updated"
      ) {
        const description = event.payload.description?.trim();
        if (description) {
          yield* rememberTaskDescription(thread.id, event.payload.taskId, description);
        }
      }
      // Sidebar background liveness: fed from the same lifecycle stream,
      // read by the shell query at mapping time (no persistence).
      switch (event.type) {
        case "task.started":
        case "task.progress":
        case "task.updated":
        case "task.completed": {
          const payload = event.payload as {
            taskId: string;
            taskType?: string;
            status?: string;
            agentId?: string;
          };
          threadBackgroundLiveness.recordTaskLiveness({
            threadId: thread.id,
            taskId: payload.taskId,
            taskType: payload.taskType,
            status: payload.status,
            agentId: payload.agentId,
            kind:
              event.type === "task.started"
                ? "started"
                : event.type === "task.progress"
                  ? "progress"
                  : event.type === "task.updated"
                    ? "updated"
                    : "completed",
          });
          break;
        }
        case "session.exited":
          threadBackgroundLiveness.clearThreadLiveness(thread.id);
          break;
        default:
          break;
      }

      let taskTitle: string | undefined;
      if (event.type === "task.completed") {
        taskTitle = yield* lookupTaskDescription(thread.id, event.payload.taskId);
        if (!taskTitle) {
          const detailedThread = yield* getLoadedThreadDetail();
          taskTitle = findTaskTitleInActivities(detailedThread?.activities, event.payload.taskId);
        }
      }

      const activities = runtimeEventToActivities(event, taskTitle);
      yield* Effect.forEach(activities, (activity) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: providerCommandId(event, "thread-activity-append", String(activity.id)),
          threadId: thread.id,
          activity,
          createdAt: activity.createdAt,
        }),
      ).pipe(Effect.asVoid);
    });

  const processDomainEvent = (_event: TurnStartRequestedDomainEvent) => Effect.void;

  const restoredTurns = yield* Cache.make<string, true>({
    capacity: 10_000,
    timeToLive: "120 minutes",
    lookup: () => Effect.succeed(true as const),
  });

  const processHistory = (input: Extract<RuntimeIngestionInput, { source: "history" }>) =>
    Effect.gen(function* () {
      const thread = yield* resolveThreadDetail(input.threadId);
      if (
        !thread ||
        thread.updatedAt !== input.expectedUpdatedAt ||
        !input.binding.runtimeSessionId ||
        !input.binding.providerInstanceId ||
        thread.session?.runtimeSessionId !== input.binding.runtimeSessionId ||
        thread.session.providerInstanceId !== input.binding.providerInstanceId
      )
        return;
      const now = new Date(Math.max(Date.now(), Date.parse(thread.updatedAt) + 1)).toISOString();
      // User messages are persisted before the provider assigns a turn ID.
      // The turn projection owns that association; message.turnId stays null.
      const userMessageIdsByTurn = new Map<TurnId, MessageId>();
      if (input.history.messages.some((message) => message.role === "user")) {
        const turns = yield* projectionTurnRepository.listByThreadId({ threadId: thread.id });
        for (const turn of turns) {
          if (turn.turnId !== null && turn.pendingMessageId !== null) {
            userMessageIdsByTurn.set(turn.turnId, turn.pendingMessageId);
          }
        }
      }
      const messages = historyMessagesToRestore(thread, input.history, now, userMessageIdsByTurn);
      const activities = missingHistoryActivities(
        thread.activities,
        input.history.items.flatMap((event) => runtimeEventToActivities(event)),
      );
      for (const request of derivePendingThreadRequests(thread.activities)) {
        if (
          request.turnId === null ||
          !input.history.completedTurnIds.includes(TurnId.make(request.turnId))
        )
          continue;
        activities.push({
          id: EventId.make(`history:${thread.id}:resolved:${request.kind}:${request.requestId}`),
          kind: `${request.kind}.resolved`,
          tone: "info",
          summary: "Pending request cleared because its provider turn ended",
          payload: { requestId: request.requestId },
          turnId: TurnId.make(request.turnId),
          createdAt: now,
        });
      }
      const settlesTurn =
        thread.session.activeTurnId !== null &&
        input.history.completedTurnIds.includes(thread.session.activeTurnId);
      if (messages.length > 0 || activities.length > 0 || settlesTurn)
        yield* orchestrationEngine.dispatch({
          type: "thread.history.restore",
          commandId: CommandId.make(`history:${crypto.randomUUID()}`),
          threadId: thread.id,
          providerInstanceId: input.binding.providerInstanceId,
          runtimeSessionId: input.binding.runtimeSessionId,
          expectedUpdatedAt: thread.updatedAt,
          messages,
          activities,
          completedTurnIds: input.history.completedTurnIds,
          failedTurnIds: input.history.failedTurnIds,
          createdAt: now,
        });
      // This worker also owns live buffers. Retire only confirmed completed
      // turns after the durable repair, so delayed flushes cannot duplicate it.
      for (const turnId of input.history.completedTurnIds) {
        yield* Cache.set(
          restoredTurns,
          `${thread.id}:${input.binding.runtimeSessionId}:${turnId}`,
          true,
        );
        const ids = yield* getAssistantMessageIdsForTurn(thread.id, turnId);
        yield* Effect.forEach(ids, clearAssistantMessageState, { discard: true });
        yield* clearAssistantMessageIdsForTurn(thread.id, turnId);
        yield* clearAssistantSegmentStateForTurn(thread.id, turnId);
        for (const [key, buffer] of liveAssistantDeltaBuffers) {
          if (buffer.threadId === thread.id && buffer.turnId === turnId)
            liveAssistantDeltaBuffers.delete(key);
        }
      }
    }).pipe(Effect.ensuring(Deferred.succeed(input.done, undefined)));

  const processInput = (input: RuntimeIngestionInput) =>
    input.source === "history"
      ? processHistory(input)
      : input.source === "runtime"
        ? processRuntimeEvent(input.event)
        : input.source === "domain"
          ? processDomainEvent(input.event)
          : flushLiveAssistantDeltaBuffer({
              key: input.key,
              generation: input.generation,
              commandTag: "assistant-delta-coalesced-interval",
            }).pipe(Effect.asVoid);

  const processInputSafely = (input: RuntimeIngestionInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider runtime ingestion failed to process event", {
          source: input.source,
          ...(input.source === "history"
            ? { threadId: input.threadId }
            : input.source === "liveAssistantFlush"
              ? { flushKey: input.key, flushGeneration: input.generation }
              : { eventId: input.event.eventId, eventType: input.event.type }),
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker({
    policy: losslessBackpressureQueuePolicy({
      component: "ProviderRuntimeIngestion",
      capacity: 2_048,
    }),
    process: processInputSafely,
  });
  enqueueRuntimeInput = worker.enqueue;

  const historyAdmission = yield* Semaphore.make(2);
  const historyReads = new Set<ThreadId>();
  const historyLastRead = yield* Cache.make<ThreadId, number>({
    capacity: 1_000,
    timeToLive: "30 seconds",
    lookup: () => Effect.succeed(0),
  });
  const reconcileThread = (threadId: ThreadId) =>
    Effect.suspend(() => {
      if (!providerService.readThreadHistory || historyReads.has(threadId)) return Effect.void;
      historyReads.add(threadId);
      return Effect.gen(function* () {
        if (Option.isSome(yield* Cache.getOption(historyLastRead, threadId))) return;
        yield* historyAdmission
          .withPermit(
            Effect.gen(function* () {
              const thread = yield* resolveThreadShell(threadId);
              if (!thread?.session) return;
              const snapshot = yield* providerService.readThreadHistory!(threadId);
              if (Option.isNone(snapshot)) return;
              const done = yield* Deferred.make<void>();
              yield* worker.enqueue({
                source: "history",
                threadId,
                expectedUpdatedAt: thread.updatedAt,
                ...snapshot.value,
                done,
              });
              yield* Deferred.await(done);
            }),
          )
          .pipe(
            Effect.timeoutOption("25 seconds"),
            Effect.asVoid,
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logWarning("Provider history recovery failed; preserving local thread", {
                    threadId,
                  }),
            ),
            Effect.ensuring(Cache.set(historyLastRead, threadId, Date.now())),
          );
      }).pipe(Effect.ensuring(Effect.sync(() => historyReads.delete(threadId))));
    });

  const start: ProviderRuntimeIngestionShape["start"] = () =>
    Effect.gen(function* () {
      yield* Effect.forkScoped(
        Stream.runForEach(providerService.streamEvents, (event) =>
          worker.enqueue({ source: "runtime", event }),
        ),
      );
      yield* Effect.forkScoped(
        Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
          if (event.type !== "thread.turn-start-requested") {
            return Effect.void;
          }
          return worker.enqueue({ source: "domain", event });
        }),
      );
    });

  return {
    reconcileThread,
    start,
    // Drain pending runtime work, flush any remaining live assistant text,
    // then drain again for scheduled flush inputs that landed during shutdown.
    drain: worker.drain.pipe(
      Effect.andThen(
        flushLiveAssistantDeltaBuffersSafely({
          commandTag: "assistant-delta-flush-on-drain",
        }),
      ),
      Effect.andThen(worker.drain),
    ),
  } satisfies ProviderRuntimeIngestionShape;
});

export const ProviderRuntimeIngestionLive = Layer.effect(
  ProviderRuntimeIngestionService,
  make,
).pipe(Layer.provide(ProjectionTurnRepositoryLive));
