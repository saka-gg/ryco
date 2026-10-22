import { relative } from "node:path";
import { BaseSequencer, type TestSpecification } from "vite-plus/test/node";
import { shuffle } from "vite-plus/test/plugins/utils-helpers";

import committedDurations from "./browserTestDurations.json" with { type: "json" };

/** Seconds each browser test file occupies its CI shard, keyed by path relative to `apps/web`. */
export type BrowserTestDurations = Readonly<Record<string, number>>;

export interface WeightedEntry<T> {
  /** Unique and stable across machines: it breaks weight ties. */
  readonly id: string;
  readonly weight: number;
  readonly value: T;
}

function compareIds(left: string, right: string): number {
  // Code-unit order, not localeCompare: collation depends on the runner's ICU
  // data and locale, and shards that order files differently would skip some
  // and run others twice.
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Greedy longest-processing-time split: heaviest entry first, each onto the
 * lightest shard. Every shard job computes the whole partition and keeps its
 * own part, so the result depends only on the set of entries, never on their
 * input order.
 */
export function partitionByWeight<T>(entries: readonly WeightedEntry<T>[], count: number): T[][] {
  if (!Number.isInteger(count) || count < 1) throw new RangeError(`Invalid shard count ${count}.`);
  const ids = new Set<string>();
  for (const entry of entries) {
    // A NaN weight or a repeated id would leave the order to the input.
    if (!Number.isFinite(entry.weight) || entry.weight < 0) {
      throw new RangeError(`Invalid shard weight ${entry.weight} for ${entry.id}.`);
    }
    if (ids.has(entry.id)) throw new Error(`Duplicate shard entry ${entry.id}.`);
    ids.add(entry.id);
  }
  const ordered = entries.toSorted(
    (left, right) => right.weight - left.weight || compareIds(left.id, right.id),
  );
  const loads = Array.from({ length: count }, () => 0);
  const shards = Array.from({ length: count }, (): T[] => []);
  for (const entry of ordered) {
    let target = 0;
    for (let index = 1; index < count; index++) {
      const load = loads[index]!;
      const targetLoad = loads[target]!;
      // Equal loads go to the shard with fewer files, so zero-weight files
      // still spread out.
      if (
        load < targetLoad ||
        (load === targetLoad && shards[index]!.length < shards[target]!.length)
      ) {
        target = index;
      }
    }
    loads[target]! += entry.weight;
    shards[target]!.push(entry.value);
  }
  return shards;
}

/** Looks up a file's committed duration; files added since the last refresh get the median. */
export function durationWeights(durations: BrowserTestDurations): (file: string) => number {
  const known = Object.entries(durations)
    .map(([file, seconds]) => {
      if (!Number.isFinite(seconds) || seconds < 0) {
        throw new RangeError(`Invalid browser test duration ${String(seconds)} for ${file}.`);
      }
      return seconds;
    })
    .toSorted((left, right) => left - right);
  const middle = Math.floor(known.length / 2);
  const median =
    known.length === 0
      ? 1
      : known.length % 2 === 1
        ? known[middle]!
        : (known[middle - 1]! + known[middle]!) / 2;
  return (file) => (Object.hasOwn(durations, file) ? durations[file]! : median);
}

const committedWeight = durationWeights(committedDurations);

/**
 * Vitest's own `--shard` sorts files by path hash and gives each shard the same
 * number of them, so a shard that draws several ChatView suites finishes
 * minutes after the rest. This one balances measured CI time instead, from
 * `browserTestDurations.json` (refresh it with `scripts/ci/browser-durations.ts`).
 * Stale durations only unbalance the shards; every file still runs exactly once.
 */
export class BrowserShardSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard;
    if (!shard) return files;
    const root = this.ctx.config.root;
    const entries = files.map((spec) => {
      const file = relative(root, spec.moduleId).replaceAll("\\", "/");
      // The project name keeps the id unique if a second browser instance
      // ever runs the same file.
      return { id: `${spec.project.name}:${file}`, weight: committedWeight(file), value: spec };
    });
    return partitionByWeight(entries, shard.count)[shard.index - 1] ?? [];
  }

  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    // Any configured sequencer replaces Vitest's RandomSequencer, so keep
    // `--sequence.shuffle` shuffling the file order the way that one does.
    const { shuffle: shuffled, seed } = this.ctx.config.sequence;
    // eslint-disable-next-line unicorn/no-array-sort -- BaseSequencer#sort, not Array#sort.
    return shuffled ? shuffle([...files], seed) : super.sort(files);
  }
}
