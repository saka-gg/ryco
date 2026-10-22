import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  RELAY_CLOSE_REASONS,
  RELAY_FRAME_TYPES,
  RELAY_INITIAL_LIMITS,
  RELAY_PROTOCOL_MINOR,
  RELAY_MAX_DATA_CHUNK_BYTES,
  RelayChannelId,
  RelayFrame,
  RelayLimits,
  RelayNodeId,
} from "./relay.ts";

const version = { protocolMajor: 1, protocolMinor: 2 } as const;
const version3 = { protocolMajor: 1, protocolMinor: 3 } as const;
const nodeId = `node_${"n".repeat(22)}`;
const channelId = `ch_${"c".repeat(22)}`;
const digest = new Uint8Array(32).fill(8);

const validFrames = [
  {
    type: "auth",
    peer: "node",
    ...version,
    nodeId,
    nonce: new Uint8Array(32).fill(1),
    signature: new Uint8Array(64).fill(2),
  },
  {
    type: "auth",
    peer: "client",
    ...version,
    relayTicket: new Uint8Array(32).fill(3),
  },
  { type: "ready", ...version, limits: RELAY_INITIAL_LIMITS },
  {
    type: "channel.open",
    ...version,
    channelId,
    capability: "ryco.rpc",
    effectiveRole: "operator",
  },
  { type: "channel.accept", ...version, channelId },
  {
    type: "channel.reject",
    ...version,
    channelId,
    reason: "rate_limited",
    retryAfterMs: 5_000,
  },
  {
    type: "data",
    ...version,
    channelId,
    sequence: 7,
    payload: Uint8Array.from([0, 0xff, 0x80, 0x7f]),
  },
  { type: "flow.pause", ...version, channelId },
  { type: "flow.resume", ...version, channelId },
  { type: "channel.close", ...version, channelId, reason: "server_draining" },
  { type: "ping", ...version, nonce: new Uint8Array(8).fill(4) },
  { type: "pong", ...version, nonce: new Uint8Array(8).fill(4) },
  { type: "error", ...version, code: "rate_limited", fatal: false, retryAfterMs: 1_000 },
  {
    type: "node.e2ee.statement",
    ...version3,
    connectorGeneration: 1,
    statement: new Uint8Array(128).fill(7),
    statementDigest: digest,
    expiresAt: 1_788_451_260_000,
  },
  {
    type: "node.e2ee.statement.ack",
    ...version3,
    connectorGeneration: 1,
    statementDigest: digest,
  },
  {
    type: "e2ee.verifier-keys",
    ...version3,
    generation: 1,
    keys: [
      {
        keyId: `hgk_${"k".repeat(22)}`,
        publicKey: new Uint8Array(32).fill(9),
        notBefore: 1_788_451_200_000,
        notAfter: 1_788_451_260_000,
      },
    ],
  },
  {
    type: "e2ee.enrollment-revoked",
    ...version3,
    enrollmentId: `enr_${"e".repeat(22)}`,
    enrollmentRevision: 1,
    accountAuthEpoch: 2,
    deviceAuthEpoch: 3,
  },
] as const;

describe("relay schemas", () => {
  const decodeFrame = Schema.decodeUnknownSync(RelayFrame);

  it("decodes both authentication handshakes and every frame class", () => {
    const decoded = validFrames.map((frame) => decodeFrame(frame));

    expect(decoded).toHaveLength(17);
    expect(new Set(decoded.map((frame) => frame.type))).toEqual(new Set(RELAY_FRAME_TYPES));
  });

  it("advertises relay minor 3 while retaining the older schema versions", () => {
    expect(RELAY_PROTOCOL_MINOR).toBe(3);
  });

  it("keeps the stable close-reason set exact", () => {
    expect(RELAY_CLOSE_REASONS).toEqual([
      "authentication_required",
      "authentication_failed",
      "ticket_expired",
      "ticket_consumed",
      "node_offline",
      "node_revoked",
      "grant_revoked",
      "protocol_unsupported",
      "frame_too_large",
      "slow_consumer",
      "rate_limited",
      "server_draining",
      "internal_error",
      "authentication_timeout",
      "authorization_failed",
      "channel_rejected",
      "connection_replaced",
      "transfer_limit",
      "revoked",
    ]);
  });

  it("ignores future optional fields on known structures", () => {
    const decoded = decodeFrame({
      type: "ready",
      ...version,
      futureCapability: true,
      limits: { ...RELAY_INITIAL_LIMITS, futureLimit: 123 },
    });

    expect(decoded).toEqual({ type: "ready", ...version, limits: RELAY_INITIAL_LIMITS });
    expect("futureCapability" in decoded).toBe(false);
    if (decoded.type !== "ready") {
      throw new Error("Expected ready frame");
    }
    expect("futureLimit" in decoded.limits).toBe(false);
  });

  it("carries an optional, bounded node version on the node handshake", () => {
    const nodeAuth = validFrames[0]!;
    expect(decodeFrame({ ...nodeAuth, clientVersion: "0.1.33" })).toMatchObject({
      peer: "node",
      clientVersion: "0.1.33",
    });
    expect("clientVersion" in decodeFrame(nodeAuth)).toBe(false);
    for (const clientVersion of ["", " 0.1.33", "x".repeat(65), 33]) {
      expect(() => decodeFrame({ ...nodeAuth, clientVersion })).toThrow();
    }
  });

  it("rejects missing and unknown discriminants", () => {
    expect(() => decodeFrame({ ...version })).toThrow();
    expect(() => decodeFrame({ type: "future.frame", ...version })).toThrow();
    expect(() => decodeFrame({ type: "auth", peer: "future", ...version })).toThrow();
  });

  it("enforces identifier syntax and bounds", () => {
    const decodeNodeId = Schema.decodeUnknownSync(RelayNodeId);
    const decodeChannelId = Schema.decodeUnknownSync(RelayChannelId);

    expect(decodeNodeId(nodeId)).toBe(nodeId);
    expect(decodeChannelId(channelId)).toBe(channelId);
    expect(() => decodeNodeId(`node_${"n".repeat(21)}`)).toThrow();
    expect(() => decodeNodeId(`node_${"n".repeat(44)}`)).toThrow();
    expect(() => decodeNodeId("node_not+base64url!!!!!!!!")).toThrow();
    expect(() => decodeChannelId(`ch_${"c".repeat(21)}`)).toThrow();
    expect(() => decodeChannelId(`ch_${"c".repeat(23)}`)).toThrow();
  });

  it("requires native opaque bytes and enforces payload bounds", () => {
    expect(() =>
      decodeFrame({
        type: "data",
        ...version,
        channelId,
        sequence: 0,
        payload: [0, 255],
      }),
    ).toThrow();
    expect(() =>
      decodeFrame({
        type: "data",
        ...version,
        channelId,
        sequence: 0,
        payload: new Uint8Array(RELAY_MAX_DATA_CHUNK_BYTES + 1),
      }),
    ).toThrow();
  });

  it("rejects invalid negotiated-limit relationships", () => {
    const decodeLimits = Schema.decodeUnknownSync(RelayLimits);

    expect(decodeLimits(RELAY_INITIAL_LIMITS)).toEqual(RELAY_INITIAL_LIMITS);
    expect(() =>
      decodeLimits({
        ...RELAY_INITIAL_LIMITS,
        maxQueuedBytes: RELAY_INITIAL_LIMITS.maxDataChunkBytes,
      }),
    ).toThrow();
    expect(() =>
      decodeLimits({
        ...RELAY_INITIAL_LIMITS,
        heartbeatIntervalMs: 20_000,
        deadConnectionTimeoutMs: 30_000,
      }),
    ).toThrow();
  });

  it("gates retryAfterMs on protocol minor version 1", () => {
    expect(() =>
      decodeFrame({
        type: "channel.reject",
        protocolMajor: 1,
        protocolMinor: 0,
        channelId,
        reason: "rate_limited",
        retryAfterMs: 1_000,
      }),
    ).toThrow();
  });

  it("requires authorized channel metadata on protocol minor version 2", () => {
    expect(
      decodeFrame({
        type: "channel.open",
        ...version,
        channelId,
        capability: "ryco.rpc",
        effectiveRole: "viewer",
      }),
    ).toEqual({
      type: "channel.open",
      ...version,
      channelId,
      capability: "ryco.rpc",
      effectiveRole: "viewer",
    });
    expect(() => decodeFrame({ type: "channel.open", ...version, channelId })).toThrow();
    expect(() =>
      decodeFrame({
        type: "channel.open",
        ...version,
        channelId,
        capability: "future.capability",
        effectiveRole: "viewer",
      }),
    ).toThrow();
    expect(() =>
      decodeFrame({
        type: "channel.open",
        ...version,
        channelId,
        capability: "ryco.rpc",
        effectiveRole: "administrator",
      }),
    ).toThrow();
    expect(() =>
      decodeFrame({
        type: "channel.open",
        protocolMajor: 1,
        protocolMinor: 1,
        channelId,
        capability: "ryco.rpc",
        effectiveRole: "operator",
      }),
    ).toThrow();
    expect(
      decodeFrame({
        type: "channel.open",
        protocolMajor: 1,
        protocolMinor: 1,
        channelId,
      }),
    ).toEqual({
      type: "channel.open",
      protocolMajor: 1,
      protocolMinor: 1,
      channelId,
    });
  });

  it("gates the all-or-nothing account grant context on protocol minor 3", () => {
    const accountGrantContext = [
      2,
      `rtk_${"t".repeat(22)}`,
      digest,
      new Uint8Array(32).fill(6),
    ] as const;
    expect(
      decodeFrame({
        type: "channel.open",
        ...version3,
        channelId,
        capability: "ryco.rpc",
        effectiveRole: "operator",
        accountGrantContext,
      }),
    ).toMatchObject({ type: "channel.open", accountGrantContext });
    expect(
      decodeFrame({
        type: "channel.open",
        ...version3,
        channelId,
        capability: "ryco.rpc",
        effectiveRole: "operator",
      }),
    ).toMatchObject({ type: "channel.open" });
    expect(() =>
      decodeFrame({
        type: "channel.open",
        ...version,
        channelId,
        capability: "ryco.rpc",
        effectiveRole: "operator",
        accountGrantContext,
      }),
    ).toThrow();
    expect(() =>
      decodeFrame({
        type: "channel.open",
        protocolMajor: 1,
        protocolMinor: 1,
        channelId,
        accountGrantContext,
      }),
    ).toThrow();
    expect(() =>
      decodeFrame({
        type: "channel.open",
        ...version3,
        channelId,
        capability: "ryco.rpc",
        effectiveRole: "operator",
        accountGrantContext: accountGrantContext.slice(0, 3),
      }),
    ).toThrow();
  });

  it("rejects minor-3 E2EE control frames on older connections and duplicate key ids", () => {
    expect(() =>
      decodeFrame({
        type: "node.e2ee.statement.ack",
        ...version,
        connectorGeneration: 1,
        statementDigest: digest,
      }),
    ).toThrow();
    const key = {
      keyId: `hgk_${"k".repeat(22)}`,
      publicKey: new Uint8Array(32).fill(9),
      notBefore: 1_788_451_200_000,
      notAfter: 1_788_451_260_000,
    } as const;
    expect(() =>
      decodeFrame({
        type: "e2ee.verifier-keys",
        ...version3,
        generation: 1,
        keys: [key, key],
      }),
    ).toThrow();
  });

  it("gates protocol minor version 2 close reasons", () => {
    expect(
      decodeFrame({
        type: "channel.close",
        ...version,
        channelId,
        reason: "revoked",
      }),
    ).toMatchObject({ reason: "revoked" });
    expect(
      decodeFrame({
        type: "error",
        ...version,
        code: "authentication_timeout",
        fatal: true,
      }),
    ).toMatchObject({ code: "authentication_timeout" });
    expect(() =>
      decodeFrame({
        type: "channel.close",
        protocolMajor: 1,
        protocolMinor: 1,
        channelId,
        reason: "revoked",
      }),
    ).toThrow();
    expect(() =>
      decodeFrame({
        type: "channel.reject",
        protocolMajor: 1,
        protocolMinor: 1,
        channelId,
        reason: "channel_rejected",
      }),
    ).toThrow();
    expect(() =>
      decodeFrame({
        type: "error",
        protocolMajor: 1,
        protocolMinor: 1,
        code: "authentication_timeout",
        fatal: true,
      }),
    ).toThrow();
  });

  it("requires deterministic metadata for unsupported-protocol error frames", () => {
    expect(() =>
      decodeFrame({
        type: "error",
        ...version,
        code: "protocol_unsupported",
        fatal: false,
      }),
    ).toThrow();

    const decoded = decodeFrame({
      type: "error",
      ...version,
      code: "protocol_unsupported",
      fatal: true,
      supported: { protocolMajor: 1, minimumMinor: 0, maximumMinor: 2 },
    });
    expect(decoded.type).toBe("error");
  });
});
