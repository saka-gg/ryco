import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { link, lstat, open, rm, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

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

const ATTACHMENT_ID_MAX_CHARS = 128;
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

/** The first 32 hex digits of a sha-256 digest, formatted like a UUID (no version bits). */
export function uuidFromSha256Hex(hash: string): string {
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
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

/**
 * The id a fork's copy of an inherited attachment gets: in the fork's own thread segment, so
 * deleting or reverting the source never touches it, and derived from (fork, source id), so a
 * retried fork links the same file again. The extension segment of a streamed-upload id is
 * kept, so the copy's on-disk name follows the same rule as the source's.
 */
export function inheritedAttachmentId(input: {
  readonly forkThreadId: string;
  readonly sourceAttachmentId: string;
}): string | null {
  const threadSegment = toSafeThreadAttachmentSegment(input.forkThreadId);
  if (!threadSegment) {
    return null;
  }
  const extension = input.sourceAttachmentId.match(ATTACHMENT_ID_WITH_EXTENSION_PATTERN)?.[3];
  const uuid = uuidFromSha256Hex(
    createHash("sha256")
      .update(`${input.forkThreadId}\0${input.sourceAttachmentId}`, "utf8")
      .digest("hex"),
  );
  const id = `${threadSegment}-${uuid}${extension ? `-${extension.toLowerCase()}` : ""}`;
  return id.length <= ATTACHMENT_ID_MAX_CHARS ? id : null;
}

/**
 * The inherited copy of an attachment, with only its id rewritten. Attachments without a stored
 * file (unknown types) are inherited as they are; null when no valid copy id exists.
 */
export function inheritedChatAttachment(
  attachment: ChatAttachment,
  forkThreadId: string,
): ChatAttachment | null {
  if (!isPersistableChatAttachment(attachment)) {
    return attachment;
  }
  const id = inheritedAttachmentId({ forkThreadId, sourceAttachmentId: attachment.id });
  return id === null ? null : { ...attachment, id };
}

function errorCode(cause: unknown): string | undefined {
  return cause instanceof Error && "code" in cause ? String(cause.code) : undefined;
}

/** Copy through a private staging file, then publish without overwriting. */
async function copyAttachmentFile(source: string, destination: string, attachmentsDir: string) {
  const staging = path.join(attachmentsDir, `.${randomUUID()}.part`);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let input: FileHandle | undefined;
  let output: FileHandle | undefined;
  try {
    input = await open(source, constants.O_RDONLY | noFollow);
    output = await open(staging, "wx", 0o600);
    const chunk = Buffer.allocUnsafe(64 * 1024);
    for (let offset = 0; ;) {
      const { bytesRead } = await input.read(chunk, 0, chunk.length, offset);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        const result = await output.write(chunk, written, bytesRead - written, offset + written);
        written += result.bytesWritten;
      }
      offset += bytesRead;
    }
    await output.sync();
    await output.close();
    output = undefined;
    try {
      await link(staging, destination);
      return true;
    } catch (cause) {
      if (errorCode(cause) === "EEXIST") return false;
      throw cause;
    }
  } finally {
    await input?.close();
    await output?.close();
    await rm(staging, { force: true });
  }
}

/**
 * Materializes a fork's copy of an inherited attachment: a hard link to the source file (no
 * bytes copied), or a staged copy when the link crosses filesystems. Never follows a symlink and
 * never overwrites: an existing copy (a retry) counts as done. Returns the rewritten attachment;
 * `created` is false when nothing was written.
 */
export async function materializeInheritedAttachment(input: {
  readonly attachmentsDir: string;
  readonly forkThreadId: string;
  readonly attachment: ChatAttachment;
}): Promise<{ readonly attachment: ChatAttachment; readonly created: boolean }> {
  const copy = inheritedChatAttachment(input.attachment, input.forkThreadId);
  if (copy === null) {
    throw new Error(`Attachment '${input.attachment.id ?? "unknown"}' cannot be inherited.`);
  }
  if (!isPersistableChatAttachment(input.attachment)) {
    return { attachment: copy, created: false };
  }
  const source = resolveAttachmentPath({
    attachmentsDir: input.attachmentsDir,
    attachment: input.attachment,
  });
  const destination = resolveAttachmentPath({
    attachmentsDir: input.attachmentsDir,
    attachment: copy,
  });
  if (!source || !destination) {
    throw new Error(`Invalid attachment id '${input.attachment.id}'.`);
  }
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.size !== input.attachment.sizeBytes) {
    throw new Error(`Attachment '${input.attachment.name}' is missing or changed.`);
  }
  let created: boolean;
  try {
    await link(source, destination);
    created = true;
  } catch (cause) {
    const code = errorCode(cause);
    if (code === "EEXIST") {
      created = false;
    } else if (code === "EXDEV" || code === "EPERM" || code === "ENOTSUP") {
      created = await copyAttachmentFile(source, destination, input.attachmentsDir);
    } else {
      throw cause;
    }
  }
  const copied = await lstat(destination);
  if (!copied.isFile() || copied.size !== input.attachment.sizeBytes) {
    throw new Error(`Attachment '${input.attachment.name}' could not be inherited.`);
  }
  return { attachment: copy, created };
}

/**
 * Deletes a thread's attachment files by id, e.g. a failed fork's copies. Refuses (before
 * deleting anything) ids outside the thread's segment; missing files count as deleted. Links are
 * removed, never followed.
 */
export async function deleteThreadAttachmentFiles(input: {
  readonly attachmentsDir: string;
  readonly threadId: string;
  readonly attachmentIds: ReadonlyArray<string>;
}): Promise<void> {
  const threadSegment = toSafeThreadAttachmentSegment(input.threadId);
  if (
    !threadSegment ||
    input.attachmentIds.some((id) => parseThreadSegmentFromAttachmentId(id) !== threadSegment)
  ) {
    throw new Error("Refusing to delete attachments of another thread.");
  }
  for (const attachmentId of input.attachmentIds) {
    const filePath = resolveAttachmentPathById({
      attachmentsDir: input.attachmentsDir,
      attachmentId,
    });
    if (filePath === null) continue;
    try {
      await unlink(filePath);
    } catch (cause) {
      if (errorCode(cause) !== "ENOENT") throw cause;
    }
  }
}
