import { LRUCache } from "./lruCache";

/**
 * Small LRU cache for parsed diff payloads.
 *
 * Diff parsing (`parsePatchFiles` + sorting) is the most expensive synchronous
 * step before the worker pool highlights a diff. Re-opening a turn/file that
 * was already viewed should not re-run that work, and rapid switching between
 * turns should not keep re-parsing identical content. This cache is keyed by
 * the tuple that uniquely identifies a parsed diff payload:
 * `(turnId, filePath, blobSha)`.
 *
 * Eviction (least-recently-used) is delegated to the shared {@link LRUCache};
 * this layer adds composite-key building, an entry-count bound, an optional
 * weight budget (callers weigh an entry by its source size) and slots: an
 * entry stored under a slot replaces the slot's previous entry, for payloads
 * that supersede each other and are never revisited. Do not store
 * `null`/`undefined` values — those are reserved to signal a cache miss.
 */

export interface DiffParseCacheKey {
  /** Turn (or conversation scope) the parsed diff belongs to. */
  readonly turnId: string;
  /**
   * File scope for the parsed payload. Use a concrete path for per-file
   * payloads, or a stable sentinel (e.g. `"*"`) for whole-turn payloads.
   */
  readonly filePath: string;
  /**
   * Content identity for the payload — a blob sha when available, otherwise a
   * content hash. Distinct content under the same `(turnId, filePath)` must
   * produce a distinct `blobSha`.
   */
  readonly blobSha: string;
}

/** Default capacity for diff parse caches (~50 parsed payloads). */
export const DEFAULT_DIFF_PARSE_CACHE_MAX_ENTRIES = 50;

const KEY_SEPARATOR = "\u0000";

// Without a weight budget the cache bounds purely by entry count, and every
// entry contributes a uniform weight.
const UNBOUNDED_WEIGHT = Number.POSITIVE_INFINITY;
const UNIT_ENTRY_WEIGHT = 1;

export interface DiffParseCacheSetOptions {
  /** The entry's share of the weight budget (e.g. its source length). */
  readonly weight?: number;
  /** A slot the entry replaces the previous entry of. */
  readonly slot?: string;
}

/**
 * Builds a collision-resistant string key from a {@link DiffParseCacheKey}.
 * Components are joined by a NUL separator that does not appear in turn ids,
 * file paths, or content hashes.
 */
export function buildDiffParseCacheKey(key: DiffParseCacheKey): string {
  return `${key.turnId}${KEY_SEPARATOR}${key.filePath}${KEY_SEPARATOR}${key.blobSha}`;
}

export class DiffParseCache<V> {
  readonly #cache: LRUCache<V>;
  readonly #maxEntries: number;
  readonly #keyBySlot = new Map<string, string>();

  constructor(
    maxEntries: number = DEFAULT_DIFF_PARSE_CACHE_MAX_ENTRIES,
    maxWeight: number = UNBOUNDED_WEIGHT,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError(
        `DiffParseCache maxEntries must be a positive integer, received ${String(maxEntries)}`,
      );
    }
    if (!(maxWeight > 0)) {
      throw new RangeError(
        `DiffParseCache maxWeight must be positive, received ${String(maxWeight)}`,
      );
    }
    this.#maxEntries = maxEntries;
    this.#cache = new LRUCache<V>(maxEntries, maxWeight);
  }

  /** Total weight of the cached entries. */
  get retainedWeight(): number {
    return this.#cache.retainedBytes;
  }

  get maxEntries(): number {
    return this.#maxEntries;
  }

  /** Returns the cached value (if any) and marks it most-recently-used. */
  get(key: DiffParseCacheKey): V | undefined {
    return this.#cache.get(buildDiffParseCacheKey(key)) ?? undefined;
  }

  /** Stores a value, marking it most-recently-used and evicting LRU overflow. */
  set(key: DiffParseCacheKey, value: V, options: DiffParseCacheSetOptions = {}): void {
    const cacheKey = buildDiffParseCacheKey(key);
    if (options.slot !== undefined) {
      const previous = this.#keyBySlot.get(options.slot);
      if (previous !== undefined && previous !== cacheKey) this.#cache.delete(previous);
      this.#keyBySlot.set(options.slot, cacheKey);
    }
    this.#cache.set(cacheKey, value, Math.max(UNIT_ENTRY_WEIGHT, options.weight ?? 0));
  }

  /** Returns the cached value, computing and storing it on a cache miss. */
  getOrCompute(key: DiffParseCacheKey, compute: () => V): V {
    const existing = this.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const value = compute();
    this.set(key, value);
    return value;
  }

  clear(): void {
    this.#cache.clear();
    this.#keyBySlot.clear();
  }
}
