import { attachmentPreviewKind } from "@ryco/shared/attachmentPreview";

/** PDFs larger than this go to the share sheet: a preview reads the whole file over the node. */
export const PDF_PREVIEW_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Whether a file attachment opens in place (PDF, Markdown, text) rather than the share sheet.
 * `pdf`: the platform's web view renders PDFs (iOS does; Android's has no PDF viewer, so a PDF
 * there would open as a blank sheet).
 */
export function canPreviewAttachment(
  attachment: {
    readonly name: string;
    readonly mimeType: string;
    readonly sizeBytes: number;
  },
  options: { readonly pdf: boolean },
): boolean {
  const kind = attachmentPreviewKind(attachment);
  if (kind === "pdf") return options.pdf && attachment.sizeBytes <= PDF_PREVIEW_MAX_BYTES;
  return kind !== null;
}
