import { describe, expect, it } from "vite-plus/test";
import { ActiveDiffParser, getRenderablePatch, splitPatchIntoFileSegments } from "./diffParsing";
import { buildPatchCacheKey } from "./diffRendering";
import { parsePatchFiles } from "@pierre/diffs";

describe("buildPatchCacheKey", () => {
  it("returns a stable cache key for identical content", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(patch)).toBe(buildPatchCacheKey(patch));
  });

  it("normalizes outer whitespace before hashing", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(`\n${patch}\n`)).toBe(buildPatchCacheKey(patch));
  });

  it("changes when diff content changes", () => {
    const before = "diff --git a/a.ts b/a.ts\n+console.log('hello')";
    const after = "diff --git a/a.ts b/a.ts\n+console.log('hello world')";

    expect(buildPatchCacheKey(before)).not.toBe(buildPatchCacheKey(after));
  });

  it("changes when cache scope changes", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(patch, "diff-panel:light")).not.toBe(
      buildPatchCacheKey(patch, "diff-panel:dark"),
    );
  });
});

const patchFor = (path: string, value = "new") =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old value\n+${value} value\n`;

function files(patch: string, previous?: Parameters<typeof getRenderablePatch>[2]) {
  const parsed = getRenderablePatch(patch, "diff-panel", previous);
  if (parsed?.kind !== "files") throw new Error("Expected parsed files");
  return parsed.files;
}

describe("per-file parsing", () => {
  it("preserves metadata and keys when a different file changes or is inserted/reordered", () => {
    const a = patchFor("a.ts");
    const oldPatch = a + patchFor("b.ts");
    const changedPatch = a + patchFor("b.ts", "edited");
    const legacyKeys = (patch: string) =>
      parsePatchFiles(patch, buildPatchCacheKey(patch))
        .flatMap((p) => p.files)
        .map((f) => f.cacheKey);
    const legacyBefore = legacyKeys(oldPatch);
    const legacyAfter = legacyKeys(changedPatch);
    expect(legacyAfter.filter((key, index) => key !== legacyBefore[index])).toHaveLength(2);
    const before = files(oldPatch);
    const after = files(patchFor("c.ts") + patchFor("b.ts", "edited") + a, {
      source: oldPatch,
      patch: { kind: "files", files: before },
    });
    expect(after[2]).toBe(before[0]);
    expect(after[2]?.cacheKey).toBe(before[0]?.cacheKey);
    expect(after[1]?.cacheKey).not.toBe(before[1]?.cacheKey);
  });

  it("reuses every unchanged active entry beyond the whole-payload LRU capacity", () => {
    const source = Array.from({ length: 120 }, (_, i) => patchFor(`${i}.ts`)).join("");
    const owner = new ActiveDiffParser();
    const initial = owner.parse(source, "test");
    if (initial?.kind !== "files") throw new Error("Expected files");
    const before = initial.files;
    const next = source.replace("+new value", "+changed value");
    const updated = owner.parse(next, "test");
    if (updated?.kind !== "files") throw new Error("Expected files");
    const after = updated.files;
    expect(after.filter((file, index) => file === before[index])).toHaveLength(119);
    expect(after[0]).not.toBe(before[0]);
  });

  it("adopts a reopened payload before reusing its active entries", () => {
    const owner = new ActiveDiffParser();
    const source = patchFor("a.ts") + patchFor("b.ts");
    const reopened = getRenderablePatch(source, "test");
    owner.parse(patchFor("unrelated.ts"), "test");
    owner.parse(source, "test", reopened);
    const updated = owner.parse(source.replace("+new value", "+changed value"), "test");
    if (reopened?.kind !== "files" || updated?.kind !== "files") throw new Error("Expected files");
    expect(updated.files[1]).toBe(reopened.files[1]);
  });

  it("preserves explicit missing-newline markers and quoted paths", () => {
    const source =
      'diff --git "a/with space.ts" "b/with space.ts"\n--- "a/with space.ts"\n+++ "b/with space.ts"\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n';
    const expected = parsePatchFiles(source).flatMap((patch) => patch.files);
    expect(files(source).map(({ cacheKey: _key, ...file }) => file)).toEqual(
      expected.map(({ cacheKey: _key, ...file }) => file),
    );
  });

  it("keeps meaningful trailing spaces in content identity", () => {
    const source = patchFor("space.ts").trimEnd();
    expect(files(source)[0]?.cacheKey).not.toBe(files(source + " ")[0]?.cacheKey);
    expect(buildPatchCacheKey(source)).not.toBe(buildPatchCacheKey(source + " "));
  });

  it("preserves parser semantics for rename, mode-only, binary, added and deleted files", () => {
    const patch = [
      "diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts",
      "diff --git a/mode.ts b/mode.ts\nold mode 100644\nnew mode 100755",
      "diff --git a/image.png b/image.png\nindex 1234567..7654321 100644\nBinary files a/image.png and b/image.png differ",
      "diff --git a/add.ts b/add.ts\nnew file mode 100644\n--- /dev/null\n+++ b/add.ts\n@@ -0,0 +1 @@\n+added",
      "diff --git a/delete.ts b/delete.ts\ndeleted file mode 100644\n--- a/delete.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-deleted",
    ].join("\n");
    const withoutKeys = (values: ReturnType<typeof files>) =>
      values.map(({ cacheKey: _key, ...file }) => file);
    expect(withoutKeys(files(patch))).toEqual(
      withoutKeys(parsePatchFiles(patch + "\n").flatMap((p) => p.files)),
    );
  });

  it("does not split header-like hunk content and preserves leading metadata", () => {
    const a = patchFor("notes.md", "diff --git a/fake b/fake");
    const segments = splitPatchIntoFileSegments("commit metadata\n" + a + patchFor("b.ts"));
    expect(segments).toHaveLength(2);
    expect(segments[0]).toBe("commit metadata\n" + a);
  });

  it("retains empty and raw fallback behavior", () => {
    expect(getRenderablePatch(" \n")).toBeNull();
    expect(getRenderablePatch("unsupported patch")).toMatchObject({
      kind: "raw",
      text: "unsupported patch",
    });
  });
});
