import { deflateRawSync } from "node:zlib";

import {
  inflateRelayPayload,
  makeStreamRelayPayloadInflater,
  RelayPayloadInflateError,
  type RawDeflateDecompressor,
} from "@ryco/client-runtime/relay";
import { encodeCompressedRelayPayload } from "@ryco/shared/relayPayloadCompression";
import { describe, expect, it } from "vite-plus/test";

import { fflateRelayPayloadInflater } from "./relayPayloadInflater";

function jsonMessage(bytes: number): Uint8Array {
  const items: string[] = [];
  for (let index = 0, length = 0; length < bytes; index += 1) {
    const item = `{"id":"thread-${index}","title":"Thread ${index % 11}"}`;
    items.push(item);
    length += item.length + 1;
  }
  return new TextEncoder().encode(`[${items.join(",")}]`);
}

describe("fflate relay payload inflater", () => {
  it("inflates a node-compressed frame to the exact message", async () => {
    const message = jsonMessage(512 * 1_024);
    const frame = encodeCompressedRelayPayload(
      deflateRawSync(message, { level: 1 }),
      message.byteLength,
    );
    await expect(inflateRelayPayload(frame, fflateRelayPayloadInflater)).resolves.toEqual(message);
  });

  it("abandons an inflate bomb once output passes the declared length", async () => {
    const bomb = deflateRawSync(new Uint8Array(64 * 1_024 * 1_024));
    const frame = encodeCompressedRelayPayload(bomb, 1_024 * 1_024);
    await expect(inflateRelayPayload(frame, fflateRelayPayloadInflater)).rejects.toBeInstanceOf(
      RelayPayloadInflateError,
    );
    await expect(fflateRelayPayloadInflater.inflateRaw(bomb, 1_024 * 1_024)).rejects.toThrow(
      "exceeds its cap",
    );
  });

  it("refuses corrupt, truncated, and wrongly declared frames", async () => {
    const message = jsonMessage(64 * 1_024);
    const deflated = deflateRawSync(message, { level: 1 });
    const corrupt = Uint8Array.from(deflated);
    corrupt[0] = 0xff;
    corrupt[1] = 0xff;
    for (const frame of [
      encodeCompressedRelayPayload(corrupt, message.byteLength),
      encodeCompressedRelayPayload(
        deflated.subarray(0, deflated.byteLength >> 1),
        message.byteLength,
      ),
      encodeCompressedRelayPayload(deflated, message.byteLength + 1),
      encodeCompressedRelayPayload(deflated, message.byteLength - 1),
    ]) {
      await expect(inflateRelayPayload(frame, fflateRelayPayloadInflater)).rejects.toBeInstanceOf(
        RelayPayloadInflateError,
      );
    }
  });

  it("accepts and rejects exactly what DecompressionStream does", async () => {
    // fflate on its own stops at the end of the DEFLATE stream and ignores what
    // follows; web and desktop reject it. Both platforms must agree.
    const streamInflater = makeStreamRelayPayloadInflater(
      () => new DecompressionStream("deflate-raw") as unknown as RawDeflateDecompressor,
    );
    const message = jsonMessage(64 * 1_024);
    const deflated = deflateRawSync(message, { level: 1 });
    const second = deflateRawSync(new TextEncoder().encode("second"));
    const stored = deflateRawSync(message.subarray(0, 4_000), { level: 0 });
    const cases: Array<readonly [string, Uint8Array, number, boolean]> = [
      ["exact", deflated, message.byteLength, true],
      ["stored blocks, byte-aligned end", stored, 4_000, true],
      ["trailing bytes", Uint8Array.from([...deflated, 1, 2, 3]), message.byteLength, false],
      ["trailing zero byte", Uint8Array.from([...deflated, 0]), message.byteLength, false],
      ["byte after a stored stream", Uint8Array.from([...stored, 7]), 4_000, false],
      [
        "two concatenated streams",
        Uint8Array.from([...deflated, ...second]),
        message.byteLength,
        false,
      ],
      [
        "stream cut short",
        deflated.subarray(0, deflated.byteLength - 4),
        message.byteLength,
        false,
      ],
    ];
    for (const [label, body, declared, accepted] of cases) {
      const frame = encodeCompressedRelayPayload(body, declared);
      const results = await Promise.allSettled([
        inflateRelayPayload(frame, fflateRelayPayloadInflater),
        inflateRelayPayload(frame, streamInflater),
      ]);
      expect(
        results.map((result) => result.status),
        label,
      ).toEqual(accepted ? ["fulfilled", "fulfilled"] : ["rejected", "rejected"]);
    }
  });
});
