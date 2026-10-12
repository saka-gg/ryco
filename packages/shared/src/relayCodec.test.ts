import {
  RELAY_INITIAL_LIMITS,
  RELAY_MAX_CONTROL_FRAME_BYTES,
  RELAY_MAX_DATA_CHUNK_BYTES,
  RELAY_PROTOCOL_ERROR_CODES,
} from "@ryco/contracts/relay";
import { decode, encode, rfc8949EncodeOptions } from "cborg";
import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeRelayFrame,
  encodeRelayFrame,
  isCanonicalEncoding,
  makeProtocolUnsupportedErrorFrame,
  negotiateRelayVersion,
} from "./relayCodec.ts";

const PROPERTY_SEED = 0x5259_434f;
const version = { protocolMajor: 1, protocolMinor: 2 } as const;
const nodeId = `node_${"n".repeat(22)}`;
const channelId = `ch_${"c".repeat(22)}`;
const heartbeatNonce = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]);

const validFrames = [
  {
    type: "auth",
    peer: "node",
    ...version,
    nodeId,
    nonce: new Uint8Array(32).fill(0x11),
    signature: new Uint8Array(64).fill(0x22),
  },
  {
    type: "auth",
    peer: "client",
    ...version,
    relayTicket: new Uint8Array(32).fill(0x33),
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
    sequence: 4_294_967_295,
    payload: Uint8Array.from([0x00, 0xff, 0x80, 0x7f]),
  },
  { type: "flow.pause", ...version, channelId },
  { type: "flow.resume", ...version, channelId },
  { type: "channel.close", ...version, channelId, reason: "server_draining" },
  { type: "ping", ...version, nonce: heartbeatNonce },
  { type: "pong", ...version, nonce: heartbeatNonce },
  { type: "error", ...version, code: "rate_limited", fatal: false, retryAfterMs: 1_000 },
] as const;

function unwrap<A>(result: { readonly ok: true; readonly value: A } | { readonly ok: false }): A {
  if (!result.ok) {
    throw new Error("Expected relay codec success");
  }
  return result.value;
}

describe("relay codec", () => {
  it("round trips both handshakes and every frame class", () => {
    for (const frame of validFrames) {
      const firstEncoding = unwrap(encodeRelayFrame(frame));
      const secondEncoding = unwrap(encodeRelayFrame(frame));
      expect(firstEncoding).toEqual(secondEncoding);
      expect(unwrap(decodeRelayFrame(firstEncoding))).toEqual(
        unwrap(decodeRelayFrame(secondEncoding)),
      );
    }
  });

  it("negotiates current, older compatible, and future compatible minor versions", () => {
    expect(unwrap(negotiateRelayVersion({ protocolMajor: 1, protocolMinor: 2 }))).toEqual({
      protocolMajor: 1,
      protocolMinor: 2,
    });
    expect(unwrap(negotiateRelayVersion({ protocolMajor: 1, protocolMinor: 1 }))).toEqual({
      protocolMajor: 1,
      protocolMinor: 1,
    });
    expect(unwrap(negotiateRelayVersion({ protocolMajor: 1, protocolMinor: 0 }))).toEqual({
      protocolMajor: 1,
      protocolMinor: 0,
    });
    expect(unwrap(negotiateRelayVersion({ protocolMajor: 1, protocolMinor: 17 }))).toEqual({
      protocolMajor: 1,
      protocolMinor: 3,
    });

    const unsupported = negotiateRelayVersion({ protocolMajor: 2, protocolMinor: 0 });
    expect(unsupported).toEqual({
      ok: false,
      error: {
        code: "protocol_unsupported",
        supported: { protocolMajor: 1, minimumMinor: 0, maximumMinor: 3 },
      },
    });
    expect(makeProtocolUnsupportedErrorFrame()).toMatchObject({
      type: "error",
      code: "protocol_unsupported",
      fatal: true,
    });
  });

  it("enforces the negotiated version when supplied", () => {
    const bytes = unwrap(encodeRelayFrame(validFrames[3]));
    expect(
      decodeRelayFrame(bytes, { expectedVersion: { protocolMajor: 1, protocolMinor: 0 } }),
    ).toEqual({ ok: false, error: { code: "invalid_frame" } });
  });

  it("ignores canonical future optional fields on known frames", () => {
    const bytes = encode(
      {
        type: "channel.open",
        protocolMajor: 1,
        protocolMinor: 7,
        channelId,
        capability: "ryco.rpc",
        effectiveRole: "owner",
        futureCapability: { enabled: true, generation: 2 },
      },
      rfc8949EncodeOptions,
    );

    const decoded = unwrap(decodeRelayFrame(bytes));
    expect(decoded).toEqual({
      type: "channel.open",
      protocolMajor: 1,
      protocolMinor: 7,
      channelId,
      capability: "ryco.rpc",
      effectiveRole: "owner",
    });
    expect("futureCapability" in decoded).toBe(false);
  });

  it("classifies missing, unknown, malformed, and invalid-limit inputs deterministically", () => {
    const missing = encode(version, rfc8949EncodeOptions);
    const unknown = encode({ type: "future.frame", ...version }, rfc8949EncodeOptions);
    const invalidBinary = encode(
      { type: "data", ...version, channelId, sequence: 0, payload: "not-bytes" },
      rfc8949EncodeOptions,
    );
    const invalidLimits = encode(
      {
        type: "ready",
        ...version,
        limits: { ...RELAY_INITIAL_LIMITS, maxChannels: 0 },
      },
      rfc8949EncodeOptions,
    );

    expect(decodeRelayFrame(missing)).toEqual({
      ok: false,
      error: { code: "missing_discriminant" },
    });
    expect(decodeRelayFrame(unknown)).toEqual({
      ok: false,
      error: { code: "unknown_frame_type" },
    });
    expect(decodeRelayFrame(invalidBinary)).toEqual({
      ok: false,
      error: { code: "invalid_frame" },
    });
    expect(decodeRelayFrame(invalidLimits)).toEqual({
      ok: false,
      error: { code: "invalid_limits" },
    });
  });

  it("rejects truncated, trailing, and non-map encodings", () => {
    const valid = unwrap(encodeRelayFrame(validFrames[10]));
    const trailing = new Uint8Array(valid.byteLength + 1);
    trailing.set(valid);
    trailing[trailing.length - 1] = 0;

    expect(decodeRelayFrame(valid.slice(0, -1))).toEqual({
      ok: false,
      error: { code: "invalid_encoding" },
    });
    expect(decodeRelayFrame(trailing)).toEqual({
      ok: false,
      error: { code: "invalid_encoding" },
    });
    expect(decodeRelayFrame(Uint8Array.of(1))).toEqual({
      ok: false,
      error: { code: "invalid_encoding" },
    });
  });

  it("enforces encoded control and data limits", () => {
    const oversizedControl = encode(
      {
        type: "ping",
        ...version,
        nonce: heartbeatNonce,
        futureBlob: new Uint8Array(RELAY_MAX_CONTROL_FRAME_BYTES),
      },
      rfc8949EncodeOptions,
    );
    const oversizedData = encode(
      {
        type: "data",
        ...version,
        channelId,
        sequence: 0,
        payload: new Uint8Array(RELAY_MAX_DATA_CHUNK_BYTES + 1),
      },
      rfc8949EncodeOptions,
    );

    expect(decodeRelayFrame(oversizedControl)).toEqual({
      ok: false,
      error: { code: "frame_too_large" },
    });
    expect(decodeRelayFrame(oversizedData)).toEqual({
      ok: false,
      error: { code: "frame_too_large" },
    });
    expect(
      encodeRelayFrame({
        type: "data",
        ...version,
        channelId,
        sequence: 0,
        payload: new Uint8Array(RELAY_MAX_DATA_CHUNK_BYTES + 1),
      }),
    ).toEqual({ ok: false, error: { code: "frame_too_large" } });
  });

  it("preserves opaque payload bytes without interpreting Ryco RPC data", () => {
    const payload = Uint8Array.from([
      0xff,
      0xfe,
      ...new TextEncoder().encode('{"jsonrpc":"2.0","method":"not-valid"'),
      0x00,
      0x80,
    ]);
    const bytes = unwrap(
      encodeRelayFrame({ type: "data", ...version, channelId, sequence: 9, payload }),
    );
    const decoded = unwrap(decodeRelayFrame(bytes));
    if (decoded.type !== "data") {
      throw new Error("Expected data frame");
    }
    expect(decoded.payload).toEqual(payload);
  });

  it("never includes payload or credential canaries in validation failures", () => {
    const credentialCanary = "RELAY_TICKET_CANARY_9b7f1c";
    const payloadCanary = "RELAY_PAYLOAD_CANARY_5e3a2d";
    const bytes = encode(
      {
        type: "data",
        ...version,
        channelId: "malformed-channel",
        sequence: 0,
        payload: new TextEncoder().encode(payloadCanary),
        relayTicket: new TextEncoder().encode(credentialCanary),
      },
      rfc8949EncodeOptions,
    );
    const output = JSON.stringify(decodeRelayFrame(bytes));

    expect(output).not.toContain(credentialCanary);
    expect(output).not.toContain(payloadCanary);
    expect(output).not.toContain("/Users/");
    expect(output).not.toContain("stack");
  });
});

describe("relay codec deterministic properties", () => {
  it("round trips seeded opaque payloads and boundary sequences", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 1_024 }),
        fc.integer({ min: 0, max: 0xffff_ffff }),
        (payload, sequence) => {
          const encoded = unwrap(
            encodeRelayFrame({ type: "data", ...version, channelId, sequence, payload }),
          );
          const decoded = unwrap(decodeRelayFrame(encoded));
          if (decoded.type !== "data") {
            return false;
          }
          return decoded.sequence === sequence && Buffer.from(decoded.payload).equals(payload);
        },
      ),
      { seed: PROPERTY_SEED, numRuns: 250 },
    );
  });

  it("rejects every seeded truncation of a complete frame", () => {
    const encoded = unwrap(encodeRelayFrame(validFrames[0]));
    fc.assert(
      fc.property(fc.integer({ min: 0, max: encoded.byteLength - 1 }), (length) => {
        const result = decodeRelayFrame(encoded.slice(0, length));
        return !result.ok && result.error.code === "invalid_encoding";
      }),
      { seed: PROPERTY_SEED, numRuns: 200 },
    );
  });

  it("returns identical bounded outcomes for seeded byte mutations", () => {
    const encoded = unwrap(encodeRelayFrame(validFrames[6]));
    const allowedErrors = new Set<string>(RELAY_PROTOCOL_ERROR_CODES);

    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: encoded.byteLength - 1 }),
        fc.integer({ min: 0, max: 255 }),
        (index, byte) => {
          const mutated = encoded.slice();
          mutated[index] = byte;
          const first = decodeRelayFrame(mutated);
          const second = decodeRelayFrame(mutated);
          if (JSON.stringify(first) !== JSON.stringify(second)) {
            return false;
          }
          return first.ok || allowedErrors.has(first.error.code);
        },
      ),
      { seed: PROPERTY_SEED, numRuns: 500 },
    );
  });

  it("ignores seeded canonical unknown optional fields", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000 }), (generation) => {
        const bytes = encode(
          {
            type: "channel.open",
            ...version,
            channelId,
            capability: "ryco.rpc",
            effectiveRole: "viewer",
            [`future${generation}`]: generation,
          },
          rfc8949EncodeOptions,
        );
        const decoded = decodeRelayFrame(bytes);
        return decoded.ok && decoded.value.type === "channel.open";
      }),
      { seed: PROPERTY_SEED, numRuns: 200 },
    );
  });
});

describe("relay codec canonical check for large data frames", () => {
  function strictDecode(bytes: Uint8Array): Map<unknown, unknown> | null {
    try {
      const raw: unknown = decode(bytes, {
        allowIndefinite: false,
        allowUndefined: false,
        allowInfinity: false,
        allowNaN: false,
        allowBigInt: false,
        strict: true,
        useMaps: true,
        rejectDuplicateMapKeys: true,
        tags: {},
      });
      return raw instanceof Map ? raw : null;
    } catch {
      return null;
    }
  }
  /** The full re-encode-and-compare check the spliced one must equal. */
  function referenceCanonical(bytes: Uint8Array): boolean {
    let raw: unknown;
    try {
      raw = decode(bytes, {
        allowIndefinite: false,
        allowUndefined: false,
        allowInfinity: false,
        allowNaN: false,
        allowBigInt: false,
        strict: true,
        useMaps: true,
        rejectDuplicateMapKeys: true,
        tags: {},
      });
    } catch {
      return false;
    }
    if (!(raw instanceof Map)) return false;
    return Buffer.from(encode(raw, rfc8949EncodeOptions)).equals(bytes);
  }
  const decodesCanonically = (bytes: Uint8Array) => {
    const result = decodeRelayFrame(bytes);
    return result.ok || result.error.code !== "invalid_encoding";
  };
  const frame = (length: number) => {
    const payload = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) payload[index] = (index * 13) & 0xff;
    return unwrap(encodeRelayFrame({ type: "data", ...version, channelId, sequence: 9, payload }));
  };
  const rawMap = (entries: ReadonlyArray<readonly [string, unknown]>) =>
    Uint8Array.from(encode(new Map(entries), { ...rfc8949EncodeOptions, mapSorter: () => 0 }));

  it("accepts canonical frames around every byte-string head size", () => {
    for (const length of [1_023, 1_024, 65_535, 65_536, RELAY_MAX_DATA_CHUNK_BYTES]) {
      const decoded = decodeRelayFrame(frame(length));
      expect(decoded.ok && decoded.value.type === "data" && decoded.value.payload.byteLength).toBe(
        length,
      );
    }
  });

  it("rejects reordered keys, non-minimal heads and trailing bytes exactly as the full check does", () => {
    const payload = new Uint8Array(4_096).fill(7);
    const entries: Array<readonly [string, unknown]> = [
      ["type", "data"],
      ["protocolMajor", 1],
      ["protocolMinor", 2],
      ["channelId", channelId],
      ["sequence", 9],
      ["payload", payload],
    ];
    const unsorted = rawMap(entries);
    expect(referenceCanonical(unsorted)).toBe(false);
    expect(decodesCanonically(unsorted)).toBe(false);

    const canonical = frame(4_096);
    const at = canonical.indexOf(0x59);
    // A four-byte length head for a payload that fits a two-byte one.
    const widened = new Uint8Array(canonical.byteLength + 2);
    widened.set(canonical.subarray(0, at));
    widened.set([0x5a, 0, 0, canonical[at + 1]!, canonical[at + 2]!], at);
    widened.set(canonical.subarray(at + 3), at + 5);
    expect(referenceCanonical(widened)).toBe(false);
    expect(decodesCanonically(widened)).toBe(false);

    const trailing = Uint8Array.of(...canonical, 0);
    expect(decodesCanonically(trailing)).toBe(referenceCanonical(trailing));
  });

  it("agrees with the full check on seeded mutations of a large frame", () => {
    const encoded = frame(2_048);
    let decodable = 0;
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: encoded.byteLength - 1 }),
        fc.integer({ min: 0, max: 255 }),
        fc.boolean(),
        (index, byte, insert) => {
          const mutated = insert
            ? Uint8Array.of(...encoded.subarray(0, index), byte, ...encoded.subarray(index))
            : Uint8Array.from(encoded).fill(byte, index, index + 1);
          const raw = strictDecode(mutated);
          // Never accept what the full check rejects.
          if (!referenceCanonical(mutated) && decodesCanonically(mutated)) return false;
          if (raw === null) return true;
          decodable += 1;
          return isCanonicalEncoding(mutated, raw) === referenceCanonical(mutated);
        },
      ),
      { seed: PROPERTY_SEED, numRuns: 2_000 },
    );
    expect(decodable).toBeGreaterThan(100);
  });
});
