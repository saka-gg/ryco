import { describe, expect, it } from "vite-plus/test";
import { HUB_SESSION_MAX_FRAME_BYTES, type HubSessionFrame } from "@ryco/contracts/hub-session";
import { RELAY_MAX_DATA_FRAME_BYTES } from "@ryco/contracts/relay";
import {
  decodeHubSessionFrame,
  encodeHubSessionFrame,
  negotiateHubSessionVersion,
  parseHubSessionSubprotocols,
} from "./hubSessionCodec.ts";

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
  it("borrows a data payload from the input only when asked to, and nothing else", () => {
    const data = encodeHubSessionFrame({ type: "data", streamId: 9, payload: Uint8Array.of(5, 6) });
    if (!data.ok) throw new Error("encode");
    const borrowed = decodeHubSessionFrame(data.value, { borrowDataPayload: true });
    if (!borrowed.ok || borrowed.value.type !== "data") throw new Error("decode");
    expect([...borrowed.value.payload]).toEqual([5, 6]);
    // A view over the input: the consumer that zeroes it zeroes the input too.
    expect(borrowed.value.payload.buffer).toBe(data.value.buffer);
    borrowed.value.payload.fill(0);
    expect([...data.value.subarray(5)]).toEqual([0, 0]);

    const ping = encodeHubSessionFrame({
      type: "ping",
      nonce: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8),
    });
    if (!ping.ok) throw new Error("encode");
    const nonce = decodeHubSessionFrame(ping.value, { borrowDataPayload: true });
    ping.value.fill(0);
    expect(nonce).toEqual({
      ok: true,
      value: { type: "ping", nonce: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8) },
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

const NODE_ID = `node_${"a".repeat(22)}`;
const ACCOUNT_ID = `acct_${"b".repeat(22)}`;
const SESSION_ID = `sess_${"c".repeat(22)}`;
const ascii = (value: string) => [...value].map((character) => character.charCodeAt(0));
const openNode = (overrides: Record<string, unknown> = {}) =>
  ({
    type: "openNode",
    streamId: 3,
    nodeId: NODE_ID,
    sessionId: SESSION_ID,
    capability: "ryco.rpc",
    protocolMajor: 1,
    protocolMinor: 3,
    ...overrides,
  }) as HubSessionFrame;
const v2 = { protocolVersion: 2 } as const;

describe("Hub session protocol version 2", () => {
  it("keeps every version 1 frame byte for byte", () => {
    const pinned: ReadonlyArray<readonly [HubSessionFrame, readonly number[]]> = [
      [{ type: "ready", protocolVersion: 1, maxChannels: 8 }, [4, 0, 0, 0, 0, 1, 8]],
      [{ type: "open", streamId: 7 }, [1, 0, 0, 0, 7]],
      [{ type: "close", streamId: 7, code: 1000, reason: "x" }, [3, 0, 0, 0, 7, 3, 232, 120]],
      [{ type: "invalidate", directory: true, threadCache: true }, [7, 0, 0, 0, 0, 3]],
    ];
    for (const [frame, bytes] of pinned) {
      const encoded = encodeHubSessionFrame(frame);
      if (!encoded.ok) throw new Error("encode");
      expect([...encoded.value]).toEqual(bytes);
      // A version-2 decoder reads version-1 frames exactly as a version-1 decoder does.
      expect(decodeHubSessionFrame(encoded.value)).toEqual({ ok: true, value: frame });
      expect(decodeHubSessionFrame(encoded.value, v2)).toEqual({ ok: true, value: frame });
    }
  });

  it("encodes a version 2 ready with the account and session ids and decodes it only under v2", () => {
    const frame: HubSessionFrame = {
      type: "ready",
      protocolVersion: 2,
      maxChannels: 8,
      accountId: ACCOUNT_ID,
      sessionId: SESSION_ID,
    };
    const encoded = encodeHubSessionFrame(frame);
    if (!encoded.ok) throw new Error("encode");
    expect([...encoded.value]).toEqual([
      4,
      0,
      0,
      0,
      0,
      2,
      8,
      27,
      ...ascii(ACCOUNT_ID),
      27,
      ...ascii(SESSION_ID),
    ]);
    expect(decodeHubSessionFrame(encoded.value, v2)).toEqual({ ok: true, value: frame });
    // A client that never advertised version 2 fails closed on it, as a version-1 codec does.
    expect(decodeHubSessionFrame(encoded.value).ok).toBe(false);
  });

  it("round trips openNode under v2 and pins its wire format", () => {
    const encoded = encodeHubSessionFrame(openNode());
    if (!encoded.ok) throw new Error("encode");
    expect([...encoded.value]).toEqual([
      8,
      0,
      0,
      0,
      3,
      1,
      3,
      1,
      27,
      ...ascii(NODE_ID),
      27,
      ...ascii(SESSION_ID),
    ]);
    expect(decodeHubSessionFrame(encoded.value, v2)).toEqual({ ok: true, value: openNode() });
    const minor2 = encodeHubSessionFrame(openNode({ protocolMinor: 2 }));
    if (!minor2.ok) throw new Error("encode");
    expect(decodeHubSessionFrame(minor2.value, v2)).toEqual({
      ok: true,
      value: openNode({ protocolMinor: 2 }),
    });
  });

  it("fails closed on openNode under a version 1 session", () => {
    const encoded = encodeHubSessionFrame(openNode());
    if (!encoded.ok) throw new Error("encode");
    expect(decodeHubSessionFrame(encoded.value).ok).toBe(false);
    expect(decodeHubSessionFrame(encoded.value, { protocolVersion: 1 }).ok).toBe(false);
  });

  it.each<[string, number[]]>([
    ["stream zero", [8, 0, 0, 0, 0, 1, 3, 1, 27, ...ascii(NODE_ID), 27, ...ascii(SESSION_ID)]],
    ["empty payload", [8, 0, 0, 0, 3]],
    ["truncated node id", [8, 0, 0, 0, 3, 1, 3, 1, 27, ...ascii(NODE_ID).slice(0, 26)]],
    ["missing session id", [8, 0, 0, 0, 3, 1, 3, 1, 27, ...ascii(NODE_ID)]],
    ["trailing byte", [8, 0, 0, 0, 3, 1, 3, 1, 27, ...ascii(NODE_ID), 27, ...ascii(SESSION_ID), 0]],
    [
      "account id in place of the session id",
      [8, 0, 0, 0, 3, 1, 3, 1, 27, ...ascii(NODE_ID), 27, ...ascii(ACCOUNT_ID)],
    ],
    ["zero-length node id", [8, 0, 0, 0, 3, 1, 3, 1, 0]],
    ["oversized length", [8, 0, 0, 0, 3, 1, 3, 1, 49, ...Array.from({ length: 49 }, () => 97)]],
    [
      "unknown capability 0",
      [8, 0, 0, 0, 3, 1, 3, 0, 27, ...ascii(NODE_ID), 27, ...ascii(SESSION_ID)],
    ],
    [
      "unknown capability 2",
      [8, 0, 0, 0, 3, 1, 3, 2, 27, ...ascii(NODE_ID), 27, ...ascii(SESSION_ID)],
    ],
    ["minor 1", [8, 0, 0, 0, 3, 1, 1, 1, 27, ...ascii(NODE_ID), 27, ...ascii(SESSION_ID)]],
    ["minor 4", [8, 0, 0, 0, 3, 1, 4, 1, 27, ...ascii(NODE_ID), 27, ...ascii(SESSION_ID)]],
    ["major 2", [8, 0, 0, 0, 3, 2, 3, 1, 27, ...ascii(NODE_ID), 27, ...ascii(SESSION_ID)]],
    [
      "invalid node id",
      [8, 0, 0, 0, 3, 1, 3, 1, 27, ...ascii(`nodx_${"a".repeat(22)}`), 27, ...ascii(SESSION_ID)],
    ],
    ["unknown kind 9", [9, 0, 0, 0, 3]],
  ])("rejects a malformed openNode: %s", (_name, bytes) => {
    expect(decodeHubSessionFrame(Uint8Array.from(bytes), v2).ok).toBe(false);
  });

  it.each<[string, number[]]>([
    ["missing ids", [4, 0, 0, 0, 0, 2, 8]],
    ["trailing byte", [4, 0, 0, 0, 0, 2, 8, 27, ...ascii(ACCOUNT_ID), 27, ...ascii(SESSION_ID), 0]],
    ["truncated session", [4, 0, 0, 0, 0, 2, 8, 27, ...ascii(ACCOUNT_ID), 27, 115]],
    ["swapped ids", [4, 0, 0, 0, 0, 2, 8, 27, ...ascii(SESSION_ID), 27, ...ascii(ACCOUNT_ID)]],
    ["channel bound", [4, 0, 0, 0, 0, 2, 9, 27, ...ascii(ACCOUNT_ID), 27, ...ascii(SESSION_ID)]],
    ["unknown version 3", [4, 0, 0, 0, 0, 3, 8]],
    ["version 1 with trailing ids", [4, 0, 0, 0, 0, 1, 8, 27, ...ascii(ACCOUNT_ID)]],
  ])("rejects a malformed version 2 ready: %s", (_name, bytes) => {
    expect(decodeHubSessionFrame(Uint8Array.from(bytes), v2).ok).toBe(false);
  });

  it("refuses to encode frames outside the schema", () => {
    expect(encodeHubSessionFrame(openNode({ nodeId: "node_short" })).ok).toBe(false);
    expect(encodeHubSessionFrame(openNode({ capability: "ryco.files" })).ok).toBe(false);
    expect(encodeHubSessionFrame(openNode({ protocolMinor: 4 })).ok).toBe(false);
    expect(encodeHubSessionFrame(openNode({ protocolMajor: 2 })).ok).toBe(false);
    expect(encodeHubSessionFrame(openNode({ streamId: 0 })).ok).toBe(false);
    expect(encodeHubSessionFrame(openNode({ sessionId: ACCOUNT_ID })).ok).toBe(false);
    const ready = {
      type: "ready",
      protocolVersion: 2,
      maxChannels: 8,
      accountId: ACCOUNT_ID,
      sessionId: SESSION_ID,
    } as const;
    expect(encodeHubSessionFrame({ ...ready, accountId: SESSION_ID }).ok).toBe(false);
    expect(encodeHubSessionFrame({ ...ready, sessionId: ACCOUNT_ID }).ok).toBe(false);
    expect(encodeHubSessionFrame({ ...ready, maxChannels: 0 }).ok).toBe(false);
  });

  it("parses the advertised maximum from the subprotocol offer and negotiates the lower version", () => {
    expect(parseHubSessionSubprotocols(null)).toEqual({ maxVersion: 1, token: null });
    expect(parseHubSessionSubprotocols("ryco.hub-session.v2")).toEqual({
      maxVersion: 2,
      token: "ryco.hub-session.v2",
    });
    expect(parseHubSessionSubprotocols("chat, ryco.hub-session.v3 , ryco.hub-session.v2")).toEqual({
      maxVersion: 3,
      token: "ryco.hub-session.v3",
    });
    for (const ignored of [
      "chat",
      "ryco.hub-session.v0",
      "ryco.hub-session.v02",
      "ryco.hub-session.vx",
    ])
      expect(parseHubSessionSubprotocols(ignored)).toEqual({ maxVersion: 1, token: null });
    expect(
      parseHubSessionSubprotocols(Array.from({ length: 9 }, () => "ryco.hub-session.v2").join(",")),
    ).toEqual({ maxVersion: 1, token: null });
    expect(negotiateHubSessionVersion(1, 2)).toBe(1);
    expect(negotiateHubSessionVersion(2, 1)).toBe(1);
    expect(negotiateHubSessionVersion(2, 2)).toBe(2);
    expect(negotiateHubSessionVersion(9, 2)).toBe(2);
  });
});
