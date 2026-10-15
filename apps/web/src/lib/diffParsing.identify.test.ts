import { describe, expect, it, vi } from "vite-plus/test";

const hashes = vi.hoisted(() => ({ count: 0 }));
vi.mock("./diffRendering", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./diffRendering")>();
  return {
    ...actual,
    buildPatchCacheKey: (patch: string, scope?: string) => {
      hashes.count += 1;
      return actual.buildPatchCacheKey(patch, scope);
    },
  };
});

import { ActiveDiffParser } from "./diffParsing";

describe("ActiveDiffParser.identify", () => {
  it("reuses the key of a patch delivered in the same result across panel mounts", () => {
    hashes.count = 0;
    const result = { diff: "diff --git a/a.ts b/a.ts\n+one\n" };
    const key = new ActiveDiffParser().identify(result.diff, result);
    expect(hashes.count).toBe(1);

    // A remount builds a new parser over the cached result: no second hash.
    expect(new ActiveDiffParser().identify(result.diff, result)).toBe(key);
    expect(hashes.count).toBe(1);
  });

  it("hashes again when the result carries different text", () => {
    hashes.count = 0;
    const result = { diff: "diff --git a/a.ts b/a.ts\n+one\n" };
    const parser = new ActiveDiffParser();
    const first = parser.identify(result.diff, result);
    const changed = "diff --git a/a.ts b/a.ts\n+two\n";
    expect(new ActiveDiffParser().identify(changed, result)).not.toBe(first);
    expect(hashes.count).toBe(2);
  });

  it("records a result first seen through the parser's own memo", () => {
    hashes.count = 0;
    const text = "diff --git a/a.ts b/a.ts\n+one\n";
    const parser = new ActiveDiffParser();
    parser.identify(text);
    // A refetch delivers the same text in a new result object.
    const refetched = { diff: text };
    parser.identify(refetched.diff, refetched);
    expect(new ActiveDiffParser().identify(refetched.diff, refetched)).toBe(parser.identify(text));
    expect(hashes.count).toBe(1);
  });
});
