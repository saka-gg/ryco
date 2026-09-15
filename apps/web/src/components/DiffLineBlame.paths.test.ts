import { parsePatchFiles } from "@pierre/diffs";
import { getRenderablePatch } from "../lib/diffParsing";
import { resolveDiffFilePath } from "./DiffPanel.search.logic";
import { describe, expect, it } from "vitest";
import { displayedBlameTarget } from "@ryco/client-runtime/state/comparison/lineBlame";
const patch = (oldPath: string, newPath: string) =>
  `diff --git ${oldPath} ${newPath}\n--- ${oldPath}\n+++ ${newPath}\n@@ -20,3 +30,3 @@\n context\n-old\n+new\n after\n`;
const parse = (oldPath: string, newPath: string) => {
  const result = getRenderablePatch(patch(oldPath, newPath));
  if (result?.kind !== "files") throw new Error("Expected normalized files");
  return result.files[0]!;
};
describe("actual Pierre paths are repository-relative", () => {
  it.each(["a/file.ts", "b/file.ts", "a/é file.ts", "b/space name.ts"])(
    "preserves %s without stripping twice",
    (path) => {
      const file = parse(`a/${path}`, `b/${path}`);
      expect(parsePatchFiles(patch(`a/${path}`, `b/${path}`))[0]!.files[0]!.name).toBe(path);
      expect(file.name).toBe(path);
      expect(resolveDiffFilePath(file)).toBe(path);
      expect(displayedBlameTarget(file, "base", 21)?.filePath).toBe(path);
      expect(displayedBlameTarget(file, "head", 32)?.filePath).toBe(path);
    },
  );
  it("uses previous path for deleted/context base lines and new path for head context", () => {
    const file = parse("a/a/old.ts", "b/b/new.ts");
    expect(displayedBlameTarget(file, "base", 21)?.filePath).toBe("a/old.ts");
    expect(displayedBlameTarget(file, "head", 32)?.filePath).toBe("b/new.ts");
  });
  it("handles Git quoted UTF-8 and literal quote paths", () => {
    const file = parse('"a/a/\\303\\251 \\"name\\".ts"', '"b/a/\\303\\251 \\"name\\".ts"');
    expect(file.name).toBe('a/é "name".ts');
    expect(displayedBlameTarget(file, "base", 21)?.filePath).toBe('a/é "name".ts');
  });
});

describe("raw header path boundary", () => {
  it("preserves trailing spaces and decodes escaped backslashes only once", () => {
    const spaced = parse("a/b/name \t", "b/b/name \t");
    expect(spaced.name).toBe("b/name ");
    const escaped = parse('"a/a/literal\\\\303.ts"', '"b/a/literal\\\\303.ts"');
    expect(escaped.name).toBe("a/literal\\303.ts");
  });
  it("does not invent paths for malformed quoting or invalid UTF-8", () => {
    for (const name of ['"a/\\377.ts"', '"a/bad\\q.ts"']) {
      expect(getRenderablePatch(patch(name, name))?.kind).toBe("raw");
    }
  });
  it("resolves deletion/addition pairs independently from real parsed files", () => {
    const source =
      "diff --git a/a/old.ts b/a/old.ts\ndeleted file mode 100644\n--- a/a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n" +
      "diff --git a/b/new.ts b/b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/b/new.ts\n@@ -0,0 +1 @@\n+new\n";
    const rendered = getRenderablePatch(source);
    if (rendered?.kind !== "files") throw new Error("Expected files");
    expect(displayedBlameTarget(rendered.files[0]!, "base", 1)?.filePath).toBe("a/old.ts");
    expect(displayedBlameTarget(rendered.files[1]!, "head", 1)).toBeNull();
  });
});
