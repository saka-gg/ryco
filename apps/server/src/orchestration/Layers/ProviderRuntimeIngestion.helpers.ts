/**
 * Runtime ingestion's constants, buffer state shapes and pure helpers: ids, keys, message and
 * plan lookups, and turn and session state mapping.
 */
import { isAssistantDeliveryFenceInfo } from "../../assistantAttachments.ts";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationMessage,
  ThreadId,
  TurnId,
  type OrchestrationCheckpointSummary,
  type OrchestrationProposedPlan,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
} from "@ryco/contracts";
import { Deferred, Duration } from "effect";
import type { ProviderRuntimeBinding } from "../../provider/Services/ProviderSessionDirectory.ts";
import type { ProviderThreadHistory } from "../../provider/Services/ProviderAdapter.ts";
import { ASSISTANT_TEXT_SCAN_START, type AssistantTextScan } from "@ryco/shared/assistantStreaming";
import {
  LATEST_STATE_ACTIVITY_GROUPS,
  type LatestStateActivityGroup,
} from "@ryco/shared/latestStateActivities";
import { modelSelectionSpeed } from "@ryco/shared/model";
import { readEnv } from "@ryco/shared/runtimeEnv";

/** Statistics price usage at the speed tier the thread's selection asked for. */
export function statisticsSpeedField(modelSelection: ModelSelection): {
  readonly statisticsSpeed?: "fast" | "ultrafast";
} {
  const speed = modelSelectionSpeed(modelSelection);
  return speed === undefined ? {} : { statisticsSpeed: speed };
}

export const providerTurnKey = (threadId: ThreadId, turnId: TurnId) => `${threadId}:${turnId}`;

export const providerTaskKey = (threadId: ThreadId, taskId: string) => `${threadId}:${taskId}`;

// Fallback when the in-memory description cache no longer has the task name
// (server restart, session-exit sweep, TTL/capacity eviction): earlier
// task.started/task.progress activities for the task are persisted with it.
export function findTaskTitleInActivities(
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

export const TASK_DESCRIPTION_BY_TASK_CACHE_CAPACITY = 10_000;

export const TASK_DESCRIPTION_BY_TASK_TTL = Duration.minutes(120);

export const providerCommandId = (
  event: ProviderRuntimeEvent,
  tag: string,
  discriminator?: string,
): CommandId =>
  CommandId.make(
    discriminator === undefined
      ? `provider:${event.eventId}:${tag}`
      : `provider:${event.eventId}:${tag}:${discriminator}`,
  );

export const liveAssistantDeltaBufferKey = (threadId: ThreadId, messageId: MessageId) =>
  `${threadId}:${messageId}`;

export interface AssistantSegmentState {
  baseKey: string;
  nextSegmentIndex: number;
  activeMessageId: MessageId | null;
}

export interface LiveAssistantDeltaBuffer {
  threadId: ThreadId;
  messageId: MessageId;
  turnId?: TurnId;
  event: ProviderRuntimeEvent;
  text: string;
  createdAt: string;
  generation: number;
}

/** Context of the latest delta of a held message, for a release no delta triggers. */
export interface HeldAssistantDeltaSource {
  readonly event: ProviderRuntimeEvent;
  readonly threadId: ThreadId;
  readonly turnId?: TurnId;
  readonly createdAt: string;
}

/** What paragraph and turn streaming hold back of one assistant message. */
export interface HeldAssistantText {
  /** Text not sent yet. */
  readonly text: string;
  /** The Markdown scan at the end of what was sent, which is where `text` starts. */
  readonly scan: AssistantTextScan;
  /** Server-clock time of the last release in paragraph mode, spills included. */
  readonly releasedAtMs?: number;
  /** A paced paragraph release is queued for this message. */
  readonly flushScheduled: boolean;
  readonly source?: HeldAssistantDeltaSource;
}

export const NOTHING_HELD: HeldAssistantText = {
  text: "",
  scan: ASSISTANT_TEXT_SCAN_START,
  flushScheduled: false,
};

// A delivery manifest is consumed when the reply completes, so it never streams.
export const PARAGRAPH_SPLIT_OPTIONS = { holdFence: isAssistantDeliveryFenceInfo };

export const TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY = 10_000;

export const TURN_MESSAGE_IDS_BY_TURN_TTL = Duration.minutes(120);

export const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY = 20_000;

export const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL = Duration.minutes(120);

export const BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY = 10_000;

export const BUFFERED_PROPOSED_PLAN_BY_ID_TTL = Duration.minutes(120);

export const MAX_BUFFERED_ASSISTANT_CHARS = 24_000;

// Paragraph streaming releases a message's finished blocks at most this often. Every
// release is a persisted event (and relay traffic), so a fast model costs one event per
// interval rather than one per paragraph; blocks that finish in between land together,
// with the next delta or a trailing release once the interval has passed.
export const MIN_ASSISTANT_RELEASE_INTERVAL_MS = 400;

export const LIVE_ASSISTANT_DELTA_FLUSH_INTERVAL = Duration.millis(32);

export const LIVE_ASSISTANT_DELTA_FLUSH_THRESHOLD_CHARS = 4_096;

// A subagent message and a task's progress are latest-state activities that
// providers rewrite on every tick. They are persisted at most once per
// interval; boundaries (completion, turn end, session exit) persist the rest.
// The groups are shared with live coalescing and event-log compaction.
export const SUBAGENT_MESSAGE_WRITE_INTERVAL_MS =
  LATEST_STATE_ACTIVITY_GROUPS["subagent-message"].writeIntervalMs;

export const TASK_PROGRESS_WRITE_INTERVAL_MS =
  LATEST_STATE_ACTIVITY_GROUPS["task-progress"].writeIntervalMs;

export const STRICT_PROVIDER_LIFECYCLE_GUARD =
  readEnv("RYCO_STRICT_PROVIDER_LIFECYCLE_GUARD") !== "0";

export const HISTORY_RECOVERY_TIMEOUT = Duration.seconds(25);

export const HISTORY_RECOVERY_TRACKED_THREADS = 1_000;

export type TurnStartRequestedDomainEvent = Extract<
  OrchestrationEvent,
  { type: "thread.turn-start-requested" }
>;

export type RuntimeIngestionInput =
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
    }
  | {
      source: "reasoningFlush";
      key: string;
      generation: number;
    }
  | {
      source: "coalescedActivityFlush";
      key: string;
      generation: number;
    }
  | {
      source: "assistantParagraphFlush";
      messageId: MessageId;
    };

export type ActivityAppendCommand = Extract<
  OrchestrationCommand,
  { type: "thread.activity.append" }
>;

/** Which latest-state activity stream a coalesced write belongs to. */
export type CoalescedActivityGroup = Extract<
  LatestStateActivityGroup,
  "subagent-message" | "task-progress"
>;

/**
 * Write state of one latest-state activity (one activity id). Offers newer than
 * the last write replace `pending` instead of being persisted one by one.
 */
export interface CoalescedActivityWrite {
  readonly group: CoalescedActivityGroup;
  readonly threadId: ThreadId;
  readonly intervalMs: number;
  readonly generation: number;
  /** Newest command not persisted yet; null while everything offered is persisted. */
  pending: ActivityAppendCommand | null;
  /** What the last persisted command said; a different value is persisted at once. */
  writtenChangeKey: string;
  writtenAtMs: number;
  flushScheduled: boolean;
}

export function toTurnId(value: TurnId | string | undefined): TurnId | undefined {
  return value === undefined ? undefined : TurnId.make(String(value));
}

export function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

export function hasAssistantMessageForTurn(
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

export function findMessageById(
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

export function findProposedPlanById(
  proposedPlans: ReadonlyArray<OrchestrationProposedPlan>,
  planId: string,
): OrchestrationProposedPlan | undefined {
  for (let index = 0; index < proposedPlans.length; index += 1) {
    const proposedPlan = proposedPlans[index];
    if (proposedPlan?.id === planId) {
      return proposedPlan;
    }
  }
  return undefined;
}

export function hasCheckpointForTurn(
  checkpoints: ReadonlyArray<Pick<OrchestrationCheckpointSummary, "turnId">>,
  turnId: TurnId,
): boolean {
  for (let index = 0; index < checkpoints.length; index += 1) {
    if (checkpoints[index]?.turnId === turnId) {
      return true;
    }
  }
  return false;
}

export function maxCheckpointTurnCount(
  checkpoints: ReadonlyArray<Pick<OrchestrationCheckpointSummary, "checkpointTurnCount">>,
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

/** The recorded limit message is bounded by the contract (1,000 characters). */
export function truncateUsageLimitMessage(value: string): string {
  return value.length > 1_000 ? `${value.slice(0, 997)}...` : value;
}

export function truncateActivityText(value: string, limit = 24_000): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function rawPayloadThreadId(event: ProviderRuntimeEvent): string | undefined {
  return asTrimmedString(asRecord(event.raw?.payload)?.threadId);
}

export function collabReceiverThreadIdsFromRuntimeEvent(
  event: ProviderRuntimeEvent,
): ReadonlyArray<string> {
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
  return event.payload.receiverThreadIds ?? [];
}

/**
 * What a task.progress activity says besides its usage numbers. A change here
 * is persisted at once; a tick that only moves usage waits for the write interval.
 * The usage-only activity has no such state, so it is always paced.
 */
export function taskProgressChangeKey(
  activity: Pick<OrchestrationThreadActivity, "payload">,
): string {
  const payload = asRecord(activity.payload);
  if (payload === null || payload.usageSnapshot === true) {
    return "usage";
  }
  return JSON.stringify([
    payload.title,
    payload.summary,
    payload.detail,
    payload.lastToolName,
    payload.status,
    payload.error,
  ]);
}

export function subagentMessageBufferKey(input: {
  threadId: ThreadId;
  providerThreadId: string;
  providerItemId: string;
}): string {
  return `${input.threadId}:${input.providerThreadId}:${input.providerItemId}`;
}

export function cappedSubagentMessageText(value: string): string {
  return truncateActivityText(value, MAX_BUFFERED_ASSISTANT_CHARS);
}

export function normalizeProposedPlanMarkdown(
  planMarkdown: string | undefined,
): string | undefined {
  const trimmed = planMarkdown?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

export function hasRenderableAssistantText(text: string | undefined): boolean {
  return (text?.trim().length ?? 0) > 0;
}

export function isAssistantTextDeltaEvent(
  event: ProviderRuntimeEvent,
): event is Extract<ProviderRuntimeEvent, { type: "content.delta" }> {
  return event.type === "content.delta" && event.payload.streamKind === "assistant_text";
}

export function proposedPlanIdForTurn(threadId: ThreadId, turnId: TurnId): string {
  return `plan:${threadId}:turn:${turnId}`;
}

export function proposedPlanIdFromEvent(event: ProviderRuntimeEvent, threadId: ThreadId): string {
  const turnId = toTurnId(event.turnId);
  if (turnId) {
    return proposedPlanIdForTurn(threadId, turnId);
  }
  if (event.itemId) {
    return `plan:${threadId}:item:${event.itemId}`;
  }
  return `plan:${threadId}:event:${event.eventId}`;
}

export function assistantSegmentBaseKeyFromEvent(event: ProviderRuntimeEvent): string {
  return String(event.itemId ?? event.turnId ?? event.eventId);
}

export function assistantSegmentMessageId(baseKey: string, segmentIndex: number): MessageId {
  return MessageId.make(
    segmentIndex === 0 ? `assistant:${baseKey}` : `assistant:${baseKey}:segment:${segmentIndex}`,
  );
}

export function normalizeRuntimeTurnState(
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

export function isTerminalProjectionTurnState(state: string): boolean {
  return state === "completed" || state === "error" || state === "interrupted";
}

export function orchestrationSessionStatusFromRuntimeState(
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
