import { RELAY_MAX_RPC_MESSAGE_BYTES } from "@ryco/contracts/relay";
import { decodeCompressedRelayPayload } from "@ryco/shared/relayPayloadCompression";

// The client half of relay payload compression: the inflater a platform
// provides, the guard every inflation runs under, and the one implementation
// web and desktop share. The frame format and the advertisement are
// `@ryco/shared/relayPayloadCompression`'s.
//
// THE GUARD. A frame declares its inflated length, and that length — never more
// than RELAY_MAX_RPC_MESSAGE_BYTES, the largest message this client would have
// accepted uncompressed — is the hard cap the inflater runs under. Inflation is
// streamed and stops the moment output passes the cap, so a small frame cannot
// make this client hold more than the cap plus one slice's worst-case expansion
// (about 4 MiB). Any output length other than the declared one is as fatal as a
// corrupt stream.

/**
 * Raw DEFLATE inflation, provided by the platform. client-runtime imports no
 * DOM or React Native code, so the codec comes in through here.
 *
 * Contract: resolve the complete output of one raw DEFLATE stream, and REJECT
 * — without materializing it — as soon as the output would exceed
 * `maxOutputBytes`, as well as on any truncated or corrupt stream.
 */
export interface RelayPayloadInflater {
  readonly inflateRaw: (body: Uint8Array, maxOutputBytes: number) => Promise<Uint8Array>;
}

/** A compressed relay payload this client must not deliver. Channel-fatal. */
export class RelayPayloadInflateError extends Error {
  constructor(
    message = "A compressed relay payload could not be inflated.",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RelayPayloadInflateError";
  }
}

/**
 * Input slice fed to a streaming inflater. Raw DEFLATE expands at most ~1032x,
 * so one slice can produce at most ~4 MiB before the cap is checked again;
 * smaller slices cost measurably more per message (about 1.8x at 1 KiB on a
 * 1.4 MB shell page) for a bound nobody needs tighter.
 */
export const RELAY_INFLATE_INPUT_SLICE_BYTES = 4_096;

/**
 * Validate one compressed frame and inflate it under its declared length.
 * Rejects with `RelayPayloadInflateError` on every failure.
 */
export async function inflateRelayPayload(
  frame: Uint8Array,
  inflater: RelayPayloadInflater,
): Promise<Uint8Array> {
  const decoded = decodeCompressedRelayPayload(frame, RELAY_MAX_RPC_MESSAGE_BYTES);
  if (decoded.kind === "error") {
    throw new RelayPayloadInflateError(`Compressed relay payload rejected: ${decoded.reason}.`);
  }
  let output: Uint8Array;
  try {
    output = await inflater.inflateRaw(decoded.body, decoded.uncompressedBytes);
  } catch (cause) {
    throw new RelayPayloadInflateError(undefined, { cause });
  }
  // A backstop for the platform's own cap, and the declared-length check.
  if (output.byteLength !== decoded.uncompressedBytes) {
    output.fill(0);
    throw new RelayPayloadInflateError("Inflated relay payload length differs from its header.");
  }
  return output;
}

// The slice of the WHATWG streams surface the shared inflater uses, declared
// structurally because this package compiles without DOM types.
interface ByteStreamReadResult {
  readonly done: boolean;
  readonly value?: Uint8Array | undefined;
}
interface ByteStreamReader {
  read(): Promise<ByteStreamReadResult>;
  cancel(reason?: unknown): Promise<void>;
}
interface ByteStreamWriter {
  write(chunk: Uint8Array<ArrayBuffer>): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}
/** A `DecompressionStream("deflate-raw")`, or anything shaped like one. */
export interface RawDeflateDecompressor {
  readonly readable: { getReader(): ByteStreamReader };
  readonly writable: { getWriter(): ByteStreamWriter };
}

class InflateLimitExceeded extends Error {}

/**
 * The inflater web and desktop provide, over the platform's
 * `DecompressionStream("deflate-raw")`.
 *
 * The body is written in `RELAY_INFLATE_INPUT_SLICE_BYTES` slices, one at a
 * time, while output is read concurrently and copied straight into one buffer
 * of the declared length. A `DecompressionStream` inflates each written chunk
 * to completion before yielding, so slicing is what bounds the output that can
 * exist before the cap is checked; the transform's own backpressure keeps the
 * writer at most one slice ahead of the reader. Peak memory is therefore the
 * declared length plus one slice's worst-case expansion (about 4 MiB), with no
 * second copy for concatenation.
 */
export function makeStreamRelayPayloadInflater(
  createDecompressor: () => RawDeflateDecompressor,
): RelayPayloadInflater {
  return {
    inflateRaw: async (body, maxOutputBytes) => {
      const stream = createDecompressor();
      const writer = stream.writable.getWriter();
      const reader = stream.readable.getReader();
      const control = { stopped: false };
      const writing = (async () => {
        for (let offset = 0; offset < body.byteLength;) {
          if (control.stopped) return;
          const end = Math.min(offset + RELAY_INFLATE_INPUT_SLICE_BYTES, body.byteLength);
          await writer.write(body.slice(offset, end));
          offset = end;
        }
        if (!control.stopped) await writer.close();
      })();
      // Failures surface through the reader; this only keeps a write that loses
      // the race with `cancel` from being reported as unhandled.
      writing.catch(() => undefined);
      const output = new Uint8Array(maxOutputBytes);
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value === undefined || value.byteLength === 0) continue;
          if (total + value.byteLength > maxOutputBytes) {
            value.fill(0);
            throw new InflateLimitExceeded("Inflated relay payload exceeds its cap.");
          }
          output.set(value, total);
          total += value.byteLength;
          value.fill(0);
        }
        await writing;
      } catch (error) {
        control.stopped = true;
        output.fill(0);
        await Promise.allSettled([reader.cancel(error), writer.abort(error)]);
        throw error;
      }
      return total === maxOutputBytes ? output : output.subarray(0, total);
    },
  };
}

/**
 * `makeStreamRelayPayloadInflater`, or `undefined` where the platform cannot
 * build the decompressor — Chrome 80 to 102 ship `DecompressionStream` without
 * `deflate-raw`, and constructing one throws. A client that gets `undefined`
 * never advertises, so it never receives a frame it cannot read.
 */
export function probeStreamRelayPayloadInflater(
  createDecompressor: () => RawDeflateDecompressor,
): RelayPayloadInflater | undefined {
  try {
    createDecompressor();
  } catch {
    return undefined;
  }
  return makeStreamRelayPayloadInflater(createDecompressor);
}
