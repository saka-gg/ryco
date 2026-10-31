import { describe, expect, it } from "vite-plus/test";

import {
  markdownFenceFor,
  sanitizeUntrustedBlock,
  sanitizeUntrustedLine,
} from "./untrustedText.ts";

describe("untrusted text", () => {
  it("keeps one line to one line, without what changes how it reads", () => {
    expect(sanitizeUntrustedLine("a\nb\u202ec\u200bd\u0000e", 100)).toBe("a b cd e");
    expect(sanitizeUntrustedLine("x".repeat(20), 10)).toBe("xxxxxxx...");
    expect(sanitizeUntrustedLine(null, 10)).toBe("");
  });

  it("keeps a block's lines and tabs, and drops terminal escapes", () => {
    expect(sanitizeUntrustedBlock("\u001b]8;;https://evil\u0007link\u001b]8;;\u0007\r\n\tok")).toBe(
      "link\n\tok",
    );
    expect(sanitizeUntrustedBlock("a\u2028b\u2066c\ufeffd")).toBe("a b cd");
  });

  it("fences longer than any backtick run", () => {
    expect(markdownFenceFor("no ticks")).toBe("```");
    expect(markdownFenceFor("``` and ``````")).toBe("```````");
  });
});
