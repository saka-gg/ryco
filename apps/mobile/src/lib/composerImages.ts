import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type UploadChatImageAttachment,
} from "@ryco/contracts/orchestration";
import { estimateBase64ByteSize } from "./base64";
import { uuidv4 } from "./uuid";

export interface DraftComposerImageAttachment extends UploadChatImageAttachment {
  readonly id: string;
  readonly previewUri: string;
}

/** Wire shape for startTurn: pure uploads without client draft id / previewUri. */
export function toUploadChatImageAttachments(
  attachments: ReadonlyArray<DraftComposerImageAttachment>,
): ReadonlyArray<UploadChatImageAttachment> {
  return attachments.map((attachment) => ({
    type: attachment.type,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    dataUrl: attachment.dataUrl,
  }));
}

const OWNED_PASTED_IMAGE_DIRECTORY = "t3-composer-paste";

export async function loadImagePicker() {
  try {
    return await import("expo-image-picker");
  } catch (error) {
    throw new Error("Image attachments are unavailable right now.", { cause: error });
  }
}

/** Leading base64 of each image format's magic bytes. */
const IMAGE_BASE64_SIGNATURES: ReadonlyArray<readonly [prefix: string, mimeType: string]> = [
  ["/9j/", "image/jpeg"],
  ["iVBORw0KGgo", "image/png"],
  ["R0lGOD", "image/gif"],
  ["UklGR", "image/webp"],
];

/** The image type the bytes themselves are, from their magic number; null when unknown. */
export function sniffImageMimeTypeFromBase64(base64: string): string | null {
  return IMAGE_BASE64_SIGNATURES.find(([prefix]) => base64.startsWith(prefix))?.[1] ?? null;
}

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

function renameForMimeType(name: string, mimeType: string): string {
  const extension = IMAGE_EXTENSIONS[mimeType];
  if (!extension) return name;
  const dot = name.lastIndexOf(".");
  return `${dot > 0 ? name.slice(0, dot) : name}.${extension}`;
}

/**
 * Converts one picked asset into a draft image attachment (inline base64
 * dataUrl + local preview uri). Shared by the photo pickers, the camera and
 * Files-app images.
 *
 * The attachment describes the base64 it sends, never the picked file: the
 * node rejects a payload whose decoded size differs from `sizeBytes`. iOS's
 * image picker re-encodes every image as JPEG for `base64` while `fileSize`
 * and `mimeType` still describe the original file (a PNG, or a JPEG of another
 * size), so both are taken from the payload itself.
 */
export function draftImageAttachmentFromPickerAsset(asset: {
  readonly mimeType?: string | undefined;
  readonly fileName?: string | null | undefined;
  readonly base64?: string | null | undefined;
  readonly fileSize?: number | null | undefined;
  readonly uri: string;
}): {
  readonly attachment: DraftComposerImageAttachment | null;
  readonly error: string | null;
} {
  const declaredMimeType = asset.mimeType?.toLowerCase();
  if (!declaredMimeType?.startsWith("image/")) {
    return {
      attachment: null,
      error: `Unsupported file type for '${asset.fileName ?? "image"}'.`,
    };
  }

  const base64 = asset.base64?.replace(/\s+/g, "");
  if (!base64) {
    return {
      attachment: null,
      error: `Failed to read '${asset.fileName ?? "image"}'.`,
    };
  }

  const sizeBytes = estimateBase64ByteSize(base64);
  if (sizeBytes <= 0 || sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
    return {
      attachment: null,
      error: `'${asset.fileName ?? "image"}' exceeds the 10 MB attachment limit.`,
    };
  }

  const mimeType = sniffImageMimeTypeFromBase64(base64) ?? declaredMimeType;
  const name = asset.fileName ?? "image";
  return {
    attachment: {
      id: uuidv4(),
      type: "image",
      name: mimeType === declaredMimeType ? name : renameForMimeType(name, mimeType),
      mimeType,
      sizeBytes,
      dataUrl: `data:${mimeType};base64,${base64}`,
      previewUri: asset.uri,
    },
    error: null,
  };
}

export async function pickComposerImages(input: { readonly existingCount: number }): Promise<{
  readonly images: ReadonlyArray<DraftComposerImageAttachment>;
  readonly error: string | null;
}> {
  const remainingSlots = PROVIDER_SEND_TURN_MAX_ATTACHMENTS - input.existingCount;
  if (remainingSlots <= 0) {
    return {
      images: [],
      error: `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images per message.`,
    };
  }

  let imagePicker: Awaited<ReturnType<typeof loadImagePicker>>;
  try {
    imagePicker = await loadImagePicker();
  } catch (error) {
    return {
      images: [],
      error:
        error instanceof Error ? error.message : "Image attachments are unavailable right now.",
    };
  }

  const permission = await imagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    return {
      images: [],
      error: "Allow photo library access to attach images.",
    };
  }

  const result = await imagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
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
    return {
      images: [],
      error: null,
    };
  }

  const nextImages: DraftComposerImageAttachment[] = [];
  let error: string | null = null;

  for (const asset of result.assets) {
    const result = draftImageAttachmentFromPickerAsset(asset);
    if (result.error) {
      error = result.error;
    }
    if (result.attachment) {
      nextImages.push(result.attachment);
    }
  }

  return {
    images: nextImages,
    error,
  };
}

function mimeTypeFromUri(uri: string): string {
  const ext = uri.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "heic":
      return "image/heic";
    default:
      return "image/png";
  }
}

export function isOwnedPastedImageUri(uri: string): boolean {
  try {
    const url = new URL(uri);
    if (url.protocol !== "file:") {
      return false;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    return (
      segments.at(-2) === OWNED_PASTED_IMAGE_DIRECTORY && segments.at(-1)?.endsWith(".png") === true
    );
  } catch {
    return false;
  }
}

export async function convertPastedImagesToAttachments(input: {
  readonly uris: ReadonlyArray<string>;
  readonly existingCount: number;
}): Promise<ReadonlyArray<DraftComposerImageAttachment>> {
  const { File } = await import("expo-file-system");
  const remainingSlots = PROVIDER_SEND_TURN_MAX_ATTACHMENTS - input.existingCount;
  const results: DraftComposerImageAttachment[] = [];

  for (const [index, uri] of input.uris.entries()) {
    const ownedTemporaryFile = isOwnedPastedImageUri(uri);
    try {
      if (index >= Math.max(0, remainingSlots)) {
        continue;
      }
      const file = new File(uri);
      const base64 = await file.base64();
      const sizeBytes = estimateBase64ByteSize(base64);
      if (sizeBytes <= 0 || sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
        continue;
      }
      const mimeType = sniffImageMimeTypeFromBase64(base64) ?? mimeTypeFromUri(uri);
      results.push({
        id: uuidv4(),
        type: "image",
        name: `pasted-image.${mimeType.split("/")[1] ?? "png"}`,
        mimeType,
        sizeBytes,
        dataUrl: `data:${mimeType};base64,${base64}`,
        previewUri: ownedTemporaryFile ? `data:${mimeType};base64,${base64}` : uri,
      });
    } catch (error) {
      console.warn("Failed to read pasted image", uri, error);
    } finally {
      if (ownedTemporaryFile) {
        try {
          const file = new File(uri);
          if (file.exists) {
            file.delete();
          }
        } catch (error) {
          console.warn("Failed to remove temporary pasted image", uri, error);
        }
      }
    }
  }

  return results;
}
