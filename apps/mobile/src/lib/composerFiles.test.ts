import { describe, expect, it, vi } from "vite-plus/test";

// expo-image-picker / expo-crypto are native RN modules; the pure gate logic is
// tested without loading the native runtime.
vi.mock("./cameraAvailability", () => ({ isCameraCaptureAvailable: () => true }));
vi.mock("expo-crypto", () => ({
  randomUUID: () => "generated-id",
  getRandomBytes: (length: number) => new Uint8Array(length),
}));

import { classifyPickedDocument, resolveComposerFileAttachment } from "./composerFiles";

function baseInput(overrides?: Partial<Parameters<typeof resolveComposerFileAttachment>[0]>) {
  return {
    name: "report.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1024,
    readUri: "file:///tmp/report.pdf",
    fileUploadMaxBytes: 50 * 1024 * 1024,
    existingCount: 0,
    existingTotalBytes: 0,
    ...overrides,
  };
}

describe("resolveComposerFileAttachment", () => {
  it("accepts a valid file and assigns a fresh id", () => {
    const result = resolveComposerFileAttachment(baseInput());
    expect(result.error).toBeNull();
    expect(result.attachment).not.toBeNull();
    expect(result.attachment?.type).toBe("file");
    expect(result.attachment?.name).toBe("report.pdf");
    expect(result.attachment?.readUri).toBe("file:///tmp/report.pdf");
    expect(result.attachment?.uploadToken).toBeUndefined();
    expect(result.attachment?.uploadState).toBeUndefined();
  });

  it("rejects a file larger than the capability ceiling", () => {
    const result = resolveComposerFileAttachment(
      baseInput({ sizeBytes: 64 * 1024 * 1024, fileUploadMaxBytes: 50 * 1024 * 1024 }),
    );
    expect(result.attachment).toBeNull();
    expect(result.error).toContain("report.pdf");
    expect(result.error).toContain("50MB");
  });

  it("formats a non-megabyte capability limit in KB", () => {
    const result = resolveComposerFileAttachment(
      baseInput({ sizeBytes: 2 * 1024 * 1024, fileUploadMaxBytes: 1536 * 1024 }),
    );
    expect(result.attachment).toBeNull();
    expect(result.error).toContain("1536KB");
  });

  it("rejects empty files", () => {
    const result = resolveComposerFileAttachment(baseInput({ sizeBytes: 0 }));
    expect(result.attachment).toBeNull();
    expect(result.error).toContain("non-empty");
  });

  it("rejects filenames with path separators or control characters", () => {
    const result = resolveComposerFileAttachment(baseInput({ name: "../etc/passwd" }));
    expect(result.attachment).toBeNull();
    expect(result.error).toContain("unsafe filename");
  });

  it("rejects files beyond the shared attachment count", () => {
    const result = resolveComposerFileAttachment(baseInput({ existingCount: 8 }));
    expect(result.attachment).toBeNull();
    expect(result.error).toContain("up to 8 files");
  });

  it("rejects files that would exceed the total attachment budget", () => {
    const result = resolveComposerFileAttachment(
      baseInput({
        sizeBytes: 1024,
        existingTotalBytes: 50 * 1024 * 1024,
      }),
    );
    expect(result.attachment).toBeNull();
    expect(result.error).toContain("50MB");
  });
});

describe("classifyPickedDocument", () => {
  const base = { name: "x", sizeBytes: 1024, fileUploadMaxBytes: 50 * 1024 * 1024 };

  it("inlines small common images and streams everything else", () => {
    expect(classifyPickedDocument({ ...base, mimeType: "image/PNG" })).toBe("image");
    expect(classifyPickedDocument({ ...base, mimeType: "image/heic" })).toBe("file");
    expect(classifyPickedDocument({ ...base, mimeType: "application/pdf" })).toBe("file");
    expect(
      classifyPickedDocument({ ...base, mimeType: "image/jpeg", sizeBytes: 11 * 1024 * 1024 }),
    ).toBe("file");
  });

  it("refuses non-images when the node cannot take streamed files", () => {
    expect(
      classifyPickedDocument({ ...base, mimeType: "application/pdf", fileUploadMaxBytes: null }),
    ).toMatchObject({ error: expect.stringContaining("only takes images") });
    expect(
      classifyPickedDocument({ ...base, mimeType: "image/png", fileUploadMaxBytes: null }),
    ).toBe("image");
  });
});
