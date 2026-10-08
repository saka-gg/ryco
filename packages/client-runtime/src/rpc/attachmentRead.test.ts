import { expect, it, vi } from "vite-plus/test";
import { MessageId, ThreadId } from "@ryco/contracts";
import { readAttachmentBytes, readAttachmentBytesFromTransport } from "./attachmentRead.ts";

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

it("reads over the transport current at the start and fails if it is replaced mid-read", async () => {
  const chunk = (data: string) => async (input: { offset: number }) => ({
    offset: input.offset,
    totalBytes: 5,
    dataBase64: btoa(input.offset === 0 ? data.slice(0, 3) : data.slice(3)),
  });
  const first = { readChunk: vi.fn(chunk("abcde")) };
  expect(
    await readAttachmentBytesFromTransport({
      reference,
      sizeBytes: 5,
      currentTransport: () => first,
    }),
  ).toEqual(new TextEncoder().encode("abcde"));

  let current: { readChunk: ReturnType<typeof vi.fn> } | undefined = first;
  const second = { readChunk: vi.fn(chunk("vwxyz")) };
  first.readChunk.mockImplementationOnce(async (input: { offset: number }) => {
    current = second;
    return { offset: input.offset, totalBytes: 5, dataBase64: btoa("abc") };
  });
  await expect(
    readAttachmentBytesFromTransport({ reference, sizeBytes: 5, currentTransport: () => current }),
  ).rejects.toThrow("Attachment connection changed.");
  expect(second.readChunk).not.toHaveBeenCalled();

  current = undefined;
  await expect(
    readAttachmentBytesFromTransport({ reference, sizeBytes: 5, currentTransport: () => current }),
  ).rejects.toThrow("Attachment connection unavailable.");
});
