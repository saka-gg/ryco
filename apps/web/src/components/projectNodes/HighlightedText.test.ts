import { describe, expect, it } from "vite-plus/test";

import { highlightMatch } from "./HighlightedText";

describe("highlightMatch", () => {
  it("marks the first case-insensitive occurrence", () => {
    expect(highlightMatch("~/dev/homebrew-tap", "TAP")).toEqual([
      { text: "~/dev/homebrew-", match: false },
      { text: "tap", match: true },
    ]);
    expect(highlightMatch("ryco", "zzz")).toEqual([{ text: "ryco", match: false }]);
  });
});
