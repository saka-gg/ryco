import { describe, expect, it } from "vitest";

import { formatTokenCount } from "./tokenCount.ts";

describe("formatTokenCount", () => {
  it("reads small, thousand and million counts compactly", () => {
    expect(formatTokenCount(null)).toBe("0");
    expect(formatTokenCount(Number.NaN)).toBe("0");
    expect(formatTokenCount(842.4)).toBe("842");
    expect(formatTokenCount(4_000)).toBe("4k");
    expect(formatTokenCount(4_120)).toBe("4.1k");
    expect(formatTokenCount(14_000)).toBe("14k");
    expect(formatTokenCount(128_400)).toBe("128k");
    expect(formatTokenCount(1_000_000)).toBe("1m");
    expect(formatTokenCount(1_240_000)).toBe("1.2m");
  });
});
