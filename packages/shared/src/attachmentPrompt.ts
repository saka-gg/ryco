import type { ChatAttachment } from "@ryco/contracts";

export interface AttachmentPathLineEntry {
  readonly attachment: ChatAttachment;
  readonly resolvedPath?: string | undefined;
}

/**
 * The line that tells an agent where an attached image is saved. The model sees the image
 * itself, but its tools cannot open pixels: the path lets it copy or read the file.
 */
function formatImagePathLine(entry: AttachmentPathLineEntry): string {
  const name = entry.attachment.name ?? "image";
  if (entry.attachment.id === undefined || entry.resolvedPath === undefined) {
    return `[Attached image "${name}"]`;
  }
  return `[Attached image "${name}" is saved at: ${entry.resolvedPath}]`;
}

export function formatAttachmentPathLine(entry: AttachmentPathLineEntry): string {
  const attachment = entry.attachment;
  if (attachment.type === "image") {
    return formatImagePathLine(entry);
  }
  const name = attachment.name ?? "attachment";
  const mimeType = attachment.mimeType ?? "unknown";
  const sizeText = attachment.sizeBytes === undefined ? "size unknown" : `${attachment.sizeBytes}`;
  if (attachment.id === undefined || entry.resolvedPath === undefined) {
    return `[Attached file] ${name} (${mimeType}, ${sizeText} bytes)`;
  }
  return `[Attached file] ${name} (${mimeType}, ${sizeText} bytes) saved at: ${entry.resolvedPath}`;
}

export function formatAttachmentPathLines(
  entries: ReadonlyArray<AttachmentPathLineEntry>,
): string[] {
  return entries.map(formatAttachmentPathLine);
}

export function appendAttachmentPathLines(
  text: string | undefined,
  pathLines: ReadonlyArray<string>,
): string | undefined {
  if (pathLines.length === 0) {
    return text;
  }
  const lines = pathLines.join("\n");
  if (text === undefined || text.trim().length === 0) {
    return lines;
  }
  return `${text}\n\n${lines}`;
}

const ATTACHMENT_PATH_LINE_PREFIX = "[Attached file] ";
const ATTACHMENT_PATH_LINE_DETAILS = / \([^,()]+, (?:\d+|size unknown) bytes\)(?: saved at: .+)?$/;
const IMAGE_PATH_LINE = /^\[Attached image ".*"(?: is saved at: .+)?\]$/;

function isAttachmentPathLine(line: string): boolean {
  return (
    (line.startsWith(ATTACHMENT_PATH_LINE_PREFIX) && ATTACHMENT_PATH_LINE_DETAILS.test(line)) ||
    IMAGE_PATH_LINE.test(line)
  );
}

/**
 * The text before `appendAttachmentPathLines`: the trailing run of path lines and the blank line
 * that separated it go. Text that only had path lines comes back empty.
 */
export function stripAttachmentPathLines(text: string): string {
  const lines = text.trimEnd().split("\n");
  let end = lines.length;
  while (end > 0 && isAttachmentPathLine(lines[end - 1]!)) end -= 1;
  if (end === lines.length) return text;
  return lines.slice(0, end).join("\n").trimEnd();
}
