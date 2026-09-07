import { expect, it, vi } from "vite-plus/test";
import { MessageId, ThreadId } from "@ryco/contracts";
import { readAttachmentBytes } from "./attachmentRead.ts";

const reference = {
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make("message"),
  attachmentId: "file-id",
};
it("assembles bounded sequential chunks without changing the attachment reference", async () => {
  const readChunk = vi.fn(async (input: { offset: number }) => ({
    offset: input.offset,
    totalBytes: 5,
    dataBase64: input.offset === 0 ? btoa("abc") : btoa("de"),
  }));
  expect(await readAttachmentBytes({ reference, sizeBytes: 5, readChunk })).toEqual(
    new TextEncoder().encode("abcde"),
  );
  expect(readChunk.mock.calls).toEqual([
    [{ ...reference, offset: 0 }],
    [{ ...reference, offset: 3 }],
  ]);
});
it("rejects changed sizes, unexpected offsets and empty responses", async () => {
  for (const result of [
    { offset: 0, totalBytes: 6, dataBase64: btoa("abc") },
    { offset: 1, totalBytes: 5, dataBase64: btoa("abc") },
    { offset: 0, totalBytes: 5, dataBase64: "" },
  ]) {
    await expect(
      readAttachmentBytes({ reference, sizeBytes: 5, readChunk: async () => result }),
    ).rejects.toThrow();
  }
});
it("stops after cancellation instead of requesting more chunks", async () => {
  const controller = new AbortController();
  const readChunk = vi.fn(async () => {
    controller.abort();
    return { offset: 0, totalBytes: 5, dataBase64: btoa("abc") };
  });
  await expect(
    readAttachmentBytes({ reference, sizeBytes: 5, readChunk, signal: controller.signal }),
  ).rejects.toThrow("cancelled");
  expect(readChunk).toHaveBeenCalledTimes(1);
});
