import { scopedThreadKey } from "@ryco/client-runtime/scoped";
import { readQueueThreadView } from "@ryco/client-runtime/state/message-queue";
import { useStore } from "@ryco/client-runtime/state/threads";
import type { MessageId, ScopedThreadRef } from "@ryco/contracts";

import type { DraftComposerAttachment } from "../../lib/composerFiles";
import { newMessageId } from "../../lib/ids";
import {
  addOptimisticUserMessage,
  buildOptimisticUserMessage,
  markOptimisticUserMessageDispatched,
  type OptimisticUserMessage,
} from "../../state/optimisticUserMessages";
import {
  beginThreadOutboxForegroundDispatch,
  type ThreadOutboxForegroundDispatch,
} from "../../state/threadOutbox";

// The thread screen's optimistic send (web's `setOptimisticUserMessages` in
// executeChatSendTurn): the message shows in the timeline and the composer is
// free the moment the user sends; the dispatch (attachment encoding, the Claude
// resume review, `thread.turn.start`) runs behind it. The node's echo replaces
// the bubble; a failure takes it back out and hands the draft to `onFailed`.
// The send's readiness checks are the dispatch's own, unchanged.

export interface OptimisticDispatchInput {
  readonly threadRef: ScopedThreadRef;
  /** The send's message id and time; new ones by default (test seams). */
  readonly messageId?: MessageId;
  readonly createdAt?: string;
  /** The text the node will echo (`composeOutgoingPrompt`), so the swap does not flicker. */
  readonly outgoingText: string;
  readonly prompt: string;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  /**
   * Marks the thread busy for the outbox until the send ends; defaults to the outbox's own
   * (`beginThreadOutboxForegroundDispatch`). A test seam.
   */
  readonly beginForegroundDispatch?: () => ThreadOutboxForegroundDispatch;
  /** Sends the turn; resolves false with the error it reported when it failed. */
  readonly dispatch: (hooks: {
    /** The id and time the bubble shows: the turn goes out under them, so the echo replaces it. */
    readonly messageId: MessageId;
    readonly createdAt: string;
    readonly onBeforeTurnStart: () => void;
    readonly reportError: (error: string | null) => void;
  }) => Promise<boolean>;
  /** The send failed: the draft goes back to the composer (or waits for the screen). */
  readonly onFailed: (entry: OptimisticUserMessage, error: string) => void;
  readonly onSettled?: (dispatched: boolean) => void;
}

/** Shows the message now and dispatches it in the background; resolves when the send ends. */
export function startOptimisticDispatch(input: OptimisticDispatchInput): Promise<boolean> {
  const threadKey = scopedThreadKey(input.threadRef);
  const messageId = input.messageId ?? newMessageId();
  const createdAt = input.createdAt ?? new Date().toISOString();
  const entry = buildOptimisticUserMessage({
    messageId,
    text: input.outgoingText,
    createdAt,
    prompt: input.prompt,
    attachments: input.attachments,
  });
  addOptimisticUserMessage(threadKey, entry);
  const foreground = (
    input.beginForegroundDispatch ??
    (() =>
      beginThreadOutboxForegroundDispatch({
        threadKey,
        messageId,
        readView: () => readQueueThreadView(useStore.getState(), input.threadRef),
      }))
  )();
  let reported: string | null = null;
  const settle = (dispatched: boolean, error: string | null) => {
    foreground.end(dispatched);
    if (dispatched) {
      markOptimisticUserMessageDispatched(threadKey, messageId);
    } else {
      input.onFailed(entry, error ?? reported ?? "Failed to send message.");
    }
    input.onSettled?.(dispatched);
    return dispatched;
  };
  return input
    .dispatch({
      messageId,
      createdAt,
      onBeforeTurnStart: foreground.onBeforeTurnStart,
      reportError: (error) => {
        reported = error;
      },
    })
    .then(
      (dispatched) => settle(dispatched, null),
      (error: unknown) =>
        settle(false, error instanceof Error ? error.message : "Failed to send message."),
    );
}
