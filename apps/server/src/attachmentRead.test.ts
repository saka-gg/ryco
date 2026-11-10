import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, expect, it } from "vite-plus/test";
import { Effect, Option } from "effect";
import {
  CHAT_ATTACHMENT_READ_CHUNK_BYTES,
  MessageId,
  ThreadId,
  type OrchestrationMessage,
} from "@ryco/contracts";
import { persistAssistantAttachment } from "./assistantAttachments.ts";
import { readAttachmentChunk, resetResolvedAttachmentsForTests } from "./attachmentRead.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
it("reads bounded chunks only for attachments belonging to the requested persisted message", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ryco-read-file-"));
  roots.push(root);
  const attachmentsDir = path.join(root, "attachments");
  const source = Buffer.alloc(CHAT_ATTACHMENT_READ_CHUNK_BYTES + 7, 42);
  await fs.writeFile(path.join(root, "clip.mp4"), source);
  const threadId = ThreadId.make("thread");
  const messageId = MessageId.make("message");
  const attachment = await persistAssistantAttachment({
    cwd: root,
    attachmentsDir,
    threadId,
    deliveryId: messageId,
    file: { path: "clip.mp4" },
  });
  const message: OrchestrationMessage = {
    id: messageId,
    role: "assistant",
    text: "",
    turnId: null,
    streaming: false,
    createdAt: "2026-09-07T00:00:00Z",
    updatedAt: "2026-09-07T00:00:00Z",
    attachments: [attachment],
  };
  const deps = {
    attachmentsDir,
    projections: {
      getThreadMessageById: (input: { threadId: ThreadId; messageId: MessageId }) =>
        Effect.succeed(
          input.threadId === threadId && input.messageId === messageId
            ? Option.some(message)
            : Option.none(),
        ),
    },
  };
  const input = { threadId, messageId, attachmentId: attachment.id!, offset: 0 };
  const first = await Effect.runPromise(readAttachmentChunk(input, deps));
  expect(Buffer.from(first.dataBase64, "base64")).toEqual(
    source.subarray(0, CHAT_ATTACHMENT_READ_CHUNK_BYTES),
  );
  const last = await Effect.runPromise(
    readAttachmentChunk({ ...input, offset: CHAT_ATTACHMENT_READ_CHUNK_BYTES }, deps),
  );
  expect(Buffer.from(last.dataBase64, "base64")).toHaveLength(7);
  for (const invalid of [
    { ...input, threadId: ThreadId.make("other") },
    { ...input, messageId: MessageId.make("other") },
    { ...input, attachmentId: "unknown" },
    { ...input, offset: source.length },
  ]) {
    await expect(Effect.runPromise(readAttachmentChunk(invalid, deps))).rejects.toThrow(
      "Attachment unavailable",
    );
  }
});

async function persistedMessage(file: { name: string; bytes: Buffer }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ryco-read-file-"));
  roots.push(root);
  const attachmentsDir = path.join(root, "attachments");
  await fs.writeFile(path.join(root, file.name), file.bytes);
  const threadId = ThreadId.make("thread");
  const messageId = MessageId.make("message");
  const attachment = await persistAssistantAttachment({
    cwd: root,
    attachmentsDir,
    threadId,
    deliveryId: messageId,
    file: { path: file.name },
  });
  const message: OrchestrationMessage = {
    id: messageId,
    role: "assistant",
    text: "",
    turnId: null,
    streaming: false,
    createdAt: "2026-09-07T00:00:00Z",
    updatedAt: "2026-09-07T00:00:00Z",
    attachments: [attachment],
  };
  let lookups = 0;
  const deps = {
    attachmentsDir,
    projections: {
      getThreadMessageById: () => {
        lookups += 1;
        return Effect.succeed(Option.some(message));
      },
    },
  };
  return {
    deps,
    lookups: () => lookups,
    input: { threadId, messageId, attachmentId: attachment.id!, offset: 0 },
  };
}

it("looks up the message once for a run of chunks, not once per chunk", async () => {
  resetResolvedAttachmentsForTests();
  const bytes = Buffer.alloc(CHAT_ATTACHMENT_READ_CHUNK_BYTES * 3 + 1, 9);
  const { deps, input, lookups } = await persistedMessage({ name: "clip.mp4", bytes });
  for (let offset = 0; offset < bytes.length; offset += CHAT_ATTACHMENT_READ_CHUNK_BYTES) {
    await Effect.runPromise(readAttachmentChunk({ ...input, offset }, deps));
  }
  expect(lookups()).toBe(1);
  // Once the run is over, the next read proves membership again.
  const now = Date.now() + 60_000;
  await Effect.runPromise(readAttachmentChunk(input, { ...deps, now: () => now }));
  expect(lookups()).toBe(2);
});

it("serves an image's preview when asked, and says whether it did", async () => {
  resetResolvedAttachmentsForTests();
  const png = await sharp({
    create: {
      width: 2000,
      height: 1250,
      channels: 3,
      background: "#000",
      noise: { type: "gaussian", mean: 128, sigma: 40 },
    },
  })
    .png()
    .toBuffer();
  const { deps, input } = await persistedMessage({ name: "shot.png", bytes: png });

  // An older client never asks: the original, without `preview`.
  const plain = await Effect.runPromise(readAttachmentChunk(input, deps));
  expect(plain.totalBytes).toBe(png.length);
  expect(plain).not.toHaveProperty("preview");

  const first = await Effect.runPromise(readAttachmentChunk({ ...input, preview: 512 }, deps));
  expect(first.preview).toBe(true);
  expect(first.totalBytes).toBeLessThan(png.length / 4);
  let previewBytes = Buffer.from(first.dataBase64, "base64");
  for (let offset = previewBytes.length; offset < first.totalBytes;) {
    const next = await Effect.runPromise(
      readAttachmentChunk({ ...input, offset, preview: 512 }, deps),
    );
    expect(next.totalBytes).toBe(first.totalBytes);
    const chunk = Buffer.from(next.dataBase64, "base64");
    previewBytes = Buffer.concat([previewBytes, chunk]);
    offset += chunk.length;
  }
  const metadata = await sharp(previewBytes).metadata();
  expect([metadata.format, metadata.width, metadata.height]).toEqual(["webp", 512, 320]);

  // A file that is no image is its own preview.
  const other = await persistedMessage({ name: "clip.mp4", bytes: Buffer.alloc(300_000, 1) });
  const original = await Effect.runPromise(
    readAttachmentChunk({ ...other.input, preview: 1024 }, other.deps),
  );
  expect(original).toMatchObject({ preview: false, totalBytes: 300_000 });
});
