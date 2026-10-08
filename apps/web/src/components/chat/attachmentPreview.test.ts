import { describe, expect, it } from "vite-plus/test";
import {
  attachmentPreviewKind,
  attachmentUrlPolicy,
  formatAttachmentBytes,
} from "./attachmentPreview";

describe("attachment preview classification", () => {
  it.each([
    ["report", " Application/PDF; version=1.7", "pdf"],
    ["REPORT.PDF", "application/octet-stream", "pdf"],
    ["report.pdf", "", "pdf"],
    ["report.pdf", "text/html", "text"],
    ["notes.md", "application/octet-stream", "markdown"],
    ["NOTES.MD", "text/plain", "markdown"],
    ["notes.markdown", "", "markdown"],
    ["notes", "text/markdown; charset=utf-8", "markdown"],
    ["notes.md", "text/html", "text"],
    ["config", "application/json", "text"],
    ["report.docx", "application/octet-stream", null],
    ["photo.pdf", "image/png", null],
    ["archive.zip", "application/zip", null],
  ])("classifies %s (%s)", (name, mimeType, expected) => {
    expect(attachmentPreviewKind({ name, mimeType })).toBe(expected);
  });
  // A blob URL runs a document type in the app's origin when opened in a tab.
  it.each([
    ["text/html", false, "blob", "application/octet-stream"],
    ["Text/HTML; charset=utf-8", false, "blob", "application/octet-stream"],
    ["application/xhtml+xml", false, "blob", "application/octet-stream"],
    ["text/xml", false, "blob", "application/octet-stream"],
    ["application/pdf", false, "blob", "application/octet-stream"],
    ["text/plain", false, "blob", "application/octet-stream"],
    ["", false, "blob", "application/octet-stream"],
    [undefined, false, "blob", "application/octet-stream"],
    ["image/svg+xml", false, "blob", "application/octet-stream"],
    ["image/svg+xml; charset=utf-8", true, "data", "image/svg+xml"],
    ["image/png", true, "blob", "image/png"],
    ["Image/JPEG", true, "blob", "image/jpeg"],
    ["image/webp", false, "blob", "image/webp"],
    ["audio/wav", false, "blob", "audio/wav"],
    ["video/mp4; codecs=avc1", false, "blob", "video/mp4"],
    ["video/x-svg+xml", false, "blob", "application/octet-stream"],
  ] as const)("holds %s (image: %s) as an inert %s URL of %s", (mimeType, image, scheme, type) => {
    expect(attachmentUrlPolicy({ mimeType, image })).toEqual({ scheme, type });
  });

  it("formats sizes consistently across composer and messages", () => {
    expect(formatAttachmentBytes(123)).toBe("123 B");
    expect(formatAttachmentBytes(2048)).toBe("2 KB");
    expect(formatAttachmentBytes(1572864)).toBe("1.5 MB");
  });
});
