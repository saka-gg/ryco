/**
 * Byte-for-byte equality for hot paths: canonical-encoding checks over relay
 * frames, protocol constants, nonces.
 *
 * NOT constant-time: it returns at the first difference. Never use it to
 * compare secrets or authenticators an attacker can probe; those keep their
 * own constant-time comparisons.
 *
 * A per-byte loop is the fastest for a few dozen bytes, and the slowest by far
 * for frame-sized inputs. Larger inputs are compared four bytes at a time
 * (aligned `Uint32Array` views, or a `DataView` when either side is not
 * 4-byte aligned), or by the runtime's native `Buffer#equals` under Node and
 * Bun. React Native and browsers have no native `Buffer`; a polyfilled one is
 * not used. Measured on Apple Silicon (Node 24 / Bun 1.4), 256 KiB equal
 * inputs: per-byte loop 136 / 93 µs, `Array#every` 1,144 / 1,026 µs, 32-bit
 * words 26 / 27 µs, `Buffer#equals` 4.8 / 5.0 µs.
 */
export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  const length = left.byteLength;
  if (length !== right.byteLength) return false;
  if (length < WORD_COMPARE_MIN_BYTES) return byteLoopEqual(left, right, 0, length);
  if (nativeBuffer !== null) {
    return nativeBuffer
      .from(left.buffer, left.byteOffset, length)
      .equals(nativeBuffer.from(right.buffer, right.byteOffset, length));
  }
  return wordBytesEqual(left, right);
}

/** {@link bytesEqual}'s path without a native `Buffer`; exported for its tests. */
export function wordBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  const length = left.byteLength;
  if (length !== right.byteLength) return false;
  const words = length >>> 2;
  const tail = words << 2;
  if (((left.byteOffset | right.byteOffset) & 3) === 0) {
    const leftWords = new Uint32Array(left.buffer, left.byteOffset, words);
    const rightWords = new Uint32Array(right.buffer, right.byteOffset, words);
    for (let index = 0; index < words; index += 1) {
      if (leftWords[index] !== rightWords[index]) return false;
    }
  } else {
    const leftView = new DataView(left.buffer, left.byteOffset, length);
    const rightView = new DataView(right.buffer, right.byteOffset, length);
    for (let offset = 0; offset < tail; offset += 4) {
      if (leftView.getUint32(offset) !== rightView.getUint32(offset)) return false;
    }
  }
  return byteLoopEqual(left, right, tail, length);
}

/** Below this the per-byte loop beats setting up word views. */
const WORD_COMPARE_MIN_BYTES = 64;

function byteLoopEqual(left: Uint8Array, right: Uint8Array, from: number, to: number): boolean {
  for (let index = from; index < to; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

interface NativeBuffer {
  from(
    buffer: ArrayBufferLike,
    byteOffset: number,
    length: number,
  ): {
    equals(other: unknown): boolean;
  };
}

/** The runtime's own `Buffer` (Node, Bun), never a userland polyfill. */
const nativeBuffer: NativeBuffer | null = (() => {
  const runtime = globalThis as {
    readonly Buffer?: NativeBuffer;
    readonly process?: { readonly versions?: { readonly node?: string } };
  };
  return typeof runtime.process?.versions?.node === "string" && runtime.Buffer !== undefined
    ? runtime.Buffer
    : null;
})();
