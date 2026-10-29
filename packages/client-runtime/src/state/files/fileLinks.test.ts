import { describe, expect, it } from "vite-plus/test";

import {
  resolveFileLinkReference,
  resolveFileLinkTarget,
  resolvePathLinkTarget,
  resolveWorkspaceFileReference,
  resolveWorkspaceImageReference,
  rewriteMarkdownFileUriHref,
  splitPathAndPosition,
  workspaceFileFolder,
} from "./fileLinks.ts";

describe("splitPathAndPosition", () => {
  it("splits a trailing line and column, or a line alone", () => {
    expect(splitPathAndPosition("src/a.ts:12:3")).toEqual({
      path: "src/a.ts",
      line: "12",
      column: "3",
    });
    expect(splitPathAndPosition("src/a.ts:12")).toEqual({
      path: "src/a.ts",
      line: "12",
      column: undefined,
    });
    expect(splitPathAndPosition("src/a.ts")).toEqual({
      path: "src/a.ts",
      line: undefined,
      column: undefined,
    });
  });
});

describe("resolvePathLinkTarget", () => {
  it("resolves relative paths against cwd", () => {
    expect(
      resolvePathLinkTarget(
        "src/components/ThreadTerminalDrawer.tsx:42:7",
        "/Users/julius/project",
      ),
    ).toBe("/Users/julius/project/src/components/ThreadTerminalDrawer.tsx:42:7");
  });

  it("keeps absolute paths unchanged", () => {
    expect(
      resolvePathLinkTarget("/Users/julius/project/src/main.ts:12", "/Users/julius/project"),
    ).toBe("/Users/julius/project/src/main.ts:12");
  });

  it("keeps Windows absolute paths with forward slashes unchanged", () => {
    expect(
      resolvePathLinkTarget("C:/Users/julius/project/src/main.ts:12", "C:\\Users\\julius\\project"),
    ).toBe("C:/Users/julius/project/src/main.ts:12");
  });
});

describe("rewriteMarkdownFileUriHref", () => {
  it("rewrites file uri hrefs into direct path hrefs", () => {
    expect(rewriteMarkdownFileUriHref("file:///Users/julius/project/src/main.ts#L42")).toBe(
      "/Users/julius/project/src/main.ts#L42",
    );
  });

  it("preserves encoded octets so file paths are decoded only once later", () => {
    expect(rewriteMarkdownFileUriHref("file:///Users/julius/project/file%2520name.md")).toBe(
      "/Users/julius/project/file%2520name.md",
    );
  });
});

describe("resolveFileLinkTarget", () => {
  it("resolves absolute posix file paths", () => {
    expect(resolveFileLinkTarget("/Users/julius/project/AGENTS.md")).toBe(
      "/Users/julius/project/AGENTS.md",
    );
  });

  it("resolves relative file paths and bare file names against the base directory", () => {
    expect(resolveFileLinkTarget("src/processRunner.ts:71", "/Users/julius/project")).toBe(
      "/Users/julius/project/src/processRunner.ts:71",
    );
    expect(resolveFileLinkTarget("script.ts:10", "/Users/julius/project")).toBe(
      "/Users/julius/project/script.ts:10",
    );
    expect(resolveFileLinkTarget("AGENTS.md", "/Users/julius/project")).toBe(
      "/Users/julius/project/AGENTS.md",
    );
    expect(resolveFileLinkTarget("AGENTS.md")).toBeNull();
  });

  it("maps #L line anchors to line suffixes", () => {
    expect(resolveFileLinkTarget("/Users/julius/project/src/main.ts#L42C7")).toBe(
      "/Users/julius/project/src/main.ts:42:7",
    );
  });

  it("ignores external urls, anchors and app routes", () => {
    expect(resolveFileLinkTarget("https://example.com/docs")).toBeNull();
    expect(resolveFileLinkTarget("#install", "/repo")).toBeNull();
    expect(resolveFileLinkTarget("/chat/settings")).toBeNull();
    expect(resolveFileLinkTarget("LICENSE", "/repo")).toBeNull();
    expect(resolveFileLinkTarget("docs/", "/repo")).toBeNull();
  });

  it("does not double-decode file URLs", () => {
    expect(resolveFileLinkTarget("file:///Users/julius/project/file%2520name.md")).toBe(
      "/Users/julius/project/file%20name.md",
    );
  });
});

describe("resolveFileLinkReference", () => {
  it("names the file and its place in the workspace, or null outside it", () => {
    expect(
      resolveFileLinkReference("../notes.md#L4C2", {
        workspaceRoot: "/repo",
        baseDirectory: "/repo/docs",
      }),
    ).toEqual({
      targetPath: "/repo/docs/../notes.md:4:2",
      filePath: "/repo/docs/../notes.md",
      line: 4,
      column: 2,
      workspacePath: "notes.md",
    });
    expect(resolveFileLinkReference("/etc/hosts", { workspaceRoot: "/repo" })).toEqual({
      targetPath: "/etc/hosts",
      filePath: "/etc/hosts",
      workspacePath: null,
    });
    // Without a workspace an absolute link is still a file; a relative one is not.
    expect(resolveFileLinkReference("/repo/a.ts:3", {})).toMatchObject({
      filePath: "/repo/a.ts",
      line: 3,
      workspacePath: null,
    });
    expect(resolveFileLinkReference("a.ts", {})).toBeNull();
  });

  it("keeps only real positions: no line 0, no column without a line", () => {
    expect(resolveFileLinkReference("src/a.ts:0:5", { workspaceRoot: "/repo" })).toEqual({
      targetPath: "/repo/src/a.ts:0:5",
      filePath: "/repo/src/a.ts",
      workspacePath: "src/a.ts",
    });
  });

  it("keeps a malformed escape in a link as written", () => {
    expect(resolveFileLinkReference("/repo/100%.md", { workspaceRoot: "/repo" })).toMatchObject({
      filePath: "/repo/100%.md",
      workspacePath: "100%.md",
    });
  });
});

describe("resolveWorkspaceFileReference", () => {
  const repo = { workspaceRoot: "/repo" };
  const docs = { workspaceRoot: "/repo", baseDirectory: "/repo/docs" };

  it("resolves relative links from a document's own folder, contained in the workspace", () => {
    expect(resolveWorkspaceFileReference("../notes.md", docs)).toEqual({ path: "notes.md" });
    expect(resolveWorkspaceFileReference("./guide.md", docs)).toEqual({ path: "docs/guide.md" });
    expect(resolveWorkspaceFileReference("../../etc/passwd", docs)).toBeNull();
    expect(resolveWorkspaceFileReference("/etc/hosts", docs)).toBeNull();
  });

  it("keeps a line and column", () => {
    expect(resolveWorkspaceFileReference("src/a.ts:12:3", repo)).toEqual({
      path: "src/a.ts",
      line: 12,
      column: 3,
    });
    expect(resolveWorkspaceFileReference("/repo/x.ts#L4C2", repo)).toEqual({
      path: "x.ts",
      line: 4,
      column: 2,
    });
    expect(resolveWorkspaceFileReference("src/a.ts:0", repo)).toEqual({ path: "src/a.ts" });
  });

  it("refuses non-file hrefs", () => {
    expect(resolveWorkspaceFileReference(undefined, repo)).toBeNull();
    expect(resolveWorkspaceFileReference("https://example.com/a.ts", repo)).toBeNull();
    expect(resolveWorkspaceFileReference("#usage", repo)).toBeNull();
  });
});

describe("resolveWorkspaceImageReference", () => {
  const project = { workspaceRoot: "/repo/project" };

  it("resolves relative and workspace-contained absolute images", () => {
    expect(resolveWorkspaceImageReference("./assets/demo.png", project)).toBe("assets/demo.png");
    expect(resolveWorkspaceImageReference("/repo/project/docs/shot.webp", project)).toBe(
      "docs/shot.webp",
    );
    expect(resolveWorkspaceImageReference("file:///repo/project/docs/shot.webp", project)).toBe(
      "docs/shot.webp",
    );
    // A directory named like a home path is still an ordinary directory.
    expect(resolveWorkspaceImageReference("~assets/shot.png", project)).toBe("~assets/shot.png");
  });

  it("resolves relative images from a document's own folder", () => {
    expect(
      resolveWorkspaceImageReference("../assets/a.png", {
        workspaceRoot: "/repo",
        baseDirectory: "/repo/docs",
      }),
    ).toBe("assets/a.png");
    expect(
      resolveWorkspaceImageReference("diagram.png?raw=1", {
        workspaceRoot: "/repo",
        baseDirectory: "/repo/docs/",
      }),
    ).toBe("docs/diagram.png");
    expect(
      resolveWorkspaceImageReference("/repo/assets/a.png", {
        workspaceRoot: "/repo",
        baseDirectory: "/repo/docs",
      }),
    ).toBe("assets/a.png");
    expect(
      resolveWorkspaceImageReference("../../secret.png", {
        workspaceRoot: "/repo",
        baseDirectory: "/repo/docs",
      }),
    ).toBeNull();
  });

  it("rejects traversal, sibling-prefix, remote, data and malformed sources", () => {
    expect(resolveWorkspaceImageReference("../../secret.png", project)).toBeNull();
    expect(resolveWorkspaceImageReference("/repo/project-copy/shot.png", project)).toBeNull();
    expect(resolveWorkspaceImageReference("https://example.com/a.png", project)).toBeNull();
    expect(resolveWorkspaceImageReference("data:image/png;base64,aGVsbG8=", project)).toBeNull();
    expect(resolveWorkspaceImageReference("file://server/share/a.png", project)).toBeNull();
    expect(resolveWorkspaceImageReference("%E0%A4%A.png", project)).toBeNull();
  });

  it("reads an encoded drive in a file URL as a drive", () => {
    expect(
      resolveWorkspaceImageReference("file:///C%3A/repo/assets/a.png", {
        workspaceRoot: "C:\\repo",
      }),
    ).toBe("assets/a.png");
  });

  it("handles Windows paths without case-sensitive drive comparisons", () => {
    expect(
      resolveWorkspaceImageReference("C:\\Repo\\Project\\assets\\shot.png", {
        workspaceRoot: "c:\\repo\\project",
      }),
    ).toBe("assets/shot.png");
    expect(
      resolveWorkspaceImageReference("docs\\..\\a.png", {
        workspaceRoot: "C:\\repo",
        baseDirectory: workspaceFileFolder("C:\\repo", "docs/guide.md"),
      }),
    ).toBe("docs/a.png");
    expect(
      resolveWorkspaceImageReference("..\\a.png", {
        workspaceRoot: "C:\\repo",
        baseDirectory: workspaceFileFolder("C:\\repo", "docs/guide.md"),
      }),
    ).toBe("a.png");
  });
});

describe("workspaceFileFolder", () => {
  it("is the file's parent folder, or the root for a top-level file", () => {
    expect(workspaceFileFolder("/repo/", "docs/guide.md")).toBe("/repo/docs");
    expect(workspaceFileFolder("/repo", "a/b/c.md")).toBe("/repo/a/b");
    expect(workspaceFileFolder("/repo", "README.md")).toBe("/repo");
  });
});
