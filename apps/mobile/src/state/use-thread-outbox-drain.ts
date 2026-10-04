import { readEnvironmentServerConfig } from "./environmentServerConfigs";
import { createMobileConnectionRegistry } from "../runtime/bootstrap";
import { useEffect } from "react";

import {
  appAtomRegistry,
  getWsConnectionStatusForEnvironment,
  getWsConnectionUiState,
  wsConnectionOpenedCountAtom,
  wsConnectionStatusAtom,
} from "@ryco/client-runtime/rpc";
import { scopeThreadRef, scopedThreadKey } from "@ryco/client-runtime/scoped";
import { DEFAULT_AGENT_TOKEN_MODE, type ScopedThreadRef } from "@ryco/contracts";
import {
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  commitSendTurnDispatch,
  captureReviewedSendReadiness,
} from "@ryco/client-runtime/state/composer";
import {
  readQueueThreadView,
  type QueueEnvironmentReadiness,
  type QueueSendHooks,
} from "@ryco/client-runtime/state/message-queue";

import { ensureEnvironmentApi } from "../connection/environmentApi";
import { retainThreadDetailSubscription } from "../connection/threadDetail";
import { newCommandId } from "../lib/ids";
import {
  drainThreadOutbox,
  hydrateThreadOutbox,
  listThreadOutboxMessages,
  subscribeThreadOutbox,
  trackThreadOutboxLiveCauses,
  type ThreadOutboxDrainState,
} from "./threadOutbox";
import { buildQueuedThreadMessageAttachments } from "./queuedThreadMessageAttachments";
import type { QueuedThreadMessage } from "./threadOutboxModel";
import { selectEnvironmentShellLive, selectThreadByRef, useStore } from "./threadsRuntime";
import { useWsConnectionOpenedCount } from "../rpc/wsConnectionState";

// §3-14: dispatch a queued turn for an EXISTING thread through the runtime send
// path. The queued item carries its own composer settings (captured at enqueue);
// a message missing them cannot be sent and is dropped by the drain caller.
async function sendQueuedThreadMessage(
  message: QueuedThreadMessage,
  hooks: QueueSendHooks,
): Promise<void> {
  if (!message.modelSelection || !message.runtimeMode || !message.interactionMode) {
    throw new Error("Queued message is missing composer settings.");
  }
  const api = ensureEnvironmentApi(message.environmentId);
  const turnAttachments = await buildQueuedThreadMessageAttachments(message);
  await commitSendTurnDispatch({
    claudeCacheReview: {
      review: async (review) =>
        (await import("../features/threads/claudeCacheReview")).mobileClaudeCacheReview.review(
          review,
        ),
    },
    sourceProviderDriver: selectThreadByRef(
      useStore.getState(),
      scopeThreadRef(message.environmentId, message.threadId),
    )?.session?.provider,
    providerDriver:
      readEnvironmentServerConfig(message.environmentId)?.providers.find(
        (provider) => provider.instanceId === message.modelSelection?.instanceId,
      )?.driver ?? null,
    assertMutationReady: captureReviewedSendReadiness(message.environmentId, () =>
      createMobileConnectionRegistry().driver.supervisor.read(message.environmentId),
    ),
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
    tokenMode: message.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
    bootstrap: undefined,
    sourceControlContexts: [],
    createdAt: message.createdAt,
    newCommandId,
    beginLocalDispatch: () => {},
    onBeforeTurnStart: hooks.onBeforeTurnStart,
    persistThreadSettingsForNextTurn: () => Promise.resolve(),
  });
}

/**
 * Whether the drain may trust this environment's rows and mutate it. The gate
 * consults the THREAD's environment: with several nodes connected, the global
 * status reflects whichever socket wrote last, and a queued message for an
 * offline node would be judged drainable because a different node happens to
 * be connected.
 */
export function readThreadOutboxEnvironment(
  environmentId: ScopedThreadRef["environmentId"],
): QueueEnvironmentReadiness {
  const state = useStore.getState();
  // Wave 2: rows hydrated from the snapshot cache (or demoted after a
  // disconnect) are last-known state, not evidence of what the node holds now.
  // The socket can open one RTT before the live shell snapshot lands, and in
  // that window a cached idle row would read as "exists, not busy" and
  // dispatch a queued message into a thread that is actually mid-turn.
  const shellLive = selectEnvironmentShellLive(state, environmentId);
  const connected =
    getWsConnectionUiState(getWsConnectionStatusForEnvironment(environmentId)) === "connected";
  return { shellLive, mutationReady: shellLive && connected };
}

// Exported for testing: the drain gate's per-thread snapshot.
export function readThreadDrainState(ref: ScopedThreadRef): ThreadOutboxDrainState {
  return {
    view: readQueueThreadView(useStore.getState(), ref),
    environment: readThreadOutboxEnvironment(ref.environmentId),
  };
}

export function runOutboxDrain(): void {
  void drainThreadOutbox({
    readThreadDrainState,
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
 * Keeps a thread-detail subscription for every thread with outbox messages
 * whose environment is mutation-ready. Detail is required for dedupe (a
 * projected queued message) and for start-failure acks, so without it an
 * off-screen queue would wait on `detail`. Released when the thread has no
 * messages or its environment is not ready. Exported for testing.
 */
export function createThreadOutboxDetailRetention(deps: {
  readonly listMessages: () => ReadonlyArray<QueuedThreadMessage>;
  readonly isEnvironmentReady: (environmentId: ScopedThreadRef["environmentId"]) => boolean;
  readonly retain: (ref: ScopedThreadRef) => () => void;
}): { sync(): void; dispose(): void } {
  const retains = new Map<string, () => void>();
  return {
    sync() {
      const wanted = new Map<string, ScopedThreadRef>();
      for (const message of deps.listMessages()) {
        if (!deps.isEnvironmentReady(message.environmentId)) continue;
        const ref = scopeThreadRef(message.environmentId, message.threadId);
        wanted.set(scopedThreadKey(ref), ref);
      }
      for (const [key, release] of retains) {
        if (wanted.has(key)) continue;
        retains.delete(key);
        release();
      }
      for (const [key, ref] of wanted) {
        if (!retains.has(key)) retains.set(key, deps.retain(ref));
      }
    },
    dispose() {
      for (const release of retains.values()) release();
      retains.clear();
    },
  };
}

function useThreadOutboxDetailRetention(): void {
  useEffect(() => {
    const retention = createThreadOutboxDetailRetention({
      listMessages: listThreadOutboxMessages,
      isEnvironmentReady: (environmentId) =>
        readThreadOutboxEnvironment(environmentId).mutationReady,
      retain: (ref) => retainThreadDetailSubscription(ref.environmentId, ref.threadId),
    });
    retention.sync();
    const unsubscribers = [
      subscribeThreadOutbox(retention.sync),
      useStore.subscribe(retention.sync),
      appAtomRegistry.subscribe(wsConnectionOpenedCountAtom, retention.sync),
      appAtomRegistry.subscribe(wsConnectionStatusAtom, retention.sync),
    ];
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
      retention.dispose();
    };
  }, []);
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

  // The failures each thread showed live baseline a message composed later
  // against cached rows.
  useEffect(() => trackThreadOutboxLiveCauses(), []);

  useThreadOutboxDetailRetention();
}
