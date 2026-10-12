/**
 * Durable storage for the usage scan cache.
 *
 * The cache used to be one JSON document (tens of MB for heavy users) that was
 * parsed whole on the first summary and re-serialized whole after every scan
 * that touched one active transcript. It is now split into a fixed number of
 * shards keyed by the (already hashed) file key. Only shards whose entries
 * changed are rewritten, and loading parses many small documents, yielding
 * between them, instead of one large one.
 *
 * @module usageScanCacheStore
 */
import { Cause, Effect, FileSystem, Path } from "effect";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { readBoundedUsageFile } from "./usageFileReader.ts";
import {
  type CachedUsageFile,
  capUsageScanCache,
  decodeUsageScanCache,
  encodeUsageScanCache,
  pruneUsageScanCache,
  type UsageScanCache,
} from "./usageScanCache.ts";

export const USAGE_SCAN_CACHE_SHARD_COUNT = 64;
/**
 * Records held in memory across all shards. The least recently modified files
 * are evicted first; the cache is also released entirely while usage is idle.
 */
export const USAGE_SCAN_CACHE_RECORD_LIMIT = 1_000_000;
const SHARD_FILE_BYTES = 64 * 1024 * 1024;
const LEGACY_FILE_BYTES = 64 * 1024 * 1024;
const SHARD_READ_CONCURRENCY = 8;

/** File keys are hex SHA-256 digests, so their first byte spreads evenly over shards. */
export function usageScanCacheShardOf(fileKey: string): number {
  const value = Number.parseInt(fileKey.slice(0, 2), 16);
  return (Number.isNaN(value) ? 0 : value) % USAGE_SCAN_CACHE_SHARD_COUNT;
}

/**
 * A scan cache that versions each shard on every change, so a persist can tell
 * which shards still differ from disk even when a write fails or is interrupted.
 */
export class TrackedUsageScanCache extends Map<string, CachedUsageFile> {
  // Map's constructor never calls set() here: instances are always created empty.
  readonly #versions = new Map<number, number>();
  readonly #persisted = new Map<number, number>();

  #touch(fileKey: string): void {
    const shard = usageScanCacheShardOf(fileKey);
    this.#versions.set(shard, (this.#versions.get(shard) ?? 0) + 1);
  }

  override set(fileKey: string, entry: CachedUsageFile): this {
    this.#touch(fileKey);
    return super.set(fileKey, entry);
  }

  override delete(fileKey: string): boolean {
    const removed = super.delete(fileKey);
    if (removed) this.#touch(fileKey);
    return removed;
  }

  override clear(): void {
    for (const fileKey of this.keys()) this.#touch(fileKey);
    super.clear();
  }

  /** Shards changed since their last successful persist, with the version to persist. */
  dirtyShards(): ReadonlyMap<number, number> {
    const dirty = new Map<number, number>();
    for (const [shard, version] of this.#versions) {
      if (this.#persisted.get(shard) !== version) dirty.set(shard, version);
    }
    return dirty;
  }

  markPersisted(shard: number, version: number): void {
    this.#persisted.set(shard, version);
  }

  /** Insert entries read from disk without marking their shards dirty. */
  restore(entries: Iterable<readonly [string, CachedUsageFile]>): void {
    for (const [fileKey, entry] of entries) super.set(fileKey, entry);
  }

  /** Forget every entry without scheduling deletes: the shards on disk stay valid. */
  unload(): void {
    super.clear();
    this.#versions.clear();
    this.#persisted.clear();
  }
}

export interface UsageScanCacheStoreOptions {
  readonly directory: string;
  /** The single-document cache written by earlier versions, migrated on first load. */
  readonly legacyFilePath: string;
  readonly retentionMs: number;
}

const readText = (filePath: string, maxBytes: number) =>
  Effect.promise((signal) => readBoundedUsageFile(filePath, maxBytes, signal)).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(null),
    ),
  );

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export const makeUsageScanCacheStore = Effect.fn("makeUsageScanCacheStore")(function* (
  options: UsageScanCacheStoreOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const loadLock = yield* Semaphore.make(1);
  const cache = new TrackedUsageScanCache();
  let loaded = false;
  let legacyPending = false;

  const shardPath = (shard: number) =>
    path.join(options.directory, `${shard.toString(16).padStart(2, "0")}.json`);

  const load = Effect.fn("UsageScanCacheStore.load")(function* (nowMs: number) {
    const shards = yield* Effect.forEach(
      Array.from({ length: USAGE_SCAN_CACHE_SHARD_COUNT }, (_, shard) => shard),
      (shard) =>
        readText(shardPath(shard), SHARD_FILE_BYTES).pipe(
          // Decode right after each read, so only a few parsed documents are alive.
          Effect.map((raw) => {
            const document = raw === null ? null : parseJson(raw);
            return document === null ? null : decodeUsageScanCache(document);
          }),
        ),
      { concurrency: SHARD_READ_CONCURRENCY },
    );
    let foundShard = false;
    for (const decoded of shards) {
      if (decoded === null) continue;
      foundShard = true;
      cache.restore(decoded);
    }
    if (foundShard) {
      // A migration whose persist failed part-way left the legacy document
      // behind. Its missing shards are rescanned; the next clean persist only
      // has to remove the file.
      legacyPending = yield* fileSystem
        .exists(options.legacyFilePath)
        .pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(false),
          ),
        );
    } else {
      const raw = yield* readText(options.legacyFilePath, LEGACY_FILE_BYTES);
      const document = raw === null ? null : parseJson(raw);
      // Every migrated entry belongs to a shard that is not on disk yet.
      if (document !== null) {
        for (const [fileKey, entry] of decodeUsageScanCache(document)) cache.set(fileKey, entry);
      }
      legacyPending = raw !== null;
    }
    // Retention normally prunes only during windowed requests; apply it on load
    // too, then bound what stays resident.
    pruneUsageScanCache(cache, {
      liveFileKeys: new Set(),
      walkedRootKeys: new Set(),
      windowStartMs: Number.POSITIVE_INFINITY,
      retentionCutoffMs: nowMs - options.retentionMs,
    });
    capUsageScanCache(cache, USAGE_SCAN_CACHE_RECORD_LIMIT);
    loaded = true;
  });

  /** Load every shard (or migrate the legacy document) once. Concurrent callers share it. */
  const ensureLoaded = (nowMs: number) =>
    loadLock.withPermits(1)(Effect.suspend(() => (loaded ? Effect.void : load(nowMs))));

  /** Rewrite only the shards that changed. A failed or interrupted write stays dirty. */
  const persist = Effect.fn("UsageScanCacheStore.persist")(function* () {
    const dirty = cache.dirtyShards();
    if (dirty.size === 0 && !legacyPending) return;
    const byShard = new Map<number, UsageScanCache>(
      [...dirty.keys()].map((shard) => [shard, new Map()]),
    );
    for (const [fileKey, entry] of cache) {
      byShard.get(usageScanCacheShardOf(fileKey))?.set(fileKey, entry);
    }
    let failed = false;
    for (const [shard, entries] of byShard) {
      const write =
        entries.size === 0
          ? fileSystem.remove(shardPath(shard), { force: true })
          : writeFileStringAtomically({
              filePath: shardPath(shard),
              contents: `${JSON.stringify(encodeUsageScanCache(entries))}\n`,
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
            );
      const written = yield* write.pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(false),
        ),
      );
      if (written) cache.markPersisted(shard, dirty.get(shard)!);
      else failed = true;
      // Give request fibers a turn between shard encodes.
      yield* Effect.yieldNow;
    }
    if (legacyPending && !failed) {
      yield* fileSystem
        .remove(options.legacyFilePath, { force: true })
        .pipe(Effect.catchCause(() => Effect.void));
      legacyPending = false;
    }
  });

  /** Persist pending changes, then release the in-memory cache until it is needed again. */
  const unload = Effect.fn("UsageScanCacheStore.unload")(function* () {
    yield* loadLock.withPermits(1)(
      Effect.gen(function* () {
        if (!loaded) return;
        yield* persist();
        // Keep entries that could not be written rather than losing them.
        if (cache.dirtyShards().size > 0 || legacyPending) return;
        cache.unload();
        loaded = false;
      }),
    );
  });

  return {
    cache,
    ensureLoaded,
    persist,
    unload,
    isLoaded: () => loaded,
  };
});

export type UsageScanCacheStore = Effect.Success<ReturnType<typeof makeUsageScanCacheStore>>;
