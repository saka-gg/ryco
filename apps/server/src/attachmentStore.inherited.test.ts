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
  derivedAttachmentId,
  inheritedAttachmentId,
  linkOrCopyAttachmentFile,
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

describe("derivedAttachmentId", () => {
  it("is deterministic per (thread, source) and lives in the thread's segment", () => {
    const id = derivedAttachmentId({
      threadId: FORK,
      sourceId: "task-x-file",
      extensionSegment: "PDF",
    });
    expect(id).toBe(
      derivedAttachmentId({ threadId: FORK, sourceId: "task-x-file", extensionSegment: "PDF" }),
    );
    expect(id).toMatch(/-pdf$/);
    expect(parseThreadSegmentFromAttachmentId(id!)).toBe(FORK);
    expect(
      derivedAttachmentId({ threadId: FORK, sourceId: "task-y-file", extensionSegment: "pdf" }),
    ).not.toBe(id);
  });

  it("gives an image id without an extension segment, so its file is id plus extension", () => {
    const id = derivedAttachmentId({
      threadId: FORK,
      sourceId: "task-x-png",
      extensionSegment: null,
    })!;
    expect(id.split("-")).toHaveLength(7);
    expect(
      attachmentRelativePath({
        type: "image",
        id,
        name: "shot.png",
        mimeType: "image/png",
        sizeBytes: 4,
      }),
    ).toBe(`${id}.png`);
  });

  it("refuses ids longer than an attachment id may be", () => {
    // An 80-character thread segment, a uuid and a 12-character extension exceed 128.
    expect(
      derivedAttachmentId({
        threadId: "t".repeat(80),
        sourceId: "x",
        extensionSegment: "a".repeat(12),
      }),
    ).toBeNull();
  });
});

describe("linkOrCopyAttachmentFile", () => {
  it("hard-links once and counts an existing destination as done", async () => {
    const source = path.join(attachmentsDir, "source.bin");
    const destination = path.join(attachmentsDir, "copy.bin");
    fs.writeFileSync(source, "abc");
    const input = { source, destination, attachmentsDir, sizeBytes: 3, name: "notes.txt" };
    expect(await linkOrCopyAttachmentFile(input)).toEqual({ created: true });
    expect(fs.statSync(destination).ino).toBe(fs.statSync(source).ino);
    expect(await linkOrCopyAttachmentFile(input)).toEqual({ created: false });
  });

  it("refuses a source that changed size or is a symlink", async () => {
    const source = path.join(attachmentsDir, "source.bin");
    fs.writeFileSync(source, "abc");
    await expect(
      linkOrCopyAttachmentFile({
        source,
        destination: path.join(attachmentsDir, "copy.bin"),
        attachmentsDir,
        sizeBytes: 4,
        name: "notes.txt",
      }),
    ).rejects.toThrow("Attachment 'notes.txt' is missing or changed.");
    const linked = path.join(attachmentsDir, "linked.bin");
    fs.symlinkSync(source, linked);
    await expect(
      linkOrCopyAttachmentFile({
        source: linked,
        destination: path.join(attachmentsDir, "other.bin"),
        attachmentsDir,
        sizeBytes: 3,
        name: "notes.txt",
      }),
    ).rejects.toThrow();
    expect(fs.existsSync(path.join(attachmentsDir, "copy.bin"))).toBe(false);
    expect(fs.existsSync(path.join(attachmentsDir, "other.bin"))).toBe(false);
  });
});
