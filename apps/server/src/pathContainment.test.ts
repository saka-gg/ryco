import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { isCanonicalPathInside, isPathInside } from "./pathContainment.ts";

describe("isPathInside", () => {
  const posix = NodePath.posix;

  it("accepts children and refuses siblings, parents and other trees", () => {
    const inside = (candidate: string) =>
      isPathInside({ root: "/work/repo", candidate, allowRoot: true, path: posix });
    expect(inside("/work/repo/src/a.ts")).toBe(true);
    expect(inside("/work/repo-other/a.ts")).toBe(false);
    expect(inside("/work")).toBe(false);
    expect(inside("/elsewhere/a.ts")).toBe(false);
  });

  it("counts the root itself only when allowed", () => {
    expect(isPathInside({ root: "/r", candidate: "/r", allowRoot: true, path: posix })).toBe(true);
    expect(isPathInside({ root: "/r", candidate: "/r/", allowRoot: true, path: posix })).toBe(true);
    expect(isPathInside({ root: "/r", candidate: "/r", allowRoot: false, path: posix })).toBe(
      false,
    );
    expect(isPathInside({ root: "/r", candidate: "/r/x", allowRoot: false, path: posix })).toBe(
      true,
    );
  });

  it("treats a child named with leading dots as inside, and `..` segments as outside", () => {
    const inside = (candidate: string) =>
      isPathInside({ root: "/r", candidate, allowRoot: false, path: posix });
    expect(inside("/r/..foo")).toBe(true);
    expect(inside("/r/..foo/bar")).toBe(true);
    expect(inside("/r/../x")).toBe(false);
    expect(inside("/r/a/../../x")).toBe(false);
    expect(inside("/r/a/../b")).toBe(true);
  });

  it("does not fold case", () => {
    expect(isPathInside({ root: "/R", candidate: "/r/x", allowRoot: true, path: posix })).toBe(
      false,
    );
  });

  it("refuses another Windows drive, whose relative path is absolute", () => {
    const win = NodePath.win32;
    expect(
      isPathInside({ root: "C:\\work", candidate: "D:\\work\\a", allowRoot: true, path: win }),
    ).toBe(false);
    expect(
      isPathInside({ root: "C:\\work", candidate: "C:\\work\\a", allowRoot: true, path: win }),
    ).toBe(true);
    expect(
      isPathInside({ root: "C:\\work", candidate: "C:\\work\\..foo", allowRoot: true, path: win }),
    ).toBe(true);
    expect(
      isPathInside({ root: "C:\\work", candidate: "C:\\other", allowRoot: true, path: win }),
    ).toBe(false);
  });

  it("uses node:path by default", () => {
    const root = NodePath.resolve("some-root");
    expect(isPathInside({ root, candidate: NodePath.join(root, "x"), allowRoot: false })).toBe(
      true,
    );
  });
});

describe("isCanonicalPathInside", () => {
  const inside = (root: string, candidate: string, allowRoot = true) =>
    isCanonicalPathInside({ root, candidate, allowRoot, sep: "/" });

  it("matches the root and paths below it by separator-bounded prefix", () => {
    expect(inside("/r", "/r")).toBe(true);
    expect(inside("/r", "/r", false)).toBe(false);
    expect(inside("/r", "/r/x")).toBe(true);
    expect(inside("/r", "/r/x", false)).toBe(true);
    expect(inside("/r", "/rx")).toBe(false);
    expect(inside("/r", "/")).toBe(false);
  });

  it("uses a root that already ends in a separator as is", () => {
    expect(inside("/", "/x")).toBe(true);
    expect(inside("/r/", "/r/x")).toBe(true);
    expect(inside("/r/", "/rx")).toBe(false);
  });

  it("normalizes nothing and does not fold case", () => {
    expect(inside("/r", "/r/../x")).toBe(true);
    expect(inside("/R", "/r/x")).toBe(false);
  });

  it("honours a Windows separator", () => {
    expect(
      isCanonicalPathInside({ root: "C:\\r", candidate: "C:\\r\\x", allowRoot: true, sep: "\\" }),
    ).toBe(true);
    expect(
      isCanonicalPathInside({ root: "C:\\", candidate: "C:\\x", allowRoot: true, sep: "\\" }),
    ).toBe(true);
    expect(
      isCanonicalPathInside({ root: "C:\\r", candidate: "C:\\rx", allowRoot: true, sep: "\\" }),
    ).toBe(false);
  });
});
