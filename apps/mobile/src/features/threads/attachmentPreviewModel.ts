import { attachmentPreviewKind } from "@ryco/shared/attachmentPreview";

/** PDFs larger than this go to the share sheet: a preview holds the whole file in memory. */
export const PDF_PREVIEW_MAX_BYTES = 25 * 1024 * 1024;

/** Whether a file attachment opens in place (PDF, Markdown, text) rather than the share sheet. */
export function canPreviewAttachment(attachment: {
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}): boolean {
  const kind = attachmentPreviewKind(attachment);
  if (kind === "pdf") return attachment.sizeBytes <= PDF_PREVIEW_MAX_BYTES;
  return kind !== null;
}
