import type { AttachmentReadTransport } from "@ryco/client-runtime/rpc";
import {
  CHAT_ATTACHMENT_READ_CHUNK_BYTES,
  MessageId,
  ThreadId,
  type ChatAttachmentReadChunkInput,
} from "@ryco/contracts";
import { injectHtmlRenderBootstrap } from "@ryco/shared/htmlRender";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  acquireHtmlRenderSource,
  clearHtmlRenderSourceCache,
  decodeHtmlRenderBytes,
  htmlRenderSourceKey,
  readCachedHtmlRenderSource,
} from "./htmlRenderSource";

const reference = {
  threadId: ThreadId.make("thread-1"),
  messageId: MessageId.make("message-1"),
  attachmentId: "thread-1-abc-html",
};
const key = htmlRenderSourceKey("env-1", reference);

function toBase64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}

/** A transport serving `bytes`, whose reads can be held open until released. */
function fakeTransport(bytes: Uint8Array, options: { hold?: boolean; fail?: boolean } = {}) {
  const pending: Array<() => void> = [];
  const readChunk = vi.fn(async (input: ChatAttachmentReadChunkInput) => {
    if (options.hold) await new Promise<void>((resolve) => pending.push(resolve));
    if (options.fail) throw new Error("boom");
    const chunk = bytes.subarray(input.offset, input.offset + CHAT_ATTACHMENT_READ_CHUNK_BYTES);
    return { dataBase64: toBase64(chunk), offset: input.offset, totalBytes: bytes.length };
  });
  const transport: AttachmentReadTransport = { readChunk };
  const release = () => {
    for (const resolve of pending.splice(0)) resolve();
  };
  return { transport, readChunk, release };
}

const page = new TextEncoder().encode("<!doctype html><p>Ünïcode ✓</p>");

afterEach(() => {
  clearHtmlRenderSourceCache();
});

describe("acquireHtmlRenderSource", () => {
  it("reads the page over the transport, decodes it, and keeps it", async () => {
    const { transport, readChunk } = fakeTransport(page);
    const lease = acquireHtmlRenderSource({
      key,
      reference,
      sizeBytes: page.length,
      currentTransport: () => transport,
    });
    await expect(lease.promise).resolves.toBe("<!doctype html><p>Ünïcode ✓</p>");
    expect(readChunk).toHaveBeenCalledWith({ ...reference, offset: 0 });
    expect(readCachedHtmlRenderSource(key)).toBe("<!doctype html><p>Ünïcode ✓</p>");

    // A row that mounts again is served from memory.
    const again = acquireHtmlRenderSource({
      key,
      reference,
      sizeBytes: page.length,
      currentTransport: () => transport,
    });
    await expect(again.promise).resolves.toBe("<!doctype html><p>Ünïcode ✓</p>");
    expect(readChunk).toHaveBeenCalledTimes(1);
  });

  it("shares one read between rows showing the same page", async () => {
    const { transport, readChunk, release } = fakeTransport(page, { hold: true });
    const request = { key, reference, sizeBytes: page.length, currentTransport: () => transport };
    const first = acquireHtmlRenderSource(request);
    const second = acquireHtmlRenderSource(request);
    expect(second.promise).toBe(first.promise);
    await vi.waitFor(() => expect(readChunk).toHaveBeenCalledTimes(1));
    // One row leaving does not cancel the read the other still waits for.
    first.release();
    release();
    await expect(second.promise).resolves.toContain("Ünïcode");
    expect(readChunk).toHaveBeenCalledTimes(1);
  });

  it("stops the read once every row has released it", async () => {
    const { transport, readChunk, release } = fakeTransport(page, { hold: true });
    const lease = acquireHtmlRenderSource({
      key,
      reference,
      sizeBytes: page.length,
      currentTransport: () => transport,
    });
    await vi.waitFor(() => expect(readChunk).toHaveBeenCalledTimes(1));
    lease.release();
    release();
    await expect(lease.promise).rejects.toThrow("Attachment load cancelled.");
    expect(readCachedHtmlRenderSource(key)).toBeUndefined();

    // The next row starts a fresh read rather than joining the cancelled one.
    const next = fakeTransport(page);
    await expect(
      acquireHtmlRenderSource({
        key,
        reference,
        sizeBytes: page.length,
        currentTransport: () => next.transport,
      }).promise,
    ).resolves.toContain("Ünïcode");
  });

  it("fails without a connection and remembers nothing, so a later read can succeed", async () => {
    const offline = acquireHtmlRenderSource({
      key,
      reference,
      sizeBytes: page.length,
      currentTransport: () => undefined,
    });
    await expect(offline.promise).rejects.toThrow("Attachment connection unavailable.");
    const failing = fakeTransport(page, { fail: true });
    await expect(
      acquireHtmlRenderSource({
        key,
        reference,
        sizeBytes: page.length,
        currentTransport: () => failing.transport,
      }).promise,
    ).rejects.toThrow("boom");
    expect(readCachedHtmlRenderSource(key)).toBeUndefined();
    const online = fakeTransport(page);
    await expect(
      acquireHtmlRenderSource({
        key,
        reference,
        sizeBytes: page.length,
        currentTransport: () => online.transport,
      }).promise,
    ).resolves.toContain("Ünïcode");
  });

  it("gives a page published by an older build this build's bootstrap, and keeps that", async () => {
    const published = "<!doctype html><html><head><title>t</title></head><body>x</body></html>";
    const current = injectHtmlRenderBootstrap(published);
    const older = current
      .replace(/<style id="ryco-theme">[^<]*<\/style>/, '<style id="ryco-theme">:root{}</style>')
      .replace(/<script>[\s\S]*?<\/script>/, "<script>window.oldBootstrap=1</script>");
    const { transport } = fakeTransport(new TextEncoder().encode(older));
    const lease = acquireHtmlRenderSource({
      key,
      reference,
      sizeBytes: new TextEncoder().encode(older).length,
      currentTransport: () => transport,
    });
    await expect(lease.promise).resolves.toBe(current);
    expect(readCachedHtmlRenderSource(key)).toBe(current);
  });

  it("keys pages by environment, thread, message, and attachment", () => {
    expect(htmlRenderSourceKey("env-2", reference)).not.toBe(key);
    expect(htmlRenderSourceKey("env-1", { ...reference, attachmentId: "other-html" })).not.toBe(
      key,
    );
  });
});

describe("decodeHtmlRenderBytes", () => {
  it("replaces malformed bytes instead of failing the page", () => {
    expect(decodeHtmlRenderBytes(new Uint8Array([0x3c, 0x70, 0x3e, 0xff, 0x3c]))).toBe("<p>�<");
  });
});
