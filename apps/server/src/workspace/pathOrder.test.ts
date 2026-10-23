import { describe, expect, it } from "vite-plus/test";

import { comparePathsByUtf8, indexAfterPath, sortPathsByUtf8 } from "./pathOrder.ts";

const utf8Order = (paths: ReadonlyArray<string>) =>
  paths.toSorted((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));

describe("workspace path order", () => {
  it("orders paths by their UTF-8 bytes, as git lists them", () => {
    const paths = ["b.ts", "a/b.ts", "a.ts", "A.ts", "a-b.ts", "ä.ts", "\uE000.ts", "😀.ts", "a"];
    expect(sortPathsByUtf8(paths)).toEqual(utf8Order(paths));
    // UTF-16 order differs here: the surrogate pair sorts below U+E000.
    expect(comparePathsByUtf8("😀.ts", "\uE000.ts")).toBeGreaterThan(0);
    expect([..."😀\uE000"].toSorted()).toEqual(["😀", "\uE000"]);
  });

  it("finds where a page resumes", () => {
    const paths = sortPathsByUtf8(["a.ts", "b.ts", "c/d.ts", "e.ts"]);
    expect(indexAfterPath(paths, "")).toBe(0);
    expect(indexAfterPath(paths, "b.ts")).toBe(2);
    // A cursor path that has since been deleted still resumes after its place.
    expect(indexAfterPath(paths, "c/a.ts")).toBe(2);
    expect(indexAfterPath(paths, "z.ts")).toBe(4);
  });
});
