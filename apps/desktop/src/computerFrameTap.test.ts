import { expect, it, vi } from "vitest";
vi.mock("electron", () => ({}));
import { createFrameReader } from "./computerFrameTap.ts";

const frame = (bytes: number[]) => {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(bytes.length);
  return Buffer.concat([header, Buffer.from(bytes)]);
};

it("splits whole, batched and fragmented frames", () => {
  const frames: number[][] = [];
  const malformed = vi.fn();
  const read = createFrameReader((jpeg) => frames.push([...jpeg]), malformed);
  read(Buffer.concat([frame([1, 2]), frame([3])]));
  const split = Buffer.concat([frame([4, 5, 6]), frame([7])]);
  // Byte by byte: the header itself arrives in pieces.
  for (let index = 0; index < split.length; index += 1) read(split.subarray(index, index + 1));
  expect(frames).toEqual([[1, 2], [3], [4, 5, 6], [7]]);
  expect(malformed).not.toHaveBeenCalled();
});

it("stops on a malformed length and forgets a partial frame on reset", () => {
  const frames: number[][] = [];
  const malformed = vi.fn();
  const read = createFrameReader((jpeg) => frames.push([...jpeg]), malformed);
  read(frame([1, 2, 3]).subarray(0, 5));
  read.reset();
  read(frame([9]));
  expect(frames).toEqual([[9]]);
  read(Buffer.alloc(4));
  expect(malformed).toHaveBeenCalledOnce();
  read(frame([8]));
  expect(frames).toEqual([[9]]);
});
