import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
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
    // iOS hands over a JPEG for a HEIC photo: no provider reads HEIC, and only a Mac node could
    // convert it.
    preferredAssetRepresentationMode:
      imagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
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

/** Where the composer's attach menu takes attachments from. */
export type ComposerAttachmentSource = "library" | "camera" | "files";

/** The draft's count and total-bytes budget, and the node's streaming file limit. */
export interface ComposerAttachmentBudget {
  readonly existingCount: number;
  readonly existingTotalBytes: number;
  /** Null when the node cannot take streamed files: only images can be attached then. */
  readonly fileUploadMaxBytes: number | null;
}

/** Image types every provider reads inline; anything else is sent as a file. */
const INLINE_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * How a file picked in the Files app is attached: a small common image goes
 * inline like a photo (with a preview), anything else streams as a file, and
 * without streaming support only inline images can be attached.
 */
export function classifyPickedDocument(input: {
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly fileUploadMaxBytes: number | null;
}): "image" | "file" | { readonly error: string } {
  const mimeType = input.mimeType.toLowerCase();
  const inlineImage =
    INLINE_IMAGE_MIME_TYPES.has(mimeType) &&
    input.sizeBytes > 0 &&
    input.sizeBytes <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES;
  if (inlineImage) return "image";
  if (input.fileUploadMaxBytes !== null) return "file";
  return {
    error: `'${input.name}' can't be attached: this machine only takes images in messages. Update Ryco on it to send files.`,
  };
}

function attachmentLimitError(): string {
  return `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`;
}

/**
 * Files from the Files app (iCloud Drive, On My iPhone, other providers). The
 * picker copies each one into the app's cache, which the upload reads later.
 */
export async function pickComposerDocuments(
  input: ComposerAttachmentBudget,
): Promise<PickComposerAttachmentsResult> {
  const remainingSlots = PROVIDER_SEND_TURN_MAX_ATTACHMENTS - input.existingCount;
  if (remainingSlots <= 0) return { images: [], files: [], error: attachmentLimitError() };

  let result: Awaited<ReturnType<typeof import("expo-document-picker").getDocumentAsync>>;
  try {
    const { getDocumentAsync } = await import("expo-document-picker");
    result = await getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
  } catch (error) {
    return {
      images: [],
      files: [],
      error: error instanceof Error ? error.message : "Could not open the file picker.",
    };
  }
  if (result.canceled) return { images: [], files: [], error: null };

  const images: DraftComposerImageAttachment[] = [];
  const files: DraftComposerFileAttachment[] = [];
  let totalBytes = input.existingTotalBytes;
  let error: string | null = null;
  for (const asset of result.assets) {
    if (images.length + files.length >= remainingSlots) {
      error = attachmentLimitError();
      break;
    }
    const name = asset.name.trim() || "file";
    const mimeType = asset.mimeType?.trim() || "application/octet-stream";
    const sizeBytes = asset.size ?? 0;
    const kind = classifyPickedDocument({
      name,
      mimeType,
      sizeBytes,
      fileUploadMaxBytes: input.fileUploadMaxBytes,
    });
    if (typeof kind === "object") {
      error = kind.error;
      continue;
    }
    if (kind === "image") {
      try {
        const { File } = await import("expo-file-system");
        const base64 = await new File(asset.uri).base64();
        const image = draftImageAttachmentFromPickerAsset({
          mimeType,
          fileName: name,
          base64,
          fileSize: sizeBytes,
          uri: asset.uri,
        });
        if (image.error) error = image.error;
        if (image.attachment) {
          images.push(image.attachment);
          totalBytes += image.attachment.sizeBytes;
        }
      } catch {
        error = `Failed to read '${name}'.`;
      }
      continue;
    }
    const file = resolveComposerFileAttachment({
      name,
      mimeType,
      sizeBytes,
      readUri: asset.uri,
      fileUploadMaxBytes: input.fileUploadMaxBytes as number,
      existingCount: input.existingCount + images.length + files.length,
      existingTotalBytes: totalBytes,
    });
    if (file.error) error = file.error;
    if (file.attachment) {
      files.push(file.attachment);
      totalBytes += file.attachment.sizeBytes;
    }
  }
  return { images, files, error };
}

/** One photo from the camera, attached inline like a library photo. */
export async function captureComposerPhoto(
  input: Pick<ComposerAttachmentBudget, "existingCount">,
): Promise<PickComposerAttachmentsResult> {
  if (input.existingCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
    return { images: [], files: [], error: attachmentLimitError() };
  }
  // Loaded here, not at the top: the native-module lookup has no place in the
  // pure attachment gates this file also holds.
  const { isCameraCaptureAvailable } = await import("./cameraAvailability");
  if (!isCameraCaptureAvailable()) {
    return { images: [], files: [], error: "This device has no camera." };
  }
  try {
    const imagePicker = await loadImagePicker();
    const permission = await imagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      return { images: [], files: [], error: "Allow camera access to take a photo." };
    }
    const result = await imagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      base64: true,
      quality: 0.8,
    });
    if (result.canceled) return { images: [], files: [], error: null };
    const images: DraftComposerImageAttachment[] = [];
    let error: string | null = null;
    for (const asset of result.assets) {
      const image = draftImageAttachmentFromPickerAsset({
        ...asset,
        fileName: asset.fileName ?? "photo.jpg",
      });
      if (image.error) error = image.error;
      if (image.attachment) images.push(image.attachment);
    }
    return { images, files: [], error };
  } catch {
    return { images: [], files: [], error: "The camera is not available on this device." };
  }
}

/** Opens the source the user chose in the attach menu. */
export function pickComposerAttachmentsFrom(
  source: ComposerAttachmentSource,
  budget: ComposerAttachmentBudget,
): Promise<PickComposerAttachmentsResult> {
  switch (source) {
    case "library":
      return pickComposerAttachments(budget);
    case "camera":
      return captureComposerPhoto(budget);
    case "files":
      return pickComposerDocuments(budget);
  }
}
