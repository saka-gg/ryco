import type { EnvironmentId } from "@ryco/contracts";
import {
  createChatFileUploadEngine,
  watchDirectChatFileUploadReadiness,
  isFileUploadTokenUsable,
  resolveFileUploadMaxBytes,
  type ChatFileUploadRecord,
} from "@ryco/client-runtime/state/composer";
import { useSyncExternalStore } from "react";

import { usePrimaryEnvironmentDescriptor } from "./environments/primary/context";
import {
  getEnvironmentHttpBaseUrl,
  useSavedEnvironmentRuntimeStore,
  useSavedEnvironmentRegistryStore,
} from "./environments/runtime/catalog";
import { webChatFileUploadTransport } from "./platform/attachmentUpload";

export type {
  ChatFileUploadRecord,
  ChatFileUploadStatus,
  ChatFileUploadTransport,
} from "@ryco/client-runtime/state/composer";
export {
  isFileUploadTokenUsable,
  resolveFileUploadMaxBytes,
} from "@ryco/client-runtime/state/composer";

/**
 * Process-wide upload queue for composer file attachments. Records are keyed
 * by composer attachment id and hold bytes only in memory — the draft store
 * persists token metadata, never streamed bytes.
 */
export const composerFileUploadEngine = createChatFileUploadEngine(webChatFileUploadTransport, {
  watchReadiness: async (environmentId, onChange) => {
    // Lazy: the connection service imports composer drafts back.
    const { readEnvironmentConnection, subscribeEnvironmentConnections } =
      await import("./environments/runtime/service");
    return watchDirectChatFileUploadReadiness({
      environmentId,
      onChange,
      readConnection: () => readEnvironmentConnection(environmentId),
      canUpload: () =>
        getEnvironmentHttpBaseUrl(environmentId) !== null &&
        (readEnvironmentConnection(environmentId)?.kind === "primary" ||
          useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.authState ===
            "authenticated"),
      subscribe: (listener) => {
        const stopConnections = subscribeEnvironmentConnections(listener);
        const stopRuntime = useSavedEnvironmentRuntimeStore.subscribe(listener);
        const stopRegistry = useSavedEnvironmentRegistryStore.subscribe(listener);
        return () => {
          stopConnections();
          stopRuntime();
          stopRegistry();
        };
      },
    });
  },
});

if (import.meta.hot) import.meta.hot.dispose(() => composerFileUploadEngine.releaseAll());

/** Release only uploads previously owned by this composer, preserving other drafts. */
export function releaseUnusedComposerFileUploads(
  candidateIds: ReadonlySet<string>,
  retainedIds: ReadonlySet<string>,
): void {
  for (const id of candidateIds) {
    if (!retainedIds.has(id)) composerFileUploadEngine.release(id);
  }
}

/** Seeds an uploaded file restored from persisted draft/stash state. */
export function seedComposerFileUploadFromPersisted(input: {
  attachmentId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  uploadToken: string;
  expiresAt: string;
}): void {
  composerFileUploadEngine.seedUploaded({
    ...input,
    threadId: "" as never,
    environmentId: "" as EnvironmentId,
  });
}

/** Seeds a needsReattach row for a streamed file whose bytes were never kept. */
export function seedComposerFileNeedsReattach(attachmentId: string): void {
  composerFileUploadEngine.seedNeedsReattach(attachmentId);
}

/**
 * Returns the still-usable upload token for a file attachment, demoting the
 * record to needsReattach when its token expired.
 */
export function getUsableComposerFileUploadToken(
  attachmentId: string,
): { uploadToken: string; expiresAt: string } | null {
  const record = composerFileUploadEngine.get(attachmentId);
  if (!record || record.status.kind !== "uploaded") {
    return null;
  }
  if (!composerFileUploadEngine.verifyUsable(attachmentId, Date.now())) {
    return null;
  }
  const status = composerFileUploadEngine.get(attachmentId)?.status;
  return status?.kind === "uploaded"
    ? { uploadToken: status.uploadToken, expiresAt: status.expiresAt }
    : null;
}

/**
 * Send-block reason across the composer's attachments: uploading, failed,
 * needsReattach, or an expired token all hold the send back. A byte-less file
 * with a still-valid token on the attachment itself (e.g. restored from a
 * stash snapshot) sends fine without an engine record.
 */
export function deriveComposerFileUploadSendBlock(input: {
  readonly attachments: ReadonlyArray<{
    readonly id: string;
    readonly type: string;
    readonly name: string;
    readonly file: File | null;
    readonly uploadToken?: string | undefined;
    readonly expiresAt?: string | undefined;
  }>;
  readonly nowMs: number;
}): string | null {
  for (const attachment of input.attachments) {
    if (attachment.type !== "file") {
      continue;
    }
    const status = composerFileUploadEngine.get(attachment.id)?.status;
    if (status) {
      if (status.kind === "pending" || status.kind === "uploading") {
        return `Uploading '${attachment.name}'…`;
      }
      if (status.kind === "failed") {
        return `'${attachment.name}' failed to upload. ${status.message} Retry it or remove it.`;
      }
      if (
        status.kind === "needsReattach" ||
        (status.kind === "uploaded" && !isFileUploadTokenUsable(status.expiresAt, input.nowMs))
      ) {
        return `Attach '${attachment.name}' again to send this message.`;
      }
      continue;
    }
    if (attachment.file === null && !hasUsableTokenOnAttachment(attachment, input.nowMs)) {
      return `Attach '${attachment.name}' again to send this message.`;
    }
  }
  return null;
}

function hasUsableTokenOnAttachment(
  attachment: { uploadToken?: string | undefined; expiresAt?: string | undefined },
  nowMs: number,
): boolean {
  return (
    attachment.uploadToken !== undefined &&
    attachment.expiresAt !== undefined &&
    isFileUploadTokenUsable(attachment.expiresAt, nowMs)
  );
}

/** Live upload records for the composer UI; one snapshot per engine change. */
export function useComposerFileUploadRecords(): ReadonlyMap<string, ChatFileUploadRecord> {
  return useSyncExternalStore(
    composerFileUploadEngine.subscribe,
    () => composerFileUploadEngine.snapshot(),
    () => composerFileUploadEngine.snapshot(),
  );
}

/**
 * Streaming-upload byte limit advertised by the environment (null when the
 * connected server predates file uploads).
 */
export function useEnvironmentFileUploadCapability(environmentId: EnvironmentId): number | null {
  const runtimeDescriptor = useSavedEnvironmentRuntimeStore(
    (state) => state.byId[environmentId]?.descriptor ?? null,
  );
  const primaryDescriptor = usePrimaryEnvironmentDescriptor();
  const descriptor =
    primaryDescriptor?.environmentId === environmentId ? primaryDescriptor : runtimeDescriptor;
  return resolveFileUploadMaxBytes(descriptor?.capabilities);
}
