import { describe, expect, it } from "vite-plus/test";

import { canPreviewAttachment, PDF_PREVIEW_MAX_BYTES } from "./attachmentPreviewModel";

const ios = { pdf: true };
const android = { pdf: false };
const pdf = { name: "plan.pdf", mimeType: "application/pdf", sizeBytes: 10 };

describe("attachment previews", () => {
  it("opens PDFs, Markdown and text in place, everything else in the share sheet", () => {
    expect(canPreviewAttachment(pdf, ios)).toBe(true);
    expect(canPreviewAttachment({ name: "notes.md", mimeType: "", sizeBytes: 10 }, ios)).toBe(true);
    expect(
      canPreviewAttachment({ name: "log.txt", mimeType: "text/plain", sizeBytes: 10 }, ios),
    ).toBe(true);
    expect(
      canPreviewAttachment({ name: "a.zip", mimeType: "application/zip", sizeBytes: 10 }, ios),
    ).toBe(false);
    expect(canPreviewAttachment({ ...pdf, sizeBytes: PDF_PREVIEW_MAX_BYTES + 1 }, ios)).toBe(false);
  });

  it("sends PDFs to the share sheet where the web view has no PDF viewer (Android)", () => {
    expect(canPreviewAttachment(pdf, android)).toBe(false);
    expect(canPreviewAttachment({ name: "notes.md", mimeType: "", sizeBytes: 10 }, android)).toBe(
      true,
    );
  });
});
