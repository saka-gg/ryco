import { describe, expect, it } from "vite-plus/test";

import { parseClaudeAutoCompactWindow, resolveClaudeAutoCompactMode } from "./claudeAutoCompact.ts";

describe("parseClaudeAutoCompactWindow", () => {
  it("accepts whole numbers from 100,000 to 1,000,000", () => {
    expect(parseClaudeAutoCompactWindow("100000")).toBe(100_000);
    expect(parseClaudeAutoCompactWindow("400000")).toBe(400_000);
    expect(parseClaudeAutoCompactWindow("1000000")).toBe(1_000_000);
  });

  it("ignores digit group separators and surrounding space", () => {
    expect(parseClaudeAutoCompactWindow("200,000")).toBe(200_000);
    expect(parseClaudeAutoCompactWindow("200_000")).toBe(200_000);
    expect(parseClaudeAutoCompactWindow(" 200 000 ")).toBe(200_000);
  });

  it("rejects values outside the range", () => {
    expect(parseClaudeAutoCompactWindow("99999")).toBeUndefined();
    expect(parseClaudeAutoCompactWindow("50000")).toBeUndefined();
    expect(parseClaudeAutoCompactWindow("1000001")).toBeUndefined();
    expect(parseClaudeAutoCompactWindow("0")).toBeUndefined();
  });

  it("rejects anything that is not a whole number", () => {
    expect(parseClaudeAutoCompactWindow("")).toBeUndefined();
    expect(parseClaudeAutoCompactWindow("   ")).toBeUndefined();
    expect(parseClaudeAutoCompactWindow("abc")).toBeUndefined();
    expect(parseClaudeAutoCompactWindow("200k")).toBeUndefined();
    expect(parseClaudeAutoCompactWindow("200000.5")).toBeUndefined();
    expect(parseClaudeAutoCompactWindow("-200000")).toBeUndefined();
    expect(parseClaudeAutoCompactWindow("2e5")).toBeUndefined();
    expect(parseClaudeAutoCompactWindow("auto")).toBeUndefined();
  });
});

describe("resolveClaudeAutoCompactMode", () => {
  it("resolves the known modes", () => {
    expect(resolveClaudeAutoCompactMode("ryco")).toBe("ryco");
    expect(resolveClaudeAutoCompactMode("claudeCode")).toBe("claudeCode");
  });

  it("falls back to Ryco's policy for anything else", () => {
    expect(resolveClaudeAutoCompactMode("")).toBe("ryco");
    expect(resolveClaudeAutoCompactMode("never")).toBe("ryco");
    expect(resolveClaudeAutoCompactMode("ClaudeCode")).toBe("ryco");
  });
});
