import { encodeCompressedRelayPayload } from "@ryco/shared/relayPayloadCompression";
import { describe, expect, it } from "vite-plus/test";

import {
  inflateRelayPayload,
  makeStreamRelayPayloadInflater,
  probeStreamRelayPayloadInflater,
  RELAY_INFLATE_INPUT_SLICE_BYTES,
  RelayPayloadInflateError,
  type RawDeflateDecompressor,
} from "./relayPayloadInflation.ts";
import { deflateRaw } from "../../test/deflateRaw.ts";

const encoder = new TextEncoder();

function jsonMessage(bytes: number): Uint8Array {
  const items: string[] = [];
  for (let index = 0, length = 0; length < bytes; index += 1) {
    const item = `"item-${index}"`;
    items.push(item);
    length += item.length + 1;
  }
  return encoder.encode(`[${items.join(",")}]`);
}

/** Node's own DecompressionStream, with a tally of every byte it ever produced. */
function countingDecompressor(tally: { produced: number }): () => RawDeflateDecompressor {
  return () => {
    const inner = new DecompressionStream("deflate-raw");
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        tally.produced += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    return {
      writable: inner.writable,
      readable: inner.readable.pipeThrough(counter),
    } as unknown as RawDeflateDecompressor;
  };
}

const streamInflater = makeStreamRelayPayloadInflater(
  () => new DecompressionStream("deflate-raw") as unknown as RawDeflateDecompressor,
);

describe("inflateRelayPayload over DecompressionStream", () => {
  it("inflates a framed message back to its exact bytes", async () => {
    const message = jsonMessage(300 * 1_024);
    const frame = encodeCompressedRelayPayload(await deflateRaw(message), message.byteLength);
    await expect(inflateRelayPayload(frame, streamInflater)).resolves.toEqual(message);
  });

  it("stops an inflate bomb at the declared length, holding at most one slice past it", async () => {
    // 64 MiB of zeros deflates to ~64 KiB; the frame claims 1 MiB.
    const bomb = await deflateRaw(new Uint8Array(64 * 1_024 * 1_024));
    const declared = 1_024 * 1_024;
    const frame = encodeCompressedRelayPayload(bomb, declared);
    const tally = { produced: 0 };
    const inflater = makeStreamRelayPayloadInflater(countingDecompressor(tally));
    await expect(inflateRelayPayload(frame, inflater)).rejects.toBeInstanceOf(
      RelayPayloadInflateError,
    );
    // Raw DEFLATE expands at most 1032:1, and slices are written one at a time.
    expect(tally.produced).toBeLessThanOrEqual(declared + RELAY_INFLATE_INPUT_SLICE_BYTES * 1_032);
    expect(tally.produced).toBeLessThan(64 * 1_024 * 1_024);
  });

  it("refuses output shorter than the declared length", async () => {
    const message = jsonMessage(32 * 1_024);
    const frame = encodeCompressedRelayPayload(await deflateRaw(message), message.byteLength + 1);
    await expect(inflateRelayPayload(frame, streamInflater)).rejects.toThrow(
      "Inflated relay payload length differs from its header.",
    );
  });

  it("refuses output longer than the declared length", async () => {
    const message = jsonMessage(32 * 1_024);
    const frame = encodeCompressedRelayPayload(await deflateRaw(message), message.byteLength - 1);
    await expect(inflateRelayPayload(frame, streamInflater)).rejects.toBeInstanceOf(
      RelayPayloadInflateError,
    );
  });

  it("refuses a corrupt and a truncated DEFLATE stream", async () => {
    const message = jsonMessage(32 * 1_024);
    const deflated = await deflateRaw(message);
    const corrupt = Uint8Array.from(deflated);
    corrupt[0] = 0xff;
    corrupt[1] = 0xff;
    await expect(
      inflateRelayPayload(
        encodeCompressedRelayPayload(corrupt, message.byteLength),
        streamInflater,
      ),
    ).rejects.toBeInstanceOf(RelayPayloadInflateError);
    const truncated = deflated.subarray(0, deflated.byteLength >> 1);
    await expect(
      inflateRelayPayload(
        encodeCompressedRelayPayload(truncated, message.byteLength),
        streamInflater,
      ),
    ).rejects.toBeInstanceOf(RelayPayloadInflateError);
  });

  it("refuses a malformed frame before inflating anything", async () => {
    const message = jsonMessage(32 * 1_024);
    const frame = encodeCompressedRelayPayload(await deflateRaw(message), message.byteLength);
    frame[frame.byteLength - 1] = 7;
    let called = false;
    await expect(
      inflateRelayPayload(frame, {
        inflateRaw: async () => {
          called = true;
          return message;
        },
      }),
    ).rejects.toThrow("bad_padding");
    expect(called).toBe(false);
  });

  it("runs the platform inflater under the declared length as its cap", async () => {
    const message = jsonMessage(32 * 1_024);
    const frame = encodeCompressedRelayPayload(await deflateRaw(message), message.byteLength);
    const caps: number[] = [];
    await inflateRelayPayload(frame, {
      inflateRaw: async (body, cap) => {
        caps.push(cap);
        return streamInflater.inflateRaw(body, cap);
      },
    });
    expect(caps).toEqual([message.byteLength]);
  });

  it("is not offered where the platform cannot build a deflate-raw decompressor", () => {
    // Chrome 80–102: `DecompressionStream` exists, `"deflate-raw"` throws.
    expect(
      probeStreamRelayPayloadInflater(() => {
        throw new TypeError("Unsupported compression format: 'deflate-raw'");
      }),
    ).toBeUndefined();
    expect(
      probeStreamRelayPayloadInflater(
        () => new DecompressionStream("deflate-raw") as unknown as RawDeflateDecompressor,
      ),
    ).toBeDefined();
  });

  it("rejects trailing bytes and a second concatenated stream, as every platform must", async () => {
    const message = jsonMessage(32 * 1_024);
    const deflated = await deflateRaw(message);
    const second = await deflateRaw(new TextEncoder().encode("second"));
    for (const body of [
      Uint8Array.from([...deflated, 1, 2, 3]),
      Uint8Array.from([...deflated, ...second]),
    ]) {
      await expect(
        inflateRelayPayload(encodeCompressedRelayPayload(body, message.byteLength), streamInflater),
      ).rejects.toBeInstanceOf(RelayPayloadInflateError);
    }
  });
});
