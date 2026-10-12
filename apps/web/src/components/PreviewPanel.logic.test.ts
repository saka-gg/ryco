import { describe, expect, it } from "vite-plus/test";

import {
  decodeBase64Bytes,
  detectPreviewFileKind,
  filterPreviewProjectEntries,
  inferPreviewLanguage,
  isInertRasterImageMimeType,
  previewSvgDataUrl,
  resolvePreviewImageSource,
} from "./PreviewPanel.logic";

describe("detectPreviewFileKind", () => {
  it("detects image previews by extension and MIME type", () => {
    for (const filePath of [
      "assets/logo.png",
      "assets/photo.jpg",
      "assets/animation.gif",
      "assets/card.webp",
      "assets/icon.svg",
    ]) {
      expect(detectPreviewFileKind({ filePath })).toBe("image");
    }
    expect(detectPreviewFileKind({ filePath: "download", mimeType: "image/png" })).toBe("image");
  });

  it("detects text previews by extension and MIME type", () => {
    for (const filePath of ["src/app.ts", "README.md", "scripts/tool.py", "data/config.json"]) {
      expect(detectPreviewFileKind({ filePath })).toBe("text");
    }
    expect(
      detectPreviewFileKind({ filePath: "LICENSE", mimeType: "text/plain; charset=utf-8" }),
    ).toBe("text");
  });

  it("falls back to binary for unknown file types", () => {
    expect(detectPreviewFileKind({ filePath: "dist/app.bin" })).toBe("binary");
    expect(
      detectPreviewFileKind({ filePath: "archive", mimeType: "application/octet-stream" }),
    ).toBe("binary");
  });
});

describe("inferPreviewLanguage", () => {
  it("maps common extensions to highlighter languages", () => {
    expect(inferPreviewLanguage("src/App.tsx")).toBe("tsx");
    expect(inferPreviewLanguage("src/index.ts")).toBe("ts");
    expect(inferPreviewLanguage("README.md")).toBe("markdown");
    expect(inferPreviewLanguage("scripts/migrate.py")).toBe("python");
    expect(inferPreviewLanguage("Dockerfile")).toBe("dockerfile");
    expect(inferPreviewLanguage(".gitignore")).toBe("ini");
  });

  it("falls back to plain text for unknown extensions", () => {
    expect(inferPreviewLanguage("notes.custom")).toBe("text");
  });
});

describe("resolvePreviewImageSource", () => {
  it("reads raster images through the binary read and SVG as text", () => {
    for (const filePath of ["assets/logo.png", "a/photo.JPG", "b/anim.gif", "c/card.webp"]) {
      expect(resolvePreviewImageSource(filePath)).toBe("raster");
    }
    expect(resolvePreviewImageSource("assets/icon.svg")).toBe("svg");
  });

  it("returns null for non-image files", () => {
    expect(resolvePreviewImageSource("src/app.ts")).toBeNull();
    expect(resolvePreviewImageSource("LICENSE")).toBeNull();
  });
});

describe("decodeBase64Bytes", () => {
  it("decodes base64 into the original bytes", () => {
    expect([...decodeBase64Bytes("AAEC/w==")]).toEqual([0, 1, 2, 255]);
    expect(decodeBase64Bytes("").byteLength).toBe(0);
  });
});

describe("isInertRasterImageMimeType", () => {
  it("accepts the raster types the binary read reports", () => {
    for (const mimeType of ["image/png", "image/jpeg", "image/gif", "image/webp", "IMAGE/AVIF"]) {
      expect(isInertRasterImageMimeType(mimeType)).toBe(true);
    }
  });

  it("refuses types that could run script from a same-origin blob URL", () => {
    for (const mimeType of ["image/svg+xml", "image/svg+xml; charset=utf-8", "text/html", ""]) {
      expect(isInertRasterImageMimeType(mimeType)).toBe(false);
    }
  });
});

describe("previewSvgDataUrl", () => {
  it("encodes the markup into an opaque-origin data URL", () => {
    const url = previewSvgDataUrl('<svg xmlns="http://www.w3.org/2000/svg"><text>#&</text></svg>');
    expect(url.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(url.slice(url.indexOf(",") + 1))).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg"><text>#&</text></svg>',
    );
  });
});

describe("filterPreviewProjectEntries", () => {
  const entries = [
    { path: "src", kind: "directory" as const },
    { path: "src/app.ts", kind: "file" as const },
    { path: "src/components", kind: "directory" as const },
    { path: "src/components/PreviewPanel.tsx", kind: "file" as const },
    { path: "docs", kind: "directory" as const },
    { path: "docs/readme.md", kind: "file" as const },
    { path: "assets/logo.png", kind: "file" as const },
  ];

  it("returns every entry for blank searches", () => {
    expect(filterPreviewProjectEntries(entries, "   ")).toBe(entries);
  });

  it("filters entries by path tokens", () => {
    expect(filterPreviewProjectEntries(entries, "preview tsx").map((entry) => entry.path)).toEqual([
      "src/components/PreviewPanel.tsx",
    ]);
  });

  it("keeps descendants when a matching directory is filtered", () => {
    expect(filterPreviewProjectEntries(entries, "components").map((entry) => entry.path)).toEqual([
      "src/components",
      "src/components/PreviewPanel.tsx",
    ]);
  });
});
