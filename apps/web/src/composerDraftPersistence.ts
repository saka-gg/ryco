import {
  COMPOSER_DRAFT_STORAGE_KEY,
  COMPOSER_DRAFT_STORAGE_VERSION,
  PersistedComposerImageAttachment,
} from "@ryco/client-runtime/state/composer";
import { Option, Schema } from "effect";

import { isHostedHubMode } from "./env";
import { createDebouncedStorage, createMemoryStorage } from "./lib/storage";
import {
  seedComposerFileNeedsReattach,
  seedComposerFileUploadFromPersisted,
} from "./composerFileUpload";
import type { ComposerImageAttachment } from "./composerDraftStore";

// ---------------------------------------------------------------------------
// Browser persistence adapter for the composer draft store.
//
// The Schema migrations (v1–v7), persisted-shape normalization, and key
// builders live in `@ryco/client-runtime/state/composer`. This module owns the
// web-only concerns the package deliberately excludes: the localStorage
// binding, the `beforeunload` flush, the persisted-attachment id read, and the
// dataURL→`File` rehydration at the UI boundary.
// ---------------------------------------------------------------------------

const COMPOSER_PERSIST_DEBOUNCE_MS = 300;

export const composerDebouncedStorage = createDebouncedStorage(
  typeof localStorage !== "undefined" && !isHostedHubMode() ? localStorage : createMemoryStorage(),
  COMPOSER_PERSIST_DEBOUNCE_MS,
);

// Flush pending composer draft writes before page unload to prevent data loss.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", () => {
    composerDebouncedStorage.flush();
  });
}

const decodePersistedAttachments = Schema.decodeUnknownOption(
  Schema.Array(PersistedComposerImageAttachment),
);

function readRecordField(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * The attachment ids persisted for one thread. Decodes only that thread's
 * attachments instead of Schema-decoding every draft (and every image data
 * URL) in the persisted blob.
 */
export function readPersistedAttachmentIdsFromStorage(threadKey: string): string[] {
  // Hosted mode keeps drafts in memory only: nothing is durably persisted.
  if (threadKey.length === 0 || typeof window === "undefined" || isHostedHubMode()) {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY);
    if (raw === null) return [];
    const persisted: unknown = JSON.parse(raw);
    if (readRecordField(persisted, "version") !== COMPOSER_DRAFT_STORAGE_VERSION) {
      return [];
    }
    const draftsByThreadKey = readRecordField(
      readRecordField(persisted, "state"),
      "draftsByThreadKey",
    );
    const attachments = readRecordField(
      readRecordField(draftsByThreadKey, threadKey),
      "attachments",
    );
    if (attachments === undefined) return [];
    const decoded = decodePersistedAttachments(attachments);
    return Option.isSome(decoded) ? decoded.value.map((attachment) => attachment.id) : [];
  } catch {
    return [];
  }
}

function hydratePersistedComposerImageAttachment(
  attachment: PersistedComposerImageAttachment,
  dataUrl: string,
): File | null {
  const commaIndex = dataUrl.indexOf(",");
  const header = commaIndex === -1 ? dataUrl : dataUrl.slice(0, commaIndex);
  const payload = commaIndex === -1 ? "" : dataUrl.slice(commaIndex + 1);
  if (payload.length === 0) {
    return null;
  }
  try {
    const isBase64 = header.includes(";base64");
    if (!isBase64) {
      const decodedText = decodeURIComponent(payload);
      const inferredMimeType =
        header.startsWith("data:") && header.includes(";")
          ? header.slice("data:".length, header.indexOf(";"))
          : attachment.mimeType;
      return new File([decodedText], attachment.name, {
        type: inferredMimeType || attachment.mimeType,
      });
    }
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new File([bytes], attachment.name, { type: attachment.mimeType });
  } catch {
    return null;
  }
}

/**
 * Web-side decode boundary: rehydrate the neutral persisted attachments
 * (dataURL-encoded) into the in-memory `ComposerImageAttachment` shape that
 * carries a DOM `File` and a blob-preview URL.
 */
export function hydrateImagesFromPersisted(
  attachments: ReadonlyArray<PersistedComposerImageAttachment>,
): ComposerImageAttachment[] {
  return hydrateImagesFromPersistedWithFailures(attachments).images;
}

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
      // Streamed file attachment: bytes were never client-persisted, so the
      // row restores from token metadata (or as an "attach again" stub).
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
      images.push({
        type: "file",
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        previewUrl: "",
        file: null,
      });
      continue;
    }
    const file = hydratePersistedComposerImageAttachment(attachment, attachment.dataUrl);
    if (!file) {
      unreadableImageNames.push(attachment.name);
      continue;
    }
    images.push({
      type: attachment.type ?? (attachment.mimeType.startsWith("image/") ? "image" : "file"),
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
