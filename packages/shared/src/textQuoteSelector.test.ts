import { describe, expect, it } from "vite-plus/test";

import {
  createTextQuoteSelector,
  findTextQuote,
  findTextQuoteRange,
  TEXT_QUOTE_CONTEXT_LENGTH,
  textQuoteRawOffset,
} from "./textQuoteSelector.ts";

describe("text quote selectors", () => {
  it("trims the quote to visible characters and records collapsed context and offsets", () => {
    const text = "Intro   line.\n\n  Use the cache\tfor reads.  \nNext paragraph.";
    const rawStart = text.indexOf("  Use");
    const rawEnd = text.indexOf("Next");
    const selector = createTextQuoteSelector(text, rawStart, rawEnd);

    expect(selector).toEqual({
      exact: "Use the cache\tfor reads.",
      prefix: "Intro line. ",
      suffix: " Next paragraph.",
      start: 12,
      end: 36,
    });
    expect(findTextQuote(text, selector!)).toEqual({ start: 12, end: 36 });
    expect(findTextQuoteRange(text, selector!)).toEqual({
      start: text.indexOf("Use"),
      end: text.indexOf("  \nNext"),
    });
  });

  it("returns null when nothing visible is selected", () => {
    expect(createTextQuoteSelector("a  \n  b", 1, 5)).toBeNull();
    expect(createTextQuoteSelector("abc", 2, 2)).toBeNull();
    expect(createTextQuoteSelector("abc", 5, -3)).toBeNull();
  });

  it("bounds context and never splits an astral character", () => {
    // The 32-unit window starts and ends inside a rocket on each side.
    const before = `🚀${"x".repeat(TEXT_QUOTE_CONTEXT_LENGTH - 1)}`;
    const after = `${"y".repeat(TEXT_QUOTE_CONTEXT_LENGTH - 1)}🚀`;
    const text = `${before}QUOTE${after}`;
    const start = text.indexOf("QUOTE");
    const selector = createTextQuoteSelector(text, start, start + 5)!;

    expect(selector.exact).toBe("QUOTE");
    expect(selector.prefix).toBe("x".repeat(TEXT_QUOTE_CONTEXT_LENGTH - 1));
    expect(selector.suffix).toBe("y".repeat(TEXT_QUOTE_CONTEXT_LENGTH - 1));
  });

  it("re-anchors after the text reflows and the offsets drift", () => {
    const original = "Alpha beta.\nThe quoted passage here.\nGamma.";
    const start = original.indexOf("The");
    const selector = createTextQuoteSelector(original, start, start + 24)!;
    const reflowed = "Preface added later.\n\nAlpha   beta.\n\nThe quoted\npassage here.\nGamma.";

    const match = findTextQuoteRange(reflowed, selector);
    expect(match).not.toBeNull();
    expect(reflowed.slice(match!.start, match!.end)).toBe("The quoted\npassage here.");
  });

  it("prefers the occurrence whose context matches, then the nearest to the hint", () => {
    const text = "first: same words. second: same words. third: same words.";
    const selector = {
      exact: "same words",
      prefix: "second: ",
      suffix: ". third",
      start: 0,
      end: 10,
    };
    expect(findTextQuote(text, selector)).toEqual({ start: 27, end: 37 });

    const noContext = { ...selector, prefix: "elsewhere ", suffix: "!", start: 45, end: 55 };
    expect(findTextQuote(text, noContext)).toEqual({ start: 46, end: 56 });
  });

  it("returns null once the text no longer contains the quote", () => {
    const selector = { exact: "gone", prefix: "", suffix: "", start: 0, end: 4 };
    expect(findTextQuote("nothing here", selector)).toBeNull();
    expect(findTextQuote("anything", { ...selector, exact: " \n\t" })).toBeNull();
  });

  it("maps collapsed offsets back through whitespace runs", () => {
    const text = "a  \n b";
    expect(textQuoteRawOffset(text, 0)).toBe(0);
    expect(textQuoteRawOffset(text, 1)).toBe(1);
    expect(textQuoteRawOffset(text, 2)).toBe(5);
    expect(textQuoteRawOffset(text, 3)).toBe(6);
    expect(textQuoteRawOffset(text, 99)).toBe(6);
  });
});
