import path from "node:path";
import { CHAT_ATTACHMENT_PREVIEW_SIZES, type ChatAttachmentPreviewSize } from "@ryco/contracts";

export const ATTACHMENTS_ROUTE_PREFIX = "/attachments";

export function normalizeAttachmentRelativePath(rawRelativePath: string): string | null {
  const normalized = path.normalize(rawRelativePath).replace(/^[/\\]+/, "");
  if (normalized.length === 0 || normalized.startsWith("..") || normalized.includes("\0")) {
    return null;
  }
  return normalized.replace(/\\/g, "/");
}

export function resolveAttachmentRelativePath(input: {
  readonly attachmentsDir: string;
  readonly relativePath: string;
}): string | null {
  const normalizedRelativePath = normalizeAttachmentRelativePath(input.relativePath);
  if (!normalizedRelativePath) {
    return null;
  }

  const attachmentsRoot = path.resolve(input.attachmentsDir);
  const filePath = path.resolve(path.join(attachmentsRoot, normalizedRelativePath));
  if (!filePath.startsWith(`${attachmentsRoot}${path.sep}`)) {
    return null;
  }
  return filePath;
}

/** A `?preview=` size the server makes; anything else serves the original. */
export function parseAttachmentPreviewSize(
  value: string | null | undefined,
): ChatAttachmentPreviewSize | null {
  if (value === null || value === undefined) return null;
  const size = Number(value);
  return (CHAT_ATTACHMENT_PREVIEW_SIZES as ReadonlyArray<number>).includes(size)
    ? (size as ChatAttachmentPreviewSize)
    : null;
}
