import type {
  AgentTokenMode,
  EnvironmentId,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@ryco/contracts";

import type { DraftComposerAttachment } from "../../lib/composerFiles";
import type { QueuedThreadMessage } from "../../state/threadOutboxModel";

// §3-14: a send issued while the thread's turn is RUNNING, or while the
// environment is disconnected, must be ENQUEUED into the offline outbox instead
// of dispatched immediately (web ChatView routes running/disconnected sends to
// the queue). Otherwise it dispatches through the runtime send engine. Where the
// node keeps follow-up queues itself, a busy send is queued there instead
// (`thread.queue.add`, the predicate web uses: `shouldQueueFollowUpOnServer`);
// the outbox stays the offline intake. A thread whose node is about to send its
// own queue's head counts as busy: its session still reads ready while that
// turn starts (`followUpSendWaitsForServerQueue`).

export type ThreadSendAction = "enqueue" | "queue-on-server" | "dispatch";

export function resolveThreadSendAction(input: {
  readonly threadBusy: boolean;
  readonly connected: boolean;
  /** A busy send goes to the node's queue (`shouldQueueFollowUpOnServer`). */
  readonly serverQueue?: boolean | undefined;
  /** The node's queue goes first (`followUpSendWaitsForServerQueue`): the send waits behind it. */
  readonly serverQueueWaiting?: boolean | undefined;
}): ThreadSendAction {
  if (!input.connected) return "enqueue";
  if (input.threadBusy || input.serverQueueWaiting === true) {
    return input.serverQueue === true ? "queue-on-server" : "enqueue";
  }
  return "dispatch";
}

export interface SendThreadTurnContext {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly tokenMode: AgentTokenMode;
  readonly threadBusy: boolean;
  readonly connected: boolean;
  /** A busy send goes to the node's queue (`shouldQueueFollowUpOnServer`). */
  readonly serverQueue?: boolean | undefined;
  /** The node's queue goes first (`followUpSendWaitsForServerQueue`). */
  readonly serverQueueWaiting?: boolean | undefined;
}

export interface SendThreadTurnDeps {
  readonly newMessageId: () => string;
  readonly newCommandId: () => string;
  readonly now: () => string;
  /** Enqueue for later delivery (running/disconnected). */
  readonly enqueue: (message: QueuedThreadMessage) => void;
  /** Dispatch immediately; returns true on success, false on failure. */
  readonly dispatch: () => Promise<boolean>;
  /**
   * Runs before a message is enqueued: `"queue"` enqueues it as usual, `"steer"` enqueues it and
   * hands it to `steer` (a redirect that declined the waiting approvals), `"refuse"` sends
   * nothing and keeps the draft.
   */
  readonly beforeEnqueue?: (message: QueuedThreadMessage) => Promise<"queue" | "steer" | "refuse">;
  /** Starts a steer of a message just enqueued. */
  readonly steer?: (message: QueuedThreadMessage) => void;
  /**
   * Queues the message on the node (`thread.queue.add`), then steers it when `steer` is set.
   * True once the node took it, or once it was kept in the outbox after a lost reply; false
   * (a definite refusal) leaves it in the composer.
   */
  readonly queueOnServer?: (
    message: QueuedThreadMessage,
    options: { readonly steer: boolean },
  ) => Promise<boolean>;
}

/**
 * Route a thread send: enqueue (returns true — the message is safely queued), queue it
 * on the node (returns whether the node took it) or dispatch (returns the dispatch
 * result). The composer keeps the user's text only when this returns false.
 */
export async function sendThreadTurn(
  context: SendThreadTurnContext,
  deps: SendThreadTurnDeps,
): Promise<boolean> {
  const action = resolveThreadSendAction({
    threadBusy: context.threadBusy,
    connected: context.connected,
    serverQueue: context.serverQueue === true && deps.queueOnServer !== undefined,
    serverQueueWaiting: context.serverQueueWaiting,
  });
  if (action !== "dispatch") {
    const message: QueuedThreadMessage = {
      environmentId: context.environmentId,
      threadId: context.threadId,
      messageId: deps.newMessageId() as QueuedThreadMessage["messageId"],
      commandId: deps.newCommandId() as QueuedThreadMessage["commandId"],
      text: context.text,
      attachments: context.attachments,
      modelSelection: context.modelSelection,
      runtimeMode: context.runtimeMode,
      interactionMode: context.interactionMode,
      tokenMode: context.tokenMode,
      createdAt: deps.now(),
    };
    const route = deps.beforeEnqueue ? await deps.beforeEnqueue(message) : "queue";
    if (route === "refuse") return false;
    if (action === "queue-on-server" && deps.queueOnServer) {
      return deps.queueOnServer(message, { steer: route === "steer" });
    }
    deps.enqueue(message);
    // Marked steering right after the enqueue, before any await, so the drain never sends it
    // as a turn of its own.
    if (route === "steer") deps.steer?.(message);
    return true;
  }
  return deps.dispatch();
}
