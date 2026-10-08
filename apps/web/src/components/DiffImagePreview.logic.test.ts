import { parsePatchFiles } from "@pierre/diffs";
import { describe, expect, it } from "vitest";
import { diffImageCacheKey, resolveDiffImageTargets } from "./DiffImagePreview.logic";

function parseSingleFile(patch: string) {
  const file = parsePatchFiles(patch, "test").flatMap((parsed) => parsed.files)[0];
  if (!file) throw new Error("Patch did not parse.");
  return file;
}

describe("resolveDiffImageTargets", () => {
  it("reads both stored versions of a changed binary image", () => {
    const fileDiff = parseSingleFile(
      [
        "diff --git a/assets/shot.png b/assets/shot.png",
        "index bccac03..46b8f05 100644",
        "Binary files a/assets/shot.png and b/assets/shot.png differ",
        "",
      ].join("\n"),
    );
    expect(resolveDiffImageTargets({ fileDiff, afterIsWorkingTree: false })).toEqual([
      {
        side: "before",
        label: "Before",
        path: "assets/shot.png",
        source: { kind: "blob", oid: "bccac03" },
      },
      {
        side: "after",
        label: "After",
        path: "assets/shot.png",
        source: { kind: "blob", oid: "46b8f05" },
      },
    ]);
  });

  it("labels added and deleted images and skips the null object", () => {
    const added = parseSingleFile(
      [
        "diff --git a/new.PNG b/new.PNG",
        "new file mode 100644",
        "index 0000000..7cbde72",
        "Binary files /dev/null and b/new.PNG differ",
        "",
      ].join("\n"),
    );
    expect(resolveDiffImageTargets({ fileDiff: added, afterIsWorkingTree: false })).toEqual([
      { side: "after", label: "Added", path: "new.PNG", source: { kind: "blob", oid: "7cbde72" } },
    ]);
    const deleted = parseSingleFile(
      [
        "diff --git a/old.jpg b/old.jpg",
        "deleted file mode 100644",
        "index 7cbde72..0000000",
        "Binary files a/old.jpg and /dev/null differ",
        "",
      ].join("\n"),
    );
    expect(resolveDiffImageTargets({ fileDiff: deleted, afterIsWorkingTree: false })).toEqual([
      {
        side: "before",
        label: "Deleted",
        path: "old.jpg",
        source: { kind: "blob", oid: "7cbde72" },
      },
    ]);
  });

  it("reads the unstaged side from the working file, versioned by its hash", () => {
    const oldOid = "b".repeat(40);
    const newOid = "c".repeat(40);
    const fileDiff = parseSingleFile(
      [
        "diff --git a/shot.webp b/shot.webp",
        `index ${oldOid}..${newOid} 100644`,
        "GIT binary patch",
        "literal 5",
        "McmZQzU|?ckU;qFB00RI30RR91",
        "",
        "literal 0",
        "HcmV?d00001",
        "",
      ].join("\n"),
    );
    expect(resolveDiffImageTargets({ fileDiff, afterIsWorkingTree: true })).toEqual([
      { side: "before", label: "Before", path: "shot.webp", source: { kind: "blob", oid: oldOid } },
      {
        side: "after",
        label: "After",
        path: "shot.webp",
        source: { kind: "working-tree", relativePath: "shot.webp", version: newOid },
      },
    ]);
  });

  it("ignores text diffs, non-images and headers without content IDs", () => {
    const svg = parseSingleFile(
      [
        "diff --git a/icon.svg b/icon.svg",
        "index 1111111..2222222 100644",
        "--- a/icon.svg",
        "+++ b/icon.svg",
        "@@ -1 +1 @@",
        "-<svg/>",
        "+<svg></svg>",
        "",
      ].join("\n"),
    );
    expect(resolveDiffImageTargets({ fileDiff: svg, afterIsWorkingTree: false })).toEqual([]);
    const archive = parseSingleFile(
      [
        "diff --git a/data.zip b/data.zip",
        "index 1111111..2222222 100644",
        "Binary files a/data.zip and b/data.zip differ",
        "",
      ].join("\n"),
    );
    expect(resolveDiffImageTargets({ fileDiff: archive, afterIsWorkingTree: false })).toEqual([]);
    const modeOnly = parseSingleFile(
      ["diff --git a/shot.png b/shot.png", "old mode 100644", "new mode 100755", ""].join("\n"),
    );
    expect(resolveDiffImageTargets({ fileDiff: modeOnly, afterIsWorkingTree: false })).toEqual([]);
  });
});

describe("diffImageCacheKey", () => {
  it("separates blobs and working files by environment, checkout and version", () => {
    const blob = diffImageCacheKey({
      environmentId: "env",
      cwd: "/repo",
      source: { kind: "blob", oid: "abc1234" },
    });
    expect(
      diffImageCacheKey({
        environmentId: "other",
        cwd: "/repo",
        source: { kind: "blob", oid: "abc1234" },
      }),
    ).not.toBe(blob);
    const working = (version: string) =>
      diffImageCacheKey({
        environmentId: "env",
        cwd: "/repo",
        source: { kind: "working-tree", relativePath: "shot.png", version },
      });
    expect(working("a".repeat(40))).not.toBe(working("b".repeat(40)));
  });
});
