/** Same keys with the same values (by identity), except the ignored ones. */
export function sameRecordIgnoring(a: object, b: object, ignored: ReadonlySet<string>): boolean {
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  if (aKeys.length !== Object.keys(bRecord).length) return false;
  for (const key of aKeys) {
    if (ignored.has(key)) continue;
    if (!(key in bRecord) || aRecord[key] !== bRecord[key]) return false;
  }
  return true;
}
