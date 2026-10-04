import { describe, expect, it } from "vite-plus/test";

import { truncate, truncateUnicodeSafe } from "./String.ts";

describe("truncate", () => {
  it("trims surrounding whitespace", () => {
    expect(truncate("   hello world   ")).toBe("hello world");
  });

  it("returns shorter strings unchanged", () => {
    expect(truncate("alpha", 10)).toBe("alpha");
  });

  it("truncates long strings and appends an ellipsis", () => {
    expect(truncate("abcdefghij", 5)).toBe("abcde...");
  });
});

describe("truncateUnicodeSafe", () => {
  it("returns shorter strings unchanged", () => {
    expect(truncateUnicodeSafe("alpha", 10)).toBe("alpha");
    expect(truncateUnicodeSafe("alpha", 5)).toBe("alpha");
  });

  it("cuts long strings at maxChars", () => {
    expect(truncateUnicodeSafe("abcdefghij", 4)).toBe("abcd");
  });

  it("drops a high surrogate that would be split at the boundary", () => {
    // "ab" + 😀 (a surrogate pair) + "c": cutting at 3 would split the pair.
    const value = "ab\u{1F600}c";
    expect(truncateUnicodeSafe(value, 3)).toBe("ab");
    expect(truncateUnicodeSafe(value, 4)).toBe("ab\u{1F600}");
  });

  it("returns an empty string for non-positive limits", () => {
    expect(truncateUnicodeSafe("abc", 0)).toBe("");
    expect(truncateUnicodeSafe("abc", -1)).toBe("");
  });
});
