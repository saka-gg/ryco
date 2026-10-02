import { randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ChatAttachment,
  type ChatFileAttachment,
  type ChatImageAttachment,
} from "@ryco/contracts";

import {
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths.ts";
import { inferImageExtension, SAFE_IMAGE_FILE_EXTENSIONS } from "./imageMime.ts";

const ATTACHMENT_FILENAME_EXTENSIONS = [...SAFE_IMAGE_FILE_EXTENSIONS, ".bin"];
const ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS = 80;
const ATTACHMENT_ID_THREAD_SEGMENT_PATTERN = "[a-z0-9_]+(?:-[a-z0-9_]+)*";
const ATTACHMENT_ID_UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ATTACHMENT_ID_EXTENSION_SEGMENT_MAX_CHARS = 12;
const ATTACHMENT_ID_PATTERN = new RegExp(
  `^(${ATTACHMENT_ID_THREAD_SEGMENT_PATTERN})-(${ATTACHMENT_ID_UUID_PATTERN})$`,
  "i",
);
const ATTACHMENT_ID_WITH_EXTENSION_PATTERN = new RegExp(
  `^(${ATTACHMENT_ID_THREAD_SEGMENT_PATTERN})-(${ATTACHMENT_ID_UUID_PATTERN})-([a-z0-9]{1,${ATTACHMENT_ID_EXTENSION_SEGMENT_MAX_CHARS}})$`,
  "i",
);

const PART_EXTENSION_SEGMENT = "part";
const FALLBACK_EXTENSION_SEGMENT = "bin";

export function toSafeThreadAttachmentSegment(threadId: string): string | null {
  const segment = threadId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS)
    .replace(/[-_]+$/g, "");
  if (segment.length === 0) {
    return null;
  }
  return segment;
}

export function createAttachmentId(threadId: string): string | null {
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (!threadSegment) {
    return null;
  }
  return `${threadSegment}-${randomUUID()}`;
}

/**
 * Derives the safe extension segment baked into streamed-upload attachment
 * ids so the persisted path resolves directly from the id without probing a
 * list of extensions. A `part` segment is remapped to `bin` so a final file
 * can never collide with the `<name>.part` staging namespace used while an
 * upload is still streaming.
 */
export function toSafeFileAttachmentExtensionSegment(name: string): string {
  const dotIndex = name.lastIndexOf(".");
  const rawExtension = dotIndex >= 0 && dotIndex < name.length - 1 ? name.slice(dotIndex + 1) : "";
  const segment = rawExtension
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, ATTACHMENT_ID_EXTENSION_SEGMENT_MAX_CHARS);
  if (segment.length === 0 || segment === PART_EXTENSION_SEGMENT) {
    return FALLBACK_EXTENSION_SEGMENT;
  }
  return segment;
}

/**
 * Attachment ids for streamed general-file uploads carry a sanitized
 * extension segment (`<thread>-<uuid>-<ext>`) so the on-disk file name is
 * exactly the id. `*.part` staging files live outside this namespace.
 */
export function createFileAttachmentId(threadId: string, name: string): string | null {
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (!threadSegment) {
    return null;
  }
  return `${threadSegment}-${randomUUID()}-${toSafeFileAttachmentExtensionSegment(name)}`;
}

export function parseThreadSegmentFromAttachmentId(attachmentId: string): string | null {
  const normalizedId = normalizeAttachmentRelativePath(attachmentId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return null;
  }
  const match =
    normalizedId.match(ATTACHMENT_ID_PATTERN) ??
    normalizedId.match(ATTACHMENT_ID_WITH_EXTENSION_PATTERN);
  if (!match) {
    return null;
  }
  return match[1]?.toLowerCase() ?? null;
}

export function isPersistableChatAttachment(
  attachment: ChatAttachment,
): attachment is ChatImageAttachment | ChatFileAttachment {
  return attachment.type === "image" || attachment.type === "file";
}

export function attachmentRelativePath(attachment: ChatAttachment): string | null {
  if (!isPersistableChatAttachment(attachment)) {
    return null;
  }
  switch (attachment.type) {
    case "image": {
      const extension = inferImageExtension({
        mimeType: attachment.mimeType,
        fileName: attachment.name,
      });
      return `${attachment.id}${extension}`;
    }
    case "file":
      // Streamed uploads bake a sanitized extension segment into the id and
      // the on-disk file name is exactly the id. Legacy general files keep
      // the opaque `.bin` extension; display names and MIME types never
      // influence a path.
      return ATTACHMENT_ID_WITH_EXTENSION_PATTERN.test(attachment.id)
        ? attachment.id
        : `${attachment.id}.bin`;
  }
}

export function resolveAttachmentPath(input: {
  readonly attachmentsDir: string;
  readonly attachment: ChatAttachment;
}): string | null {
  const relativePath = attachmentRelativePath(input.attachment);
  if (relativePath === null) {
    return null;
  }
  return resolveAttachmentRelativePath({
    attachmentsDir: input.attachmentsDir,
    relativePath,
  });
}

export type PersistedAttachmentRead =
  | { readonly ok: true; readonly bytes: Buffer; readonly sizeBytes: number }
  | { readonly ok: false; readonly reason: string };

function attachmentByteLimit(attachment: ChatAttachment): number {
  return attachment.type === "image"
    ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
    : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
}

/**
 * Opens and reads a persisted attachment through one descriptor. Comparing
 * the path's lstat identity with the opened descriptor prevents a path or
 * symlink swap between validation and read, including on platforms without a
 * useful O_NOFOLLOW flag.
 */
export async function readPersistedAttachment(input: {
  readonly attachmentsDir: string;
  readonly attachment: ChatAttachment;
}): Promise<PersistedAttachmentRead> {
  const attachmentPath = resolveAttachmentPath(input);
  if (!attachmentPath) {
    return { ok: false, reason: `Invalid attachment id '${input.attachment.id}'.` };
  }

  let descriptor: FileHandle | undefined;
  try {
    const pathInfo = await lstat(attachmentPath);
    if (!pathInfo.isFile()) {
      return {
        ok: false,
        reason: `Attachment '${input.attachment.name}' is not a regular file.`,
      };
    }
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    descriptor = await open(attachmentPath, constants.O_RDONLY | noFollow);
    const openedInfo = await descriptor.stat();
    if (
      !openedInfo.isFile() ||
      openedInfo.dev !== pathInfo.dev ||
      openedInfo.ino !== pathInfo.ino
    ) {
      return {
        ok: false,
        reason: `Attachment '${input.attachment.name}' changed while it was being opened. Attach it again and retry.`,
      };
    }

    const limit = attachmentByteLimit(input.attachment);
    if (openedInfo.size <= 0 || openedInfo.size > limit) {
      return {
        ok: false,
        reason: `Attachment '${input.attachment.name}' is ${openedInfo.size} bytes; limit is ${limit} bytes.`,
      };
    }
    if (openedInfo.size !== input.attachment.sizeBytes) {
      return {
        ok: false,
        reason: `Attachment '${input.attachment.name}' changed after upload; expected ${input.attachment.sizeBytes} bytes but found ${openedInfo.size}.`,
      };
    }

    // Cap allocation and reads even if another process grows the file after
    // fstat. The extra byte distinguishes a changed file from the expected EOF.
    const buffer = Buffer.allocUnsafe(openedInfo.size + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const read = await descriptor.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    const bytes = buffer.subarray(0, bytesRead);
    const completedInfo = await descriptor.stat();
    if (
      completedInfo.dev !== openedInfo.dev ||
      completedInfo.ino !== openedInfo.ino ||
      completedInfo.size !== openedInfo.size ||
      bytes.byteLength !== openedInfo.size
    ) {
      return {
        ok: false,
        reason: `Attachment '${input.attachment.name}' changed while it was being read. Attach it again and retry.`,
      };
    }
    return { ok: true, bytes, sizeBytes: bytes.byteLength };
  } catch {
    return {
      ok: false,
      reason: `Attachment '${input.attachment.name}' is missing, unreadable, or not a safe regular file.`,
    };
  } finally {
    if (descriptor !== undefined) {
      await descriptor.close();
    }
  }
}

export function resolveAttachmentPathById(input: {
  readonly attachmentsDir: string;
  readonly attachmentId: string;
}): string | null {
  const normalizedId = normalizeAttachmentRelativePath(input.attachmentId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return null;
  }
  // Streamed-upload ids carry their extension segment, so the file name is
  // exactly the id; legacy ids probe the known extension set.
  const directPath = resolveAttachmentRelativePath({
    attachmentsDir: input.attachmentsDir,
    relativePath: normalizedId,
  });
  if (directPath && existsSync(directPath)) {
    return directPath;
  }
  for (const extension of ATTACHMENT_FILENAME_EXTENSIONS) {
    const maybePath = resolveAttachmentRelativePath({
      attachmentsDir: input.attachmentsDir,
      relativePath: `${normalizedId}${extension}`,
    });
    if (maybePath && existsSync(maybePath)) {
      return maybePath;
    }
  }
  return null;
}

export function parseAttachmentIdFromRelativePath(relativePath: string): string | null {
  const normalized = normalizeAttachmentRelativePath(relativePath);
  if (!normalized || normalized.includes("/") || normalized.toLowerCase().endsWith(".part")) {
    return null;
  }
  const extensionIndex = normalized.lastIndexOf(".");
  if (extensionIndex > 0) {
    const id = normalized.slice(0, extensionIndex);
    return id.length > 0 && !id.includes(".") ? id : null;
  }
  return ATTACHMENT_ID_WITH_EXTENSION_PATTERN.test(normalized) ? normalized : null;
}

/**
 * Streamed-upload ids end with a sanitized extension segment instead of a
 * dotted extension, so the on-disk file has no `path.extname`. This recovers
 * the equivalent dotted extension for content-type sniffing on serve.
 */
export function attachmentIdExtensionSegment(attachmentId: string): string | null {
  const match = attachmentId.toLowerCase().match(ATTACHMENT_ID_WITH_EXTENSION_PATTERN);
  return match?.[3] ? `.${match[3]}` : null;
}
