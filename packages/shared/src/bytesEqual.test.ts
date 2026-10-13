import { describe, expect, it } from "vite-plus/test";

import { bytesEqual, wordBytesEqual } from "./bytesEqual.ts";

function pattern(length: number, seed = 0): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 31 + seed) & 0xff;
  return bytes;
}

/** A copy of `bytes` at `offset` inside a larger buffer, to exercise unaligned views. */
function at(bytes: Uint8Array, offset: number): Uint8Array {
  const backing = new Uint8Array(bytes.byteLength + offset + 3).fill(0xee);
  backing.set(bytes, offset);
  return backing.subarray(offset, offset + bytes.byteLength);
}

describe.each([
  ["bytesEqual", bytesEqual],
  ["wordBytesEqual", wordBytesEqual],
] as const)("%s", (_name, equal) => {
  it("agrees with a per-byte comparison at every size, offset and difference", () => {
    for (const length of [0, 1, 3, 4, 5, 63, 64, 65, 127, 1024, 1027, 4099]) {
      const base = pattern(length);
      for (const leftOffset of [0, 1, 2, 3, 4]) {
        for (const rightOffset of [0, 1, 3]) {
          const left = at(base, leftOffset);
          expect(equal(left, at(base, rightOffset))).toBe(true);
          for (const position of new Set([0, length >> 1, length - 1, length - 2, length - 5])) {
            if (position < 0 || position >= length) continue;
            const changed = Uint8Array.from(base);
            changed[position] = (changed[position]! + 1) & 0xff;
            expect(equal(left, at(changed, rightOffset))).toBe(false);
          }
        }
      }
    }
  });

  it("never equates inputs of different lengths", () => {
    const bytes = pattern(256);
    expect(equal(bytes, bytes.subarray(0, 255))).toBe(false);
    expect(equal(new Uint8Array(0), new Uint8Array(1))).toBe(false);
  });
});
