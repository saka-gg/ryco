import { describe, expect, it } from "vite-plus/test";
import { HUB_SESSION_MAX_FRAME_BYTES, type HubSessionFrame } from "@ryco/contracts/hub-session";
import { RELAY_MAX_DATA_FRAME_BYTES } from "@ryco/contracts/relay";
import { decodeHubSessionFrame, encodeHubSessionFrame } from "./hubSessionCodec.ts";

describe("Hub session envelope", () => {
  it.each<HubSessionFrame>([
    { type: "open", streamId: 0xffff_ffff },
    { type: "data", streamId: 7, payload: Uint8Array.of(0, 255, 3) },
    { type: "close", streamId: 2, code: 4401, reason: "authorization failed" },
    { type: "ready", protocolVersion: 1, maxChannels: 8 },
    { type: "ping", nonce: new Uint8Array(8) },
    { type: "pong", nonce: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8) },
    { type: "invalidate", directory: true, threadCache: false },
    { type: "invalidate", directory: false, threadCache: true },
    { type: "invalidate", directory: true, threadCache: true },
  ])("round trips $type without changing inner bytes", (frame) => {
    const encoded = encodeHubSessionFrame(frame);
    expect(encoded.ok).toBe(true);
    if (encoded.ok)
      expect(decodeHubSessionFrame(encoded.value)).toEqual({ ok: true, value: frame });
  });
  it("pins the wire format and owns decoded data", () => {
    const encoded = encodeHubSessionFrame({
      type: "data",
      streamId: 0x01020304,
      payload: Uint8Array.of(77),
    });
    if (!encoded.ok) throw new Error("encode");
    expect([...encoded.value]).toEqual([2, 1, 2, 3, 4, 77]);
    const decoded = decodeHubSessionFrame(encoded.value);
    encoded.value.fill(0);
    expect(decoded).toEqual({
      ok: true,
      value: { type: "data", streamId: 0x01020304, payload: Uint8Array.of(77) },
    });
  });
  it("enforces frame, UTF8 reason, nonce and channel bounds", () => {
    expect(
      encodeHubSessionFrame({
        type: "data",
        streamId: 1,
        payload: new Uint8Array(RELAY_MAX_DATA_FRAME_BYTES),
      }).ok,
    ).toBe(true);
    expect(decodeHubSessionFrame(new Uint8Array(HUB_SESSION_MAX_FRAME_BYTES + 1)).ok).toBe(false);
    expect(
      encodeHubSessionFrame({ type: "close", streamId: 1, code: 1000, reason: "😀".repeat(17) }).ok,
    ).toBe(false);
    expect(encodeHubSessionFrame({ type: "open", streamId: 0 }).ok).toBe(false);
    expect(encodeHubSessionFrame({ type: "ready", protocolVersion: 1, maxChannels: 9 }).ok).toBe(
      false,
    );
    expect(encodeHubSessionFrame({ type: "ping", nonce: new Uint8Array(7) }).ok).toBe(false);
    expect(
      encodeHubSessionFrame({ type: "invalidate", directory: false, threadCache: false }).ok,
    ).toBe(false);
  });
  it.each([
    [],
    [1, 0, 0, 0, 0],
    [4, 0, 0, 0, 1, 8],
    [1, 0, 0, 0, 1, 0],
    [2, 0, 0, 0, 1],
    [4, 0, 0, 0, 0, 1, 9],
    [4, 0, 0, 0, 0, 2, 8],
    [4, 0, 0, 0, 0, 8],
    [7, 0, 0, 0, 0, 4],
    [3, 0, 0, 0, 1, 3, 232, 255],
    [255, 0, 0, 0, 0],
  ])("rejects malformed envelope %j", (...bytes) => {
    expect(decodeHubSessionFrame(Uint8Array.from(bytes)).ok).toBe(false);
  });
});
