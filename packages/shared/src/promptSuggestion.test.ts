import { describe, expect, it } from "vite-plus/test";

import { normalizePromptSuggestion, readPromptSuggestionPayload } from "./promptSuggestion.ts";

describe("normalizePromptSuggestion", () => {
  it("trims and keeps a normal suggestion", () => {
    expect(normalizePromptSuggestion("  run the tests again \n", 1000)).toBe("run the tests again");
  });

  it("drops an empty or missing reply (no clear next step)", () => {
    expect(normalizePromptSuggestion("", 1000)).toBeUndefined();
    expect(normalizePromptSuggestion("   \n", 1000)).toBeUndefined();
    expect(normalizePromptSuggestion(null, 1000)).toBeUndefined();
    expect(normalizePromptSuggestion(undefined, 1000)).toBeUndefined();
    expect(normalizePromptSuggestion('""', 1000)).toBeUndefined();
  });

  it("unwraps a reply the model put in quotes, but keeps inner quotes", () => {
    expect(normalizePromptSuggestion('"commit this"', 1000)).toBe("commit this");
    expect(normalizePromptSuggestion("“open a PR”", 1000)).toBe("open a PR");
    expect(normalizePromptSuggestion('"rename "foo" to "bar""', 1000)).toBe(
      '"rename "foo" to "bar""',
    );
  });

  it("cuts long text without splitting a surrogate pair", () => {
    expect(normalizePromptSuggestion("abcdef", 3)).toBe("abc");
    const cut = normalizePromptSuggestion("ab😀cd", 3);
    expect(cut).toBe("ab");
    expect(cut!.length).toBeLessThanOrEqual(3);
  });
});

describe("readPromptSuggestionPayload", () => {
  it("reads the suggestion of a payload", () => {
    expect(readPromptSuggestionPayload({ suggestion: "ship it" })).toBe("ship it");
  });

  it("ignores payloads without text", () => {
    expect(readPromptSuggestionPayload(null)).toBeUndefined();
    expect(readPromptSuggestionPayload("ship it")).toBeUndefined();
    expect(readPromptSuggestionPayload({ suggestion: "  " })).toBeUndefined();
    expect(readPromptSuggestionPayload({ suggestion: 3 })).toBeUndefined();
  });
});
