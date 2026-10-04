import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  createInterruptQueueHold,
  createMessageQueueDrainCoordinator,
  type MessageQueueDrainCoordinator,
  type MessageQueueDrainPlatform,
  type MessageQueueSender,
  type QueueThreadView,
} from "@ryco/client-runtime/state/message-queue";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { useEffect } from "react";

import type { SendTurnComposerSnapshot, SendTurnSettings } from "./hooks/executeChatSendTurn";
import { sendQueuedMessageInBackground } from "./hooks/sendQueuedMessageInBackground";
import { useComposerDraftStore } from "./composerDraftStore";
import { retainThreadDetailSubscription } from "./environments/runtime/service";
import {
  readWebQueueEnvironment,
  subscribeWebQueueEnvironmentReadiness,
} from "./messageQueueEnvironment";
import { useMessageQueueStore, type WebQueuedMessage } from "./messageQueueStore";
import { selectThreadByRef, useStore } from "./store";

export { readWebQueueEnvironment } from "./messageQueueEnvironment";

export type WebQueueSender = MessageQueueSender<SendTurnComposerSnapshot, SendTurnSettings>;

// ---------------------------------------------------------------------------
// Web adapter for the client-runtime drain coordinator: one drain for every
// thread with a queue, not only the visible ChatView. A mounted ChatView
// registers a foreground sender for its key; a started server thread without
// one uses the headless background sender; drafts and unstarted threads wait.
// ---------------------------------------------------------------------------

const foregroundSendersByThreadKey = new Map<string, WebQueueSender[]>();
const backgroundSendersByThreadKey = new Map<string, WebQueueSender>();

function backgroundSender(threadKey: string): WebQueueSender {
  let sender = backgroundSendersByThreadKey.get(threadKey);
  if (!sender) {
    sender = { send: (entry, hooks) => sendQueuedMessageInBackground(threadKey, entry, hooks) };
    backgroundSendersByThreadKey.set(threadKey, sender);
  }
  return sender;
}

export function resolveWebQueueSender(
  threadKey: string,
  view: QueueThreadView | null,
): { kind: "foreground" | "background"; sender: WebQueueSender } | null {
  const foreground = foregroundSendersByThreadKey.get(threadKey)?.at(-1);
  if (foreground) return { kind: "foreground", sender: foreground };
  if (view?.started) return { kind: "background", sender: backgroundSender(threadKey) };
  return null;
}

export function isLocalDraftQueueKey(threadKey: string): boolean {
  return Object.values(useComposerDraftStore.getState().draftThreadsByThreadKey).some(
    (draft) => scopedThreadKey(scopeThreadRef(draft.environmentId, draft.threadId)) === threadKey,
  );
}

function revokeQueuedPreviewUrls(_threadKey: string, entry: WebQueuedMessage): void {
  for (const image of entry.composer.images) {
    if (image.previewUrl.startsWith("blob:")) URL.revokeObjectURL(image.previewUrl);
  }
}

const webPlatform: MessageQueueDrainPlatform<SendTurnComposerSnapshot, SendTurnSettings> = {
  threads: { getState: useStore.getState, subscribe: (listener) => useStore.subscribe(listener) },
  readEnvironment: readWebQueueEnvironment,
  subscribeEnvironmentReadiness: subscribeWebQueueEnvironmentReadiness,
  resolveSender: resolveWebQueueSender,
  isLocalDraftKey: isLocalDraftQueueKey,
  headProviderInstanceId: (entry) => entry.composer.selectedModelSelection.instanceId,
  // Never `retainHostedWorkspaceThreadScope`: the coordinator retains detail
  // only while the environment is mutation-ready, so hosted mode retains only
  // the selected, connected node and never creates connection demand.
  retainThreadDetail: (ref) => retainThreadDetailSubscription(ref.environmentId, ref.threadId),
  onEntryRemoved: revokeQueuedPreviewUrls,
};

let coordinator: MessageQueueDrainCoordinator | null = null;

function getCoordinator(): MessageQueueDrainCoordinator {
  coordinator ??= createMessageQueueDrainCoordinator(useMessageQueueStore, webPlatform);
  return coordinator;
}

/** Ref-counted; the final release stops the drain and clears its bookkeeping. */
export function retainMessageQueueDrain(): () => void {
  return getCoordinator().retain();
}

export function resumeMessageQueue(threadKey: string): void {
  getCoordinator().resume(threadKey);
}

export function retryQueuedMessage(threadKey: string, messageId: string): void {
  getCoordinator().retry(threadKey, messageId);
}

export function inspectMessageQueueDrain(threadKey: string) {
  return getCoordinator().inspect(threadKey);
}

/**
 * Records the explicit Stop hold before the interrupt is dispatched. `undo`
 * removes only causes this call added, without acknowledging them.
 */
export function holdMessageQueueForInterrupt(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): { undo(): void } {
  const ref = scopeThreadRef(environmentId, threadId);
  const threadKey = scopedThreadKey(ref);
  const hold = createInterruptQueueHold(
    selectThreadByRef(useStore.getState(), ref)?.session?.activeTurnId ?? null,
    new Date().toISOString(),
  );
  const changed = useMessageQueueStore.getState().hold(threadKey, hold);
  return {
    undo: () => {
      if (changed) useMessageQueueStore.getState().removeHoldCauses(threadKey, hold.causeKeys);
    },
  };
}

export function registerForegroundQueueSender(
  threadKey: string,
  sender: WebQueueSender,
): () => void {
  const stack = foregroundSendersByThreadKey.get(threadKey) ?? [];
  stack.push(sender);
  foregroundSendersByThreadKey.set(threadKey, stack);
  getCoordinator().evaluate(threadKey);
  return () => {
    const current = foregroundSendersByThreadKey.get(threadKey);
    if (!current) return;
    const index = current.lastIndexOf(sender);
    if (index !== -1) current.splice(index, 1);
    if (current.length === 0) foregroundSendersByThreadKey.delete(threadKey);
    getCoordinator().evaluate(threadKey);
  };
}

/**
 * Registers the mounted ChatView as its thread's sender and retains the drain,
 * so a ChatView mounted on its own (browser suites) still drains.
 */
export function useForegroundQueueSender(threadKey: string | null, sender: WebQueueSender): void {
  useEffect(() => {
    const release = retainMessageQueueDrain();
    const unregister = threadKey ? registerForegroundQueueSender(threadKey, sender) : null;
    return () => {
      unregister?.();
      release();
    };
  }, [threadKey, sender]);
}
