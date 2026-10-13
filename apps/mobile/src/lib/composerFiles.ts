import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
} from "@ryco/contracts/orchestration";

import {
  draftImageAttachmentFromPickerAsset,
  loadImagePicker,
  type DraftComposerImageAttachment,
} from "./composerImages";
import { uuidv4 } from "./uuid";

/**
 * A non-image composer attachment that streams through the shared upload
 * engine. `readUri` is the local file the picked asset points at — it is
 * transient (never persisted) and read only while uploading.
 */
export interface DraftComposerFileAttachment {
  readonly type: "file";
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly readUri: string;
  readonly uploadToken?: string;
  readonly expiresAt?: string;
  readonly uploadState?: "needsReattach";
}

export type DraftComposerAttachment = DraftComposerImageAttachment | DraftComposerFileAttachment;

export function isDraftComposerFileAttachment(
  attachment: DraftComposerAttachment,
): attachment is DraftComposerFileAttachment {
  return attachment.type === "file";
}

function formatUploadSizeLimitLabel(maxBytes: number): string {
  const streamingLimit = Math.min(maxBytes, PROVIDER_SEND_TURN_MAX_FILE_BYTES);
  return streamingLimit % (1024 * 1024) === 0
    ? `${Math.round(streamingLimit / (1024 * 1024))}MB`
    : `${Math.round(streamingLimit / 1024)}KB`;
}

/**
 * Pure gate for one picked non-image file, mirroring the web composer's
 * streaming limits: the capability ceiling (already min-ed with the provider
 * send-turn file limit by the shared `resolveFileUploadMaxBytes`) bounds the
 * file, alongside the shared count and total-bytes budgets.
 */
export function resolveComposerFileAttachment(input: {
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly readUri: string;
  readonly fileUploadMaxBytes: number;
  readonly existingCount: number;
  readonly existingTotalBytes: number;
}): {
  readonly attachment: DraftComposerFileAttachment | null;
  readonly error: string | null;
} {
  const name = input.name.trim() || "file";
  if (!/^[^/\\\p{Cc}]+$/u.test(name)) {
    return {
      attachment: null,
      error: `'${name}' has an unsafe filename. Rename it without path separators or control characters.`,
    };
  }
  if (input.sizeBytes <= 0 || input.sizeBytes > input.fileUploadMaxBytes) {
    return {
      attachment: null,
      error: `'${name}' must be non-empty and no larger than the ${formatUploadSizeLimitLabel(input.fileUploadMaxBytes)} attachment limit.`,
    };
  }
  if (input.existingCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
    return {
      attachment: null,
      error: `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`,
    };
  }
  if (input.existingTotalBytes + input.sizeBytes > PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES) {
    return {
      attachment: null,
      error: "Attachments can total at most 50MB per message.",
    };
  }
  return {
    attachment: {
      type: "file",
      id: uuidv4(),
      name,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      readUri: input.readUri,
    },
    error: null,
  };
}

/** Reads the picked file's bytes at upload time (RN file uri, no DOM File). */
export async function readComposerFileBytes(readUri: string): Promise<Uint8Array> {
  const { File } = await import("expo-file-system");
  return await new File(readUri).bytes();
}

export interface PickComposerAttachmentsResult {
  readonly images: ReadonlyArray<DraftComposerImageAttachment>;
  readonly files: ReadonlyArray<DraftComposerFileAttachment>;
  readonly error: string | null;
}

/**
 * Capability-routed library picker. With a `fileAttachments` capability the
 * picker offers images and videos and routes non-images into streaming file
 * rows; without it only the legacy inline dataUrl image path is reachable and
 * file picking stays hidden.
 */
export async function pickComposerAttachments(input: {
  readonly existingCount: number;
  readonly existingTotalBytes: number;
  readonly fileUploadMaxBytes: number | null;
}): Promise<PickComposerAttachmentsResult> {
  const remainingSlots = PROVIDER_SEND_TURN_MAX_ATTACHMENTS - input.existingCount;
  if (remainingSlots <= 0) {
    return {
      images: [],
      files: [],
      error: `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`,
    };
  }

  let imagePicker: Awaited<ReturnType<typeof loadImagePicker>>;
  try {
    imagePicker = await loadImagePicker();
  } catch (error) {
    return {
      images: [],
      files: [],
      error: error instanceof Error ? error.message : "Attachments are unavailable right now.",
    };
  }

  const permission = await imagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    return {
      images: [],
      files: [],
      error: "Allow photo library access to attach files.",
    };
  }

  const result = await imagePicker.launchImageLibraryAsync({
    mediaTypes: input.fileUploadMaxBytes !== null ? ["images", "videos"] : ["images"],
    allowsMultipleSelection: true,
    selectionLimit: remainingSlots,
    base64: true,
    quality: 1,
  });

  if (result.canceled) {
    return { images: [], files: [], error: null };
  }

  const nextImages: DraftComposerImageAttachment[] = [];
  const nextFiles: DraftComposerFileAttachment[] = [];
  let nextTotalBytes = input.existingTotalBytes;
  let error: string | null = null;

  for (const asset of result.assets) {
    const mimeType = asset.mimeType?.toLowerCase();
    if (mimeType?.startsWith("image/")) {
      const imageResult = draftImageAttachmentFromPickerAsset(asset);
      if (imageResult.error) {
        error = imageResult.error;
      }
      if (imageResult.attachment) {
        nextImages.push(imageResult.attachment);
        nextTotalBytes += imageResult.attachment.sizeBytes;
      }
      continue;
    }

    if (input.fileUploadMaxBytes === null) {
      error = `Unsupported file type for '${asset.fileName ?? "file"}'.`;
      continue;
    }
    const fileResult = resolveComposerFileAttachment({
      name: asset.fileName ?? "file",
      mimeType: mimeType ?? "application/octet-stream",
      sizeBytes: asset.fileSize ?? 0,
      readUri: asset.uri,
      fileUploadMaxBytes: input.fileUploadMaxBytes,
      existingCount: input.existingCount + nextImages.length + nextFiles.length,
      existingTotalBytes: nextTotalBytes,
    });
    if (fileResult.error) {
      error = fileResult.error;
    }
    if (fileResult.attachment) {
      nextFiles.push(fileResult.attachment);
      nextTotalBytes += fileResult.attachment.sizeBytes;
    }
  }

  return {
    images: nextImages,
    files: nextFiles,
    error,
  };
}
