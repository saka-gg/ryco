import {
  moveQueuedMessage as move,
  removeQueuedMessage as remove,
  summarizeQueuedMessage as summarize,
  type QueuedMessage as RuntimeQueuedMessage,
} from "@ryco/client-runtime/state/message-queue";

import type { SendTurnComposerSnapshot, SendTurnSettings } from "./hooks/executeChatSendTurn";

// ---------------------------------------------------------------------------
// Message queue (client-owned)
//
// While a provider turn is running the composer queues follow-up messages
// instead of sending them; each queued item captures the full composer + settings
// snapshot so it can be replayed verbatim once the turn reaches quiescence. The
// array operations below are pure so the reorder/remove rules stay unit-testable.
// ---------------------------------------------------------------------------

export type QueuedMessage = RuntimeQueuedMessage<SendTurnComposerSnapshot, SendTurnSettings>;

/** Remove the queued message with the given id (no-op if absent). */
export function removeQueuedMessage(queue: readonly QueuedMessage[], id: string): QueuedMessage[] {
  return remove(queue, id);
}

/** Move a queued message up or down one slot; clamped at the ends. */
export function moveQueuedMessage(
  queue: readonly QueuedMessage[],
  id: string,
  direction: "up" | "down",
): QueuedMessage[] {
  return move(queue, id, direction);
}

/** Short, single-line label for a queued message chip. */
export function summarizeQueuedMessage(message: QueuedMessage): string {
  return summarize({
    trimmedPrompt: message.composer.trimmedPrompt,
    imageCount: message.composer.images.length,
    terminalContextCount: message.composer.sendableTerminalContexts.length,
    fileReferenceCount: message.composer.fileReferences?.length ?? 0,
  });
}
