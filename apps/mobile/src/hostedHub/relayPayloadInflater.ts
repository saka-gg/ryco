import {
  RELAY_INFLATE_INPUT_SLICE_BYTES,
  type RelayPayloadInflater,
} from "@ryco/client-runtime/relay";
import { Inflate } from "fflate";

/**
 * The parts of fflate 0.8's `Inflate` state that say where the DEFLATE stream
 * ended: `s.f` is set once the final block has been read, `p` holds the input
 * not yet consumed (starting with the partly read byte), and `s.p` is the bit
 * position inside that byte. Not public API — the version is pinned, and a
 * shape this check does not recognize fails closed.
 */
interface InflateEndState {
  readonly p?: unknown;
  readonly s?: { readonly f?: unknown; readonly p?: unknown };
}

/** Bytes of input left after the end of the DEFLATE stream, or `undefined` if it never ended. */
function bytesAfterStreamEnd(inflater: Inflate): number | undefined {
  const state = inflater as unknown as InflateEndState;
  if (!(state.p instanceof Uint8Array) || typeof state.s !== "object" || state.s === null) {
    return undefined;
  }
  if (!state.s.f) return undefined;
  const bit = typeof state.s.p === "number" ? state.s.p : 0;
  return state.p.byteLength - (bit > 0 ? 1 : 0);
}

/**
 * Relay payload compression on the native client (docs/relay-e2ee-protocol.md
 * §4.6). Hermes has no `DecompressionStream`, so raw DEFLATE is inflated by
 * fflate's streaming `Inflate`.
 *
 * The cap is enforced the same way as on web: the body is pushed one
 * `RELAY_INFLATE_INPUT_SLICE_BYTES` slice at a time, and fflate emits each
 * slice's output before the next is pushed, so no more than the cap plus one
 * slice's expansion ever exists before the inflation is abandoned. Output is
 * copied into one buffer of the declared length as it arrives.
 *
 * fflate stops at the end of the DEFLATE stream and would silently ignore
 * whatever follows it — trailing bytes, or a second concatenated stream — where
 * `DecompressionStream` rejects both. So does this inflater: the stream must end
 * exactly where the body does.
 */
export const fflateRelayPayloadInflater: RelayPayloadInflater = {
  inflateRaw: async (body, maxOutputBytes) => {
    const output = new Uint8Array(maxOutputBytes);
    let total = 0;
    let exceeded = false;
    const inflater = new Inflate((chunk) => {
      if (exceeded) return;
      if (total + chunk.byteLength > maxOutputBytes) {
        exceeded = true;
        chunk.fill(0);
        return;
      }
      output.set(chunk, total);
      total += chunk.byteLength;
      chunk.fill(0);
    });
    try {
      for (let offset = 0; offset < body.byteLength;) {
        const end = Math.min(offset + RELAY_INFLATE_INPUT_SLICE_BYTES, body.byteLength);
        inflater.push(body.subarray(offset, end), end === body.byteLength);
        offset = end;
        if (exceeded) throw new Error("Inflated relay payload exceeds its cap.");
      }
      const trailing = bytesAfterStreamEnd(inflater);
      if (trailing === undefined) {
        throw new Error("Compressed relay payload ended before its DEFLATE stream.");
      }
      if (trailing !== 0) {
        throw new Error("Compressed relay payload has bytes after its DEFLATE stream.");
      }
    } catch (error) {
      output.fill(0);
      throw error;
    }
    return total === maxOutputBytes ? output : output.subarray(0, total);
  },
};
