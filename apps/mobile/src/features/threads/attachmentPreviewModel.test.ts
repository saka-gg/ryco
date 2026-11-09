import { describe, expect, it } from "vite-plus/test";

import { canPreviewAttachment, PDF_PREVIEW_MAX_BYTES } from "./attachmentPreviewModel";

describe("attachment previews", () => {
  it("opens PDFs, Markdown and text in place, everything else in the share sheet", () => {
    expect(
      canPreviewAttachment({ name: "plan.pdf", mimeType: "application/pdf", sizeBytes: 10 }),
    ).toBe(true);
    expect(canPreviewAttachment({ name: "notes.md", mimeType: "", sizeBytes: 10 })).toBe(true);
    expect(canPreviewAttachment({ name: "log.txt", mimeType: "text/plain", sizeBytes: 10 })).toBe(
      true,
    );
    expect(
      canPreviewAttachment({ name: "a.zip", mimeType: "application/zip", sizeBytes: 10 }),
    ).toBe(false);
    expect(
      canPreviewAttachment({
        name: "huge.pdf",
        mimeType: "application/pdf",
        sizeBytes: PDF_PREVIEW_MAX_BYTES + 1,
      }),
    ).toBe(false);
  });
});
