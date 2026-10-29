import { assert, describe, it } from "@effect/vitest";

import { pageText, splitsSurrogatePair, textVersion } from "./messagePages.ts";

const readAll = (text: string, maxChars: number) => {
  const pages: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = pageText(text, offset, maxChars);
    assert.isNotNull(page);
    pages.push(page!.text);
    offset = page!.nextOffsetChars;
  }
  return pages;
};

describe("pageText", () => {
  it("pages a text losslessly and reports where each page starts", () => {
    const text = "abcdefghij";
    assert.deepEqual(pageText(text, 0, 4), {
      text: "abcd",
      offsetChars: 0,
      totalChars: 10,
      nextOffsetChars: 4,
    });
    assert.deepEqual(pageText(text, 8, 4), {
      text: "ij",
      offsetChars: 8,
      totalChars: 10,
      nextOffsetChars: null,
    });
    assert.deepEqual(readAll(text, 3), ["abc", "def", "ghi", "j"]);
  });

  it("never ends a page inside a surrogate pair, even a one-character page", () => {
    // Each emoji is two UTF-16 code units.
    const text = "a😀b😀😀c";
    for (const maxChars of [1, 2, 3, 4, 5]) {
      const pages = readAll(text, maxChars);
      assert.equal(pages.join(""), text);
      for (const page of pages) {
        assert.isFalse(/[\uD800-\uDBFF]$/u.test(page), `cut after ${page}`);
        assert.isFalse(/^[\uDC00-\uDFFF]/u.test(page), `cut before ${page}`);
      }
    }
  });

  it("refuses an offset past the end or inside a surrogate pair", () => {
    const text = "a😀b";
    assert.isTrue(splitsSurrogatePair(text, 2));
    assert.isNull(pageText(text, 2, 10));
    assert.isNull(pageText(text, 5, 10));
    assert.deepEqual(pageText(text, 4, 10)?.text, "");
  });

  it("gives an empty page that points at its start for a zero budget", () => {
    assert.deepEqual(pageText("abc", 0, 0), {
      text: "",
      offsetChars: 0,
      totalChars: 3,
      nextOffsetChars: 0,
    });
    assert.isNull(pageText("abc", 3, 0)?.nextOffsetChars);
  });
});

describe("textVersion", () => {
  it("changes with the text and the message, and is stable otherwise", () => {
    const version = textVersion({ id: "m1", text: "hello" });
    assert.equal(textVersion({ id: "m1", text: "hello" }), version);
    assert.notEqual(textVersion({ id: "m1", text: "hellO" }), version);
    assert.notEqual(textVersion({ id: "m2", text: "hello" }), version);
    assert.isAtMost(version.length, 64);
  });
});
