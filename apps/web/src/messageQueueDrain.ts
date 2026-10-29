import { parseScopedThreadKey, scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  addFollowUpToServerQueue,
  buildFollowUpQueueAddCommand,
  createFollowUpQueuePendingStore,
  createInterruptQueueHold,
  createMessageQueueDrainCoordinator,
  MOVED_FAILED_ENTRY_FAILURE,
  type FollowUpQueueAddOutcome,
  type FollowUpQueueCommand,
  type FollowUpQueueEntryContent,
  type MessageQueueDrainCoordinator,
  type MessageQueueDrainPlatform,
  type MessageQueueSender,
  type QueueDrainSteerRejection,
  type QueueEntryMoveContext,
  type QueueSendHooks,
  type QueueThreadView,
  selectThreadFollowUpQueue,
} from "@ryco/client-runtime/state/message-queue";
import {
  MessageId,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
} from "@ryco/contracts";
import { rejectRetiredProjectMemory } from "@ryco/shared/retiredFeatures";
import { useEffect, useSyncExternalStore } from "react";

import {
  buildOutgoingMessageText,
  buildOutgoingTurnAttachments,
  type SendTurnComposerSnapshot,
  type SendTurnSettings,
} from "./hooks/executeChatSendTurn";
import { formatOutgoingPrompt } from "./hooks/chatSendShared";
import { sendQueuedMessageInBackground } from "./hooks/sendQueuedMessageInBackground";
import { useComposerDraftStore } from "./composerDraftStore";
import { stackedThreadToast, toastManager } from "./components/ui/toast";
import { readEnvironmentApi } from "./environmentApi";
import { retainThreadDetailSubscription } from "./environments/runtime/service";
import { newCommandId } from "./lib/utils";
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

/**
 * A steer the user asked for (Steer button, Mod+Enter) reports its outcome; an implicit one
 * (Enter in steer mode) falls back to the queue silently. Either way the message stays queued.
 * A steer the provider may have received is always reported: its message no longer drains and
 * waits on the row's Retry or remove.
 */
export function steerRejectionToast(rejection: QueueDrainSteerRejection): {
  readonly type: "info" | "error";
  readonly title: string;
  readonly description: string;
} | null {
  if (rejection.deliveryUncertain) {
    return {
      type: "error",
      title: "Steer delivery unconfirmed",
      description: `${rejection.error} The message stays queued until you retry or remove it.`,
    };
  }
  if (!rejection.attempt.explicit) return null;
  return rejection.reason === "deferred"
    ? { type: "info", title: "Not steered", description: rejection.error }
    : { type: "error", title: "Steer failed", description: rejection.error };
}

function notifySteerRejected(_threadKey: string, rejection: QueueDrainSteerRejection): void {
  const toast = steerRejectionToast(rejection);
  if (toast !== null) toastManager.add(stackedThreadToast(toast));
}

// ---------------------------------------------------------------------------
// The node's follow-up queue (`capabilities.serverFollowUpQueue`). A send while
// the thread is busy becomes `thread.queue.add`; this tab's own entries move
// there once the node is ready (`moveEntryToServer`).
// ---------------------------------------------------------------------------

/**
 * `thread.queue.add`s this tab sent, shown as "Queuing…" until their entries
 * arrive with the thread detail. Not in `messageQueueStore`, which boot loads.
 */
export const useFollowUpQueuePendingStore = createFollowUpQueuePendingStore();
// An account teardown (`useMessageQueueStore.reset`) drops the adds on their way too.
useMessageQueueStore.subscribe((state, previous) => {
  if (state.epoch !== previous.epoch) useFollowUpQueuePendingStore.getState().reset();
});

/** The number of this tab's adds for the thread that the thread does not show yet. */
export function countPendingFollowUpAdds(threadKey: string): number {
  return useFollowUpQueuePendingStore.getState().pendingByThreadKey[threadKey]?.length ?? 0;
}

/** What a composer snapshot sends, as a queued follow-up: composed as a direct send would. */
export async function buildWebFollowUpContent(
  composer: SendTurnComposerSnapshot,
  settings: SendTurnSettings,
): Promise<FollowUpQueueEntryContent> {
  rejectRetiredProjectMemory(composer);
  return {
    text: buildOutgoingMessageText({ composer, formatOutgoingPrompt }),
    attachments: await buildOutgoingTurnAttachments(composer.images),
    modelSelection: composer.selectedModelSelection,
    runtimeMode: settings.runtimeMode,
    interactionMode: settings.interactionMode,
    tokenMode: settings.tokenMode,
  };
}

/**
 * Whether the node's queue can carry a composer send: a Computer Use turn and
 * a goal ride only on a turn start, so such a send stays on this tab.
 */
export function isWebFollowUpMovable(
  composer: SendTurnComposerSnapshot,
  settings: SendTurnSettings,
) {
  return settings.computerUse === undefined && composer.goal === undefined;
}

/** Dispatches a `thread.queue.*` command; rejects with the node's answer. */
export async function dispatchFollowUpQueueCommand(
  environmentId: EnvironmentId,
  command: FollowUpQueueCommand,
): Promise<void> {
  const api = readEnvironmentApi(environmentId);
  if (!api) throw new Error("This environment is not connected.");
  await api.orchestration.dispatchCommand(command);
}

async function moveEntryToServer(
  threadKey: string,
  entry: WebQueuedMessage,
  context: QueueEntryMoveContext,
): Promise<void> {
  const ref = parseScopedThreadKey(threadKey);
  if (!ref) throw new Error("This conversation is not available.");
  const content = await buildWebFollowUpContent(entry.composer, entry.settings);
  await dispatchFollowUpQueueCommand(
    ref.environmentId,
    buildFollowUpQueueAddCommand({
      commandId: newCommandId(),
      threadId: ref.threadId,
      messageId: MessageId.make(entry.id),
      content,
      hold: context.hold,
      ...(context.failed ? { failure: MOVED_FAILED_ENTRY_FAILURE } : {}),
      createdAt: entry.createdAt ?? new Date().toISOString(),
    }),
  );
}

const MOVED_QUEUES_STORAGE_KEY = "ryco:follow-up-queue-moved:v1";

/** Records, in this browser, that every queued message for the node moved to it. */
function recordServerQueueMigrated(environmentId: EnvironmentId): void {
  try {
    const raw = window.localStorage.getItem(MOVED_QUEUES_STORAGE_KEY);
    const record = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    if (record[environmentId] !== undefined) return;
    record[environmentId] = new Date().toISOString();
    window.localStorage.setItem(MOVED_QUEUES_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Storage unavailable: the record is informational, a later move is idempotent anyway.
  }
}

/** Whether the thread already has the message, queued on the node or sent. */
function followUpVisible(ref: ScopedThreadRef, messageId: string): boolean {
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
 * Queues a composer send on the node (`thread.queue.add`), shown as "Queuing…"
 * until its entry arrives. A definite refusal comes back so the caller can give
 * the message back to the composer. When the reply was lost, the node may have
 * queued it: the message stays in this tab's queue under the same id
 * (`keepInTab`), so moving it re-adds it and the node's no-op on a known id
 * keeps one copy.
 */
export async function queueFollowUpOnServer(input: {
  readonly ref: ScopedThreadRef;
  readonly messageId: MessageId;
  readonly content: FollowUpQueueEntryContent;
  readonly summary: string;
  /** The tab's own entry for the message, under `messageId`. */
  readonly keepInTab: () => WebQueuedMessage;
}): Promise<FollowUpQueueAddOutcome> {
  const outcome = await addFollowUpToServerQueue({
    pendingStore: useFollowUpQueuePendingStore,
    threadKey: scopedThreadKey(input.ref),
    command: buildFollowUpQueueAddCommand({
      commandId: newCommandId(),
      threadId: input.ref.threadId,
      messageId: input.messageId,
      content: input.content,
      createdAt: new Date().toISOString(),
    }),
    summary: input.summary,
    dispatch: (command) => dispatchFollowUpQueueCommand(input.ref.environmentId, command),
    isVisible: () => followUpVisible(input.ref, input.messageId),
    subscribe: (listener) => useStore.subscribe(listener),
  });
  if (outcome.kind === "unknown") {
    useMessageQueueStore.getState().enqueue(scopedThreadKey(input.ref), input.keepInTab());
  }
  return outcome;
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
  onSteerRejected: notifySteerRejected,
  moveEntryToServer,
  isEntryMovable: (entry) => isWebFollowUpMovable(entry.composer, entry.settings),
  onServerQueueMigrated: recordServerQueueMigrated,
  isServerQueueAddPending: (threadKey) => countPendingFollowUpAdds(threadKey) > 0,
};

let coordinator: MessageQueueDrainCoordinator | null = null;

function getCoordinator(): MessageQueueDrainCoordinator {
  coordinator ??= createMessageQueueDrainCoordinator(useMessageQueueStore, webPlatform);
  return coordinator;
}

// A tab head the node cannot carry waits behind adds on their way: look again once they land.
useFollowUpQueuePendingStore.subscribe(() => coordinator?.evaluate());

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
 * Whether the tab entry's add to the node's queue is on its way. It cannot be edited or steered
 * meanwhile: the add can still land, so an edited copy or a steer would make a second message.
 */
export function isQueuedMessageMoving(threadKey: string, messageId: string): boolean {
  return getCoordinator().inspect(threadKey).movingMessageId === messageId;
}

/** The thread's tab entry whose add to the node's queue is on its way, if any. */
export function useMovingQueuedMessageId(threadKey: string | null): string | null {
  const read = () => (threadKey ? getCoordinator().inspect(threadKey).movingMessageId : null);
  return useSyncExternalStore((listener) => getCoordinator().subscribeMoving(listener), read, read);
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
