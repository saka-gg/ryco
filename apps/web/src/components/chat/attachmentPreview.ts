export {
  ATTACHMENT_TEXT_PREVIEW_MAX_BYTES,
  attachmentPreviewKind,
  formatAttachmentBytes,
} from "@ryco/shared/attachmentPreview";

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
