import { describe, expect, it } from "vite-plus/test";

import { asObjectLike, asRecord, isObjectLike, isRecord } from "./unknownValue.ts";

class Box {
  readonly value = 1;
}

const primitives: ReadonlyArray<unknown> = [
  null,
  undefined,
  0,
  1,
  "",
  "text",
  true,
  false,
  Symbol("symbol"),
  10n,
];

describe("isRecord / asRecord", () => {
  it("accepts plain objects, null-prototype objects and class instances", () => {
    const plain = { a: 1 };
    const bare = Object.create(null) as object;
    const instance = new Box();
    for (const value of [plain, bare, instance, new Date(0), new Map()]) {
      expect(isRecord(value)).toBe(true);
      expect(asRecord(value)).toBe(value);
    }
  });

  it("rejects arrays", () => {
    for (const value of [[], [1, 2], Array.from({ length: 3 })]) {
      expect(isRecord(value)).toBe(false);
      expect(asRecord(value)).toBeUndefined();
    }
  });

  it("rejects functions and primitives, null included", () => {
    for (const value of [...primitives, () => 1, function named() {}, Box]) {
      expect(isRecord(value)).toBe(false);
      expect(asRecord(value)).toBeUndefined();
    }
  });
});

describe("isObjectLike / asObjectLike", () => {
  it("accepts plain objects and class instances", () => {
    const plain = { a: 1 };
    const instance = new Box();
    for (const value of [plain, instance, new Date(0)]) {
      expect(isObjectLike(value)).toBe(true);
      expect(asObjectLike(value)).toBe(value);
    }
  });

  it("accepts arrays", () => {
    const array = [1, 2];
    expect(isObjectLike(array)).toBe(true);
    expect(asObjectLike(array)).toBe(array);
    expect(isObjectLike([])).toBe(true);
  });

  it("rejects functions and primitives, null included", () => {
    for (const value of [...primitives, () => 1, Box]) {
      expect(isObjectLike(value)).toBe(false);
      expect(asObjectLike(value)).toBeUndefined();
    }
  });
});
