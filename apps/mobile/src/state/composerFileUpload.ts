import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import {
  createChatFileUploadEngine,
  watchDirectChatFileUploadReadiness,
  resolveFileUploadMaxBytes,
  type ChatFileUploadRecord,
} from "@ryco/client-runtime/state/composer";
import { useSyncExternalStore } from "react";

import { usePrimaryEnvironmentDescriptor } from "../hostedHub/primaryEnvironment";
import { mobileChatFileUploadTransport } from "../platform/attachmentUpload";
import { createMobileConnectionRegistry } from "../runtime/bootstrap";

export type {
  ChatFileUploadRecord,
  ChatFileUploadStatus,
  ChatFileUploadTransport,
} from "@ryco/client-runtime/state/composer";
export {
  deriveChatFileUploadSendBlock,
  isFileUploadTokenUsable,
  resolveFileUploadMaxBytes,
} from "@ryco/client-runtime/state/composer";

/**
 * Process-wide upload queue for composer file attachments, over the mobile
 * transport. Records are keyed by composer attachment id and hold bytes only
 * in memory — the outbox persists token metadata, never streamed bytes.
 */
export const composerFileUploadEngine = createChatFileUploadEngine(mobileChatFileUploadTransport, {
  watchReadiness: (environmentId, onChange) => {
    const { catalog, driver } = createMobileConnectionRegistry();
    return watchDirectChatFileUploadReadiness({
      environmentId,
      onChange,
      readConnection: () => driver.supervisor.read(environmentId),
      canUpload: () =>
        catalog.get(environmentId) !== null &&
        catalog.getRuntime(environmentId).authState === "authenticated",
      subscribe: (listener) => {
        const stopConnections = driver.supervisor.subscribe(listener);
        const stopRuntime = catalog.runtimeStore.subscribe(listener);
        const stopRegistry = catalog.registryStore.subscribe(listener);
        return () => {
          stopConnections();
          stopRuntime();
          stopRegistry();
        };
      },
    });
  },
});

/** Seeds an uploaded file restored from persisted outbox state. */
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
    threadId: "" as ThreadId,
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

/** Live upload records for the composer UI; one snapshot per engine change. */
export function useComposerFileUploadRecords(): ReadonlyMap<string, ChatFileUploadRecord> {
  return useSyncExternalStore(
    composerFileUploadEngine.subscribe,
    () => composerFileUploadEngine.snapshot(),
    () => composerFileUploadEngine.snapshot(),
  );
}

/** Streaming-upload byte limit for the environment, null when the connected
 * server predates file uploads OR the environment has no direct HTTP base
 * (hosted-relay primaries keep the legacy attach paths).
 */
export function useComposerFileUploadMaxBytes(environmentId: EnvironmentId): number | null {
  const catalog = createMobileConnectionRegistry().catalog;
  const httpBaseUrl = useSyncExternalStore(
    catalog.registryStore.subscribe,
    () => catalog.get(environmentId)?.httpBaseUrl ?? null,
    () => null,
  );
  const savedDescriptor = useSyncExternalStore(
    catalog.runtimeStore.subscribe,
    () => catalog.getRuntime(environmentId).descriptor,
    () => null,
  );
  const primaryDescriptor = usePrimaryEnvironmentDescriptor();
  const descriptor =
    primaryDescriptor?.environmentId === environmentId ? primaryDescriptor : savedDescriptor;
  const advertised = resolveFileUploadMaxBytes(descriptor?.capabilities);
  return advertised !== null && httpBaseUrl !== null ? advertised : null;
}
