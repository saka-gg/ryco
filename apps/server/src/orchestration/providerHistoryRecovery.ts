import {
  MessageId,
  type TurnId,
  type OrchestrationMessage,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@ryco/contracts";
import { formatAssistantDeliveryText, parseAssistantDelivery } from "../assistantAttachments.ts";
import type { ProviderThreadHistory } from "../provider/Services/ProviderAdapter.ts";
import { inheritedItemIdPrefix, inheritedTurnIds } from "./forkInheritance.ts";

interface RecoveredReply {
  readonly text: string;
  /** The provider text carried a `ryco-attachments` manifest that live completion consumes. */
  readonly delivery: boolean;
}

/**
 * Provider transcripts keep the raw delivery manifest that live completion strips, so recovered
 * text is normalized the same way and never shows the fence. Files are not re-delivered here:
 * restores carry no attachment list, so the projection keeps the message's existing attachments.
 */
function recoveredReply(role: "user" | "assistant", text: string): RecoveredReply {
  const delivery = role === "assistant" ? parseAssistantDelivery(text) : undefined;
  return delivery
    ? { text: formatAssistantDeliveryText(delivery.text, delivery.errors), delivery: true }
    : { text, delivery: false };
}

/** Whether a local message already shows the recovered reply, so restoring it changes nothing. */
function showsReply(
  local: Pick<OrchestrationMessage, "text" | "streaming">,
  reply: RecoveredReply,
): boolean {
  if (local.streaming) return false;
  if (local.text === reply.text) return true;
  // Live delivery appends per-file failure notices after the reply, which the transcript cannot
  // reproduce. Text that still contains a raw manifest (an earlier recovery) is repaired.
  return (
    reply.delivery &&
    (reply.text.trim() === "" || local.text.startsWith(`${reply.text}\n\n`)) &&
    parseAssistantDelivery(local.text) === undefined
  );
}

/**
 * Preserve local IDs/attachments and segmented messages when filling a provider gap.
 *
 * A native fork's provider history repeats the turns it inherited, which the fork already
 * shows as copies under its own ids. Inherited history is immutable: neither those turns nor
 * a message the fork holds an inherited copy of is ever restored.
 */
export function historyMessagesToRestore(
  thread: Pick<OrchestrationThread, "id" | "createdAt" | "messages">,
  history: ProviderThreadHistory,
  now: string,
  userMessageIdsByTurn: ReadonlyMap<TurnId, MessageId> = new Map(),
): OrchestrationMessage[] {
  const restored: OrchestrationMessage[] = [];
  const byId = new Map(thread.messages.map((message) => [message.id, message]));
  const inheritedTurns = inheritedTurnIds(thread.id, thread.messages);
  const inheritedPrefix = inheritedItemIdPrefix(thread.id);
  let precedingCreatedAt = Number.NEGATIVE_INFINITY;
  for (const [index, message] of history.messages.entries()) {
    if (
      inheritedTurns.has(message.turnId) ||
      byId.has(MessageId.make(`${inheritedPrefix}${message.id}`))
    ) {
      continue;
    }
    const recoveredId = MessageId.make(`history:${thread.id}:${message.id}`);
    const existing = byId.get(message.id) ?? byId.get(recoveredId);
    const existingUser =
      message.role === "user"
        ? thread.messages.find(
            (entry) =>
              entry.role === "user" &&
              (entry.turnId === message.turnId ||
                entry.id === userMessageIdsByTurn.get(message.turnId)),
          )
        : undefined;
    if (
      message.role === "user" &&
      message.id.startsWith("user:") &&
      !byId.has(message.id) &&
      !byId.has(recoveredId) &&
      existingUser
    ) {
      precedingCreatedAt = Math.max(precedingCreatedAt, Date.parse(existingUser.createdAt));
      continue;
    }
    const segments =
      message.role === "assistant"
        ? thread.messages
            .filter(
              (existing) =>
                existing.turnId === message.turnId &&
                (existing.id === message.id || existing.id.startsWith(`${message.id}:segment:`)),
            )
            .toSorted(
              (a, b) =>
                a.createdAt.localeCompare(b.createdAt) ||
                a.id.localeCompare(b.id, undefined, { numeric: true }),
            )
        : [];
    if (segments.length > 1) {
      precedingCreatedAt = Math.max(
        precedingCreatedAt,
        ...segments.map((segment) => Date.parse(segment.createdAt)),
      );
      const prefix = segments
        .slice(0, -1)
        .map((segment) => segment.text)
        .join("");
      // Do not duplicate earlier text across a pause-for-user segment boundary.
      if (!message.text.startsWith(prefix)) continue;
      for (const [segmentIndex, segment] of segments.entries()) {
        // Live completion finalizes (and strips a manifest from) each segment on its own.
        const reply =
          segmentIndex === segments.length - 1
            ? recoveredReply(message.role, message.text.slice(prefix.length))
            : { text: segment.text, delivery: false };
        if (!showsReply(segment, reply))
          restored.push({ ...segment, text: reply.text, streaming: false, updatedAt: now });
      }
      continue;
    }
    // Codex records turn timestamps with second precision. Preserve provider
    // item order and existing local anchors when multiple messages share it.
    const createdAt =
      existing?.createdAt ??
      new Date(
        Math.max(
          message.createdAt === "1970-01-01T00:00:00.000Z"
            ? Date.parse(thread.createdAt) + index
            : Date.parse(message.createdAt),
          precedingCreatedAt + 1,
        ),
      ).toISOString();
    precedingCreatedAt = Math.max(precedingCreatedAt, Date.parse(createdAt));
    const reply = recoveredReply(message.role, message.text);
    if (existing && showsReply(existing, reply)) continue;
    restored.push({
      ...message,
      text: reply.text,
      id: existing?.id ?? recoveredId,
      streaming: false,
      createdAt,
      updatedAt: now,
    });
  }
  return restored;
}

/** What history dedupe reads of an existing activity; a payload needs only `providerItemId`. */
export type HistoryActivityIdentity = Pick<
  OrchestrationThreadActivity,
  "id" | "turnId" | "kind" | "payload"
>;

/** Recovered activities the thread lacks. Like messages, inherited turns are never restored. */
export function missingHistoryActivities(
  thread: {
    readonly id: OrchestrationThread["id"];
    readonly messages: ReadonlyArray<Pick<OrchestrationMessage, "id" | "turnId">>;
    readonly activities: ReadonlyArray<HistoryActivityIdentity>;
  },
  recovered: readonly OrchestrationThreadActivity[],
): OrchestrationThreadActivity[] {
  const existing = thread.activities;
  const inheritedTurns = inheritedTurnIds(thread.id, [...thread.messages, ...existing]);
  const key = (activity: HistoryActivityIdentity) => {
    const payload = activity.payload as { providerItemId?: unknown } | null;
    return payload && typeof payload.providerItemId === "string"
      ? `${activity.turnId}:${activity.kind}:${payload.providerItemId}`
      : activity.id;
  };
  const known = new Set(existing.map(key));
  return recovered.filter((activity) => {
    if (activity.turnId !== null && inheritedTurns.has(activity.turnId)) return false;
    // Transcript items cannot restore process-local callbacks or settle a live
    // callback that happens to reuse the same provider request ID. Lifecycle
    // cleanup is generated separately from the authoritative pending projection.
    if (
      activity.kind.startsWith("user-input.") ||
      activity.kind.startsWith("approval.") ||
      activity.kind === "provider.user-input.respond.failed" ||
      activity.kind === "provider.approval.respond.failed"
    )
      return false;
    const id = key(activity);
    if (known.has(id)) return false;
    known.add(id);
    return true;
  });
}

/**
 * The ids and turns a recovered transcript can match in the thread: everything
 * `historyMessagesToRestore` and `missingHistoryActivities` look up, so a bounded read of just
 * these gives them the same answer as the whole thread.
 */
export function historyRepairLookups(input: {
  readonly threadId: OrchestrationThread["id"];
  readonly history: ProviderThreadHistory;
  readonly recovered: readonly OrchestrationThreadActivity[];
  readonly userMessageIdsByTurn: ReadonlyMap<TurnId, MessageId>;
}): {
  readonly turnIds: string[];
  readonly messageIds: string[];
  readonly activityIds: string[];
  readonly includeTurnlessActivities: boolean;
} {
  const inheritedPrefix = inheritedItemIdPrefix(input.threadId);
  const turnIds = new Set<string>();
  const messageIds = new Set<string>();
  for (const message of input.history.messages) {
    turnIds.add(message.turnId);
    messageIds.add(message.id);
    messageIds.add(`history:${input.threadId}:${message.id}`);
    messageIds.add(`${inheritedPrefix}${message.id}`);
    const pending = input.userMessageIdsByTurn.get(message.turnId);
    if (pending !== undefined) messageIds.add(pending);
  }
  const activityIds = new Set<string>();
  let includeTurnlessActivities = false;
  for (const activity of input.recovered) {
    activityIds.add(activity.id);
    if (activity.turnId === null) includeTurnlessActivities = true;
    else turnIds.add(activity.turnId);
  }
  return {
    turnIds: [...turnIds],
    messageIds: [...messageIds],
    activityIds: [...activityIds],
    includeTurnlessActivities,
  };
}
