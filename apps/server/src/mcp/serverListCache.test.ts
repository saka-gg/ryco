import { describe, expect, it } from "vite-plus/test";

import { makeServerListCache } from "./serverListCache.ts";

describe("serverListCache", () => {
  it("returns a remembered listing until it expires", () => {
    let nowMs = 0;
    const cache = makeServerListCache<string>({ ttlMs: 5000, now: () => nowMs });
    cache.remember("w", undefined, "listing", cache.generation("w"));
    expect(cache.get("w", undefined)).toBe("listing");
    nowMs = 5001;
    expect(cache.get("w", undefined)).toBeUndefined();
  });

  it("drops a listing that began before an invalidation", () => {
    const cache = makeServerListCache<string>({ ttlMs: 5000, now: () => 0 });
    const before = cache.generation("w");
    cache.invalidate("w");
    const after = cache.generation("w");
    cache.remember("w", undefined, "fresh", after);
    expect(cache.remember("w", undefined, "stale", before)).toBe("stale");
    expect(cache.get("w", undefined)).toBe("fresh");
  });

  it("evicts the workspace's other detail entries but not another workspace's", () => {
    const cache = makeServerListCache<string>({ ttlMs: 5000, now: () => 0 });
    cache.remember("w", undefined, "full", cache.generation("w"));
    cache.remember("other", undefined, "other-full", cache.generation("other"));
    cache.remember("w", "summary", "summary", cache.generation("w"));
    expect(cache.get("w", undefined)).toBeUndefined();
    expect(cache.get("w", "summary")).toBe("summary");
    expect(cache.get("other", undefined)).toBe("other-full");
  });
});
