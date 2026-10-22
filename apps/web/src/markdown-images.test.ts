import { describe, expect, it } from "vite-plus/test";

import {
  isSafeRemoteMarkdownImageSource,
  resolveMarkdownWorkspaceImagePath,
} from "./markdown-images";

describe("resolveMarkdownWorkspaceImagePath", () => {
  it("resolves relative and workspace-contained absolute images", () => {
    expect(resolveMarkdownWorkspaceImagePath("./assets/demo.png", "/repo/project")).toBe(
      "assets/demo.png",
    );
    expect(resolveMarkdownWorkspaceImagePath("/repo/project/docs/shot.webp", "/repo/project")).toBe(
      "docs/shot.webp",
    );
    expect(
      resolveMarkdownWorkspaceImagePath("file:///repo/project/docs/shot.webp", "/repo/project"),
    ).toBe("docs/shot.webp");
    // A directory named like a home path is still an ordinary directory.
    expect(resolveMarkdownWorkspaceImagePath("~assets/shot.png", "/repo/project")).toBe(
      "~assets/shot.png",
    );
  });

  it("rejects traversal, sibling-prefix, remote, and malformed sources", () => {
    expect(resolveMarkdownWorkspaceImagePath("../../secret.png", "/repo/project")).toBeNull();
    expect(
      resolveMarkdownWorkspaceImagePath("/repo/project-copy/shot.png", "/repo/project"),
    ).toBeNull();
    expect(
      resolveMarkdownWorkspaceImagePath("https://example.com/a.png", "/repo/project"),
    ).toBeNull();
    expect(
      resolveMarkdownWorkspaceImagePath("file://server/share/a.png", "/repo/project"),
    ).toBeNull();
  });

  it("handles Windows paths without case-sensitive drive comparisons", () => {
    expect(
      resolveMarkdownWorkspaceImagePath("C:\\Repo\\Project\\assets\\shot.png", "c:\\repo\\project"),
    ).toBe("assets/shot.png");
  });
});

describe("isSafeRemoteMarkdownImageSource", () => {
  it("allows HTTPS and inert raster data URLs only", () => {
    expect(isSafeRemoteMarkdownImageSource("https://example.com/a.png")).toBe(true);
    expect(isSafeRemoteMarkdownImageSource("http://example.com/a.png")).toBe(false);
    expect(isSafeRemoteMarkdownImageSource("data:image/png;base64,aGVsbG8=")).toBe(true);
    expect(isSafeRemoteMarkdownImageSource("data:image/svg+xml,<svg/>")).toBe(false);
  });
});
