import { describe, expect, it } from "vite-plus/test";
import type { ChatAttachment } from "@ryco/contracts";

import {
  appendAttachmentPathLines,
  formatAttachmentPathLine,
  formatAttachmentPathLines,
  stripAttachmentPathLines,
} from "./attachmentPrompt.ts";

const fileAttachment: ChatAttachment = {
  type: "file",
  id: "thread-file-attachment",
  name: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 123456,
};

const imageAttachment: ChatAttachment = {
  type: "image",
  id: "thread-image-attachment",
  name: "diagram.png",
  mimeType: "image/png",
  sizeBytes: 42,
};

const unknownAttachment: ChatAttachment = {
  type: "vendor-thing" as ChatAttachment["type"],
  name: "mystery.bin",
  mimeType: "application/octet-stream",
};

describe("formatAttachmentPathLine", () => {
  it("renders persisted attachments with their resolved path", () => {
    expect(
      formatAttachmentPathLine({
        attachment: fileAttachment,
        resolvedPath: "/tmp/attachments/thread-file-attachment.bin",
      }),
    ).toBe(
      "[Attached file] report.pdf (application/pdf, 123456 bytes) saved at: /tmp/attachments/thread-file-attachment.bin",
    );
  });

  it("renders attachments without a resolvable path without a path segment", () => {
    expect(formatAttachmentPathLine({ attachment: fileAttachment })).toBe(
      "[Attached file] report.pdf (application/pdf, 123456 bytes)",
    );
  });

  it("renders unknown attachments with unknown size and no path", () => {
    expect(formatAttachmentPathLine({ attachment: unknownAttachment })).toBe(
      "[Attached file] mystery.bin (application/octet-stream, size unknown bytes)",
    );
  });

  it("renders image attachments deterministically", () => {
    expect(
      formatAttachmentPathLine({ attachment: imageAttachment, resolvedPath: "/tmp/a.png" }),
    ).toBe("[Attached file] diagram.png (image/png, 42 bytes) saved at: /tmp/a.png");
  });
});

describe("formatAttachmentPathLines", () => {
  it("formats entries in input order", () => {
    expect(
      formatAttachmentPathLines([
        { attachment: imageAttachment, resolvedPath: "/tmp/a.png" },
        { attachment: unknownAttachment },
      ]),
    ).toEqual([
      "[Attached file] diagram.png (image/png, 42 bytes) saved at: /tmp/a.png",
      "[Attached file] mystery.bin (application/octet-stream, size unknown bytes)",
    ]);
    expect(formatAttachmentPathLines([])).toEqual([]);
  });
});

describe("appendAttachmentPathLines", () => {
  it("returns the original text when there are no path lines", () => {
    expect(appendAttachmentPathLines("hello", [])).toBe("hello");
    expect(appendAttachmentPathLines(undefined, [])).toBeUndefined();
  });

  it("appends lines after the user text", () => {
    expect(
      appendAttachmentPathLines("please review", [
        "[Attached file] report.pdf (application/pdf, 123456 bytes) saved at: /tmp/report.bin",
      ]),
    ).toBe(
      "please review\n\n[Attached file] report.pdf (application/pdf, 123456 bytes) saved at: /tmp/report.bin",
    );
  });

  it("substitutes lines when the user text is empty", () => {
    expect(
      appendAttachmentPathLines("   ", [
        "[Attached file] mystery.bin (application/octet-stream, size unknown bytes)",
      ]),
    ).toBe("[Attached file] mystery.bin (application/octet-stream, size unknown bytes)");
    expect(appendAttachmentPathLines(undefined, ["line"])).toBe("line");
  });
});

describe("stripAttachmentPathLines", () => {
  it("removes the trailing path lines the formatter appended", () => {
    const lines = formatAttachmentPathLines([
      { attachment: fileAttachment, resolvedPath: "/tmp/attachments/report (1).bin" },
      { attachment: unknownAttachment },
    ]);
    expect(stripAttachmentPathLines(appendAttachmentPathLines("please review", lines) ?? "")).toBe(
      "please review",
    );
    expect(stripAttachmentPathLines(appendAttachmentPathLines("", lines) ?? "")).toBe("");
  });

  it("keeps text without trailing path lines, including one quoted mid-text", () => {
    const line = formatAttachmentPathLine({ attachment: imageAttachment });
    expect(stripAttachmentPathLines("please review")).toBe("please review");
    expect(stripAttachmentPathLines(`${line}\n\nwhy is this here?`)).toBe(
      `${line}\n\nwhy is this here?`,
    );
    expect(stripAttachmentPathLines("[Attached file] notes")).toBe("[Attached file] notes");
  });
});
