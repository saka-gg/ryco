import { describe, expect, it } from "vitest";

import {
  decodeRelayFrameTunnelMessage,
  encodeRelayFrameTunnelAck,
  encodeRelayFrameTunnelBinary,
  encodeRelayFrameTunnelClose,
  encodeRelayFrameTunnelOpen,
  encodeRelayFrameTunnelText,
  isRelayFrameTunnelMessage,
  isRelayFrameTunnelNodeBrowserTabId,
  RELAY_FRAME_TUNNEL_MAGIC,
  RELAY_FRAME_TUNNEL_NODE_BROWSER_FRAMES,
} from "./relayFrameTunnel.ts";

const HANDOFF_TAB = `handoff-${"0123456789abcdef".repeat(2)}`;

describe("relay frame tunnel", () => {
  it("round-trips every kind", () => {
    expect(
      decodeRelayFrameTunnelMessage(
        encodeRelayFrameTunnelOpen(7, { target: "device-frames", udid: "ABC-123" }),
      ),
    ).toEqual({ kind: "open", streamId: 7, target: { target: "device-frames", udid: "ABC-123" } });
    expect(decodeRelayFrameTunnelMessage(encodeRelayFrameTunnelClose(1))).toEqual({
      kind: "close",
      streamId: 1,
      code: null,
      reason: "",
    });
    expect(decodeRelayFrameTunnelMessage(encodeRelayFrameTunnelClose(2, 4404, "gone"))).toEqual({
      kind: "close",
      streamId: 2,
      code: 4404,
      reason: "gone",
    });
    expect(decodeRelayFrameTunnelMessage(encodeRelayFrameTunnelText(3, "hé"))).toEqual({
      kind: "text",
      streamId: 3,
      text: "hé",
    });
    const binary = decodeRelayFrameTunnelMessage(
      encodeRelayFrameTunnelBinary(0xffff_ffff, Uint8Array.of(1, 2, 3)),
    );
    expect(binary?.kind === "binary" && [...binary.bytes]).toEqual([1, 2, 3]);
    expect(decodeRelayFrameTunnelMessage(encodeRelayFrameTunnelAck(4, 2 ** 32 + 5))).toEqual({
      kind: "ack",
      streamId: 4,
      received: 5,
    });
  });

  it("never mistakes JSON RPC or a compressed frame for a tunnel message", () => {
    expect(isRelayFrameTunnelMessage(new TextEncoder().encode('{"_tag":"Ping"}'))).toBe(false);
    expect(isRelayFrameTunnelMessage(Uint8Array.of(0xff, 1))).toBe(false);
    expect(isRelayFrameTunnelMessage(Uint8Array.of(RELAY_FRAME_TUNNEL_MAGIC))).toBe(true);
  });

  it("rejects malformed messages", () => {
    const valid = encodeRelayFrameTunnelText(1, "x");
    expect(decodeRelayFrameTunnelMessage(valid.subarray(0, 6))).toBeNull();
    expect(decodeRelayFrameTunnelMessage(Uint8Array.of(0xfe, 2, 3, 0, 0, 0, 1))).toBeNull();
    expect(decodeRelayFrameTunnelMessage(Uint8Array.of(0xfe, 1, 9, 0, 0, 0, 1))).toBeNull();
    expect(decodeRelayFrameTunnelMessage(Uint8Array.of(0xfe, 1, 3, 0, 0, 0, 0))).toBeNull();
    expect(
      decodeRelayFrameTunnelMessage(
        encodeRelayFrameTunnelOpen(1, { target: "device-frames", udid: "bad udid" }),
      ),
    ).toBeNull();
    expect(decodeRelayFrameTunnelMessage(Uint8Array.of(0xfe, 1, 5, 0, 0, 0, 1, 0))).toBeNull();
    expect(decodeRelayFrameTunnelMessage(Uint8Array.of(0xfe, 1, 3, 0, 0, 0, 1, 0xc3))).toBeNull();
    expect(() => encodeRelayFrameTunnelText(0, "x")).toThrow(RangeError);
  });

  it("round-trips a node browser target for a handed-off tab", () => {
    expect(
      decodeRelayFrameTunnelMessage(
        encodeRelayFrameTunnelOpen(5, {
          target: RELAY_FRAME_TUNNEL_NODE_BROWSER_FRAMES,
          tabId: HANDOFF_TAB,
        }),
      ),
    ).toEqual({
      kind: "open",
      streamId: 5,
      target: { target: "node-browser-frames", tabId: HANDOFF_TAB },
    });
  });

  it("tunnels no node browser tab but a handed-off one", () => {
    const open = (body: unknown) =>
      decodeRelayFrameTunnelMessage(
        encodeRelayFrameTunnelOpen(1, body as Parameters<typeof encodeRelayFrameTunnelOpen>[1]),
      );
    for (const tabId of [
      "tab-1",
      "handoff-",
      `handoff-${"A".repeat(32)}`,
      `handoff-${"0".repeat(31)}`,
      `handoff-${"0".repeat(33)}`,
      ` ${HANDOFF_TAB}`,
      `${HANDOFF_TAB}\n`,
    ]) {
      expect(isRelayFrameTunnelNodeBrowserTabId(tabId)).toBe(false);
      expect(open({ target: "node-browser-frames", tabId })).toBeNull();
    }
    expect(open({ target: "node-browser-frames" })).toBeNull();
    expect(open({ target: "node-browser-frames", tabId: 7 })).toBeNull();
    // Each target reads only its own field.
    expect(open({ target: "node-browser-frames", udid: HANDOFF_TAB })).toBeNull();
    expect(open({ target: "device-frames", tabId: "SIM-1" })).toBeNull();
    expect(open({ target: "browser-frames", tabId: HANDOFF_TAB })).toBeNull();
    expect(isRelayFrameTunnelNodeBrowserTabId(HANDOFF_TAB)).toBe(true);
  });
});

describe("node-browser open targets", () => {
  it("carries the viewer's frame size and quality, and drops values out of range", () => {
    const tabId = `handoff-${"c".repeat(32)}`;
    const open = (target: {
      readonly target: "node-browser-frames";
      readonly tabId: string;
      readonly maxWidth?: number;
      readonly maxHeight?: number;
      readonly quality?: number;
    }) => decodeRelayFrameTunnelMessage(encodeRelayFrameTunnelOpen(7, target));
    expect(
      open({ target: "node-browser-frames", tabId, maxWidth: 640, maxHeight: 480, quality: 50 }),
    ).toMatchObject({ target: { tabId, maxWidth: 640, maxHeight: 480, quality: 50 } });
    const clamped = open({ target: "node-browser-frames", tabId, maxWidth: 99_999, quality: 5 });
    expect(clamped).toMatchObject({ target: { tabId } });
    expect(JSON.stringify(clamped)).not.toMatch(/maxWidth|quality/);
  });
});
