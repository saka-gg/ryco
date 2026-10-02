import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  attachmentRelativePath,
  createAttachmentId,
  createFileAttachmentId,
  parseAttachmentIdFromRelativePath,
  parseThreadSegmentFromAttachmentId,
  readPersistedAttachment,
  resolveAttachmentPathById,
  toSafeFileAttachmentExtensionSegment,
} from "./attachmentStore.ts";

describe("attachmentStore", () => {
  it("keeps in-flight staging files out of the persisted attachment namespace", () => {
    const id = createFileAttachmentId("thread-1", "notes.pdf")!;
    expect(parseAttachmentIdFromRelativePath(`${id}.part`)).toBeNull();
    expect(parseAttachmentIdFromRelativePath(`${id}.PART`)).toBeNull();
    expect(parseAttachmentIdFromRelativePath(id)).toBe(id);
  });

  it("sanitizes thread ids when creating attachment ids", () => {
    const attachmentId = createAttachmentId("thread.folder/unsafe space");
    expect(attachmentId).toBeTruthy();
    if (!attachmentId) {
      return;
    }

    const threadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
    expect(threadSegment).toBeTruthy();
    expect(threadSegment).toMatch(/^[a-z0-9_-]+$/i);
    expect(threadSegment).not.toContain(".");
    expect(threadSegment).not.toContain("%");
    expect(threadSegment).not.toContain("/");
  });

  it("parses exact thread segments from attachment ids without prefix collisions", () => {
    const fooId = "foo-00000000-0000-4000-8000-000000000001";
    const fooBarId = "foo-bar-00000000-0000-4000-8000-000000000002";

    expect(parseThreadSegmentFromAttachmentId(fooId)).toBe("foo");
    expect(parseThreadSegmentFromAttachmentId(fooBarId)).toBe("foo-bar");
  });

  it("normalizes created thread segments to lowercase", () => {
    const attachmentId = createAttachmentId("Thread.Foo");
    expect(attachmentId).toBeTruthy();
    if (!attachmentId) {
      return;
    }
    expect(parseThreadSegmentFromAttachmentId(attachmentId)).toBe("thread-foo");
  });

  it("resolves attachment path by id using the extension that exists on disk", () => {
    const attachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-attachment-store-"));
    try {
      const attachmentId = "thread-1-attachment";
      const pngPath = path.join(attachmentsDir, `${attachmentId}.png`);
      fs.writeFileSync(pngPath, Buffer.from("hello"));

      const resolved = resolveAttachmentPathById({
        attachmentsDir,
        attachmentId,
      });
      expect(resolved).toBe(pngPath);

      const fileAttachmentId = "thread-1-file-attachment";
      const filePath = path.join(attachmentsDir, `${fileAttachmentId}.bin`);
      fs.writeFileSync(filePath, Buffer.from("notes"));
      expect(
        resolveAttachmentPathById({
          attachmentsDir,
          attachmentId: fileAttachmentId,
        }),
      ).toBe(filePath);
    } finally {
      fs.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("returns null when no attachment file exists for the id", () => {
    const attachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-attachment-store-"));
    try {
      const resolved = resolveAttachmentPathById({
        attachmentsDir,
        attachmentId: "thread-1-missing",
      });
      expect(resolved).toBeNull();
    } finally {
      fs.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("stores general files under an opaque extension", () => {
    expect(
      attachmentRelativePath({
        type: "file",
        id: "thread-1-attachment",
        name: "archive.tar.gz",
        mimeType: "application/gzip",
        sizeBytes: 5,
      }),
    ).toBe("thread-1-attachment.bin");
  });

  it("derives safe extension segments from upload names", () => {
    expect(toSafeFileAttachmentExtensionSegment("notes.txt")).toBe("txt");
    expect(toSafeFileAttachmentExtensionSegment("REPORT.PDF")).toBe("pdf");
    expect(toSafeFileAttachmentExtensionSegment("archive.tar.gz")).toBe("gz");
    expect(toSafeFileAttachmentExtensionSegment("no-extension")).toBe("bin");
    expect(toSafeFileAttachmentExtensionSegment("trailing.")).toBe("bin");
    expect(toSafeFileAttachmentExtensionSegment("staged.part")).toBe("bin");
    expect(toSafeFileAttachmentExtensionSegment("we!rd@name.docx")).toBe("docx");
    expect(toSafeFileAttachmentExtensionSegment("x.abcdefghijklmnopqrstuvwxyz")).toBe(
      "abcdefghijkl",
    );
  });

  it("bakes extension segments into streamed upload ids and resolves them directly", () => {
    const attachmentId = createFileAttachmentId("thread.folder/unsafe space", "notes.pdf");
    expect(attachmentId).toBeTruthy();
    if (!attachmentId) {
      return;
    }
    expect(attachmentId).toMatch(/^[a-z0-9_]+(?:-[a-z0-9_]+)*-[0-9a-f-]{36}-pdf$/i);
    expect(parseThreadSegmentFromAttachmentId(attachmentId)).toBe("thread-folder-unsafe-space");

    const stagedFileAttachment = {
      type: "file" as const,
      id: attachmentId,
      name: "notes.pdf",
      mimeType: "application/pdf",
      sizeBytes: 3,
    };
    expect(attachmentRelativePath(stagedFileAttachment)).toBe(attachmentId);
    expect(parseAttachmentIdFromRelativePath(attachmentId)).toBe(attachmentId);

    expect(
      attachmentRelativePath({
        type: "file",
        id: createFileAttachmentId("thread-1", "staged.part") ?? "",
        name: "staged.part",
        mimeType: "application/octet-stream",
        sizeBytes: 1,
      }),
    ).not.toMatch(/\.part$/);

    const legacyAttachment = {
      type: "file" as const,
      id: "thread-1-attachment",
      name: "notes.pdf",
      mimeType: "application/pdf",
      sizeBytes: 3,
    };
    expect(attachmentRelativePath(legacyAttachment)).toBe("thread-1-attachment.bin");
    expect(
      parseThreadSegmentFromAttachmentId("thread-1-00000000-0000-4000-8000-000000000001"),
    ).toBe("thread-1");
    expect(parseAttachmentIdFromRelativePath("thread-1-attachment.bin")).toBe(
      "thread-1-attachment",
    );
  });

  it("resolves streamed upload ids directly before probing extensions", () => {
    const attachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-attachment-store-"));
    try {
      const uploadId = "thread-1-00000000-0000-4000-8000-000000000001-pdf";
      fs.writeFileSync(path.join(attachmentsDir, uploadId), Buffer.from("hello"));
      expect(resolveAttachmentPathById({ attachmentsDir, attachmentId: uploadId })).toBe(
        path.join(attachmentsDir, uploadId),
      );

      const legacyId = "thread-1-00000000-0000-4000-8000-000000000002";
      fs.writeFileSync(path.join(attachmentsDir, `${legacyId}.bin`), Buffer.from("abc"));
      expect(resolveAttachmentPathById({ attachmentsDir, attachmentId: legacyId })).toBe(
        path.join(attachmentsDir, `${legacyId}.bin`),
      );
    } finally {
      fs.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("rejects changed and symlinked persisted attachments", async () => {
    const attachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-attachment-store-"));
    const attachment = {
      type: "file" as const,
      id: "thread-1-attachment",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
    };
    try {
      const attachmentPath = path.join(attachmentsDir, `${attachment.id}.bin`);
      fs.writeFileSync(attachmentPath, Buffer.from("changed"));

      expect(await readPersistedAttachment({ attachmentsDir, attachment })).toEqual({
        ok: false,
        reason: "Attachment 'notes.txt' changed after upload; expected 3 bytes but found 7.",
      });

      fs.rmSync(attachmentPath);
      const targetPath = path.join(attachmentsDir, "target.bin");
      fs.writeFileSync(targetPath, Buffer.from("abc"));
      fs.symlinkSync(targetPath, attachmentPath);
      expect(await readPersistedAttachment({ attachmentsDir, attachment })).toEqual({
        ok: false,
        reason: "Attachment 'notes.txt' is not a regular file.",
      });
    } finally {
      fs.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("reads validated bytes from the same safe descriptor", async () => {
    const attachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-attachment-store-"));
    const attachment = {
      type: "file" as const,
      id: "thread-1-attachment",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
    };
    try {
      fs.writeFileSync(path.join(attachmentsDir, `${attachment.id}.bin`), Buffer.from("abc"));
      const result = await readPersistedAttachment({ attachmentsDir, attachment });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.sizeBytes).toBe(3);
        expect(result.bytes.toString("utf8")).toBe("abc");
      }
    } finally {
      fs.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });
});
