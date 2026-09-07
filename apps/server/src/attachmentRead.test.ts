import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { Effect, Option } from "effect";
import {
  CHAT_ATTACHMENT_READ_CHUNK_BYTES,
  MessageId,
  ThreadId,
  type OrchestrationMessage,
} from "@ryco/contracts";
import { persistAssistantAttachment } from "./assistantAttachments.ts";
import { readAttachmentChunk } from "./attachmentRead.ts";

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
