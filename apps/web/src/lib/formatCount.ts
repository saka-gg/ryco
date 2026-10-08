/** A count and its noun: "1 run", "3 runs", "1,200 files", "4 missed" (with `words`). */
export function formatCount(n: number, word: string, words = `${word}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? word : words}`;
}
