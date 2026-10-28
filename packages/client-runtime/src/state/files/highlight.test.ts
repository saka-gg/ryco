import { describe, expect, it } from "vite-plus/test";

import { splitHighlightSegments } from "./highlight.ts";

const plain = (text: string) => ({ text, highlighted: false });
const marked = (text: string) => ({ text, highlighted: true });

describe("splitHighlightSegments", () => {
  it("splits text into plain and highlighted runs", () => {
    expect(
      splitHighlightSegments("const value = 1;", [
        { start: 6, end: 11 },
        { start: 14, end: 15 },
      ]),
    ).toEqual([plain("const "), marked("value"), plain(" = "), marked("1"), plain(";")]);
    expect(splitHighlightSegments("abc", [{ start: 0, end: 3 }])).toEqual([marked("abc")]);
    expect(splitHighlightSegments("abc", [])).toEqual([plain("abc")]);
  });

  it("sorts and merges overlapping or touching ranges", () => {
    expect(
      splitHighlightSegments("abcdefgh", [
        { start: 5, end: 7 },
        { start: 1, end: 3 },
        { start: 2, end: 4 },
        { start: 4, end: 5 },
      ]),
    ).toEqual([plain("a"), marked("bcdefg"), plain("h")]);
  });

  it("clamps ranges to the text and drops empty, reversed and invalid ones", () => {
    expect(
      splitHighlightSegments("abc", [
        { start: -4, end: 1 },
        { start: 2, end: 99 },
        { start: 1, end: 1 },
        { start: 2, end: 1 },
        { start: Number.NaN, end: 2 },
      ]),
    ).toEqual([marked("a"), plain("b"), marked("c")]);
  });

  it("reads ranges of a longer string from the text's offset in it", () => {
    const path = "src/lib/cn.ts";
    const ranges = [
      { start: 4, end: 7 },
      { start: 8, end: 10 },
    ];
    expect(splitHighlightSegments("src/lib", ranges)).toEqual([plain("src/"), marked("lib")]);
    expect(splitHighlightSegments("cn.ts", ranges, path.lastIndexOf("/") + 1)).toEqual([
      marked("cn"),
      plain(".ts"),
    ]);
  });
});
