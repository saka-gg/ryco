/**
 * Per-checkout counters that only move forward, so a reader can tell whether
 * something happened to a checkout since it captured the counter.
 */
export interface CheckoutGenerations {
  readonly get: (key: string) => number;
  readonly bump: (key: string) => void;
}

/**
 * At most `capacity` checkouts are tracked. An evicted checkout reads the
 * highest evicted value, and every bump takes a value never handed out before,
 * so a value captured before a bump can never match again — at worst an
 * eviction makes an untouched checkout look changed.
 */
export function makeCheckoutGenerations(capacity: number): CheckoutGenerations {
  const generations = new Map<string, number>();
  let lastIssued = 0;
  let evictedFloor = 0;
  return {
    get: (key) => generations.get(key) ?? evictedFloor,
    bump: (key) => {
      generations.delete(key);
      lastIssued += 1;
      generations.set(key, lastIssued);
      for (const [oldestKey, oldestValue] of generations) {
        if (generations.size <= capacity) break;
        generations.delete(oldestKey);
        evictedFloor = Math.max(evictedFloor, oldestValue);
      }
    },
  };
}
