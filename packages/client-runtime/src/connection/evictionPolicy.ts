/**
 * The shared bounded-cache eviction policy: a count cap and a byte budget,
 * OR-triggered (either cap being exceeded starts eviction) and AND-satisfied
 * (eviction stops only when both are back within budget), evicting the least
 * recently used evictable entries first. Extracted from the thread-detail
 * subscription cache in supervision.ts so the mobile snapshot cache bounds
 * itself with the same policy instead of inventing a second one.
 *
 * Pure planning only: the caller enumerates its entries and disposes the
 * returned keys, so the same policy serves a synchronous in-memory map and an
 * async SQLite store alike.
 */

export interface EvictionCandidate<Key> {
  readonly key: Key;
  readonly lastAccessedAt: number;
  readonly retainedBytes: number;
  /** Pinned entries (refcounted, active, non-idle) are never planned away. */
  readonly evictable: boolean;
}

export interface EvictionCaps {
  readonly maxEntries: number;
  readonly maxBytes: number;
  /**
   * Which entries the byte budget covers. `"all"` (default) bounds the total,
   * as a store of persisted snapshots needs. `"evictable"` bounds only the
   * idle entries, so a pinned entry's growth cannot evict every idle one.
   */
  readonly byteBudget?: "all" | "evictable";
}

export function planEvictionsToCapacity<Key>(
  entries: ReadonlyArray<EvictionCandidate<Key>>,
  caps: EvictionCaps,
): Key[] {
  const budgeted =
    caps.byteBudget === "evictable" ? entries.filter((entry) => entry.evictable) : entries;
  let count = entries.length;
  let bytes = budgeted.reduce((total, entry) => total + entry.retainedBytes, 0);
  const withinCaps = () => count <= caps.maxEntries && bytes <= caps.maxBytes;
  if (withinCaps()) return [];

  const planned: Key[] = [];
  const idle = entries
    .filter((entry) => entry.evictable)
    .toSorted((left, right) => left.lastAccessedAt - right.lastAccessedAt);
  for (const entry of idle) {
    if (withinCaps()) break;
    planned.push(entry.key);
    count -= 1;
    bytes = Math.max(0, bytes - entry.retainedBytes);
  }
  // If everything left is pinned the caps can stay exceeded — same silent
  // overshoot the subscription cache has always allowed.
  return planned;
}
