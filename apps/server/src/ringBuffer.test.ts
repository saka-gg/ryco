import { describe, expect, it } from "vite-plus/test";

import { makeRingBuffer } from "./ringBuffer.ts";

describe("makeRingBuffer", () => {
  it("keeps every value until it is full", () => {
    const buffer = makeRingBuffer<number>(3);
    expect(buffer.values()).toEqual([]);
    expect([...buffer.newestFirst()]).toEqual([]);
    buffer.push(1);
    buffer.push(2);
    expect(buffer.size()).toBe(2);
    expect(buffer.values()).toEqual([1, 2]);
    expect([...buffer.newestFirst()]).toEqual([2, 1]);
  });

  it("drops the oldest values once full, in order, across many wraps", () => {
    const buffer = makeRingBuffer<number>(4);
    const all: Array<number> = [];
    for (let value = 0; value < 23; value += 1) {
      buffer.push(value);
      all.push(value);
      expect(buffer.values()).toEqual(all.slice(-4));
      expect([...buffer.newestFirst()]).toEqual(all.slice(-4).toReversed());
    }
    expect(buffer.size()).toBe(4);
  });

  it("reads newest first lazily", () => {
    const buffer = makeRingBuffer<number>(5);
    for (let value = 0; value < 7; value += 1) buffer.push(value);
    const iterator = buffer.newestFirst();
    expect(iterator.next().value).toBe(6);
    expect(iterator.next().value).toBe(5);
  });

  it("holds at least one value", () => {
    const buffer = makeRingBuffer<string>(0);
    buffer.push("a");
    buffer.push("b");
    expect(buffer.values()).toEqual(["b"]);
  });
});
