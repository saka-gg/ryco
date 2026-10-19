import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { copyFile, link, lstat, open, rm, unlink, type FileHandle } from "node:fs/promises";
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
import {
  inferImageExtension,
  parseBase64DataUrl,
  SAFE_IMAGE_FILE_EXTENSIONS,
} from "./imageMime.ts";

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
  return composeAttachmentId(
    threadSegment,
    randomUUID(),
    toSafeFileAttachmentExtensionSegment(name),
  );
}

/**
 * `<segment>-<uuid>`, then `-<extension>` when there is one, the extension shortened so the id
 * keeps within an attachment id's 128 characters: the longest segment (80) leaves it 10.
 */
export function composeAttachmentId(
  segment: string,
  uuid: string,
  extension: string | null | undefined,
): string {
  const base = `${segment}-${uuid}`;
  return extension
    ? `${base}-${extension.slice(0, ATTACHMENT_ID_MAX_CHARS - base.length - 1)}`
    : base;
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

export type DecodedUploadAttachmentDataUrl =
  | { readonly ok: true; readonly bytes: Buffer; readonly mimeType: string }
  | { readonly ok: false; readonly message: string };

/**
 * Decodes an inline (`data:` URL) attachment and checks it against what the sender declared: the
 * MIME type, the exact byte count, canonical base64 and the per-type size limit. Chat commands
 * and task files both accept exactly the payloads this accepts. The returned MIME type is
 * lowercased.
 */
export function decodeUploadAttachmentDataUrl(input: {
  readonly type: "image" | "file";
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly dataUrl: string;
}): DecodedUploadAttachmentDataUrl {
  const parsed = parseBase64DataUrl(input.dataUrl);
  if (!parsed) {
    return { ok: false, message: `Attachment '${input.name}' must use a valid base64 data URL.` };
  }
  const mimeType = parsed.mimeType.toLowerCase();
  if (mimeType !== input.mimeType.toLowerCase()) {
    return {
      ok: false,
      message: `Attachment '${input.name}' declares '${input.mimeType}' but its payload is '${parsed.mimeType}'.`,
    };
  }
  if (input.type === "image" && !mimeType.startsWith("image/")) {
    return {
      ok: false,
      message: `Image attachment '${input.name}' must use an image MIME type.`,
    };
  }
  const normalizedBase64 = parsed.base64.replace(/\s+/g, "");
  const bytes = Buffer.from(normalizedBase64, "base64");
  if (
    bytes.byteLength === 0 ||
    bytes.toString("base64") !== normalizedBase64 ||
    bytes.byteLength !== input.sizeBytes
  ) {
    return {
      ok: false,
      message: `Attachment '${input.name}' has invalid base64 data or mismatched size metadata.`,
    };
  }
  const limit =
    input.type === "image" ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
  if (bytes.byteLength > limit) {
    return {
      ok: false,
      message: `Attachment '${input.name}' is ${bytes.byteLength} bytes; limit is ${limit} bytes.`,
    };
  }
  return { ok: true, bytes, mimeType };
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
 * A deterministic attachment id in `threadId`'s segment, derived from (thread, source id): a
 * retried copy links the same file again, and deleting or reverting the source never touches the
 * copy. `extensionSegment` is for ids whose on-disk name is exactly the id (streamed uploads);
 * pass null for an image, whose file is the id plus its image extension (`attachmentRelativePath`).
 */
export function derivedAttachmentId(input: {
  readonly threadId: string;
  readonly sourceId: string;
  readonly extensionSegment: string | null;
}): string | null {
  const threadSegment = toSafeThreadAttachmentSegment(input.threadId);
  if (!threadSegment) {
    return null;
  }
  const uuid = uuidFromSha256Hex(
    createHash("sha256").update(`${input.threadId}\0${input.sourceId}`, "utf8").digest("hex"),
  );
  return composeAttachmentId(threadSegment, uuid, input.extensionSegment?.toLowerCase());
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
  return derivedAttachmentId({
    threadId: input.forkThreadId,
    sourceId: input.sourceAttachmentId,
    extensionSegment:
      input.sourceAttachmentId.match(ATTACHMENT_ID_WITH_EXTENSION_PATTERN)?.[3] ?? null,
  });
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

/**
 * Fills a private staging file in `attachmentsDir`, then publishes it at `destination` without
 * overwriting. False when the destination already existed (nothing was written).
 */
async function publishStagedFile(
  attachmentsDir: string,
  destination: string,
  fill: (staging: string) => Promise<void>,
): Promise<boolean> {
  const staging = path.join(attachmentsDir, `.${randomUUID()}.part`);
  try {
    await fill(staging);
    try {
      await link(staging, destination);
      return true;
    } catch (cause) {
      if (errorCode(cause) === "EEXIST") return false;
      throw cause;
    }
  } finally {
    await rm(staging, { force: true });
  }
}

/** Copy through a private staging file, then publish without overwriting. */
function copyAttachmentFile(source: string, destination: string, attachmentsDir: string) {
  return publishStagedFile(attachmentsDir, destination, async (staging) => {
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
    } finally {
      await input?.close();
      await output?.close();
    }
  });
}

async function assertAttachmentSource(input: {
  readonly source: string;
  readonly sizeBytes: number;
  readonly name: string;
}): Promise<void> {
  const sourceInfo = await lstat(input.source);
  if (!sourceInfo.isFile() || sourceInfo.size !== input.sizeBytes) {
    throw new Error(`Attachment '${input.name}' is missing or changed.`);
  }
}

async function assertAttachmentCopy(input: {
  readonly destination: string;
  readonly sizeBytes: number;
  readonly name: string;
}): Promise<void> {
  const copied = await lstat(input.destination);
  if (!copied.isFile() || copied.size !== input.sizeBytes) {
    throw new Error(`Attachment '${input.name}' could not be copied.`);
  }
}

/**
 * Publishes `source` at `destination`: a hard link (no bytes copied), or a copy staged in
 * `attachmentsDir` when the link crosses filesystems or the filesystem refuses links. Never
 * follows a symlink and never overwrites: an existing destination (a retry) counts as done. Both
 * ends must be regular files of `sizeBytes`; `name` only labels the errors. `created` is false
 * when nothing was written.
 */
export async function linkOrCopyAttachmentFile(input: {
  readonly source: string;
  readonly destination: string;
  readonly attachmentsDir: string;
  readonly sizeBytes: number;
  readonly name: string;
}): Promise<{ readonly created: boolean }> {
  await assertAttachmentSource(input);
  let created: boolean;
  try {
    await link(input.source, input.destination);
    created = true;
  } catch (cause) {
    const code = errorCode(cause);
    if (code === "EEXIST") {
      created = false;
    } else if (code === "EXDEV" || code === "EPERM" || code === "ENOTSUP") {
      created = await copyAttachmentFile(input.source, input.destination, input.attachmentsDir);
    } else {
      throw cause;
    }
  }
  await assertAttachmentCopy(input);
  return { created };
}

/**
 * Publishes a private copy of `source` at `destination`, one that never shares the source's
 * inode, so writing to the copy (an agent editing its attachment in place) cannot change the
 * source. It is a copy-on-write clone where the filesystem has them (APFS, btrfs, XFS: no bytes
 * duplicated) and a byte copy elsewhere, staged in `attachmentsDir` and published without
 * overwriting: an existing destination (a retry) counts as done. Same checks and `created` as
 * `linkOrCopyAttachmentFile`.
 */
export async function cloneAttachmentFile(input: {
  readonly source: string;
  readonly destination: string;
  readonly attachmentsDir: string;
  readonly sizeBytes: number;
  readonly name: string;
}): Promise<{ readonly created: boolean }> {
  await assertAttachmentSource(input);
  const created = await publishStagedFile(
    input.attachmentsDir,
    input.destination,
    async (staging) => {
      await copyFile(input.source, staging, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      // A byte copy is only durable once synced, like `copyAttachmentFile`'s.
      const handle = await open(staging, constants.O_RDONLY);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
  );
  await assertAttachmentCopy(input);
  return { created };
}

/**
 * Materializes a fork's copy of an inherited attachment through `linkOrCopyAttachmentFile`.
 * Returns the rewritten attachment; `created` is false when nothing was written.
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
  const { created } = await linkOrCopyAttachmentFile({
    source,
    destination,
    attachmentsDir: input.attachmentsDir,
    sizeBytes: input.attachment.sizeBytes,
    name: input.attachment.name,
  });
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
