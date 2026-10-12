/**
 * A cheap estimate of a value's JSON length, for retained-memory budgets.
 *
 * Budgets only need the order of magnitude, and `JSON.stringify` of a
 * streaming activity or a whole thread window allocated the full string on
 * every live event. This walks the value instead: string lengths plus a small
 * constant per number, boolean, null and key. Cycles and extreme depth stop
 * the walk rather than throw.
 */
const MAX_DEPTH = 64;

export function approximateJsonSize(value: unknown): number {
  const seen = new Set<object>();
  const walk = (current: unknown, depth: number): number => {
    switch (typeof current) {
      case "string":
        return current.length + 2;
      case "number":
      case "bigint":
        return 8;
      case "boolean":
        return 5;
      case "object": {
        if (current === null) return 4;
        if (depth >= MAX_DEPTH || seen.has(current)) return 0;
        seen.add(current);
        let size = 2;
        if (Array.isArray(current)) {
          for (const item of current) size += walk(item, depth + 1) + 1;
        } else {
          for (const key in current) {
            if (!Object.hasOwn(current, key)) continue;
            size += key.length + 4 + walk((current as Record<string, unknown>)[key], depth + 1);
          }
        }
        return size;
      }
      default:
        return 0;
    }
  };
  return walk(value, 0);
}
