import {
  createComposerDraftStore,
  type ComposerDraftStoreState as RuntimeComposerDraftStoreState,
  type ComposerThreadDraftState as RuntimeComposerThreadDraftState,
} from "@ryco/client-runtime/state/composer";

import type { ChatFileAttachment, ChatImageAttachment } from "./types";
import {
  collectComposerAttachmentBytes,
  composerAttachmentBytes,
  composerDraftStorage,
  composerDraftWriteScheduler,
  hydrateDraftImagesFromPersisted,
  readPersistedAttachmentIdsFromStorage,
  restoreComposerDraftAttachments,
} from "./composerDraftPersistence";

// The composer draft store's logic and Schema migrations live in
// `@ryco/client-runtime/state/composer`. This module is the web binding: it
// fixes the in-memory image type to the DOM-`File`-backed
// `ComposerImageAttachment`, wires the injected storage/lifecycle seams, and
// re-exports the package surface so existing importers keep their specifiers.
export * from "@ryco/client-runtime/state/composer";

/**
 * In-memory composer image on the web: the neutral draft image plus the live
 * DOM `File` and blob-preview URL the UI renders and sends. `File`/`Blob` never
 * cross into the package; the persisted shape stays `{ …, dataUrl }`.
 * Streamed file attachments restored from persisted state carry `file: null`
 * and are dispatched by upload token instead of inline bytes.
 */
export interface ComposerImageAttachment extends Omit<
  ChatImageAttachment | ChatFileAttachment,
  "previewUrl"
> {
  previewUrl: string;
  file: File | null;
  /** Single-use token for an already-streamed file; dispatches without bytes. */
  uploadToken?: string | undefined;
  expiresAt?: string | undefined;
  /**
   * Restored from a persisted draft whose bytes are still loading (IndexedDB,
   * or a legacy data URL): `file` is null until `ensureComposerDraftAttachmentsRestored`.
   */
  bytesPending?: true | undefined;
}

/** Concrete store state/draft types bound to the web image attachment. */
export type ComposerThreadDraftState = RuntimeComposerThreadDraftState<ComposerImageAttachment>;
export type ComposerDraftStoreState = RuntimeComposerDraftStoreState<ComposerImageAttachment>;

/** Blob-preview lifecycle stays app-side (Decision e). */
function revokeObjectPreviewUrl(previewUrl: string): void {
  if (typeof URL === "undefined") {
    return;
  }
  if (!previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

const composerDraftStore = createComposerDraftStore<ComposerImageAttachment>({
  storage: composerDraftStorage,
  flushStorage: () => composerDraftWriteScheduler.flush(),
  revokePreviewUrl: revokeObjectPreviewUrl,
  // Rows only: bytes load afterwards, so boot decodes nothing.
  hydrateImages: hydrateDraftImagesFromPersisted,
  readPersistedAttachmentIds: readPersistedAttachmentIdsFromStorage,
});

export const useComposerDraftStore = composerDraftStore.useComposerDraftStore;
export const markPromotedDraftThread = composerDraftStore.markPromotedDraftThread;
export const markPromotedDraftThreadByRef = composerDraftStore.markPromotedDraftThreadByRef;
export const markPromotedDraftThreads = composerDraftStore.markPromotedDraftThreads;
export const markPromotedDraftThreadsByRef = composerDraftStore.markPromotedDraftThreadsByRef;
export const finalizePromotedDraftThreadByRef = composerDraftStore.finalizePromotedDraftThreadByRef;
export const finalizePromotedDraftThreadsByRef =
  composerDraftStore.finalizePromotedDraftThreadsByRef;

const readDrafts = () => composerDraftStore.useComposerDraftStore.getState().draftsByThreadKey;

/**
 * Loads the bytes of restored draft attachments that are still pending. Runs
 * once the store has hydrated, off the boot path; a composer showing pending
 * attachments calls it again (it is idempotent and retries a failed read).
 */
export function ensureComposerDraftAttachmentsRestored(): Promise<void> {
  return restoreComposerDraftAttachments({
    readDrafts,
    restore: (threadKey, restored) =>
      composerDraftStore.useComposerDraftStore.getState().restoreDraftImages(threadKey, restored),
    bytes: composerAttachmentBytes,
  });
}

function restoreAfterHydration(): void {
  const run = () =>
    void ensureComposerDraftAttachmentsRestored().then(() =>
      collectComposerAttachmentBytes({ readDrafts, bytes: composerAttachmentBytes }),
    );
  if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 2_000 });
  else setTimeout(run, 0);
}

if (typeof window !== "undefined") {
  if (composerDraftStore.useComposerDraftStore.persist.hasHydrated()) restoreAfterHydration();
  else composerDraftStore.useComposerDraftStore.persist.onFinishHydration(restoreAfterHydration);
}
