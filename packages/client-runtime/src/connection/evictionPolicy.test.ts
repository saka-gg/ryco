import { describe, expect, it } from "vite-plus/test";

import { planEvictionsToCapacity } from "./evictionPolicy.ts";

function entry(key: string, lastAccessedAt: number, retainedBytes: number, evictable = true) {
  return { key, lastAccessedAt, retainedBytes, evictable };
}

describe("planEvictionsToCapacity", () => {
  it("plans nothing while both caps hold", () => {
    expect(
      planEvictionsToCapacity([entry("a", 1, 100), entry("b", 2, 100)], {
        maxEntries: 2,
        maxBytes: 200,
      }),
    ).toEqual([]);
  });

  it("evicts least-recently-used first when the count cap trips", () => {
    expect(
      planEvictionsToCapacity([entry("newer", 20, 10), entry("older", 10, 10)], {
        maxEntries: 1,
        maxBytes: 1_000_000,
      }),
    ).toEqual(["older"]);
  });

  it("keeps evicting until the byte budget is also satisfied (AND-satisfied)", () => {
    const planned = planEvictionsToCapacity(
      [entry("a", 1, 500), entry("b", 2, 500), entry("c", 3, 500)],
      { maxEntries: 3, maxBytes: 600 },
    );
    // One eviction leaves 1000 bytes — still over budget — so a second runs.
    expect(planned).toEqual(["a", "b"]);
  });

  it("never plans a pinned entry, even when caps stay exceeded", () => {
    expect(
      planEvictionsToCapacity([entry("pinned", 1, 500, false), entry("idle", 2, 500)], {
        maxEntries: 1,
        maxBytes: 100,
      }),
    ).toEqual(["idle"]);
  });

  it("can budget bytes over idle entries only, so a pinned entry cannot starve them", () => {
    const entries = [entry("hot-pinned", 3, 20_000_000, false), entry("idle", 1, 200_000)];
    expect(planEvictionsToCapacity(entries, { maxEntries: 32, maxBytes: 12_000_000 })).toEqual([
      "idle",
    ]);
    expect(
      planEvictionsToCapacity(entries, {
        maxEntries: 32,
        maxBytes: 12_000_000,
        byteBudget: "evictable",
      }),
    ).toEqual([]);
  });
});
