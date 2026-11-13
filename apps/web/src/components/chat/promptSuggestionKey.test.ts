import { describe, expect, it } from "vite-plus/test";

import { readPromptSuggestionKey } from "./promptSuggestionKey";

const plain = {
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ctrlKey: false,
  isComposing: false,
  keyCode: 9,
};

const base = {
  event: plain,
  suggestion: "run the tests",
  promptEmpty: true,
  menuIsActive: false,
} as const;

describe("readPromptSuggestionKey", () => {
  it("Tab accepts and Escape dismisses an offered suggestion", () => {
    expect(readPromptSuggestionKey({ ...base, key: "Tab" })).toBe("accept");
    expect(readPromptSuggestionKey({ ...base, key: "Escape" })).toBe("dismiss");
  });

  it("leaves other keys alone", () => {
    for (const key of ["Enter", "ArrowUp", "ArrowDown"] as const) {
      expect(readPromptSuggestionKey({ ...base, key })).toBeNull();
    }
  });

  it("does nothing without a suggestion, with a draft, or with an open menu", () => {
    expect(readPromptSuggestionKey({ ...base, key: "Tab", suggestion: null })).toBeNull();
    expect(readPromptSuggestionKey({ ...base, key: "Tab", promptEmpty: false })).toBeNull();
    expect(readPromptSuggestionKey({ ...base, key: "Tab", menuIsActive: true })).toBeNull();
    expect(readPromptSuggestionKey({ ...base, key: "Escape", menuIsActive: true })).toBeNull();
  });

  it("keeps Shift+Tab (mode switch), other modifiers and IME compositions", () => {
    for (const modifier of ["shiftKey", "altKey", "metaKey", "ctrlKey"] as const) {
      expect(
        readPromptSuggestionKey({ ...base, key: "Tab", event: { ...plain, [modifier]: true } }),
      ).toBeNull();
    }
    expect(
      readPromptSuggestionKey({ ...base, key: "Tab", event: { ...plain, isComposing: true } }),
    ).toBeNull();
    expect(
      readPromptSuggestionKey({ ...base, key: "Tab", event: { ...plain, keyCode: 229 } }),
    ).toBeNull();
  });
});
