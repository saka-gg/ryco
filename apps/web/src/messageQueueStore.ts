import {
  createMessageQueueStore,
  type QueuedMessage,
} from "@ryco/client-runtime/state/message-queue";

import type { SendTurnComposerSnapshot, SendTurnSettings } from "./hooks/executeChatSendTurn";

// ---------------------------------------------------------------------------
// Per-thread message queue store (in-memory, keyed by scoped thread key).
//
// Intentionally NOT persisted: queued items hold live `File`/blob references
// that can't survive a reload. It does survive thread switches within a session
// (module-level store), which is the required behavior.
// ---------------------------------------------------------------------------

export const useMessageQueueStore = createMessageQueueStore<
  SendTurnComposerSnapshot,
  SendTurnSettings
>();

export type WebQueuedMessage = QueuedMessage<SendTurnComposerSnapshot, SendTurnSettings>;
