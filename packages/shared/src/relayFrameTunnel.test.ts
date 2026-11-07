import { describe, expect, it } from "vitest";

import {
  decodeRelayFrameTunnelMessage,
  encodeRelayFrameTunnelAck,
  encodeRelayFrameTunnelBinary,
  encodeRelayFrameTunnelClose,
  encodeRelayFrameTunnelOpen,
  encodeRelayFrameTunnelText,
  isRelayFrameTunnelMessage,
  RELAY_FRAME_TUNNEL_MAGIC,
} from "./relayFrameTunnel.ts";

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
});
