import { isTransportConnectionErrorMessage } from "@ryco/client-runtime/errors";
import { scopeThreadRef, scopedThreadKey } from "@ryco/client-runtime/scoped";
import type {
  CommandId,
  AgentTokenMode,
  EnvironmentId,
  MessageId,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@ryco/contracts";

import type { DraftComposerAttachment } from "../lib/composerFiles";

// §3-14 (ratified option 2): the pure delivery/retry state machine for the
// persistent offline outbox, ported verbatim from the upstream thread-outbox
// model minus the Atom / upstream-runtime imports and the pending-task *creation*
// the mobile MVP queues messages for EXISTING threads only (§3-6 drops
// new-task creation). Kept node-testable (no store / react-native / native KV).

const THREAD_OUTBOX_MAX_RETRY_DELAY_MS = 16_000;

// Local mirror of the runtime shell status (no `state/shell` export in runtime A);
// only the "live" case is load-bearing here.
export type EnvironmentShellStatus = "idle" | "loading" | "live";

export interface QueuedThreadMessage {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly commandId: CommandId;
  readonly text: string;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly modelSelection?: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly tokenMode?: AgentTokenMode;
  readonly createdAt: string;
}

export interface ThreadSettingsSnapshot {
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export function resolveQueuedThreadSettings(
  message: QueuedThreadMessage,
  thread: ThreadSettingsSnapshot,
): ThreadSettingsSnapshot {
  return {
    modelSelection: message.modelSelection ?? thread.modelSelection,
    runtimeMode: message.runtimeMode ?? thread.runtimeMode,
    interactionMode: message.interactionMode ?? thread.interactionMode,
  };
}

export function modelSelectionsEqual(left: ModelSelection, right: ModelSelection): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.model === right.model &&
    JSON.stringify(left.options ?? null) === JSON.stringify(right.options ?? null)
  );
}

/**
 * Sanitizes a persisted outbox attachment list. Images keep their inline
 * dataUrl; streamed files persist token metadata only (no bytes on reload)
 * and restore as "attach again" rows when the upload never finished. Local
 * read uris are transient and are always dropped here.
 */
export function normalizePersistedQueuedThreadMessageAttachments(
  value: unknown,
): DraftComposerAttachment[] {
  if (!Array.isArray(value)) return [];
  const out: DraftComposerAttachment[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Record<string, unknown>;
    const id = candidate.id;
    const name = candidate.name;
    const mimeType = candidate.mimeType;
    const sizeBytes = candidate.sizeBytes;
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      typeof name !== "string" ||
      name.length === 0 ||
      typeof mimeType !== "string" ||
      typeof sizeBytes !== "number" ||
      !Number.isFinite(sizeBytes) ||
      sizeBytes < 0
    ) {
      continue;
    }
    const dataUrl =
      typeof candidate.dataUrl === "string" && candidate.dataUrl.length > 0
        ? candidate.dataUrl
        : undefined;
    const uploadToken =
      typeof candidate.uploadToken === "string" && candidate.uploadToken.length > 0
        ? candidate.uploadToken
        : undefined;
    const expiresAt =
      typeof candidate.expiresAt === "string" && candidate.expiresAt.length > 0
        ? candidate.expiresAt
        : undefined;
    if (candidate.type === "file") {
      if (uploadToken !== undefined) {
        out.push({
          type: "file",
          id,
          name,
          mimeType,
          sizeBytes,
          readUri: "",
          ...(expiresAt !== undefined ? { expiresAt } : {}),
          uploadToken,
        });
      } else {
        out.push({
          type: "file",
          id,
          name,
          mimeType,
          sizeBytes,
          readUri: "",
          uploadState: "needsReattach",
        });
      }
      continue;
    }
    if (dataUrl === undefined) continue;
    out.push({
      type: "image",
      id,
      name,
      mimeType,
      sizeBytes,
      dataUrl,
      previewUri: dataUrl,
    });
  }
  return out;
}

export function groupQueuedThreadMessages(
  messages: ReadonlyArray<QueuedThreadMessage>,
): Record<string, ReadonlyArray<QueuedThreadMessage>> {
  const deduplicated = new Map<MessageId, QueuedThreadMessage>();
  for (const message of messages) {
    deduplicated.set(message.messageId, message);
  }

  const grouped: Record<string, Array<QueuedThreadMessage>> = {};
  for (const message of deduplicated.values()) {
    const threadKey = scopedThreadKey(scopeThreadRef(message.environmentId, message.threadId));
    (grouped[threadKey] ??= []).push(message);
  }
  for (const queue of Object.values(grouped)) {
    queue.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
  return grouped;
}

export function flattenQueuedThreadMessages(
  queues: Record<string, ReadonlyArray<QueuedThreadMessage>>,
): ReadonlyArray<QueuedThreadMessage> {
  return Object.values(queues).flat();
}

export function threadOutboxRetryDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), THREAD_OUTBOX_MAX_RETRY_DELAY_MS);
}

export type ThreadOutboxDeliveryAction = "wait" | "remove" | "send";

// Existing-thread delivery only (no creation branch): a queued message for a
// thread that has vanished from a live shell is dropped; otherwise it sends once
// the environment is connected and the thread is not mid-turn.
export function resolveThreadOutboxDeliveryAction(input: {
  readonly threadExists: boolean;
  readonly shellStatus: EnvironmentShellStatus;
  readonly environmentConnected: boolean;
  readonly threadBusy: boolean;
  readonly alreadyDelivered?: boolean;
  /** False until detailed messages are loaded and stable-id delivery can be checked. */
  readonly deliveryReconciled?: boolean;
}): ThreadOutboxDeliveryAction {
  if (input.alreadyDelivered === true) return "remove";
  if (input.deliveryReconciled === false) return "wait";
  if (!input.threadExists) {
    return input.shellStatus === "live" ? "remove" : "wait";
  }
  return input.environmentConnected && !input.threadBusy ? "send" : "wait";
}

function errorMessage(error: unknown): string | null {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return typeof error.message === "string" ? error.message : null;
  }
  return typeof error === "string" ? error : null;
}

export function shouldRetryThreadOutboxDelivery(error: unknown): boolean {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "ConnectionTransientError"
  ) {
    return true;
  }
  return isTransportConnectionErrorMessage(errorMessage(error));
}

export type ThreadOutboxCommandStage = "settings-sync" | "start-turn";
export type ThreadOutboxFailureAction = "retry" | "discard";

export function resolveThreadOutboxFailureAction(input: {
  readonly stage: ThreadOutboxCommandStage;
  readonly error: unknown;
  readonly interrupted: boolean;
}): ThreadOutboxFailureAction {
  if (
    input.stage === "settings-sync" ||
    input.interrupted ||
    shouldRetryThreadOutboxDelivery(input.error)
  ) {
    return "retry";
  }
  return "discard";
}
