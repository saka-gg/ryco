import { expect, it, vi } from "vite-plus/test";
import { MessageId, ThreadId } from "@ryco/contracts";
import {
  ATTACHMENT_READ_CONCURRENCY,
  readAttachmentBytes,
  readAttachmentBytesFromTransport,
} from "./attachmentRead.ts";
import {
  readAttachmentPreviewBytes,
  readAttachmentPreviewFromTransport,
} from "./attachmentPreviewRead.ts";

const reference = {
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make("message"),
  attachmentId: "file-id",
};
it("assembles bounded chunks without changing the attachment reference", async () => {
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

  let current: typeof first | undefined = first;
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

/** A server holding `file` (and `preview`, when it makes previews), answering after `delayMs`. */
function fakeServer(input: {
  file: Uint8Array;
  preview?: Uint8Array;
  /** An older server: ignores `preview` and never answers with it. */
  old?: boolean;
  chunkBytes?: number;
}) {
  let inFlight = 0;
  let maxInFlight = 0;
  const calls: Array<{ offset: number; preview?: number }> = [];
  const chunkBytes = input.chunkBytes ?? 4;
  const readChunk = async (request: { offset: number; preview?: 512 | 1024 | undefined }) => {
    calls.push({
      offset: request.offset,
      ...(request.preview ? { preview: request.preview } : {}),
    });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    // Yield so every reader the client started is in flight together.
    for (let turn = 0; turn < 3; turn++) await Promise.resolve();
    inFlight -= 1;
    const servesPreview =
      !input.old && request.preview !== undefined && input.preview !== undefined;
    const bytes = servesPreview ? input.preview! : input.file;
    const chunk = bytes.subarray(request.offset, request.offset + chunkBytes);
    return {
      offset: request.offset,
      totalBytes: bytes.length,
      dataBase64: btoa(String.fromCharCode(...chunk)),
      ...(!input.old && request.preview !== undefined ? { preview: servesPreview } : {}),
    };
  };
  return { readChunk, calls, maxInFlight: () => maxInFlight };
}

const bytesOf = (length: number, seed: number) =>
  Uint8Array.from({ length }, (_, index) => (index * 7 + seed) % 256);

it("keeps up to four chunk reads in flight and assembles them in order", async () => {
  const file = bytesOf(4 * 10 + 3, 1);
  const server = fakeServer({ file });
  expect(
    await readAttachmentBytes({ reference, sizeBytes: file.length, readChunk: server.readChunk }),
  ).toEqual(file);
  expect(server.maxInFlight()).toBe(ATTACHMENT_READ_CONCURRENCY);
  expect(server.calls.map((call) => call.offset).toSorted((a, b) => a - b)).toEqual(
    Array.from({ length: 11 }, (_, index) => index * 4),
  );
});

it("stops asking for chunks once one fails", async () => {
  const file = bytesOf(4 * 20, 2);
  const server = fakeServer({ file });
  let calls = 0;
  await expect(
    readAttachmentBytes({
      reference,
      sizeBytes: file.length,
      readChunk: async (request) => {
        calls += 1;
        if (request.offset === 8) throw new Error("gone");
        return server.readChunk(request);
      },
    }),
  ).rejects.toThrow("gone");
  expect(calls).toBeLessThan(10);
});

it("rejects a later chunk shorter than the first", async () => {
  const file = bytesOf(12, 3);
  const server = fakeServer({ file });
  await expect(
    readAttachmentBytes({
      reference,
      sizeBytes: file.length,
      readChunk: async (request) => {
        const result = await server.readChunk(request);
        return request.offset === 4 ? { ...result, dataBase64: btoa("ab") } : result;
      },
    }),
  ).rejects.toThrow("Invalid attachment chunk.");
});

it("reads a preview from a server that makes them, the rest of it from the same file", async () => {
  const file = bytesOf(40, 4);
  const preview = bytesOf(10, 5);
  const server = fakeServer({ file, preview });
  expect(
    await readAttachmentPreviewBytes({
      reference,
      size: 512,
      sizeBytes: file.length,
      readChunk: server.readChunk,
    }),
  ).toEqual({ bytes: preview, preview: true });
  expect(server.calls.every((call) => call.preview === 512)).toBe(true);
});

it("takes the original from a server without previews, and stops at maxBytes", async () => {
  const file = bytesOf(40, 6);
  const old = fakeServer({ file, preview: bytesOf(10, 7), old: true });
  let toldOld = false;
  expect(
    await readAttachmentPreviewBytes({
      reference,
      size: 1024,
      sizeBytes: file.length,
      readChunk: old.readChunk,
      onServerWithoutPreviews: () => {
        toldOld = true;
      },
    }),
  ).toEqual({ bytes: file, preview: false });
  expect(toldOld).toBe(true);

  const limited = fakeServer({ file, old: true });
  expect(
    await readAttachmentPreviewBytes({
      reference,
      size: 1024,
      sizeBytes: file.length,
      maxBytes: 20,
      readChunk: limited.readChunk,
    }),
  ).toBeNull();
  expect(limited.calls).toHaveLength(1);
});

it("does not ask a connection known to make no previews again for a large original", async () => {
  const file = bytesOf(40, 8);
  const old = fakeServer({ file, old: true });
  const transport = { readChunk: vi.fn(old.readChunk) };
  const read = () =>
    readAttachmentPreviewFromTransport({
      reference,
      size: 512,
      sizeBytes: file.length,
      maxBytes: 20,
      currentTransport: () => transport,
    });
  expect(await read()).toBeNull();
  expect(transport.readChunk).toHaveBeenCalledTimes(1);
  expect(await read()).toBeNull();
  expect(transport.readChunk).toHaveBeenCalledTimes(1);
  // A new connection (another server, perhaps updated) is asked again.
  const replacement = { readChunk: vi.fn(fakeServer({ file, preview: bytesOf(8, 9) }).readChunk) };
  expect(
    await readAttachmentPreviewFromTransport({
      reference,
      size: 512,
      sizeBytes: file.length,
      maxBytes: 20,
      currentTransport: () => replacement,
    }),
  ).toEqual({ bytes: bytesOf(8, 9), preview: true });
});
