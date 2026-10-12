// @effect-diagnostics nodeBuiltinImport:off
import * as FS from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path } from "effect";
import { afterEach, expect, it } from "vite-plus/test";

import type { UsageRecord } from "./usageRecord.ts";
import { encodeUsageScanCache, usageCacheFileKey, type CachedUsageFile } from "./usageScanCache.ts";
import { makeUsageScanCacheStore, usageScanCacheShardOf } from "./usageScanCacheStore.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await FS.rm(root, { recursive: true, force: true });
});

const record: UsageRecord = {
  provider: "claude",
  timestampMs: Date.parse("2026-08-07T00:00:00Z"),
  model: "claude-test",
  sessionId: "0123456789abcdef",
  totals: {
    uncachedInputTokens: 1,
    cachedInputTokens: 2,
    cacheCreationInputTokens: 3,
    outputTokens: 4,
    totalTokens: 10,
  },
  dedupeKey: "fedcba9876543210",
  reportedCostUsd: null,
};

function entry(mtimeMs: number): CachedUsageFile {
  return { rootKey: "root", size: 1, mtimeMs, provider: "claude", records: [record] };
}

const NOW = Date.parse("2026-08-10T00:00:00Z");

async function setup() {
  const root = await FS.mkdtemp(join(tmpdir(), "ryco-scan-store-"));
  roots.push(root);
  return {
    directory: join(root, "scan-cache"),
    legacyFilePath: join(root, "scan-cache.json"),
    retentionMs: 120 * 24 * 60 * 60 * 1000,
  };
}

const run = <A>(effect: Effect.Effect<A, never, FileSystem.FileSystem | Path.Path>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

it("migrates the legacy single-document cache into shards and rewrites only changed shards", async () => {
  const options = await setup();
  const keys = ["/a.jsonl", "/b.jsonl", "/c.jsonl"].map((path) =>
    usageCacheFileKey("claude", path),
  );
  await FS.writeFile(
    options.legacyFilePath,
    JSON.stringify(encodeUsageScanCache(new Map(keys.map((key) => [key, entry(NOW)])))),
  );
  const first = await run(makeUsageScanCacheStore(options));
  await run(first.ensureLoaded(NOW));
  expect(first.cache.size).toBe(3);
  await run(first.persist());
  await expect(FS.stat(options.legacyFilePath)).rejects.toThrow();
  const shards = new Set(keys.map(usageScanCacheShardOf));
  expect(
    (await FS.readdir(options.directory)).filter((name) => name.endsWith(".json")),
  ).toHaveLength(shards.size);

  // A new process reads the shards; one change rewrites only its own shard.
  const second = await run(makeUsageScanCacheStore(options));
  await run(second.ensureLoaded(NOW));
  expect(second.cache.size).toBe(3);
  expect(second.cache.dirtyShards().size).toBe(0);
  const changed = usageCacheFileKey("claude", "/d.jsonl");
  second.cache.set(changed, entry(NOW));
  expect([...second.cache.dirtyShards().keys()]).toEqual([usageScanCacheShardOf(changed)]);
  await run(second.persist());
  expect(second.cache.dirtyShards().size).toBe(0);

  // Unloading releases memory without losing anything on disk.
  await run(second.unload());
  expect(second.isLoaded()).toBe(false);
  expect(second.cache.size).toBe(0);
  await run(second.ensureLoaded(NOW));
  expect(second.cache.size).toBe(4);

  // Deleting a shard's last entry removes the shard file.
  second.cache.delete(changed);
  await run(second.persist());
  const third = await run(makeUsageScanCacheStore(options));
  await run(third.ensureLoaded(NOW));
  expect([...third.cache.keys()].toSorted()).toEqual(keys.toSorted());
});

it("applies retention when loading and shares one load between concurrent callers", async () => {
  const options = await setup();
  const fresh = usageCacheFileKey("claude", "/fresh.jsonl");
  const aged = usageCacheFileKey("claude", "/aged.jsonl");
  await FS.writeFile(
    options.legacyFilePath,
    JSON.stringify(
      encodeUsageScanCache(
        new Map([
          [fresh, entry(NOW)],
          [aged, entry(NOW - 200 * 24 * 60 * 60 * 1000)],
        ]),
      ),
    ),
  );
  const store = await run(makeUsageScanCacheStore(options));
  await run(Effect.all([store.ensureLoaded(NOW), store.ensureLoaded(NOW)], { concurrency: 2 }));
  expect([...store.cache.keys()]).toEqual([fresh]);
});

it("removes a legacy document left behind by a migration whose persist failed part-way", async () => {
  const options = await setup();
  const kept = usageCacheFileKey("claude", "/kept.jsonl");
  const migrated = await run(makeUsageScanCacheStore(options));
  await run(migrated.ensureLoaded(NOW));
  migrated.cache.set(kept, entry(NOW));
  await run(migrated.persist());
  // The process died after writing some shards but before removing the legacy file.
  await FS.writeFile(
    options.legacyFilePath,
    JSON.stringify(encodeUsageScanCache(new Map([[kept, entry(NOW)]]))),
  );
  const restarted = await run(makeUsageScanCacheStore(options));
  await run(restarted.ensureLoaded(NOW));
  expect([...restarted.cache.keys()]).toEqual([kept]);
  expect(restarted.cache.dirtyShards().size).toBe(0);
  await run(restarted.persist());
  await expect(FS.stat(options.legacyFilePath)).rejects.toThrow();
  // Nothing was pending any more, so unloading releases the cache.
  await run(restarted.unload());
  expect(restarted.isLoaded()).toBe(false);
});
