// Workspace paths in UTF-8 byte order, the order git lists them in. Content
// search pages resume after a path in this order.

const ABOVE_SURROGATE_ORDER = /[\uD800-\uFFFF]/;

function isSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdfff;
}

/**
 * UTF-8 byte order is code point order. UTF-16 code units agree with it except
 * that a surrogate (an astral code point) sorts below U+E000–U+FFFF.
 */
export function comparePathsByUtf8(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftUnit = left.charCodeAt(index);
    const rightUnit = right.charCodeAt(index);
    if (leftUnit === rightUnit) continue;
    const leftSurrogate = isSurrogate(leftUnit);
    if (leftSurrogate === isSurrogate(rightUnit)) return leftUnit - rightUnit;
    return leftSurrogate ? 1 : -1;
  }
  return left.length - right.length;
}

/**
 * The native string sort is several times faster and gives the same order
 * unless a path holds a code unit of U+D800 or above.
 */
export function sortPathsByUtf8(paths: ReadonlyArray<string>): string[] {
  return paths.some((path) => ABOVE_SURROGATE_ORDER.test(path))
    ? paths.toSorted(comparePathsByUtf8)
    : paths.toSorted();
}

/** The index of the first path after `afterPath` in a list sorted by {@link sortPathsByUtf8}. */
export function indexAfterPath(paths: ReadonlyArray<string>, afterPath: string): number {
  let low = 0;
  let high = paths.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (comparePathsByUtf8(paths[middle] ?? "", afterPath) <= 0) low = middle + 1;
    else high = middle;
  }
  return low;
}
