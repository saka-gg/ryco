import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  createInterruptQueueHold,
  createMessageQueueDrainCoordinator,
  type MessageQueueDrainCoordinator,
  type MessageQueueDrainPlatform,
  type MessageQueueSender,
  type QueueSendHooks,
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
 * A queued send for this thread is in flight, or accepted while its turn has
 * not started. A background send is invisible to the composer's busy state, so
 * a direct send now could land in that turn's startSession bind window and be
 * orphaned; the composer queues it behind the outstanding send instead. Not
 * while the queue is held (a stall, a Stop): a direct send stays allowed then,
 * rather than vanishing behind a queue that needs Resume.
 */
export function hasOutstandingQueuedDispatch(threadKey: string): boolean {
  const { inFlightMessageId, pendingDispatch } = getCoordinator().inspect(threadKey);
  if (inFlightMessageId !== null) return true;
  return (
    pendingDispatch !== null &&
    useMessageQueueStore.getState().holdsByThreadKey[threadKey] === undefined
  );
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

/** What a mounted ChatView last committed: the thread it shows and how it sends. */
export interface ForegroundQueueTarget {
  readonly threadKey: string | null;
  /** The composer cannot send right now; the send is retried shortly. */
  readonly isBusy: () => boolean;
  readonly dispatch: (entry: WebQueuedMessage, hooks: QueueSendHooks) => Promise<boolean>;
}

/**
 * A foreground sender bound to one thread key. A ChatView instance can move to
 * another thread (a reused draft route) while this sender is still registered
 * for the old key; it defers unless the committed target still shows its key,
 * so an entry is never dispatched through another thread's closures.
 */
export function createForegroundQueueSender(
  threadKey: string,
  readTarget: () => ForegroundQueueTarget | null,
): WebQueueSender {
  return {
    send: async (entry, hooks) => {
      const target = readTarget();
      if (!target || target.threadKey !== threadKey || target.isBusy()) {
        return { kind: "deferred" };
      }
      return (await target.dispatch(entry, hooks)) ? { kind: "accepted" } : { kind: "failed" };
    },
  };
}

/**
 * Registers the mounted ChatView as its thread's sender and retains the drain
 * for as long as the ChatView is mounted, so it drains even where no
 * `MessageQueueDrainBridge` is mounted. The retain has its own effect: swapping
 * the sender on a thread switch must never take the retain count through zero,
 * which would drop every pending turn-start wait and let the next head land in
 * the previous send's bind window.
 */
export function useForegroundQueueSender(
  threadKey: string | null,
  sender: WebQueueSender | null,
): void {
  useEffect(() => retainMessageQueueDrain(), []);
  useEffect(() => {
    if (!threadKey || !sender) return;
    return registerForegroundQueueSender(threadKey, sender);
  }, [threadKey, sender]);
}
