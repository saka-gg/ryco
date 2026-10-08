/** Text is bounded and never displayed as an executable document. */
export const ATTACHMENT_TEXT_PREVIEW_MAX_BYTES = 512 * 1024;

export function attachmentPreviewKind(attachment: {
  name: string;
  mimeType: string;
}): "pdf" | "markdown" | "text" | null {
  const mime = attachment.mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const extension = attachment.name.split(".").pop()?.toLowerCase();
  if (mime === "application/pdf") return "pdf";
  if (
    mime === "text/markdown" ||
    mime === "text/x-markdown" ||
    (["", "application/octet-stream", "text/plain"].includes(mime) &&
      (extension === "md" || extension === "markdown"))
  )
    return "markdown";
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

const OPAQUE_DOWNLOAD_TYPE = "application/octet-stream";

/**
 * How the client holds an attachment's bytes as a URL. A blob URL has the
 * app's origin, so bytes typed as a document the browser runs (HTML, XML,
 * SVG, …) would run their scripts in the app if a reader opened the link in a
 * tab. As on the server's /attachments route, only inert media keep their type
 * and everything else is an opaque download. An SVG image needs its type to
 * display, so it goes in a data URL instead, whose origin is opaque.
 */
export function attachmentUrlPolicy(attachment: {
  readonly mimeType: string | undefined;
  readonly image: boolean;
}): { readonly scheme: "blob" | "data"; readonly type: string } {
  const mime = attachment.mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (attachment.image && mime === "image/svg+xml") return { scheme: "data", type: mime };
  const inert = /^(?:image|audio|video)\/[a-z0-9.+-]+$/.test(mime) && !/svg|xml/.test(mime);
  return { scheme: "blob", type: inert ? mime : OPAQUE_DOWNLOAD_TYPE };
}

export function formatAttachmentBytes(sizeBytes: number): string {
  if (sizeBytes >= 1024 * 1024) return `${Math.round((sizeBytes / (1024 * 1024)) * 10) / 10} MB`;
  if (sizeBytes >= 1024) return `${Math.ceil(sizeBytes / 1024)} KB`;
  return `${sizeBytes} B`;
}
