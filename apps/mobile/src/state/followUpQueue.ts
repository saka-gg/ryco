import { scopeThreadRef, scopedThreadKey } from "@ryco/client-runtime/scoped";
import {
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  composeOutgoingPrompt,
} from "@ryco/client-runtime/state/composer";
import {
  addFollowUpToServerQueue,
  buildFollowUpQueueAddCommand,
  createFollowUpQueuePendingStore,
  selectServerFollowUpQueueSupported,
  selectThreadFollowUpQueue,
  type FollowUpQueueAddOutcome,
  type FollowUpQueueCommand,
  type FollowUpQueueEntryContent,
  type QueueHold,
} from "@ryco/client-runtime/state/message-queue";
import { useStore } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, MessageId, ScopedThreadRef } from "@ryco/contracts";
import { DEFAULT_AGENT_TOKEN_MODE } from "@ryco/contracts/orchestration";

import { ensureEnvironmentApi } from "../connection/environmentApi";
import { newCommandId } from "../lib/ids";
import { mobileKV } from "../platform/kv";
import { readEnvironmentServerConfig } from "./environmentServerConfigs";
import { buildQueuedThreadMessageAttachments } from "./queuedThreadMessageAttachments";
import { enqueueThreadOutboxMessage } from "./threadOutbox";
import {
  queuedThreadMessageFollowUpFailure,
  summarizeQueuedThreadMessage,
  type QueuedThreadMessage,
} from "./threadOutboxModel";

// The node's follow-up queue (`capabilities.serverFollowUpQueue`, design §3.6–§3.7) on mobile.
// The policy, commands and view model are client-runtime's (`state/message-queue/serverQueue`),
// shared with web; this module binds them to the app's connection, storage and outbox messages.

/** `thread.queue.add`s this device sent, shown as "Queuing…" until their entries arrive. */
export const useFollowUpQueuePendingStore = createFollowUpQueuePendingStore();

/** The number of this device's adds for the thread that the thread does not show yet. */
export function countPendingFollowUpAdds(threadKey: string): number {
  return useFollowUpQueuePendingStore.getState().pendingByThreadKey[threadKey]?.length ?? 0;
}

/**
 * Whether the node behind `environmentId` keeps follow-up queues itself, from its own last known
 * config. False while unknown: the outbox serves until the node says otherwise.
 */
export function readServerFollowUpQueueSupported(environmentId: EnvironmentId): boolean {
  return selectServerFollowUpQueueSupported(readEnvironmentServerConfig(environmentId));
}

/** Dispatches a `thread.queue.*` command; rejects with the node's answer. */
export async function dispatchFollowUpQueueCommand(
  environmentId: EnvironmentId,
  command: FollowUpQueueCommand,
): Promise<void> {
  await ensureEnvironmentApi(environmentId).orchestration.dispatchCommand(command);
}

/**
 * What an outbox message sends as a queued follow-up: composed and attached exactly as the
 * outbox's own turn start sends it.
 */
export async function buildQueuedThreadMessageFollowUpContent(
  message: QueuedThreadMessage,
): Promise<FollowUpQueueEntryContent> {
  if (!message.modelSelection || !message.runtimeMode || !message.interactionMode) {
    throw new Error("Queued message is missing composer settings.");
  }
  return {
    text: composeOutgoingPrompt({ prompt: message.text }) || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
    attachments: await buildQueuedThreadMessageAttachments(message),
    modelSelection: message.modelSelection,
    runtimeMode: message.runtimeMode,
    interactionMode: message.interactionMode,
    tokenMode: message.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
  };
}

/**
 * Moves one outbox message to the node's queue under its own message id: a message queued
 * while offline, or one queued before the node kept queues. The thread's hold on this device
 * rides along, and a held message moves as failed, so it waits for Retry there too.
 */
export async function moveQueuedThreadMessageToServer(
  message: QueuedThreadMessage,
  context: { readonly hold: QueueHold | null },
): Promise<void> {
  const content = await buildQueuedThreadMessageFollowUpContent(message);
  await dispatchFollowUpQueueCommand(
    message.environmentId,
    buildFollowUpQueueAddCommand({
      commandId: newCommandId(),
      threadId: message.threadId,
      messageId: message.messageId,
      content,
      hold: context.hold,
      failure: queuedThreadMessageFollowUpFailure(message),
      createdAt: message.createdAt,
    }),
  );
}

/** Whether the thread already has the message: queued on the node, or sent. */
function followUpVisible(ref: ScopedThreadRef, messageId: MessageId): boolean {
  const state = useStore.getState();
  if (
    selectThreadFollowUpQueue(state, ref)?.entries.some((entry) => entry.messageId === messageId)
  ) {
    return true;
  }
  const messages = state.environmentStateById[ref.environmentId]?.messageByThreadId[ref.threadId];
  return messages !== undefined && Object.hasOwn(messages, messageId);
}

/**
 * Queues a message sent while the thread is busy on the node (`thread.queue.add`), shown as
 * "Queuing…" until its entry arrives. A definite refusal comes back, so the caller can leave the
 * message in the composer. When the reply was lost, the node may have queued it: the message
 * goes to the outbox under the same id, whose move re-adds it, and the node's no-op on a known
 * id keeps one copy.
 */
export async function queueThreadMessageOnServer(
  message: QueuedThreadMessage,
): Promise<FollowUpQueueAddOutcome> {
  const ref = scopeThreadRef(message.environmentId, message.threadId);
  let content: FollowUpQueueEntryContent;
  try {
    content = await buildQueuedThreadMessageFollowUpContent(message);
  } catch (error) {
    // Nothing was sent: a file to attach again, or settings that are missing.
    return { kind: "refused", error };
  }
  const outcome = await addFollowUpToServerQueue({
    pendingStore: useFollowUpQueuePendingStore,
    threadKey: scopedThreadKey(ref),
    command: buildFollowUpQueueAddCommand({
      commandId: newCommandId(),
      threadId: message.threadId,
      messageId: message.messageId,
      content,
      createdAt: message.createdAt,
    }),
    summary: summarizeQueuedThreadMessage(message),
    dispatch: (command) => dispatchFollowUpQueueCommand(message.environmentId, command),
    isVisible: () => followUpVisible(ref, message.messageId),
    subscribe: (listener) => useStore.subscribe(listener),
  });
  if (outcome.kind === "unknown") enqueueThreadOutboxMessage(message);
  return outcome;
}

const MOVED_QUEUES_STORAGE_KEY = "ryco.threadOutboxMovedToNode.v1";

/**
 * Records on this device that every outbox message for the node moved to its queue. Only
 * informational: the outbox stays the offline intake, and what is left in it drives the move.
 */
export function recordServerQueueMigrated(environmentId: EnvironmentId): void {
  void (async () => {
    const raw = await mobileKV.getItem(MOVED_QUEUES_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    const record: Record<string, string> =
      parsed && typeof parsed === "object" ? { ...(parsed as Record<string, string>) } : {};
    if (record[environmentId] !== undefined) return;
    record[environmentId] = new Date().toISOString();
    await mobileKV.setItem(MOVED_QUEUES_STORAGE_KEY, JSON.stringify(record));
  })().catch(() => {
    // Storage unavailable: the record is informational, and a later move is idempotent.
  });
}
