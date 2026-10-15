import { deflateRawSync, inflateRawSync } from "node:zlib";

import { RELAY_MAX_RPC_MESSAGE_BYTES } from "@ryco/contracts/relay";
import { RpcSerialization } from "effect/rpc";
import { describe, expect, it } from "vite-plus/test";

import { classifyPostStripPayload } from "./relayE2eeWire.ts";
import {
  prepareRelayMessage,
  RELAY_CHUNK_CAPABILITY_PRELUDE,
  RelayMessageAssembler,
  splitRelayMessage,
} from "./relayMessageChunks.ts";
import {
  appendRelayCompressionAdvertisement,
  decodeCompressedRelayPayload,
  encodeCompressedRelayPayload,
  hasRelayCompressionAdvertisement,
  isCompressedRelayPayload,
  readRelayCompressionAdvertisement,
  relayCompressionAdvertisement,
  RELAY_COMPRESSED_PAYLOAD_HEADER_BYTES,
  RELAY_COMPRESSED_PAYLOAD_MAGIC,
  RELAY_COMPRESSION_ADVERTISEMENT,
  relayCompressionPaddedLength,
  stripRelayCompressionAdvertisement,
} from "./relayPayloadCompression.ts";

const encoder = new TextEncoder();

function rpcMessage(size: number): Uint8Array {
  const rows = [];
  for (let index = 0; rows.length * 64 < size; index += 1) {
    rows.push({ id: `thread-${index}`, title: `Thread ${index % 7}`, updatedAt: "2026-10-15" });
  }
  return encoder.encode(JSON.stringify({ _tag: "Chunk", requestId: "7", values: rows }));
}

function frameFor(message: Uint8Array): Uint8Array {
  return encodeCompressedRelayPayload(deflateRawSync(message, { level: 1 }), message.byteLength);
}

describe("compressed relay payload framing", () => {
  it("round-trips a message through deflate, framing, decode and inflate", () => {
    const message = rpcMessage(64 * 1_024);
    const frame = frameFor(message);
    expect(frame[0]).toBe(RELAY_COMPRESSED_PAYLOAD_MAGIC);
    expect(frame.byteLength).toBeLessThan(message.byteLength / 4);
    const decoded = decodeCompressedRelayPayload(frame);
    if (decoded.kind !== "ok") throw new Error(decoded.reason);
    expect(decoded.uncompressedBytes).toBe(message.byteLength);
    expect(new Uint8Array(inflateRawSync(decoded.body))).toEqual(message);
  });

  it("pads the frame with zeros to its bucket", () => {
    const message = rpcMessage(40 * 1_024);
    const deflated = deflateRawSync(message, { level: 1 });
    const frame = encodeCompressedRelayPayload(deflated, message.byteLength);
    const unpadded = RELAY_COMPRESSED_PAYLOAD_HEADER_BYTES + deflated.byteLength;
    expect(frame.byteLength).toBe(relayCompressionPaddedLength(unpadded));
    expect(frame.byteLength % 1_024).toBe(0);
    expect(frame.subarray(unpadded).every((byte) => byte === 0)).toBe(true);
  });

  it("uses geometric buckets with a 1 KiB floor and under 6.25% overhead", () => {
    expect(relayCompressionPaddedLength(0)).toBe(0);
    expect(relayCompressionPaddedLength(1)).toBe(1_024);
    expect(relayCompressionPaddedLength(1_024)).toBe(1_024);
    expect(relayCompressionPaddedLength(1_025)).toBe(2_048);
    expect(relayCompressionPaddedLength(16_384)).toBe(16_384);
    expect(relayCompressionPaddedLength(16_385)).toBe(17_408);
    expect(relayCompressionPaddedLength(40_000)).toBe(40_960);
    expect(relayCompressionPaddedLength(1_000_000)).toBe(1_015_808);
    for (let size = 16_384; size < 8 * 1_024 * 1_024; size = Math.ceil(size * 1.013)) {
      const padded = relayCompressionPaddedLength(size);
      expect(padded).toBeGreaterThanOrEqual(size);
      expect(padded - size).toBeLessThan(Math.max(1_024, size / 16));
    }
  });

  it("refuses truncated frames and bodies that run past the frame", () => {
    const frame = frameFor(rpcMessage(20 * 1_024));
    expect(decodeCompressedRelayPayload(frame.subarray(0, 11))).toEqual({
      kind: "error",
      reason: "truncated",
    });
    const decoded = decodeCompressedRelayPayload(frame);
    if (decoded.kind !== "ok") throw new Error(decoded.reason);
    const cut = frame.subarray(
      0,
      RELAY_COMPRESSED_PAYLOAD_HEADER_BYTES + decoded.body.byteLength - 1,
    );
    expect(decodeCompressedRelayPayload(cut)).toEqual({ kind: "error", reason: "truncated" });
  });

  it("refuses an unknown version, set flag bits, and zero lengths", () => {
    const frame = frameFor(rpcMessage(20 * 1_024));
    const version = Uint8Array.from(frame);
    version[1] = 2;
    expect(decodeCompressedRelayPayload(version)).toEqual({
      kind: "error",
      reason: "unsupported_version",
    });
    for (const index of [2, 3]) {
      const flagged = Uint8Array.from(frame);
      flagged[index] = 1;
      expect(decodeCompressedRelayPayload(flagged)).toEqual({
        kind: "error",
        reason: "bad_header",
      });
    }
    const empty = Uint8Array.from(frame);
    empty.fill(0, 4, 8);
    expect(decodeCompressedRelayPayload(empty)).toEqual({ kind: "error", reason: "bad_header" });
  });

  it("refuses non-zero padding", () => {
    const frame = Uint8Array.from(frameFor(rpcMessage(20 * 1_024)));
    frame[frame.byteLength - 1] = 1;
    expect(decodeCompressedRelayPayload(frame)).toEqual({ kind: "error", reason: "bad_padding" });
  });

  it("refuses a declared length above the relay message limit before inflating anything", () => {
    const frame = Uint8Array.from(frameFor(rpcMessage(20 * 1_024)));
    const declared = RELAY_MAX_RPC_MESSAGE_BYTES + 1;
    frame[4] = (declared >>> 24) & 0xff;
    frame[5] = (declared >>> 16) & 0xff;
    frame[6] = (declared >>> 8) & 0xff;
    frame[7] = declared & 0xff;
    expect(decodeCompressedRelayPayload(frame)).toEqual({ kind: "error", reason: "too_large" });
    expect(decodeCompressedRelayPayload(frameFor(rpcMessage(20 * 1_024)), 1_000)).toEqual({
      kind: "error",
      reason: "too_large",
    });
    expect(() => encodeCompressedRelayPayload(Uint8Array.of(1), declared)).toThrow(RangeError);
  });
});

describe("compressed relay payload discrimination", () => {
  it("never starts a UTF-8 JSON text, and no JSON text contains the magic at all", () => {
    for (const value of [
      { _tag: "Chunk", values: ["ÿ", "ÿ￿", "😀"] },
      ["\u{10ffff}"],
      " x",
      0,
      null,
    ]) {
      const bytes = encoder.encode(JSON.stringify(value));
      expect(isCompressedRelayPayload(bytes)).toBe(false);
      expect(bytes.includes(RELAY_COMPRESSED_PAYLOAD_MAGIC)).toBe(false);
    }
    expect(isCompressedRelayPayload(new Uint8Array())).toBe(false);
  });

  it("is distinct from every other payload form the relay carries", () => {
    const message = rpcMessage(20 * 1_024);
    // A relay chunk, the chunk-capability prelude, an E2EE envelope and an E2EE
    // negotiation record.
    for (const payload of [
      ...splitRelayMessage(message, 1_024),
      RELAY_CHUNK_CAPABILITY_PRELUDE,
      Uint8Array.of(0x01, 0x01),
      Uint8Array.of(0x02, 0x01),
      appendRelayCompressionAdvertisement(message),
    ]) {
      expect(isCompressedRelayPayload(payload)).toBe(false);
    }
    // And a frame is none of those: the chunk layer passes it through whole,
    // and E2EE discrimination calls it neither an envelope nor JSON.
    const frame = frameFor(message);
    expect(classifyPostStripPayload(frame)).toEqual({
      kind: "other",
      reason: "unknown_discriminator",
    });
    const assembler = new RelayMessageAssembler();
    const prepared = prepareRelayMessage(frame, {
      maxChunkBytes: 256 * 1_024,
      maxMessageBytes: RELAY_MAX_RPC_MESSAGE_BYTES,
      peerSupportsChunking: true,
    });
    if (prepared.kind !== "ready") throw new Error(prepared.reason);
    const pushed = assembler.push(prepared.payloads[0]!);
    expect(pushed).toEqual({ kind: "done", message: frame });
  });

  it("survives chunking and reassembly", () => {
    const frame = frameFor(rpcMessage(2 * 1_024 * 1_024));
    const assembler = new RelayMessageAssembler();
    let assembled: Uint8Array | undefined;
    for (const chunk of splitRelayMessage(frame, 4_096)) {
      const result = assembler.push(chunk);
      if (result.kind === "error") throw new Error(result.reason);
      if (result.kind === "done") assembled = result.message;
    }
    expect(assembled).toEqual(frame);
  });
});

describe("compression advertisement", () => {
  const request = encoder.encode(
    JSON.stringify({ _tag: "Request", id: "1", tag: "orchestration.subscribeShell", payload: {} }),
  );

  it("is recognized, stripped and appended, and only ever at the end", () => {
    const advertised = appendRelayCompressionAdvertisement(request);
    expect(hasRelayCompressionAdvertisement(advertised)).toBe(true);
    expect(hasRelayCompressionAdvertisement(request)).toBe(false);
    expect(hasRelayCompressionAdvertisement(RELAY_COMPRESSION_ADVERTISEMENT)).toBe(false);
    expect(stripRelayCompressionAdvertisement(advertised)).toEqual(request);
    expect(stripRelayCompressionAdvertisement(request)).toBe(request);
    const leading = new Uint8Array(RELAY_COMPRESSION_ADVERTISEMENT.byteLength + request.byteLength);
    leading.set(RELAY_COMPRESSION_ADVERTISEMENT);
    leading.set(request, RELAY_COMPRESSION_ADVERTISEMENT.byteLength);
    expect(hasRelayCompressionAdvertisement(leading)).toBe(false);
  });

  it("carries the highest frame version the client inflates", () => {
    expect(RELAY_COMPRESSION_ADVERTISEMENT).toEqual(relayCompressionAdvertisement(1));
    expect(readRelayCompressionAdvertisement(appendRelayCompressionAdvertisement(request))).toEqual(
      {
        maxVersion: 1,
        message: request,
      },
    );
    for (const version of [2, 7, 255]) {
      const advertised = appendRelayCompressionAdvertisement(
        request,
        relayCompressionAdvertisement(version),
      );
      expect(readRelayCompressionAdvertisement(advertised)?.maxVersion).toBe(version);
      // Every version is still nothing but JSON whitespace to an old parser.
      expect(JSON.parse(new TextDecoder().decode(advertised))).toEqual(
        JSON.parse(new TextDecoder().decode(request)),
      );
    }
    const versionZero = Uint8Array.from([
      ...request,
      0x0a,
      0x0d,
      0x09,
      0x20,
      0x20,
      0x20,
      0x20,
      0x20,
    ]);
    expect(readRelayCompressionAdvertisement(versionZero)).toBeUndefined();
    expect(() => relayCompressionAdvertisement(0)).toThrow(RangeError);
    expect(() => relayCompressionAdvertisement(256)).toThrow(RangeError);
  });

  it("is something the canonical JSON encoder never emits", () => {
    expect(RELAY_COMPRESSION_ADVERTISEMENT).not.toEqual(RELAY_CHUNK_CAPABILITY_PRELUDE);
    for (const value of [{ a: " \n\t\r " }, ["\n\r\t "], "\n\r\t \n\r\t "]) {
      expect(hasRelayCompressionAdvertisement(encoder.encode(JSON.stringify(value)))).toBe(false);
    }
  });

  it("passes an old node's whole receive path unchanged: assembler, discrimination, RPC decode", () => {
    // Exactly the base code's path for a client message — the chunk assembler,
    // E2EE post-strip discrimination, then the JSON serializer every node uses —
    // none of which this change touches. The advertisement is trailing JSON
    // whitespace, so each stage treats the message as the request it carries.
    const advertised = appendRelayCompressionAdvertisement(request);
    const prepared = prepareRelayMessage(advertised, {
      maxChunkBytes: 256 * 1_024,
      maxMessageBytes: RELAY_MAX_RPC_MESSAGE_BYTES,
      peerSupportsChunking: false,
    });
    if (prepared.kind !== "ready") throw new Error(prepared.reason);
    const assembled = new RelayMessageAssembler().push(prepared.payloads[0]!);
    if (assembled.kind !== "done") throw new Error("expected one message");
    expect(classifyPostStripPayload(assembled.message)).toEqual({ kind: "legacy-json" });
    expect(RpcSerialization.json.makeUnsafe().decode(assembled.message)).toEqual([
      { _tag: "Request", id: "1", tag: "orchestration.subscribeShell", payload: {} },
    ]);
  });
});
