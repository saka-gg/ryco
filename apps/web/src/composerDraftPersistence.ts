import {
  type ComposerDraftStorage,
  composerDraftEntryStorageKey,
  PersistedComposerImageAttachment,
} from "@ryco/client-runtime/state/composer";
import { Option, Schema } from "effect";

import { isHostedHubMode } from "./env";
import { createMemoryStorage, createWriteScheduler, type StateStorage } from "./lib/storage";
import {
  type ComposerAttachmentBytesStore,
  createComposerAttachmentBytesStore,
} from "./composerAttachmentBytes";
import {
  seedComposerFileNeedsReattach,
  seedComposerFileUploadFromPersisted,
} from "./composerFileUpload";
import type { ComposerImageAttachment } from "./composerDraftStore";

// ---------------------------------------------------------------------------
// Browser persistence adapter for the composer draft store.
//
// The Schema migrations, the split draft entries, and key builders live in
// `@ryco/client-runtime/state/composer`. This module owns the web-only
// concerns the package deliberately excludes: the localStorage binding and its
// debounced, unload-flushed writes, attachment bytes in IndexedDB, the
// persisted-attachment id read, and turning persisted attachments back into
// `File`s at the UI boundary.
// ---------------------------------------------------------------------------

const COMPOSER_PERSIST_DEBOUNCE_MS = 300;
/** Bytes newer than this are never collected: another tab may not have written their draft yet. */
const ATTACHMENT_BYTES_GC_MIN_AGE_MS = 60 * 60 * 1000;

// Hosted mode keeps drafts in memory only: nothing is durably persisted.
const durableDrafts = typeof localStorage !== "undefined" && !isHostedHubMode();
const draftKeyValueStorage: StateStorage = durableDrafts ? localStorage : createMemoryStorage();

export const composerDraftWriteScheduler = createWriteScheduler(COMPOSER_PERSIST_DEBOUNCE_MS);

export const composerAttachmentBytes: ComposerAttachmentBytesStore | null =
  durableDrafts && typeof indexedDB !== "undefined"
    ? createComposerAttachmentBytesStore(indexedDB)
    : null;

/** Attachment ids whose bytes are known to be in IndexedDB, so persisting them again is free. */
const storedAttachmentIds = new Set<string>();

export const composerDraftStorage: ComposerDraftStorage = {
  getItem: (name) => draftKeyValueStorage.getItem(name),
  setItem: (name, value) => draftKeyValueStorage.setItem(name, value),
  removeItem: (name) => draftKeyValueStorage.removeItem(name),
  scheduleWrite: (flush) => composerDraftWriteScheduler.schedule(flush),
  ...(durableDrafts
    ? {
        keys: () => {
          const keys: string[] = [];
          for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);
            if (key !== null) keys.push(key);
          }
          return keys;
        },
      }
    : {}),
  releaseAttachments: (attachmentIds) => {
    for (const id of attachmentIds) storedAttachmentIds.delete(id);
    void composerAttachmentBytes?.deleteMany(attachmentIds).catch(() => undefined);
  },
  onWriteError: (key, error) => {
    console.warn("A composer draft could not be saved.", { key, error });
  },
};

// Flush pending composer draft writes before the page goes away to prevent data loss.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", () => composerDraftWriteScheduler.flush());
  window.addEventListener("pagehide", () => composerDraftWriteScheduler.flush());
}

const decodePersistedAttachments = Schema.decodeUnknownOption(
  Schema.Array(PersistedComposerImageAttachment),
);

function readRecordField(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** The attachment ids persisted for one thread, read from that thread's draft entry only. */
export function readPersistedAttachmentIdsFromStorage(threadKey: string): string[] {
  if (threadKey.length === 0 || typeof window === "undefined" || !durableDrafts) {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(composerDraftEntryStorageKey(threadKey));
    if (raw === null) return [];
    const attachments = readRecordField(JSON.parse(raw), "attachments");
    if (attachments === undefined) return [];
    const decoded = decodePersistedAttachments(attachments);
    return Option.isSome(decoded) ? decoded.value.map((attachment) => attachment.id) : [];
  } catch {
    return [];
  }
}

/**
 * The persisted record for a composer image whose bytes go to IndexedDB, or
 * null when they cannot (hosted mode, no IndexedDB, a failed write): the
 * caller then persists a data URL as before.
 */
export async function persistComposerImageBytes(
  image: Pick<ComposerImageAttachment, "type" | "id" | "name" | "mimeType" | "sizeBytes"> & {
    readonly file: File;
  },
): Promise<PersistedComposerImageAttachment | null> {
  if (composerAttachmentBytes === null) return null;
  if (!storedAttachmentIds.has(image.id)) {
    try {
      await composerAttachmentBytes.put(image.id, image.file);
    } catch {
      return null;
    }
    storedAttachmentIds.add(image.id);
  }
  return {
    type: image.type,
    id: image.id,
    name: image.name,
    mimeType: image.mimeType,
    sizeBytes: image.sizeBytes,
    bytes: "local",
  };
}

function decodeDataUrlBlob(dataUrl: string, fallbackMimeType: string): Blob | null {
  const commaIndex = dataUrl.indexOf(",");
  const header = commaIndex === -1 ? dataUrl : dataUrl.slice(0, commaIndex);
  const payload = commaIndex === -1 ? "" : dataUrl.slice(commaIndex + 1);
  if (payload.length === 0) {
    return null;
  }
  try {
    if (!header.includes(";base64")) {
      const inferredMimeType =
        header.startsWith("data:") && header.includes(";")
          ? header.slice("data:".length, header.indexOf(";"))
          : fallbackMimeType;
      return new Blob([decodeURIComponent(payload)], {
        type: inferredMimeType || fallbackMimeType,
      });
    }
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type: fallbackMimeType });
  } catch {
    return null;
  }
}

function hydratePersistedComposerImageAttachment(
  attachment: PersistedComposerImageAttachment,
  dataUrl: string,
): File | null {
  const blob = decodeDataUrlBlob(dataUrl, attachment.mimeType);
  return blob
    ? new File([blob], attachment.name, { type: blob.type || attachment.mimeType })
    : null;
}

/** The in-memory row for a persisted streamed file: it carries no bytes, only its upload state. */
function hydrateStreamedFileAttachment(
  attachment: PersistedComposerImageAttachment,
): ComposerImageAttachment {
  if (attachment.uploadToken && attachment.expiresAt) {
    seedComposerFileUploadFromPersisted({
      attachmentId: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      uploadToken: attachment.uploadToken,
      expiresAt: attachment.expiresAt,
    });
  } else {
    seedComposerFileNeedsReattach(attachment.id);
  }
  return {
    type: "file",
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    previewUrl: "",
    file: null,
  };
}

const attachmentType = (attachment: PersistedComposerImageAttachment) =>
  attachment.type ?? (attachment.mimeType.startsWith("image/") ? "image" : "file");

/**
 * Draft hydration: rows for every persisted attachment without reading or
 * decoding any bytes. Attachments with bytes come back `bytesPending` (a data
 * URL still previews directly) until `restoreComposerDraftAttachments` loads
 * them, off the boot path.
 */
export function hydrateDraftImagesFromPersisted(
  attachments: ReadonlyArray<PersistedComposerImageAttachment>,
): ComposerImageAttachment[] {
  return attachments.map((attachment) =>
    !attachment.dataUrl && attachment.bytes !== "local"
      ? hydrateStreamedFileAttachment(attachment)
      : {
          type: attachmentType(attachment),
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          previewUrl: attachment.dataUrl ?? "",
          file: null,
          bytesPending: true,
        },
  );
}

/**
 * Eager decode, for prompt stash entries (which keep data URLs): the
 * in-memory `ComposerImageAttachment` with a DOM `File`, at once.
 */
export function hydrateImagesFromPersistedWithFailures(
  attachments: ReadonlyArray<PersistedComposerImageAttachment>,
): {
  images: ComposerImageAttachment[];
  unreadableImageNames: string[];
} {
  const images: ComposerImageAttachment[] = [];
  const unreadableImageNames: string[] = [];
  for (const attachment of attachments) {
    if (!attachment.dataUrl) {
      images.push(hydrateStreamedFileAttachment(attachment));
      continue;
    }
    const file = hydratePersistedComposerImageAttachment(attachment, attachment.dataUrl);
    if (!file) {
      unreadableImageNames.push(attachment.name);
      continue;
    }
    images.push({
      type: attachmentType(attachment),
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      previewUrl: attachment.dataUrl,
      file,
    });
  }
  return { images, unreadableImageNames };
}

interface RestorableDraft {
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly persistedAttachments: ReadonlyArray<PersistedComposerImageAttachment>;
}

export interface RestoreComposerDraftAttachmentsInput {
  readonly readDrafts: () => Readonly<Record<string, RestorableDraft>>;
  readonly restore: (
    threadKey: string,
    restored: ReadonlyArray<{
      readonly id: string;
      readonly image: ComposerImageAttachment | null;
      readonly persisted?: PersistedComposerImageAttachment | undefined;
    }>,
  ) => void;
  readonly bytes: ComposerAttachmentBytesStore | null;
  readonly createObjectUrl?: (blob: Blob) => string;
}

const restoringAttachmentIds = new Set<string>();

/**
 * Loads the bytes of every `bytesPending` draft image: from IndexedDB, or by
 * decoding a data URL persisted before bytes moved there (which then moves
 * them, so the draft entry sheds the data URL). An image whose stored bytes
 * are gone is dropped from its draft, as an unreadable data URL always was.
 * If IndexedDB itself fails, images stay pending and the next call retries.
 */
export async function restoreComposerDraftAttachments(
  input: RestoreComposerDraftAttachmentsInput,
): Promise<void> {
  const createObjectUrl =
    input.createObjectUrl ??
    ((blob: Blob) => (typeof URL.createObjectURL === "function" ? URL.createObjectURL(blob) : ""));
  const work: Array<{
    readonly threadKey: string;
    readonly image: ComposerImageAttachment;
    readonly persisted: PersistedComposerImageAttachment | undefined;
  }> = [];
  for (const [threadKey, draft] of Object.entries(input.readDrafts())) {
    const persistedById = new Map(
      draft.persistedAttachments.map((attachment) => [attachment.id, attachment]),
    );
    for (const image of draft.images) {
      if (!image.bytesPending || restoringAttachmentIds.has(image.id)) continue;
      restoringAttachmentIds.add(image.id);
      work.push({ threadKey, image, persisted: persistedById.get(image.id) });
    }
  }
  if (work.length === 0) return;
  try {
    const localIds = work.flatMap((item) =>
      item.persisted?.bytes === "local" ? [item.image.id] : [],
    );
    let stored: Map<string, Blob>;
    try {
      stored = localIds.length > 0 && input.bytes ? await input.bytes.getMany(localIds) : new Map();
    } catch {
      return;
    }
    for (const id of stored.keys()) storedAttachmentIds.add(id);

    const restoredByThread = new Map<
      string,
      Array<{
        readonly id: string;
        readonly image: ComposerImageAttachment | null;
        readonly persisted?: PersistedComposerImageAttachment | undefined;
      }>
    >();
    for (const { threadKey, image, persisted } of work) {
      let blob: Blob | null = null;
      let replacement: PersistedComposerImageAttachment | undefined;
      if (persisted?.bytes === "local") {
        blob = stored.get(image.id) ?? null;
      } else if (persisted?.dataUrl) {
        blob = decodeDataUrlBlob(persisted.dataUrl, persisted.mimeType);
        if (blob && input.bytes) {
          try {
            await input.bytes.put(image.id, blob);
            storedAttachmentIds.add(image.id);
            const { dataUrl: _dataUrl, ...rest } = persisted;
            replacement = { ...rest, bytes: "local" };
          } catch {
            // Keep the data URL: the bytes stay where they were.
          }
        }
      }
      const restored = restoredByThread.get(threadKey) ?? [];
      restoredByThread.set(threadKey, restored);
      if (blob === null) {
        restored.push({ id: image.id, image: null });
        continue;
      }
      const file = new File([blob], image.name, { type: blob.type || image.mimeType });
      restored.push({
        id: image.id,
        image: {
          ...image,
          file,
          previewUrl:
            image.type === "image" ? createObjectUrl(file) || image.previewUrl : image.previewUrl,
          bytesPending: undefined,
        },
        ...(replacement ? { persisted: replacement } : {}),
      });
    }
    for (const [threadKey, restored] of restoredByThread) input.restore(threadKey, restored);
  } finally {
    for (const item of work) restoringAttachmentIds.delete(item.image.id);
  }
}

/** Deletes IndexedDB bytes no persisted draft references (older than an hour). */
export async function collectComposerAttachmentBytes(input: {
  readonly readDrafts: () => Readonly<Record<string, RestorableDraft>>;
  readonly bytes: ComposerAttachmentBytesStore | null;
  readonly now?: () => number;
}): Promise<number> {
  if (input.bytes === null) return 0;
  const keep = new Set(storedAttachmentIds);
  for (const draft of Object.values(input.readDrafts())) {
    for (const attachment of draft.persistedAttachments) keep.add(attachment.id);
    for (const image of draft.images) keep.add(image.id);
  }
  try {
    return await input.bytes.deleteUnreferenced(
      keep,
      (input.now ?? Date.now)() - ATTACHMENT_BYTES_GC_MIN_AGE_MS,
    );
  } catch {
    return 0;
  }
}

export function resetComposerAttachmentRestoreForTests(): void {
  restoringAttachmentIds.clear();
  storedAttachmentIds.clear();
}
