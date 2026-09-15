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
// the queue). Otherwise it dispatches through the runtime send engine.

export type ThreadSendAction = "enqueue" | "dispatch";

export function resolveThreadSendAction(input: {
  readonly threadBusy: boolean;
  readonly connected: boolean;
}): ThreadSendAction {
  return input.threadBusy || !input.connected ? "enqueue" : "dispatch";
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
}

export interface SendThreadTurnDeps {
  readonly newMessageId: () => string;
  readonly newCommandId: () => string;
  readonly now: () => string;
  /** Enqueue for later delivery (running/disconnected). */
  readonly enqueue: (message: QueuedThreadMessage) => void;
  /** Dispatch immediately; returns true on success, false on failure. */
  readonly dispatch: () => Promise<boolean>;
}

/**
 * Route a thread send: enqueue (returns true — the message is safely queued) or
 * dispatch (returns the dispatch result). The composer keeps the user's text only
 * when this returns false.
 */
export async function sendThreadTurn(
  context: SendThreadTurnContext,
  deps: SendThreadTurnDeps,
): Promise<boolean> {
  const action = resolveThreadSendAction({
    threadBusy: context.threadBusy,
    connected: context.connected,
  });
  if (action === "enqueue") {
    deps.enqueue({
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
    });
    return true;
  }
  return deps.dispatch();
}
