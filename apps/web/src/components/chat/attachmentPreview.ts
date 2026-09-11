/** Text is displayed as escaped source, never as an executable document. */
export const ATTACHMENT_TEXT_PREVIEW_MAX_BYTES = 512 * 1024;

export function attachmentPreviewKind(attachment: {
  name: string;
  mimeType: string;
}): "pdf" | "text" | null {
  const mime = attachment.mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const extension = attachment.name.split(".").pop()?.toLowerCase();
  if (mime === "application/pdf") return "pdf";
  if (
    mime.startsWith("text/") ||
    ["application/json", "application/xml", "application/javascript"].includes(mime)
  )
    return "text";
  if (mime !== "" && mime !== "application/octet-stream") return null;
  if (extension === "pdf") return "pdf";
  return extension &&
    /^(txt|md|markdown|csv|tsv|json|jsonl|xml|yaml|yml|log|js|jsx|ts|tsx|css|html|htm|py|sh|toml|ini|sql|rs|go|java|c|h|cpp)$/.test(
      extension,
    )
    ? "text"
    : null;
}

export function formatAttachmentBytes(sizeBytes: number): string {
  if (sizeBytes >= 1024 * 1024) return `${Math.round((sizeBytes / (1024 * 1024)) * 10) / 10} MB`;
  if (sizeBytes >= 1024) return `${Math.ceil(sizeBytes / 1024)} KB`;
  return `${sizeBytes} B`;
}
