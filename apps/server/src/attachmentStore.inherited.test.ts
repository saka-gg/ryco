import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ChatAttachment } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  attachmentRelativePath,
  createAttachmentId,
  createFileAttachmentId,
  deleteThreadAttachmentFiles,
  inheritedAttachmentId,
  inheritedChatAttachment,
  materializeInheritedAttachment,
  parseThreadSegmentFromAttachmentId,
  readPersistedAttachment,
} from "./attachmentStore.ts";

const FORK = "fork-0123456789abcdef0123456789abcdef";
let attachmentsDir: string;

beforeEach(() => {
  attachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-inherited-attachments-"));
});
afterEach(() => {
  fs.rmSync(attachmentsDir, { recursive: true, force: true });
});

function storedFile(threadId: string, name: string, bytes: string) {
  const attachment = {
    type: "file",
    id: createFileAttachmentId(threadId, name)!,
    name,
    mimeType: "application/pdf",
    sizeBytes: Buffer.byteLength(bytes),
  } as const satisfies ChatAttachment;
  fs.writeFileSync(path.join(attachmentsDir, attachmentRelativePath(attachment)!), bytes);
  return attachment;
}

function storedImage(threadId: string) {
  const attachment = {
    type: "image",
    id: createAttachmentId(threadId)!,
    name: "shot.png",
    mimeType: "image/png",
    sizeBytes: 4,
  } as const satisfies ChatAttachment;
  fs.writeFileSync(path.join(attachmentsDir, attachmentRelativePath(attachment)!), "png!");
  return attachment;
}

describe("inherited attachment ids", () => {
  it("are fork-owned, deterministic and keep the source's extension segment", () => {
    const file = createFileAttachmentId("thread-source", "notes.PDF")!;
    const copy = inheritedAttachmentId({ forkThreadId: FORK, sourceAttachmentId: file });
    expect(copy).toBe(inheritedAttachmentId({ forkThreadId: FORK, sourceAttachmentId: file }));
    expect(copy).toMatch(
      /^fork-0123456789abcdef0123456789abcdef-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-pdf$/,
    );
    expect(parseThreadSegmentFromAttachmentId(copy!)).toBe(FORK);

    const image = createAttachmentId("thread-source")!;
    const imageCopy = inheritedAttachmentId({ forkThreadId: FORK, sourceAttachmentId: image })!;
    expect(imageCopy.split("-")).toHaveLength(7);
    expect(imageCopy).not.toBe(copy);
    expect(inheritedAttachmentId({ forkThreadId: `${FORK}0`, sourceAttachmentId: image })).not.toBe(
      imageCopy,
    );
  });

  it("leaves attachments without a stored file unchanged", () => {
    const unknown = { type: "audio", name: "clip" } as ChatAttachment;
    expect(inheritedChatAttachment(unknown, FORK)).toBe(unknown);
  });
});

describe("materializeInheritedAttachment", () => {
  it("hard-links the source into the fork's namespace and is idempotent", async () => {
    const source = storedFile("thread-source", "report.pdf", "%PDF-1");
    const first = await materializeInheritedAttachment({
      attachmentsDir,
      forkThreadId: FORK,
      attachment: source,
    });
    expect(first.created).toBe(true);
    expect(first.attachment).toEqual({
      ...source,
      id: inheritedAttachmentId({ forkThreadId: FORK, sourceAttachmentId: source.id }),
    });
    const sourcePath = path.join(attachmentsDir, attachmentRelativePath(source)!);
    const copyPath = path.join(attachmentsDir, attachmentRelativePath(first.attachment)!);
    expect(fs.statSync(copyPath).ino).toBe(fs.statSync(sourcePath).ino);
    const read = await readPersistedAttachment({ attachmentsDir, attachment: first.attachment });
    expect(read.ok && read.bytes.toString()).toBe("%PDF-1");

    const again = await materializeInheritedAttachment({
      attachmentsDir,
      forkThreadId: FORK,
      attachment: source,
    });
    expect(again).toEqual({ attachment: first.attachment, created: false });

    // The copy outlives the source's files (source thread deleted or reverted).
    fs.unlinkSync(sourcePath);
    expect(fs.readFileSync(copyPath, "utf8")).toBe("%PDF-1");
  });

  it("keeps an image's stored extension", async () => {
    const source = storedImage("thread-source");
    const { attachment } = await materializeInheritedAttachment({
      attachmentsDir,
      forkThreadId: FORK,
      attachment: source,
    });
    expect(attachmentRelativePath(attachment)).toMatch(/\.png$/);
    expect(fs.existsSync(path.join(attachmentsDir, attachmentRelativePath(attachment)!))).toBe(
      true,
    );
  });

  it("refuses symlinked, missing and changed sources", async () => {
    const outside = path.join(attachmentsDir, "..", `outside-${path.basename(attachmentsDir)}`);
    fs.writeFileSync(outside, "secret");
    try {
      const linked = {
        type: "file",
        id: createFileAttachmentId("thread-source", "x.txt")!,
        name: "x.txt",
        mimeType: "text/plain",
        sizeBytes: 6,
      } as const satisfies ChatAttachment;
      fs.symlinkSync(outside, path.join(attachmentsDir, attachmentRelativePath(linked)!));
      await expect(
        materializeInheritedAttachment({ attachmentsDir, forkThreadId: FORK, attachment: linked }),
      ).rejects.toThrow();

      const changed = { ...storedFile("thread-source", "y.txt", "abc"), sizeBytes: 99 };
      await expect(
        materializeInheritedAttachment({ attachmentsDir, forkThreadId: FORK, attachment: changed }),
      ).rejects.toThrow();

      const missing = { ...storedFile("thread-source", "z.txt", "abc") };
      fs.unlinkSync(path.join(attachmentsDir, attachmentRelativePath(missing)!));
      await expect(
        materializeInheritedAttachment({ attachmentsDir, forkThreadId: FORK, attachment: missing }),
      ).rejects.toThrow();
      expect(fs.readdirSync(attachmentsDir).some((name) => name.startsWith(FORK))).toBe(false);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});

describe("deleteThreadAttachmentFiles", () => {
  it("deletes only the given thread's files and tolerates missing ones", async () => {
    const source = storedFile("thread-source", "keep.pdf", "keep");
    const { attachment } = await materializeInheritedAttachment({
      attachmentsDir,
      forkThreadId: FORK,
      attachment: source,
    });
    await expect(
      deleteThreadAttachmentFiles({
        attachmentsDir,
        threadId: FORK,
        attachmentIds: [attachment.id!, source.id],
      }),
    ).rejects.toThrow();
    expect(fs.existsSync(path.join(attachmentsDir, attachmentRelativePath(attachment)!))).toBe(
      true,
    );

    await deleteThreadAttachmentFiles({
      attachmentsDir,
      threadId: FORK,
      attachmentIds: [attachment.id!, attachment.id!],
    });
    expect(fs.existsSync(path.join(attachmentsDir, attachmentRelativePath(attachment)!))).toBe(
      false,
    );
    expect(
      fs.readFileSync(path.join(attachmentsDir, attachmentRelativePath(source)!), "utf8"),
    ).toBe("keep");
  });
});
