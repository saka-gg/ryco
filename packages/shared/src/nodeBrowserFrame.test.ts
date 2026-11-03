import { describe, expect, it } from "vitest";

import {
  decodeNodeBrowserFrame,
  encodeNodeBrowserFrame,
  isNodeBrowserFrameAck,
  NODE_BROWSER_FRAME_ACK,
  NODE_BROWSER_FRAME_HEADER_BYTES,
} from "./nodeBrowserFrame.ts";

describe("node browser frame envelope", () => {
  it("carries the sequence and the page's CSS size with the JPEG", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const encoded = encodeNodeBrowserFrame({
      seq: 2 ** 32 - 1,
      cssWidth: 1280,
      cssHeight: 800,
      jpeg,
    });
    expect(encoded.byteLength).toBe(NODE_BROWSER_FRAME_HEADER_BYTES + jpeg.byteLength);
    const decoded = decodeNodeBrowserFrame(encoded);
    expect(decoded.ok && decoded.frame.seq).toBe(2 ** 32 - 1);
    expect(decoded.ok && [decoded.frame.cssWidth, decoded.frame.cssHeight]).toEqual([1280, 800]);
    expect(decoded.ok && [...decoded.frame.jpeg]).toEqual([...jpeg]);
  });

  it("rejects a bad magic, another version and a truncated header", () => {
    const encoded = encodeNodeBrowserFrame({
      seq: 1,
      cssWidth: 10,
      cssHeight: 10,
      jpeg: new Uint8Array([1]),
    });
    expect(decodeNodeBrowserFrame(encoded.subarray(0, NODE_BROWSER_FRAME_HEADER_BYTES))).toEqual({
      ok: false,
      reason: "truncated",
    });
    const badMagic = encoded.slice();
    badMagic[0] = 0;
    expect(decodeNodeBrowserFrame(badMagic)).toEqual({ ok: false, reason: "bad-magic" });
    const badVersion = encoded.slice();
    badVersion[2] = 2;
    expect(decodeNodeBrowserFrame(badVersion)).toEqual({ ok: false, reason: "bad-version" });
  });

  it("recognizes only the acknowledgement, in text or binary", () => {
    expect(isNodeBrowserFrameAck(NODE_BROWSER_FRAME_ACK)).toBe(true);
    expect(isNodeBrowserFrameAck(new TextEncoder().encode(NODE_BROWSER_FRAME_ACK))).toBe(true);
    for (const other of [
      '{"type":"mouse"}',
      '["ack"]',
      "ack",
      "null",
      `{"type":"ack","pad":"${"x".repeat(64)}"}`,
    ]) {
      expect(isNodeBrowserFrameAck(other), other).toBe(false);
    }
  });
});
