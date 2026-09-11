import { describe, expect, it } from "vite-plus/test";
import { attachmentPreviewKind, formatAttachmentBytes } from "./attachmentPreview";

describe("attachment preview classification", () => {
  it.each([
    ["report", " Application/PDF; version=1.7", "pdf"],
    ["REPORT.PDF", "application/octet-stream", "pdf"],
    ["report.pdf", "", "pdf"],
    ["report.pdf", "text/html", "text"],
    ["notes.md", "application/octet-stream", "text"],
    ["config", "application/json", "text"],
    ["report.docx", "application/octet-stream", null],
    ["photo.pdf", "image/png", null],
    ["archive.zip", "application/zip", null],
  ])("classifies %s (%s)", (name, mimeType, expected) => {
    expect(attachmentPreviewKind({ name, mimeType })).toBe(expected);
  });
  it("formats sizes consistently across composer and messages", () => {
    expect(formatAttachmentBytes(123)).toBe("123 B");
    expect(formatAttachmentBytes(2048)).toBe("2 KB");
    expect(formatAttachmentBytes(1572864)).toBe("1.5 MB");
  });
});
