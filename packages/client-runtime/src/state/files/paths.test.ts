import { describe, expect, it } from "vite-plus/test";

import {
  normalizeWorkspaceRelativePath,
  relativePathToRouteSegments,
  resolveWorkspaceRelativePath,
  routeFilePathParam,
  routeLineParam,
  WORKSPACE_FILE_PATH_MAX_LENGTH,
  workspaceFileBasename,
  workspaceFileParentPath,
} from "./paths.ts";

describe("normalizeWorkspaceRelativePath", () => {
  it("canonicalizes separators, redundant segments and trailing slashes", () => {
    expect(normalizeWorkspaceRelativePath("a/b")).toBe("a/b");
    expect(normalizeWorkspaceRelativePath("a//b")).toBe("a/b");
    expect(normalizeWorkspaceRelativePath("./a/./b")).toBe("a/b");
    expect(normalizeWorkspaceRelativePath("a/b/")).toBe("a/b");
    expect(normalizeWorkspaceRelativePath("src\\lib\\cn.ts")).toBe("src/lib/cn.ts");
    expect(normalizeWorkspaceRelativePath("a/b/../c.ts")).toBe("a/c.ts");
  });

  it("rejects anything that can address outside the workspace root", () => {
    for (const escape of [
      "",
      ".",
      "..",
      "a/../..",
      "a/../../b",
      "../a",
      "a/..",
      "/x",
      "/",
      "C:\\x",
      "C:/x",
      // Drive-RELATIVE: no separator after the colon, resolves against the
      // drive's current directory on a Windows node.
      "C:x",
      "c:..",
      "\\\\unc\\share",
      "\\etc\\passwd",
      "~",
      "~/x",
    ]) {
      expect(normalizeWorkspaceRelativePath(escape), escape).toBeNull();
    }
  });

  it("rejects paths past the contract's relative-path cap", () => {
    const longestAccepted = "a".repeat(WORKSPACE_FILE_PATH_MAX_LENGTH);
    expect(normalizeWorkspaceRelativePath(longestAccepted)).toBe(longestAccepted);
    expect(normalizeWorkspaceRelativePath(`${longestAccepted}b`)).toBeNull();
    // The cap applies to the normalized join, not the raw input.
    expect(normalizeWorkspaceRelativePath(`./${longestAccepted}`)).toBe(longestAccepted);
  });
});

describe("workspace path parts", () => {
  it("splits basename and parent", () => {
    expect(workspaceFileBasename("a/b/c.ts")).toBe("c.ts");
    expect(workspaceFileBasename("c.ts")).toBe("c.ts");
    expect(workspaceFileParentPath("a/b/c.ts")).toBe("a/b");
    expect(workspaceFileParentPath("c.ts")).toBeNull();
  });

  it("round-trips through route segments", () => {
    expect(relativePathToRouteSegments("a/b/c.ts")).toEqual(["a", "b", "c.ts"]);
    expect(relativePathToRouteSegments("")).toEqual([]);
    expect(routeFilePathParam(relativePathToRouteSegments("a/b/c.ts"))).toBe("a/b/c.ts");
  });
});

describe("route params", () => {
  it("accepts segment arrays and plain strings, and normalizes both", () => {
    expect(routeFilePathParam(["src", "lib", "cn.ts"])).toBe("src/lib/cn.ts");
    expect(routeFilePathParam("src/lib/cn.ts")).toBe("src/lib/cn.ts");
    expect(routeFilePathParam(undefined)).toBeNull();
    expect(routeFilePathParam([])).toBeNull();
    expect(routeFilePathParam(["..", "..", "etc"])).toBeNull();
    expect(routeFilePathParam("/etc/passwd")).toBeNull();
  });

  it("keeps only positive integer line anchors", () => {
    expect(routeLineParam("42")).toBe(42);
    expect(routeLineParam(["42", "7"])).toBe(42);
    expect(routeLineParam(undefined)).toBeNull();
    expect(routeLineParam([])).toBeNull();
    expect(routeLineParam("")).toBeNull();
    expect(routeLineParam("0")).toBeNull();
    expect(routeLineParam("-3")).toBeNull();
    expect(routeLineParam("1.5")).toBeNull();
    expect(routeLineParam("abc")).toBeNull();
    expect(routeLineParam("Infinity")).toBeNull();
  });
});

describe("resolveWorkspaceRelativePath", () => {
  it("relativizes absolute paths under the root and resolves relative ones against it", () => {
    expect(resolveWorkspaceRelativePath("/repo/project/src/app.ts", "/repo/project")).toBe(
      "src/app.ts",
    );
    expect(resolveWorkspaceRelativePath("/repo/project/src/../lib/a.ts", "/repo/project/")).toBe(
      "lib/a.ts",
    );
    expect(resolveWorkspaceRelativePath("./src/app.ts", "/repo/project")).toBe("src/app.ts");
    expect(resolveWorkspaceRelativePath("src/app.ts", "/repo/project")).toBe("src/app.ts");
  });

  it("rejects the root itself, siblings sharing a prefix and escapes", () => {
    for (const path of [
      "",
      "/repo/project",
      "/repo/project-copy/a.ts",
      "/etc/passwd",
      "../secret.ts",
      "src/../../secret.ts",
      "//server/share/a.ts",
      "\\\\server\\share\\a.ts",
      "/repo/project/a\0.ts",
    ]) {
      expect(resolveWorkspaceRelativePath(path, "/repo/project")).toBeNull();
    }
    expect(resolveWorkspaceRelativePath("a.ts", "relative/root")).toBeNull();
  });

  it("compares Windows drive roots without regard to case", () => {
    expect(resolveWorkspaceRelativePath("C:\\Repo\\Project\\src\\a.ts", "c:\\repo\\project")).toBe(
      "src/a.ts",
    );
    expect(resolveWorkspaceRelativePath("D:\\repo\\project\\a.ts", "c:\\repo\\project")).toBeNull();
  });
});
