import { useEffect } from "react";

import {
  getWsConnectionStatusForEnvironment,
  getWsConnectionUiState,
} from "@ryco/client-runtime/rpc";
import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  commitSendTurnDispatch,
} from "@ryco/client-runtime/state/composer";

import { ensureEnvironmentApi } from "../connection/environmentApi";
import { newCommandId } from "../lib/ids";
import { drainThreadOutbox, hydrateThreadOutbox } from "./threadOutbox";
import { buildQueuedThreadMessageAttachments } from "./queuedThreadMessageAttachments";
import type { EnvironmentShellStatus, QueuedThreadMessage } from "./threadOutboxModel";
import {
  selectBootstrapCompleteForEnvironment,
  selectEnvironmentHydratedFromCacheAt,
  selectSidebarThreadSummaryByRef,
  selectThreadByRef,
  useStore,
} from "./threadsRuntime";
import { useWsConnectionOpenedCount } from "../rpc/wsConnectionState";

// §3-14: dispatch a queued turn for an EXISTING thread through the runtime send
// path. The queued item carries its own composer settings (captured at enqueue);
// a message missing them cannot be sent and is dropped by the drain caller.
async function sendQueuedThreadMessage(message: QueuedThreadMessage): Promise<void> {
  if (!message.modelSelection || !message.runtimeMode || !message.interactionMode) {
    throw new Error("Queued message is missing composer settings.");
  }
  const api = ensureEnvironmentApi(message.environmentId);
  const turnAttachments = await buildQueuedThreadMessageAttachments(message);
  await commitSendTurnDispatch({
    api,
    threadId: message.threadId,
    isFirstMessage: false,
    isServerThread: true,
    title: "",
    messageId: message.messageId,
    outgoingMessageText: message.text.trim() || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
    turnAttachments,
    modelSelection: message.modelSelection,
    hasSelectedModel: true,
    runtimeMode: message.runtimeMode,
    interactionMode: message.interactionMode,
    tokenMode: message.tokenMode ?? "balanced",
    bootstrap: undefined,
    sourceControlContexts: [],
    createdAt: message.createdAt,
    newCommandId,
    beginLocalDispatch: () => {},
    persistThreadSettingsForNextTurn: () => Promise.resolve(),
  });
}

// Exported for testing: the drain gate's per-message delivery snapshot.
export function readThreadDeliveryState(message: QueuedThreadMessage): {
  readonly threadExists: boolean;
  readonly shellStatus: EnvironmentShellStatus;
  readonly environmentConnected: boolean;
  readonly threadBusy: boolean;
  readonly alreadyDelivered: boolean;
  readonly deliveryReconciled: boolean;
} {
  const state = useStore.getState();
  const ref = scopeThreadRef(message.environmentId, message.threadId);
  const summary = selectSidebarThreadSummaryByRef(state, ref);
  const thread = selectThreadByRef(state, ref);
  // The gate must consult the MESSAGE's environment: with several nodes
  // connected, the global status reflects whichever socket wrote last, and a
  // queued message for an offline node would be judged drainable because a
  // different node happens to be connected.
  const connected =
    getWsConnectionUiState(getWsConnectionStatusForEnvironment(message.environmentId)) ===
    "connected";
  // Wave 2: rows hydrated from the snapshot cache (or demoted after a
  // disconnect) are last-known state, not evidence of what the node holds now.
  // A cached thread must not count as delivery-reconciled — the socket can open
  // one RTT before the live shell snapshot lands, and in that window a cached
  // idle row would read as "exists, not busy" and dispatch a queued message
  // into a thread that is actually mid-turn on the node.
  const cacheProvenance =
    selectEnvironmentHydratedFromCacheAt(state, message.environmentId) !== null;
  return {
    threadExists: Boolean(summary ?? thread),
    shellStatus: selectBootstrapCompleteForEnvironment(state, message.environmentId)
      ? "live"
      : "loading",
    environmentConnected: connected,
    threadBusy: summary?.latestTurn?.state === "running" || thread?.latestTurn?.state === "running",
    alreadyDelivered: thread?.messages.some((entry) => entry.id === message.messageId) ?? false,
    deliveryReconciled: thread !== undefined && !cacheProvenance,
  };
}

function runOutboxDrain(): void {
  void drainThreadOutbox({
    readThreadDeliveryState,
    sendQueuedMessage: sendQueuedThreadMessage,
  });
}

/**
 * Drain the outbox whenever the threads store changes — a message that waited
 * because its thread was mid-turn (§3-14) must be delivered when that thread
 * SETTLES (latestTurn no longer running / pending cleared), not only on the next
 * socket reconnect. Returns an unsubscribe. Exported for testing; the debounce
 * coalesces the store's per-event notifications.
 */
export function subscribeOutboxSettleDrain(runDrain: () => void, debounceMs = 50): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const unsubscribe = useStore.subscribe(() => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      runDrain();
    }, debounceMs);
  });
  return () => {
    if (timer !== null) clearTimeout(timer);
    unsubscribe();
  };
}

/**
 * Mount point (RootStackLayout): hydrate the persisted outbox once, then drain it
 * whenever ANY environment's socket opens OR a thread settles — the offline outbox
 * drains on reconnect AND on turn-settle (spec §Bundling / §3-14). The trigger is
 * the opened counter, not a global phase edge: with one node already connected the
 * global phase never leaves "connected" when a second node's socket opens, and
 * that second node's queued messages would wait for an unrelated settle tick.
 * A bound wrapper; no import-time side effects.
 */
export function useThreadOutboxDrain(): void {
  const openedCount = useWsConnectionOpenedCount();

  useEffect(() => {
    // Drain once hydration lands: on a cold start the opened-count effect can
    // fire before the persisted queue exists, and an already-connected
    // environment would otherwise wait for an unrelated settle tick.
    void hydrateThreadOutbox().then(() => runOutboxDrain());
  }, []);

  useEffect(() => {
    if (openedCount === 0) return;
    runOutboxDrain();
  }, [openedCount]);

  // Settle-edge: drain when a thread's turn settles while queued messages wait.
  useEffect(() => subscribeOutboxSettleDrain(runOutboxDrain), []);
}
