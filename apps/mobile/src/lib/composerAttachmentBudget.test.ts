import { describe, expect, it } from "vite-plus/test";

import { attachesInline, composerAttachmentBudgetError } from "./composerAttachmentBudget";

const MB = 1024 * 1024;

describe("attachesInline", () => {
  it("inlines common images up to the image limit", () => {
    expect(attachesInline("image/JPEG", 2 * MB)).toBe(true);
    expect(attachesInline("image/heic", 2 * MB)).toBe(false);
    expect(attachesInline("image/png", 11 * MB)).toBe(false);
    expect(attachesInline("application/pdf", 1)).toBe(false);
  });
});

describe("composerAttachmentBudgetError", () => {
  const base = { name: "a", existingCount: 0, existingTotalBytes: 0, fileUploadMaxBytes: 50 * MB };

  it("accepts what fits", () => {
    expect(composerAttachmentBudgetError({ ...base, kind: "file", sizeBytes: MB })).toBeNull();
    expect(composerAttachmentBudgetError({ ...base, kind: "image", sizeBytes: MB })).toBeNull();
  });

  it("names each limit", () => {
    expect(
      composerAttachmentBudgetError({
        ...base,
        kind: "file",
        sizeBytes: MB,
        fileUploadMaxBytes: null,
      }),
    ).toContain("only takes images");
    expect(composerAttachmentBudgetError({ ...base, kind: "image", sizeBytes: 11 * MB })).toContain(
      "10 MB",
    );
    expect(composerAttachmentBudgetError({ ...base, kind: "file", sizeBytes: 0 })).toContain(
      "non-empty",
    );
    expect(
      composerAttachmentBudgetError({ ...base, kind: "file", sizeBytes: MB, existingCount: 8 }),
    ).toContain("up to 8");
    expect(
      composerAttachmentBudgetError({
        ...base,
        kind: "file",
        sizeBytes: 10 * MB,
        existingTotalBytes: 45 * MB,
      }),
    ).toContain("total at most 50MB");
  });
});
