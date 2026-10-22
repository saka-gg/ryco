import * as fc from "fast-check";
import type { TestSpecification, Vitest } from "vite-plus/test/node";
import { describe, expect, it } from "vite-plus/test";

import {
  BrowserShardSequencer,
  durationWeights,
  partitionByWeight,
  type WeightedEntry,
} from "./browserShardSequencer";
import committedDurations from "./browserTestDurations.json" with { type: "json" };

// Ids span all of Unicode (accents, case, astral characters), where code-unit
// order and locale collation disagree.
const entriesArbitrary = fc.uniqueArray(
  fc.record({
    id: fc.string({ unit: "binary", maxLength: 8 }),
    // Repeated weights exercise the tie-break.
    weight: fc.oneof(fc.constantFrom(0, 1, 2.5), fc.double({ min: 0, max: 100, noNaN: true })),
  }),
  { selector: (entry) => entry.id, maxLength: 60 },
);

function withValues(entries: readonly { id: string; weight: number }[]): WeightedEntry<string>[] {
  return entries.map((entry) => ({ ...entry, value: entry.id }));
}

function permutation<T>(items: readonly T[]) {
  return fc.shuffledSubarray([...items], { minLength: items.length, maxLength: items.length });
}

function loadOf(shard: readonly string[], weights: ReadonlyMap<string, number>): number {
  return shard.reduce((sum, id) => sum + weights.get(id)!, 0);
}

describe("partitionByWeight", () => {
  it("places every entry in exactly one shard", () => {
    fc.assert(
      fc.property(entriesArbitrary, fc.integer({ min: 1, max: 12 }), (entries, count) => {
        const shards = partitionByWeight(withValues(entries), count);
        expect(shards).toHaveLength(count);
        const placed = shards.flat();
        expect(placed).toHaveLength(entries.length);
        expect(new Set(placed)).toEqual(new Set(entries.map((entry) => entry.id)));
      }),
    );
  });

  it("gives every shard job the same split whatever order its files arrive in", () => {
    const scenario = fc
      .tuple(entriesArbitrary, fc.integer({ min: 1, max: 8 }))
      .chain(([entries, count]) =>
        fc.tuple(
          fc.constant(count),
          fc.array(permutation(entries), { minLength: count, maxLength: count }),
        ),
      );
    fc.assert(
      fc.property(scenario, ([count, orderings]) => {
        // Each shard job partitions its own ordering and keeps only its part.
        const kept = orderings.map(
          (ordering, index) => partitionByWeight(withValues(ordering), count)[index]!,
        );
        const reference = partitionByWeight(withValues(orderings[0]!), count);
        expect(kept).toEqual(reference);
        expect(partitionByWeight(withValues(orderings[0]!), count)).toEqual(reference);
      }),
    );
  });

  it("keeps the shards within one entry's weight of each other", () => {
    fc.assert(
      fc.property(entriesArbitrary, fc.integer({ min: 1, max: 12 }), (entries, count) => {
        const weights = new Map(entries.map((entry) => [entry.id, entry.weight]));
        const loads = partitionByWeight(withValues(entries), count).map((shard) =>
          loadOf(shard, weights),
        );
        const heaviest = Math.max(0, ...entries.map((entry) => entry.weight));
        expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(heaviest + 1e-9);
      }),
    );
  });

  it("spreads equal and zero weights by file count", () => {
    const entries = withValues(["d", "a", "c", "b", "e"].map((id) => ({ id, weight: 0 })));
    expect(partitionByWeight(entries, 2)).toEqual([
      ["a", "c", "e"],
      ["b", "d"],
    ]);
  });

  it("rejects inputs that would make the split depend on order", () => {
    expect(() => partitionByWeight([], 0)).toThrow(RangeError);
    expect(() => partitionByWeight([], 1.5)).toThrow(RangeError);
    expect(() => partitionByWeight(withValues([{ id: "a", weight: Number.NaN }]), 2)).toThrow(
      "Invalid shard weight",
    );
    expect(() =>
      partitionByWeight(
        withValues([
          { id: "a", weight: 1 },
          { id: "a", weight: 2 },
        ]),
        2,
      ),
    ).toThrow("Duplicate shard entry a.");
  });
});

describe("durationWeights", () => {
  it("returns committed durations and the median for unknown files", () => {
    const odd = durationWeights({ "a.browser.tsx": 9, "b.browser.tsx": 1, "c.browser.tsx": 4 });
    expect(odd("a.browser.tsx")).toBe(9);
    expect(odd("new.browser.tsx")).toBe(4);
    expect(odd("constructor")).toBe(4);
    const even = durationWeights({ "a.browser.tsx": 2, "b.browser.tsx": 6 });
    expect(even("new.browser.tsx")).toBe(4);
    expect(durationWeights({})("new.browser.tsx")).toBe(1);
  });

  it("rejects durations that are not finite and non-negative", () => {
    expect(() => durationWeights({ "a.browser.tsx": -1 })).toThrow(RangeError);
    expect(() => durationWeights({ "a.browser.tsx": Number.POSITIVE_INFINITY })).toThrow(
      RangeError,
    );
  });

  it("keeps the committed file sorted and relative to apps/web", () => {
    const files = Object.keys(committedDurations);
    expect(files.length).toBeGreaterThan(0);
    expect(files.toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0))).toEqual(
      files,
    );
    for (const file of files)
      expect(file).toMatch(/^src\/(?:components|browser|themes)\/.+\.browser\.tsx$/u);
  });
});

describe("BrowserShardSequencer", () => {
  const root = "/repo/apps/web";
  const files = [
    ...Object.keys(committedDurations),
    // Added since the last refresh, so it has no committed duration.
    "src/components/NotYetMeasured.browser.tsx",
  ];
  const specs = files.map(
    (file) => ({ moduleId: `${root}/${file}`, project: { name: "chromium" } }) as TestSpecification,
  );

  function sequencer(config: object): BrowserShardSequencer {
    return new BrowserShardSequencer({ config: { root, ...config } } as Vitest);
  }

  it.each([4, 6])(
    "splits the suite into %i disjoint shards that cover every file",
    async (count) => {
      // Each shard job globs the files itself, so give each its own order.
      const shards = await Promise.all(
        Array.from({ length: count }, (_, index) =>
          sequencer({ shard: { index: index + 1, count } }).shard([
            ...specs.slice(index * 37),
            ...specs.slice(0, index * 37),
          ]),
        ),
      );
      const placed = shards.flat().map((spec) => spec.moduleId);
      expect(placed).toHaveLength(specs.length);
      expect(new Set(placed)).toEqual(new Set(specs.map((spec) => spec.moduleId)));
      expect(shards.every((shard) => shard.length > 0)).toBe(true);
    },
  );

  it("runs every file when not sharding", async () => {
    expect(await sequencer({}).shard(specs)).toBe(specs);
  });

  it("keeps --sequence.shuffle reproducible from its seed", async () => {
    const shuffled = (seed: number) =>
      sequencer({ sequence: { shuffle: true, seed } })
        // eslint-disable-next-line unicorn/no-array-sort -- TestSequencer#sort, not Array#sort.
        .sort(specs)
        .then((sorted) => sorted.map((spec) => spec.moduleId));
    const first = await shuffled(1234);
    expect(await shuffled(1234)).toEqual(first);
    expect(first).not.toEqual(specs.map((spec) => spec.moduleId));
    expect(new Set(first)).toEqual(new Set(specs.map((spec) => spec.moduleId)));
  });
});
