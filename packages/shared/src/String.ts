export function truncate(text: string, maxLength = 50): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength)}...`;
}

/** Truncates by UTF-16 code units without leaving an unmatched surrogate. */
export function truncateUnicodeSafe(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 0) {
    return "";
  }
  let end = maxChars;
  const lastCodeUnit = value.charCodeAt(end - 1);
  const nextCodeUnit = value.charCodeAt(end);
  if (
    lastCodeUnit >= 0xd800 &&
    lastCodeUnit <= 0xdbff &&
    nextCodeUnit >= 0xdc00 &&
    nextCodeUnit <= 0xdfff
  ) {
    end -= 1;
  }
  return value.slice(0, end);
}

/** A count and its noun: "1 run", "3 runs", "1,200 files", "4 missed" (with `words`). */
export function formatCount(n: number, word: string, words = `${word}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? word : words}`;
}
