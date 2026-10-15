import { describe, expect, it } from "vite-plus/test";

import {
  buildDiffParseCacheKey,
  DEFAULT_DIFF_PARSE_CACHE_MAX_ENTRIES,
  DiffParseCache,
  type DiffParseCacheKey,
} from "./diffParseCache";

function key(turnId: string, filePath: string, blobSha: string): DiffParseCacheKey {
  return { turnId, filePath, blobSha };
}

describe("buildDiffParseCacheKey", () => {
  it("is deterministic for identical keys", () => {
    expect(buildDiffParseCacheKey(key("t1", "src/app.ts", "sha1"))).toBe(
      buildDiffParseCacheKey(key("t1", "src/app.ts", "sha1")),
    );
  });

  it("distinguishes every component", () => {
    const base = buildDiffParseCacheKey(key("t1", "a.ts", "sha1"));
    expect(buildDiffParseCacheKey(key("t2", "a.ts", "sha1"))).not.toBe(base);
    expect(buildDiffParseCacheKey(key("t1", "b.ts", "sha1"))).not.toBe(base);
    expect(buildDiffParseCacheKey(key("t1", "a.ts", "sha2"))).not.toBe(base);
  });

  it("does not collide across component boundaries", () => {
    // Without a robust separator, ("a","b","c") could collide with ("a","bc","")
    // style splits. The NUL separator keeps these distinct.
    expect(buildDiffParseCacheKey(key("a", "b", "c"))).not.toBe(
      buildDiffParseCacheKey(key("ab", "", "c")),
    );
    expect(buildDiffParseCacheKey(key("a", "b", "c"))).not.toBe(
      buildDiffParseCacheKey(key("a", "", "bc")),
    );
  });
});

describe("DiffParseCache", () => {
  it("defaults to ~50 entries", () => {
    expect(new DiffParseCache<number>().maxEntries).toBe(DEFAULT_DIFF_PARSE_CACHE_MAX_ENTRIES);
    expect(DEFAULT_DIFF_PARSE_CACHE_MAX_ENTRIES).toBe(50);
  });

  it("rejects invalid capacities", () => {
    expect(() => new DiffParseCache<number>(0)).toThrow(RangeError);
    expect(() => new DiffParseCache<number>(-1)).toThrow(RangeError);
    expect(() => new DiffParseCache<number>(1.5)).toThrow(RangeError);
    expect(() => new DiffParseCache<number>(Number.NaN)).toThrow(RangeError);
  });

  it("round-trips stored values", () => {
    const cache = new DiffParseCache<string>(10);
    expect(cache.get(key("t1", "a.ts", "sha1"))).toBeUndefined();
    cache.set(key("t1", "a.ts", "sha1"), "value");
    expect(cache.get(key("t1", "a.ts", "sha1"))).toBe("value");
  });

  it("treats distinct content under the same file as distinct entries", () => {
    const cache = new DiffParseCache<string>(10);
    cache.set(key("t1", "a.ts", "sha1"), "first");
    cache.set(key("t1", "a.ts", "sha2"), "second");
    expect(cache.get(key("t1", "a.ts", "sha1"))).toBe("first");
    expect(cache.get(key("t1", "a.ts", "sha2"))).toBe("second");
  });

  it("overwrites the value for an existing key", () => {
    const cache = new DiffParseCache<string>(10);
    cache.set(key("t1", "a.ts", "sha1"), "first");
    cache.set(key("t1", "a.ts", "sha1"), "second");
    expect(cache.get(key("t1", "a.ts", "sha1"))).toBe("second");
  });

  it("evicts the least-recently-used entry once capacity is exceeded", () => {
    const cache = new DiffParseCache<string>(2);
    cache.set(key("t", "a", "1"), "A");
    cache.set(key("t", "b", "2"), "B");
    cache.set(key("t", "c", "3"), "C");

    expect(cache.get(key("t", "a", "1"))).toBeUndefined();
    expect(cache.get(key("t", "b", "2"))).toBe("B");
    expect(cache.get(key("t", "c", "3"))).toBe("C");
  });

  it("treats a read as a use, protecting the entry from eviction", () => {
    const cache = new DiffParseCache<string>(2);
    cache.set(key("t", "a", "1"), "A");
    cache.set(key("t", "b", "2"), "B");

    // Touch "a" so "b" becomes the least-recently-used entry.
    expect(cache.get(key("t", "a", "1"))).toBe("A");
    cache.set(key("t", "c", "3"), "C");

    expect(cache.get(key("t", "a", "1"))).toBe("A");
    expect(cache.get(key("t", "b", "2"))).toBeUndefined();
    expect(cache.get(key("t", "c", "3"))).toBe("C");
  });

  it("re-opening a previously cached file hits the cache", () => {
    const cache = new DiffParseCache<string>(50);
    const file = key("turn-7", "src/app.ts", "blob-abc");
    cache.set(file, "parsed");

    // Visit many other files, but stay within capacity.
    for (let index = 0; index < 40; index += 1) {
      cache.set(key("turn-7", `other-${index}.ts`, `blob-${index}`), `parsed-${index}`);
    }

    expect(cache.get(file)).toBe("parsed");
  });

  it("computes once on miss and reuses the cached value", () => {
    const cache = new DiffParseCache<number>(10);
    let calls = 0;
    const compute = () => {
      calls += 1;
      return 42;
    };

    expect(cache.getOrCompute(key("t", "a", "1"), compute)).toBe(42);
    expect(cache.getOrCompute(key("t", "a", "1"), compute)).toBe(42);
    expect(calls).toBe(1);
  });

  it("clears all entries", () => {
    const cache = new DiffParseCache<string>(10);
    cache.set(key("t", "a", "1"), "A");
    cache.set(key("t", "b", "2"), "B");
    cache.clear();
    expect(cache.get(key("t", "a", "1"))).toBeUndefined();
    expect(cache.get(key("t", "b", "2"))).toBeUndefined();
  });

  it("evicts least-recently-used entries past the weight budget", () => {
    const cache = new DiffParseCache<string>(10, 100);
    cache.set(key("t", "*", "1"), "one", { weight: 40 });
    cache.set(key("t", "*", "2"), "two", { weight: 40 });
    expect(cache.get(key("t", "*", "1"))).toBe("one");
    cache.set(key("t", "*", "3"), "three", { weight: 40 });

    expect(cache.get(key("t", "*", "2"))).toBeUndefined();
    expect(cache.get(key("t", "*", "1"))).toBe("one");
    expect(cache.get(key("t", "*", "3"))).toBe("three");
    expect(cache.retainedWeight).toBe(80);
  });

  it("replaces the previous entry of a slot", () => {
    const cache = new DiffParseCache<string>(10);
    cache.set(key("conversation:a", "*", "1"), "first", { slot: "thread-1" });
    cache.set(key("turn:a", "*", "1"), "turn");
    cache.set(key("conversation:a,b", "*", "2"), "second", { slot: "thread-1" });
    cache.set(key("conversation:x", "*", "3"), "other thread", { slot: "thread-2" });

    expect(cache.get(key("conversation:a", "*", "1"))).toBeUndefined();
    expect(cache.get(key("conversation:a,b", "*", "2"))).toBe("second");
    expect(cache.get(key("turn:a", "*", "1"))).toBe("turn");
    expect(cache.get(key("conversation:x", "*", "3"))).toBe("other thread");
    // Storing the slot's current entry again keeps it.
    cache.set(key("conversation:a,b", "*", "2"), "second again", { slot: "thread-1" });
    expect(cache.get(key("conversation:a,b", "*", "2"))).toBe("second again");
  });
});
