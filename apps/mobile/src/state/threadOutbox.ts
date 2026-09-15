import { hasRetiredProjectMemory } from "@ryco/shared/retiredFeatures";
import { mobileKV } from "../platform/kv";
import type { DraftComposerFileAttachment } from "../lib/composerFiles";
import { useMessageQueueStore } from "./messageQueueStore";
import {
  groupQueuedThreadMessages,
  normalizePersistedQueuedThreadMessageAttachments,
  resolveThreadOutboxDeliveryAction,
  resolveThreadOutboxFailureAction,
  type EnvironmentShellStatus,
  type QueuedThreadMessage,
} from "./threadOutboxModel";

// §3-14 (ratified option 2): the PERSISTENT offline outbox. Queued turns for
// existing threads survive an app kill (persisted to the injected mobileKV), are
// mirrored into B1's in-memory useMessageQueueStore for the composer UI, and drain
// through the runtime send path on reconnect. The delivery/retry decisions come
// from the pure threadOutboxModel; this module owns only persistence + the drain
// loop (a bound wrapper, no import-time side effects).

const OUTBOX_STORAGE_KEY = "ryco.threadOutbox.v1";

let messages: QueuedThreadMessage[] = [];
let hydrated = false;
let hydrationStarted = false;
const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

export function subscribeThreadOutbox(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isThreadOutboxHydrated(): boolean {
  return hydrated;
}

/** Mirror the persisted queue into the in-memory message-queue store (composer UI). */
function mirrorToQueueStore(): void {
  const store = useMessageQueueStore.getState();
  for (const key of Object.keys(store.queuesByThreadKey)) store.clear(key);
  for (const [threadKey, queue] of Object.entries(groupQueuedThreadMessages(messages))) {
    for (const message of queue) {
      store.enqueue(threadKey, {
        id: message.messageId,
        composer: { text: message.text, attachments: message.attachments },
        settings: {
          modelSelection: message.modelSelection,
          runtimeMode: message.runtimeMode,
          interactionMode: message.interactionMode,
          tokenMode: message.tokenMode,
        },
      });
    }
  }
}

function persist(): void {
  // The local read uri is transient: restored files carry token metadata or a
  // needsReattach marker only, never a byte source.
  void mobileKV
    .setItem(
      OUTBOX_STORAGE_KEY,
      JSON.stringify(
        messages.map((message) => ({
          ...message,
          attachments: message.attachments.map((attachment) =>
            attachment.type === "file" ? stripFileReadUri(attachment) : attachment,
          ),
        })),
      ),
    )
    .catch(() => {
      // Fire-and-forget: the in-memory queue stays authoritative until the next write.
    });
}

function stripFileReadUri(attachment: DraftComposerFileAttachment) {
  const { readUri: _readUri, ...persisted } = attachment;
  return persisted;
}

/** Idempotently load the persisted queue once. */
export async function hydrateThreadOutbox(): Promise<void> {
  if (hydrationStarted) return;
  hydrationStarted = true;
  try {
    const raw = await mobileKV.getItem(OUTBOX_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    messages = Array.isArray(parsed)
      ? parsed.flatMap((message) => {
          if (!message || typeof message !== "object") return [];
          const candidate = message as Record<string, unknown>;
          if (
            typeof candidate.messageId !== "string" ||
            typeof candidate.commandId !== "string" ||
            typeof candidate.text !== "string"
          ) {
            return [];
          }
          const queued = message as QueuedThreadMessage;
          return [
            {
              ...queued,
              attachments: normalizePersistedQueuedThreadMessageAttachments(candidate.attachments),
            },
          ];
        })
      : [];
  } catch {
    messages = [];
  }
  hydrated = true;
  mirrorToQueueStore();
  notifyListeners();
}

export function enqueueThreadOutboxMessage(message: QueuedThreadMessage): void {
  messages = [...messages.filter((m) => m.messageId !== message.messageId), message];
  mirrorToQueueStore();
  persist();
  notifyListeners();
}

export function removeThreadOutboxMessage(messageId: string): void {
  const next = messages.filter((m) => m.messageId !== messageId);
  if (next.length === messages.length) return;
  messages = next;
  mirrorToQueueStore();
  persist();
  notifyListeners();
}

export function listThreadOutboxMessages(): ReadonlyArray<QueuedThreadMessage> {
  return messages;
}

/** Test seam. */
export function resetThreadOutboxForTests(): void {
  messages = [];
  hydrated = false;
  hydrationStarted = false;
  notifyListeners();
}

// The per-message context the drain needs from live state, and the send seam.
export interface ThreadOutboxDrainDeps {
  /** Live thread state used to decide whether to send/wait/remove a queued item. */
  readonly readThreadDeliveryState: (message: QueuedThreadMessage) => {
    readonly threadExists: boolean;
    readonly shellStatus: EnvironmentShellStatus;
    readonly environmentConnected: boolean;
    readonly threadBusy: boolean;
    readonly alreadyDelivered?: boolean;
    readonly deliveryReconciled?: boolean;
  };
  /** Dispatch the queued turn through the runtime send path (commitSendTurnDispatch). */
  readonly sendQueuedMessage: (message: QueuedThreadMessage) => Promise<void>;
  readonly onInterrupted?: () => boolean;
}

/**
 * Drain the persisted outbox: for each queued message resolve the delivery
 * action, send the "send" ones through the runtime path, and remove delivered /
 * vanished items. Transient failures stay queued for the next drain; permanent
 * failures are discarded. Existing-thread messages only.
 */
export async function drainThreadOutbox(deps: ThreadOutboxDrainDeps): Promise<void> {
  const grouped = groupQueuedThreadMessages(messages);
  for (const queue of Object.values(grouped)) {
    for (const message of queue) {
      if (hasRetiredProjectMemory(message)) {
        // Keep the original request available; do not retry it or erase its context.
        break;
      }
      const action = resolveThreadOutboxDeliveryAction(deps.readThreadDeliveryState(message));
      if (action === "wait") break; // preserve ordering within a thread
      if (action === "remove") {
        removeThreadOutboxMessage(message.messageId);
        continue;
      }
      try {
        await deps.sendQueuedMessage(message);
        removeThreadOutboxMessage(message.messageId);
      } catch (error) {
        const failure = resolveThreadOutboxFailureAction({
          stage: "start-turn",
          error,
          interrupted: deps.onInterrupted?.() ?? false,
        });
        if (failure === "discard") {
          removeThreadOutboxMessage(message.messageId);
        }
        // "retry" leaves the message queued for the next drain.
        break;
      }
    }
  }
}
